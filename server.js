// ══════════════════════════════════════════════════════════════
// Ferbl multiplayer server — thin WebSocket wrapper around game.js
//
// Responsibilities (and ONLY these):
//   - Track rooms (room code -> { state, sockets, hostId })
//   - Accept actions from clients, validate sender is allowed to act
//   - Call the matching game.js function
//   - Broadcast getPublicState() (per-recipient — hands are private)
//
// All actual game rules live in game.js. This file has zero card logic.
// ══════════════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const G = require('./game.js');

const PORT = process.env.PORT || 8080;

// Serve index.html (the client) over plain HTTP so the whole game — page + WebSocket —
// can be deployed as a single service on one port, which is what most free PaaS hosts
// (Render, Koyeb, Fly.io, etc.) expect. Everything else 404s; this is a one-page app.
const INDEX_PATH = path.join(__dirname, 'index.html');
const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(INDEX_PATH, (err, data) => {
      if (err) { res.writeHead(500); res.end('Failed to load index.html'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT);

// room code -> { state, players: Map(pid -> ws), playerNames: Map(pid -> name),
//                hostPid, leavingAfterRound: Set, settings }
const rooms = new Map();

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function genPlayerId() {
  return 'p_' + Math.random().toString(36).slice(2, 10);
}

function send(ws, type, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcastState(room, extra) {
  const actorPid = extra && extra.actorPid;
  for (const [pid, ws] of room.players) {
    let payload = extra;
    // Card identities in lastResult.drew must stay private to the player who drew them —
    // game.js returns them for the actor's own UI, but broadcastState fans the same result
    // out to every socket in the room, so without this an opponent's client would receive
    // (and could inspect) the exact rank/suit of cards it has no right to see.
    if (extra && extra.lastResult && extra.lastResult.drew && extra.lastResult.drew.length && pid !== actorPid) {
      payload = { ...extra, lastResult: { ...extra.lastResult, drew: extra.lastResult.drew.map(() => null) } };
    }
    send(ws, 'state', { state: G.getPublicState(room.state, pid), ...payload });
  }
}

function broadcastLobby(room) {
  const list = [...room.players.keys()].map(pid => ({ id: pid, name: room.playerNames.get(pid) || '?' }));
  for (const ws of room.players.values()) {
    send(ws, 'lobby', { players: list, hostPid: room.hostPid, roomCode: room.code, numPlayers: room.settings.numPlayers });
  }
}

wss.on('connection', (ws) => {
  ws.pid = null;
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    if (ws.roomCode && rooms.has(ws.roomCode)) {
      const room = rooms.get(ws.roomCode);
      const wasHost = ws.pid === room.hostPid;
      const gameNotStarted = !room.state;
      room.players.delete(ws.pid);
      // If the host disconnects while everyone is still on the waiting-room screen (game
      // hasn't started), there's no host-migration logic — nobody left could start the game
      // anyway. Rather than leaving the remaining players stranded on a waiting screen with
      // a dead "waiting for host" state, close the room out from under them and send everyone
      // back to the initial lobby screen. (Mid-game host disconnects are unaffected — those
      // players are just treated as a disconnected player like any other, per the existing
      // leaving/ghost-dealer handling below.)
      if (wasHost && gameNotStarted && room.players.size > 0) {
        for (const ws2 of room.players.values()) send(ws2, 'hostLeft', {});
        rooms.delete(ws.roomCode);
        return;
      }
      if (room.players.size === 0) {
        setTimeout(() => {
          if (rooms.has(ws.roomCode) && rooms.get(ws.roomCode).players.size === 0) {
            rooms.delete(ws.roomCode);
          }
        }, 5 * 60 * 1000); // 5 min grace period before cleanup
      } else {
        broadcastLobby(room);
        checkHcdAcks(room); // a departing player might've been the one everyone else was waiting on
        checkNextRoundReady(room); // same idea, for the Next Round gate
      }
    }
  });
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'createRoom': return onCreateRoom(ws, msg);
    case 'joinRoom': return onJoinRoom(ws, msg);
    case 'startGame': return onStartGame(ws, msg);
    case 'action': return onAction(ws, msg);
    case 'toggleLeave': return onToggleLeave(ws, msg);
    case 'nextRound': return onNextRound(ws, msg);
    case 'hcdAck': return onHcdAck(ws, msg);
    case 'newGame': return onNewGame(ws, msg);
    case 'debugAction': return onDebugAction(ws, msg);
    default: return;
  }
}

// ── Lobby ─────────────────────────────────────────────────────

function onCreateRoom(ws, msg) {
  const code = genRoomCode();
  const pid = genPlayerId();
  const room = {
    code,
    state: null, // created on startGame
    players: new Map([[pid, ws]]),
    playerNames: new Map([[pid, msg.name || 'Player']]),
    hostPid: pid,
    leavingAfterRound: new Set(),
    readyForNextRound: new Set(),
    settings: { numPlayers: msg.numPlayers || 2, startCards: msg.startCards ?? 4 },
  };
  rooms.set(code, room);
  ws.pid = pid;
  ws.roomCode = code;
  send(ws, 'joined', { roomCode: code, pid, isHost: true, numPlayers: room.settings.numPlayers });
  broadcastLobby(room);
}

function onJoinRoom(ws, msg) {
  const code = (msg.roomCode || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) { send(ws, 'error', { message: 'Room not found' }); return; }
  if (room.state) { send(ws, 'error', { message: 'Game already in progress' }); return; }
  if (room.players.size >= room.settings.numPlayers) { send(ws, 'error', { message: 'Room is full' }); return; }

  const pid = genPlayerId();
  room.players.set(pid, ws);
  room.playerNames.set(pid, msg.name || 'Player');
  ws.pid = pid;
  ws.roomCode = code;
  send(ws, 'joined', { roomCode: code, pid, isHost: false, numPlayers: room.settings.numPlayers });
  broadcastLobby(room);
}

function onStartGame(ws, msg) {
  const room = rooms.get(ws.roomCode);
  if (!room || ws.pid !== room.hostPid) return;
  if (room.players.size < 2) { send(ws, 'error', { message: 'Need at least 2 players' }); return; }

  const startResult = beginGame(room);
  room.readyForNextRound.clear();

  for (const ws2 of room.players.values()) send(ws2, 'gameStarted', {});
  broadcastState(room, { lastResult: startResult });
}

// createGame() assigns its own sequential internal ids ('p0','p1',...) and uses them to set
// dealerPid (via highCardDraw) before we remap player.id to our real connection pids. state.cur
// is a numeric array INDEX (not a pid), so it needs no translation — only dealerPid (a pid string)
// does, and only because we remap in the same order createGame built the players array in.
function beginGame(room) {
  const orderedPids = [...room.playerNames.keys()];
  const orderedNames = orderedPids.map(pid => room.playerNames.get(pid));

  room.state = G.createGame(orderedNames, room.settings.startCards);
  console.log('[DEBUG] createGame startCards:', room.settings.startCards, 'player lives:', room.state.players.map(p => p.lives));

  const oldToNew = {};
  orderedPids.forEach((newId, i) => { oldToNew['p' + i] = newId; });
  if (room.state.dealerPid in oldToNew) room.state.dealerPid = oldToNew[room.state.dealerPid];
  room.state.players.forEach((p, i) => { p.id = orderedPids[i]; });

  // Remap lastHcd card keys and playerIds from old internal ids to real connection pids
  if (room.state.lastHcd) {
    const hcd = room.state.lastHcd;
    const remappedCards = {};
    for (const [oldId, card] of Object.entries(hcd.cards)) {
      remappedCards[oldToNew[oldId] || oldId] = card;
    }
    hcd.cards = remappedCards;
    if (hcd.dealerPid in oldToNew) hcd.dealerPid = oldToNew[hcd.dealerPid];
    if (hcd.playerIds) hcd.playerIds = hcd.playerIds.map(id => oldToNew[id] || id);
  }

  const startResult = G.startRound(room.state);
  console.log('[DEBUG] after startRound, hands:', room.state.players.map(p => p.name + ':' + p.hand.length));
  maybeAutoResolveGhostDirection(room);
  return startResult;
}

// game.js has no concept of a "ghost leaver" auto-picking a direction (that logic currently
// only exists client-side in index.html, pre-dating the server). Replicating it here at the
// server-orchestration layer: if the round lands in DIR_CHOICE and the dealer is out (eliminated/
// ghost), nobody is present to make the choice, so the server picks randomly on their behalf.
function maybeAutoResolveGhostDirection(room) {
  const state = room.state;
  if (state.phase !== 'DIR_CHOICE') return;
  const dealer = state.players.find(p => p.id === state.dealerPid);
  if (!dealer || !dealer.out) return;
  // A dealer who's out because they lost (not because they left) still gets to make
  // this one final choice themselves if they're still connected and watching — only
  // auto-resolve for players who voluntarily left (ghostLeaver — they may not even be
  // watching anymore) or who have actually disconnected.
  const stillConnected = room.players.has(dealer.id);
  if (stillConnected && !dealer.ghostLeaver) return;
  state.log.push(`${dealer.name} is out and cannot choose — direction picked automatically.`);
  G.actionChooseDirection(state, Math.random() < 0.5 ? 1 : -1);
}

// ── High card draw overlay sync ─────────────────────────────
//
// The draw itself already happened server-side (it's baked into state.lastHcd) by the time
// clients see it, so this isn't gating game logic the way readyForNextRound is — it's purely
// making sure everyone's overlay disappears together instead of players popping back to the
// table at different times while others are still watching the reveal.

function onHcdAck(ws, msg) {
  const room = rooms.get(ws.roomCode);
  if (!room || !room.state || !room.state.lastHcd) return;
  const sig = JSON.stringify(room.state.lastHcd);
  if (room.hcdAckSig !== sig) {
    room.hcdAckSig = sig;
    room.hcdAcks = new Set();
  }
  room.hcdAcks.add(ws.pid);
  checkHcdAcks(room);
}

function checkHcdAcks(room) {
  if (!room.hcdAcks || !room.hcdAckSig) return;
  if (!room.state || !room.state.lastHcd || JSON.stringify(room.state.lastHcd) !== room.hcdAckSig) return;
  const connectedPids = [...room.players.keys()];
  const allAcked = connectedPids.length > 0 && connectedPids.every(pid => room.hcdAcks.has(pid));
  if (allAcked) {
    for (const ws2 of room.players.values()) send(ws2, 'hcdDismiss', {});
    room.hcdAcks.clear();
    room.hcdAckSig = null;
  }
}

// ── In-game actions ──────────────────────────────────────────

function onAction(ws, msg) {
  const room = rooms.get(ws.roomCode);
  if (!room || !room.state) return;
  const state = room.state;

  let result;
  switch (msg.action) {
    case 'playCard':
      result = G.actionPlayCard(state, ws.pid, msg.cardId, msg.announcement);
      break;
    case 'drawCard':
      result = G.actionDrawCard(state, ws.pid);
      break;
    case 'acceptSkip':
      result = G.actionAcceptSkip(state, ws.pid);
      break;
    case 'chooseDirection':
      // actionChooseDirection takes no playerId — game.js doesn't validate the caller for this
      // one, so the server must: only the dealer may choose, and only while in that phase.
      if (ws.pid !== state.dealerPid) { send(ws, 'error', { message: 'Only the dealer chooses direction' }); return; }
      if (state.phase !== 'DIR_CHOICE') { send(ws, 'error', { message: 'Not in direction-choice phase' }); return; }
      result = G.actionChooseDirection(state, msg.dir);
      break;
    default:
      return;
  }

  if (!result || !result.success) {
    send(ws, 'error', { message: (result && result.error) || 'Action failed' });
    return;
  }

  maybeAutoResolveGhostDirection(room);
  broadcastState(room, { lastResult: result, actorPid: ws.pid });
}

function onToggleLeave(ws, msg) {
  const room = rooms.get(ws.roomCode);
  if (!room || !room.state) return;
  if (room.leavingAfterRound.has(ws.pid)) room.leavingAfterRound.delete(ws.pid);
  else room.leavingAfterRound.add(ws.pid);
  send(ws, 'leaveToggled', { leaving: room.leavingAfterRound.has(ws.pid) });
}

function onNextRound(ws, msg) {
  const room = rooms.get(ws.roomCode);
  if (!room || !room.state) return;
  const state = room.state;

  // Track who has clicked Next Round — wait for every currently CONNECTED player,
  // regardless of whether they've been eliminated. An eliminated player may still be
  // watching, and could even be the next round's ghost dealer who needs the chance to
  // choose direction themselves — excluding them here previously meant the round could
  // race ahead (and even auto-resolve their own direction choice) before they had any
  // say. The only players exempted are those who explicitly marked themselves as
  // leaving after this round (asking them to also click Next Round would leave the
  // round permanently stuck if they, reasonably, don't bother) — a player who
  // disconnects entirely is naturally dropped from room.players and stops being
  // waited on too.
  room.readyForNextRound.add(ws.pid);
  checkNextRoundReady(room);
}

function checkNextRoundReady(room) {
  if (!room || !room.state) return;
  const state = room.state;
  // Wait for every currently connected, non-leaving player — EXCEPT an eliminated
  // player who isn't the upcoming dealer. An eliminated player only has an active role
  // (ghost-dealing: choosing direction) on the specific round transition where they're
  // about to become state.dealerPid; once dealer rotates to someone else in a later
  // round, requiring their click indefinitely would just be busywork with nothing for
  // them to actually do.
  const connectedPids = [...room.players.keys()].filter(pid => {
    if (room.leavingAfterRound.has(pid)) return false;
    const player = state.players.find(p => p.id === pid);
    if (player && player.out && player.id !== state.dealerPid) return false;
    return true;
  });
  const allReady = connectedPids.length > 0 && connectedPids.every(pid => room.readyForNextRound.has(pid));
  if (!allReady) {
    // Let others know this player is ready (optional — could add a visual indicator later)
    return;
  }
  room.readyForNextRound.clear();

  const log = m => state.log.push(m);

  G.applyLeavingPlayers(state, [...room.leavingAfterRound], log);
  room.leavingAfterRound.clear();

  const remaining = state.players.filter(p => !p.out);
  if (remaining.length <= 1) {
    state.phase = 'GAME_OVER';
    state.winner = remaining[0] ? remaining[0].id : null;
    state.abandoned = remaining.length === 0;
    broadcastState(room);
    return;
  }

  const startResult = G.startRound(state);
  maybeAutoResolveGhostDirection(room);
  broadcastState(room, { lastResult: startResult });
}

// ── New game (return whole room to its waiting-room lobby) ──
//
// Previously "New Game" only reset the host's own client (a local backToLobby() that also
// dropped their socket), leaving every other connected player stranded on a dead game screen
// with no way back in. This resets the room itself — same room code, same connected players —
// and broadcasts everyone (host included) back to the waiting room together.

function onNewGame(ws, msg) {
  const room = rooms.get(ws.roomCode);
  if (!room || !room.state) return;
  if (ws.pid !== room.hostPid) return; // host-only

  room.state = null;
  room.leavingAfterRound.clear();
  room.readyForNextRound.clear();
  room.hcdAcks = new Set();
  room.hcdAckSig = null;

  const list = [...room.players.keys()].map(pid => ({ id: pid, name: room.playerNames.get(pid) || '?' }));
  for (const ws2 of room.players.values()) {
    send(ws2, 'newGame', { players: list, hostPid: room.hostPid, roomCode: room.code, numPlayers: room.settings.numPlayers });
  }
}

// ── Debug panel (host-only, multiplayer testing) ────────────
//
// The solo debug panel mutates the local client's G object directly, which does nothing
// useful in multiplayer — the server owns state and would just overwrite it on the next
// broadcast. This is the same set of operations applied to the real room.state instead,
// so they actually stick, then broadcast out like any other state change.

function onDebugAction(ws, msg) {
  const room = rooms.get(ws.roomCode);
  if (!room || !room.state) return;
  if (ws.pid !== room.hostPid) return; // host-only
  const state = room.state;
  const log = m => state.log.push(m);

  let debugResult = null;
  switch (msg.action) {
    case 'giveCard': {
      const p = state.players.find(pl => pl.id === msg.pid);
      if (!p) return;
      const card = { r: msg.rank, s: msg.suit, id: msg.rank + '_' + msg.suit };
      state.draw = state.draw.filter(c => c.id !== card.id);
      p.hand.push(card);
      log(`[DEBUG] Gave ${msg.rank} of ${msg.suit} to ${p.name}.`);
      break;
    }
    case 'setTop': {
      const card = { r: msg.rank, s: msg.suit, id: msg.rank + '_' + msg.suit };
      if (state.play.length) state.play[state.play.length - 1] = card;
      else state.play = [card];
      log(`[DEBUG] Top card set to ${msg.rank} of ${msg.suit}.`);
      break;
    }
    case 'clearHands': {
      state.players.forEach(p => { p.hand = []; });
      log('[DEBUG] All hands cleared.');
      break;
    }
    case 'setPendDraw': {
      state.pendDraw = msg.n;
      state.drawSrc = msg.n === 5 ? 'K' : '7';
      log(`[DEBUG] Pending draw set to ${msg.n}.`);
      break;
    }
    case 'startRoundWith': {
      debugResult = G.startRoundWith(state, msg.rank, msg.suit);
      log(`[DEBUG] New round ${state.round} started with ${msg.rank} of ${msg.suit}.`);
      break;
    }
    default:
      return;
  }

  broadcastState(room, debugResult ? { lastResult: debugResult } : undefined);
}

console.log(`Ferbl server listening on http://localhost:${PORT} (page) and ws://localhost:${PORT} (game)`);
