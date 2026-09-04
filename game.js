// ============================================================
// game.js — Ferbl core game logic (Node.js module)
// All rules as tested and verified in game_tester.html
// ============================================================

const SUITS = ['Leaves', 'Hearts', 'Balls', 'Acorns'];
const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const PTS   = { '7':7, '8':8, '9':9, '10':10, 'J':1, 'K':2, 'A':11 };

// ── Helpers ──────────────────────────────────────────────────

function cardPoints(c) {
  return c.r === 'Q' ? (c.s === 'Hearts' ? 40 : 20) : (PTS[c.r] || 0);
}

function cardStr(c) { return c.r + ' of ' + c.s; }

function buildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ s, r, id: r + '_' + s });
  return d;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function alive(state) {
  return state.players.filter(p => !p.out);
}

function getTop(state) {
  return state.play[state.play.length - 1];
}

function curP(state) {
  return state.players[state.cur];
}

function nxt(state, fromPid, steps = 1) {
  const a = alive(state);
  const fromPlayer = state.players.find(p => p.id === fromPid);
  let ci = a.indexOf(fromPlayer);
  if (ci === -1) ci = 0;
  const ni = ((ci + steps * state.dir) % a.length + a.length * 100) % a.length;
  return a[ni].id;
}

function setCur(state, pid) {
  state.cur = state.players.findIndex(p => p.id === pid);
  state.drewQueenEmpty = false;
}

// ── High card draw ────────────────────────────────────────────

function highCardDraw(players) {
  const RANK_ORDER = ['7','8','9','10','J','Q','K','A']; // 0 = lowest
  const SUIT_ORDER = ['Acorns','Balls','Hearts','Leaves']; // 0 = weakest (deals on tie)
  const deck = shuffle(buildDeck());
  const drawn = {};
  players.forEach(p => { drawn[p.id] = deck.pop(); });
  let dealer = players[0];
  players.forEach(p => {
    const dc = drawn[p.id];
    const dd = drawn[dealer.id];
    const rDiff = RANK_ORDER.indexOf(dc.r) - RANK_ORDER.indexOf(dd.r);
    if (rDiff < 0) dealer = p;
    else if (rDiff === 0 && SUIT_ORDER.indexOf(dc.s) < SUIT_ORDER.indexOf(dd.s)) dealer = p;
  });
  return { dealer, cards: drawn };
}

// Used when a ghost dealer isn't present (disconnected, or left after their round) to
// choose a direction themselves — draws a single card from a fresh shuffled deck and
// picks a side based on suit, same spirit as highCardDraw's dealer-selection reveal.
// Hearts/Balls -> counter-clockwise (-1), Leaves/Acorns -> clockwise (1).
function drawDirectionCard() {
  const deck = shuffle(buildDeck());
  const card = deck.pop();
  const dir = (card.s === 'Hearts' || card.s === 'Balls') ? -1 : 1;
  return { card, dir };
}

// ── Playability ───────────────────────────────────────────────

function canPlay(state, c) {
  const t = getTop(state);
  if (state.pendSkip) return c.r === 'A';
  if (state.pendDraw > 0) return state.drawSrc === 'K' ? (c.r === '7' && c.s === 'Leaves') : c.r === '7';
  if (state.forcedRank) return c.r === state.forcedRank || c.r === 'J' || (c.r === 'Q' && state.forcedRank === 'Q');
  if (state.activeSuit) return c.s === state.activeSuit || c.r === 'Q' || c.r === 'J';
  return c.s === t.s || c.r === t.r || c.r === 'J' || c.r === 'Q';
}

function playerHasPlayableCard(state, player) {
  return player.hand.some(c => canPlay(state, c));
}

function playerMustPlay(state, player) {
  // Player must play (cannot draw) if they hold the forced rank
  if (state.forcedRank && !state.pendDraw) {
    return player.hand.some(x => x.r === state.forcedRank);
  }
  return false;
}

// ── Draw deck ─────────────────────────────────────────────────

function drawN(state, n, log) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!state.draw.length) {
      if (state.play.length <= 1) break;
      const keep = state.play.pop();
      state.draw = state.play.slice().reverse();
      state.play = [keep];
      state.reshuf++;
      log(`Draw deck exhausted — play pile flipped (${state.reshuf}x).`);
      if (state.reshuf >= 2) {
        if (!state.stripped) {
          state.stripped = true;
          log('All 7s and K of Leaves removed for this round. Pending effects still apply.');
        }
        // Re-filter on every reshuffle from here on (not just the one that first
        // activated stripping) — a "ghost" 7/K of Leaves left sitting in the discard
        // pile could otherwise cycle back into the draw pile unfiltered on a later
        // reshuffle, letting a player draw and play what looks like a completely
        // normal card whose effect has actually been dead since the deck was first
        // stripped.
        const bad = x => x.r === '7' || (x.r === 'K' && x.s === 'Leaves');
        state.draw = state.draw.filter(x => !bad(x));
        state.players.forEach(p => { p.hand = p.hand.filter(x => !bad(x)); });
        // Cards already pulled into `out` earlier in THIS SAME call (before the deck ran
        // dry and triggered stripping) were drawn back when state.stripped wasn't set
        // yet, so the checks above never touched them. Purge them here — deliberately
        // NOT replaced or backfilled: the loop below simply continues its remaining
        // iterations (still capped at n total draw attempts), so discovering the strip
        // partway through a multi-card draw can legitimately leave the player with fewer
        // than n cards overall, same as if those particular draws had come up empty.
        for (let j = out.length - 1; j >= 0; j--) {
          if (bad(out[j])) out.splice(j, 1);
        }
        if (state.play.length > 0 && bad(state.play[state.play.length - 1])) {
          state.play[state.play.length - 1].ghost = true;
        }
      }
    }
    if (!state.draw.length) break;
    out.push(state.draw.pop());
  }
  return out;
}

// ── Burn counter ──────────────────────────────────────────────

function updateBurnCount(state, card) {
  if (card.r === state.lastPlayedRank) {
    state.burnCount++;
  } else {
    state.burnCount = 1;
    state.lastPlayedRank = card.r;
  }
}

function checkBurn(state) { return state.burnCount >= 4; }

// ── Direction choice helpers ──────────────────────────────────

function needsDirChoice(state) {
  const alivePlayers = alive(state);
  const dealer = state.players.find(p => p.id === state.dealerPid);
  const isGhostDealer = dealer && dealer.out;
  if (isGhostDealer && alivePlayers.length === 2) return true;
  if (alivePlayers.length <= 2) return false;
  return true;
}

function firstAliveAfterDealer(state, dir) {
  const dealerIdx = state.players.findIndex(p => p.id === state.dealerPid);
  for (let step = 1; step <= state.players.length; step++) {
    const idx = (dealerIdx + step * dir + state.players.length * 100) % state.players.length;
    if (!state.players[idx].out) return state.players[idx];
  }
  return alive(state)[0];
}

// ── Apply card effect ─────────────────────────────────────────

function applyEffect(state, c, player, log) {
  if ((c.r === '7' || (c.r === 'K' && c.s === 'Leaves')) && state.stripped) {
    log(`${cardStr(c)} has no effect — 7s and K of Leaves were stripped this round.`);
    return false;
  }
  if (c.r === '7' && !state.stripped) {
    if (state.drawSrc === 'K') {
      state.pendDraw = 7;
      log('7 of Leaves overrules K of Leaves — next draws 7, no further chaining.');
    } else {
      state.pendDraw = (state.pendDraw || 0) + 2;
      state.drawSrc = '7';
      log(`7 chain — next draws ${state.pendDraw}.`);
    }
    state.activeSuit = null; state.forcedRank = null;
    return false;
  }
  if (c.r === '8') {
    state.activeSuit = null; state.forcedRank = null;
    if (alive(state).length === 2) {
      log(`8 with 2 players — ${player.name} plays again.`);
      return true; // play again
    }
    state.dir *= -1;
    log(`Direction: ${state.dir === 1 ? 'clockwise →' : '← anti-clockwise'}.`);
    return false;
  }
  if (c.r === '10' && c.s === 'Hearts') {
    const a = alive(state);
    const ci = a.findIndex(x => x.id === player.id);
    for (let i = 1; i < a.length; i++) {
      const op = a[(ci + i * state.dir + a.length * 100) % a.length];
      const drawn = drawN(state, 1, log);
      op.hand = op.hand.concat(drawn);
    }
    state.activeSuit = null; state.forcedRank = null;
    log(`10♥: all others drew 1. ${player.name} plays again.`);
    return true; // play again
  }
  if (c.r === 'K' && c.s === 'Leaves' && !state.stripped) {
    state.pendDraw = 5; state.drawSrc = 'K';
    state.activeSuit = null; state.forcedRank = null;
    log('K of Leaves — next draws 5.');
    return false;
  }
  if (c.r === 'A') {
    state.pendSkip = true;
    state.activeSuit = null; state.forcedRank = null;
    log('Ace — next player skipped (or plays an Ace).');
    return false;
  }
  if (c.r !== 'J' && c.r !== 'Q') { state.activeSuit = null; state.forcedRank = null; }
  if (c.r === 'J') state.activeSuit = null;
  if (c.r === 'Q') state.forcedRank = null;
  return false;
}

// ── Direction choice ──────────────────────────────────────────

function chooseDirection(state, dir, log) {
  if (state.phase !== 'DIR_CHOICE') return { success: false, error: 'Not in direction choice phase.' };
  state.dir = dir;
  state.phase = 'PLAYING';
  log(`Direction set: ${dir === 1 ? 'clockwise →' : '← anti-clockwise'}.`);

  const dealer = state.players.find(p => p.id === state.dealerPid) || alive(state)[0];
  const first = firstAliveAfterDealer(state, dir);
  let sideEffectDraws = null;

  if (state.dealerFinalCard) {
    const fc = state.dealerFinalCard;
    state.dealerFinalCard = null;
    if (fc.r === '10' && fc.s === 'Hearts') {
      const a = alive(state);
      const di = a.indexOf(dealer.out ? first : dealer);
      for (let s = 1; s < a.length; s++) {
        const pi = ((di + s * dir) % a.length + a.length) % a.length;
        a[pi].hand = a[pi].hand.concat(drawN(state, 1, log));
        log(`${a[pi].name} draws 1 card (10 of Hearts).`);
        if (!sideEffectDraws) sideEffectDraws = {};
        sideEffectDraws[a[pi].id] = (sideEffectDraws[a[pi].id] || 0) + 1;
      }
      setCur(state, (dealer.out ? first : dealer).id);
      log(`${(dealer.out ? first : dealer).name} plays again.`);
    } else {
      setCur(state, first.id);
      if (fc.r === 'A') { state.pendSkip = true; log(`${first.name} is skipped.`); }
      else if (fc.r === '7') log(`${first.name} must draw ${state.pendDraw}.`);
      else if (fc.r === 'K' && fc.s === 'Leaves') log(`${first.name} must draw 5.`);
      else if (fc.r === 'J') log(`Forced rank: ${state.forcedRank}. ${first.name} goes first.`);
      else if (fc.r === 'Q') log(`Active suit: ${state.activeSuit}. ${first.name} goes first.`);
      else log(`${first.name} goes first.`);
    }
  } else {
    const ic = getTop(state);
    if (ic.r === '10' && ic.s === 'Hearts') {
      const a = alive(state);
      a.forEach(p => {
        if (p.id !== dealer.id) {
          p.hand = p.hand.concat(drawN(state, 1, log));
          if (!sideEffectDraws) sideEffectDraws = {};
          sideEffectDraws[p.id] = (sideEffectDraws[p.id] || 0) + 1;
        }
      });
      setCur(state, (dealer.out ? first : dealer).id);
      log(`Initial 10 of Hearts — all players except ${dealer.name} draw 1. ${(dealer.out ? first : dealer).name} plays first.`);
    } else {
      setCur(state, first.id);
      if (ic.r === 'A') { state.pendSkip = true; }
      log(`${first.name} goes first.`);
    }
  }
  return { success: true, ...(sideEffectDraws ? { sideEffectDraws } : {}) };
}

// ── Game state factory ────────────────────────────────────────

function createGame(playerNames, startingCards) {
  const state = {
    players: playerNames.map((name, i) => ({
      id: 'p' + i, name, hand: [], lives: startingCards, losses: 0, out: false
    })),
    draw: [], play: [], dir: 1, cur: 0,
    dealerPid: null,
    pendDraw: 0, drawSrc: null, pendSkip: false,
    forcedRank: null, activeSuit: null,
    reshuf: 0, stripped: false,
    phase: 'SETUP',
    round: 0,
    startLives: startingCards,
    burnCount: 0, lastPlayedRank: null,
    dealerPlaying8: false, dealerFinalCard: null,
    drewQueenEmpty: false, roundWinnerPid: null,
    lastHcd: null,
    lastDirDraw: null,
    log: []
  };

  // High card draw for initial dealer
  const hcd = highCardDraw(state.players);
  state.dealerPid = hcd.dealer.id;
  state.lastHcd = { cards: hcd.cards, dealerPid: hcd.dealer.id, dealerName: hcd.dealer.name, playerIds: state.players.map(p => p.id) };
  const hcdMsg = playerNames.map((_, i) => {
    const p = state.players[i];
    const cd = hcd.cards[p.id];
    return `${p.name} drew ${cardStr(cd)}`;
  }).join(', ') + `. ${hcd.dealer.name} has the lowest card and deals first.`;
  state.log.push('High card draw for dealer: ' + hcdMsg);

  return state;
}

// ── Round setup ───────────────────────────────────────────────

// Same as startRound, but the initial flipped card is forced to a specific rank/suit
// instead of whatever startRound() would've randomly drawn. Exists for the debug panel:
// previously the debug tool duplicated a simplified, incomplete version of this reset
// (skipping applyInit entirely), so forcing an 8 never set dealerPlaying8 and forcing a
// 7/K-of-Leaves never set pendDraw — the round looked "started" but none of the
// initial-card special cases actually applied. Reusing the real logic fixes that.
function startRoundWith(state, forcedRank, forcedSuit) {
  state.round++;
  state.phase = 'PLAYING';
  state.dir = 1;
  state.pendDraw = 0; state.drawSrc = null; state.pendSkip = false;
  state.forcedRank = null; state.activeSuit = null;
  state.reshuf = 0; state.stripped = false;
  state.burnCount = 0; state.lastPlayedRank = null;
  state.dealerPlaying8 = false; state.dealerFinalCard = null;
  state.drewQueenEmpty = false; state.roundWinnerPid = null;
  state.roundResult = null;

  const log = msg => state.log.push(msg);
  const a = alive(state);

  state.draw = shuffle(buildDeck());
  state.play = [];
  a.forEach(p => {
    p.hand = [];
    for (let i = 0; i < p.lives; i++) p.hand.push(state.draw.pop());
  });

  const forcedId = forcedRank + '_' + forcedSuit;
  state.draw = state.draw.filter(c => c.id !== forcedId);
  state.play = [{ r: forcedRank, s: forcedSuit, id: forcedId }];
  state.cur = 0;

  const initResult = applyInit(state, log);
  return { success: true, initialPeek: initResult.peekCard };
}

function startRound(state) {
  state.round++;
  state.phase = 'PLAYING';
  state.dir = 1;
  state.pendDraw = 0; state.drawSrc = null; state.pendSkip = false;
  state.forcedRank = null; state.activeSuit = null;
  state.reshuf = 0; state.stripped = false;
  state.burnCount = 0; state.lastPlayedRank = null;
  state.dealerPlaying8 = false; state.dealerFinalCard = null;
  state.drewQueenEmpty = false; state.roundWinnerPid = null;
  state.roundResult = null;

  const log = msg => state.log.push(msg);
  const a = alive(state);

  state.draw = shuffle(buildDeck());
  state.play = [];
  a.forEach(p => {
    p.hand = [];
    for (let i = 0; i < p.lives; i++) p.hand.push(state.draw.pop());
  });
  state.play = [state.draw.pop()];
  state.cur = 0;

  const initResult = applyInit(state, log);
  return { success: true, initialPeek: initResult.peekCard };
}

function applyInit(state, log) {
  const c = getTop(state);
  state.burnCount = 1;
  state.lastPlayedRank = c.r;
  const dlr = state.players.find(p => p.id === state.dealerPid) || alive(state)[0];
  log(`Round ${state.round} — Initial card: ${cardStr(c)}. ${dlr.name} is dealer — choose direction.`);

  let peekCard = null;
  if (c.r === '7' && !state.stripped)  { state.pendDraw = 2; state.drawSrc = '7'; log('Initial 7 — first player in chosen direction must draw 2.'); }
  if (c.r === 'A')                      { state.pendSkip = true; log('Initial Ace — first player in chosen direction is skipped.'); }
  if (c.r === 'K' && c.s === 'Leaves' && !state.stripped) { state.pendDraw = 5; state.drawSrc = 'K'; log('Initial K of Leaves — first player in chosen direction must draw 5.'); }
  if (c.r === 'J') { const b = state.draw[0]; state.forcedRank = b.r; log(`Initial J — bottom card is ${cardStr(b)}. Forced rank: ${b.r}.`); peekCard = b; }
  if (c.r === 'Q') { const b = state.draw[0]; state.activeSuit = b.s; log(`Initial Q — bottom card is ${cardStr(b)}. Active suit: ${b.s}.`); peekCard = b; }

  const isGhost = dlr.out;
  const skip2 = alive(state).length <= 2 && !isGhost;

  if (c.r === '8') {
    if (isGhost) {
      state.phase = 'DIR_CHOICE';
      log(`${dlr.name} is eliminated (ghost dealer) — cannot play the 8, just choose direction.`);
    } else if (skip2) {
      setCur(state, dlr.id);
      state.dealerPlaying8 = true;
      log(`${dlr.name} plays first (initial 8). No direction choice with 2 players.`);
    } else {
      setCur(state, dlr.id);
      state.dealerPlaying8 = true;
      log(`${dlr.name} plays first (initial 8) and will choose direction after playing.`);
    }
  } else if (skip2) {
    // 2 players — set first player directly
    const nonDealer = alive(state).find(p => p.id !== state.dealerPid) || alive(state)[0];
    state.dir = 1;
    setCur(state, nonDealer.id);
    if (c.r === '10' && c.s === 'Hearts') {
      nonDealer.hand = nonDealer.hand.concat(drawN(state, 1, log));
      const d = alive(state).find(p => p.id === state.dealerPid) || alive(state)[0];
      setCur(state, d.id);
      log(`Initial 10 of Hearts — ${nonDealer.name} draws 1. ${d.name} plays first.`);
    } else {
      log(`2 players — ${nonDealer.name} goes first.`);
    }
  } else {
    state.phase = 'DIR_CHOICE';
  }

  return { peekCard };
}

// ── Public actions ────────────────────────────────────────────

function actionChooseDirection(state, dir) {
  const log = msg => state.log.push(msg);
  if (!needsDirChoice(state)) {
    // 2-player auto
    state.phase = 'DIR_CHOICE';
  }
  return chooseDirection(state, dir, log);
}

function actionPlayCard(state, playerId, cardId, announcement) {
  // announcement: { type: 'rank'|'suit', value: string } for J and Q
  const log = msg => state.log.push(msg);
  const pIdx = state.players.findIndex(p => p.id === playerId);
  if (pIdx !== state.cur) return { success: false, error: 'Not your turn.' };
  if (state.phase !== 'PLAYING') return { success: false, error: 'Game not in playing phase.' };
  const player = state.players[pIdx];
  const card = player.hand.find(c => c.id === cardId);
  if (!card) return { success: false, error: 'Card not in hand.' };
  if (!canPlay(state, card)) return { success: false, error: 'Card cannot be played.' };

  // If this card would complete a burn (4 of the same rank in a row), the round ends
  // immediately regardless of any forced-rank/suit announcement — so J and Q must skip
  // the announcement requirement here. Previously they always demanded one first, which
  // silently blocked the burning 4th Jack/Queen from ever actually completing: the client
  // would show an announcement prompt for a play that was about to end the round anyway,
  // with no sensible value to send back for it.
  const wouldBurn = card.r === state.lastPlayedRank && (state.burnCount + 1) >= 4;

  // J needs announcement
  if (card.r === 'J' && !announcement && !wouldBurn) {
    // During dealer 8 sequence
    if (state.dealerPlaying8) { state.dealerFinalCard = { r: card.r, s: card.s, id: card.id }; state.dealerPlaying8 = false; }
    return { success: true, needsAnnouncement: { type: 'rank' } };
  }
  // Q needs announcement (unless last card)
  const isLastCard = player.hand.length === 1;
  if (card.r === 'Q' && !isLastCard && !wouldBurn && !announcement) {
    if (state.forcedRank === 'Q') state.forcedRank = null;
    if (state.dealerPlaying8) { state.dealerFinalCard = { r: card.r, s: card.s, id: card.id }; state.dealerPlaying8 = false; }
    return { success: true, needsAnnouncement: { type: 'suit' } };
  }

  // Apply announcement
  if (announcement) {
    if (announcement.type === 'rank') { state.forcedRank = announcement.value; log(`Forced rank: ${announcement.value}.`); }
    if (announcement.type === 'suit') { state.activeSuit = announcement.value; log(`Active suit: ${announcement.value}.`); }
  }

  // Remove card from hand, place on play pile
  player.hand = player.hand.filter(c => c.id !== cardId);
  state.play.push(card);
  updateBurnCount(state, card);

  // Remove ghost card if underneath
  if (state.play.length >= 2 && state.play[state.play.length - 2].ghost) {
    state.play.splice(state.play.length - 2, 1);
  }

  log(`${player.name} played ${cardStr(card)}.`);

  // Q as last card ends round
  if (card.r === 'Q' && player.hand.length === 0) {
    log(`${player.name} ends the round with a Queen!`);
    state.dealerPlaying8 = false;
    state.roundWinnerPid = player.id;
    return endRound(state, log);
  }

  // Apply effect BEFORE burn check
  let sideEffectDraws = null;
  if (!state.dealerPlaying8) {
    const handSizesBefore = {};
    state.players.forEach(p => { handSizesBefore[p.id] = p.hand.length; });
    applyEffect(state, card, player, log);
    // Currently only 10 of Hearts draws cards for other players as an immediate side
    // effect (7/K-of-Leaves only accumulate pendDraw, resolved later on someone's own
    // draw action) — but detecting this generically by hand-size diff, rather than
    // hardcoding the rank check here too, keeps this correct if that ever changes.
    state.players.forEach(p => {
      if (p.id !== player.id) {
        const diff = p.hand.length - (handSizesBefore[p.id] || 0);
        if (diff > 0) { if (!sideEffectDraws) sideEffectDraws = {}; sideEffectDraws[p.id] = diff; }
      }
    });
  }

  // Burn check
  if (checkBurn(state)) {
    log(`BURN! Four ${card.r}s — round ends!`);
    state.dealerPlaying8 = false;
    let preEndDraws = null;
    if (state.pendDraw > 0) {
      const a = alive(state);
      const ci = a.findIndex(x => x.id === player.id);
      const nextP = a[(ci + state.dir + a.length * 100) % a.length];
      const forced = drawN(state, state.pendDraw, log);
      nextP.hand = nextP.hand.concat(forced);
      log(`${nextP.name} draws ${forced.length} card(s) from pending effect before round ends.`);
      state.pendDraw = 0; state.drawSrc = null;
      if (forced.length) preEndDraws = { [nextP.id]: forced.length };
    }
    const result = endRound(state, log);
    // Merge in both this forced draw and any earlier-computed sideEffectDraws (e.g. a
    // burning 10 of Hearts) — previously neither reached the client here, so whichever
    // player drew from the pending 7/K effect saw their hand update with no animation
    // at all, and the screen just cut straight to the burn flame + scoreboard.
    const mergedSideEffects = Object.assign({}, sideEffectDraws || {}, preEndDraws || {});
    if (Object.keys(mergedSideEffects).length) result.sideEffectDraws = mergedSideEffects;
    return result;
  }

  // Dealer 8 sequence
  if (state.dealerPlaying8) {
    if (card.r === '8') {
      log('Dealer plays another 8 — plays again.');
      return { success: true, ...(sideEffectDraws ? { sideEffectDraws } : {}) };
    }
    // Final (non-8) card of the dealer's 8-sequence — this ends the chain, so the
    // card's own effect needs to actually apply here. It was previously skipped
    // entirely (the "apply effect" step above only runs when NOT mid dealer-8-chain),
    // so anything other than J/Q (handled via their announcement, above) had no
    // effect at all — e.g. a King of Leaves ending the chain never set pendDraw, so
    // the next player could play anything. Ace had a manual patch for this; the same
    // gap existed for 7, K of Leaves, and 10 of Hearts.
    state.dealerPlaying8 = false;
    if (!state.dealerFinalCard) state.dealerFinalCard = { r: card.r, s: card.s, id: card.id };

    // 10 of Hearts is deferred entirely rather than applied here like the others: its
    // effect needs to know direction (who counts as "others", and in what order), which
    // isn't settled yet for 3+ players. Applying it eagerly here previously (a) drew
    // cards using a stale/leftover direction, and (b) granted an immediate replay that
    // returned early — skipping the DIR_CHOICE requirement for 3+ players outright, since
    // chooseDirection() (which already has correct deferred-resolution logic for exactly
    // this case) never got a chance to run at all. A/7/K/9 don't have this problem — they
    // just set flags that are correct regardless of when they're set — so they keep
    // applying immediately below.
    let playAgain = false;
    if (!(card.r === '10' && card.s === 'Hearts')) {
      const handSizesBefore2 = {};
      state.players.forEach(p => { handSizesBefore2[p.id] = p.hand.length; });
      playAgain = applyEffect(state, card, player, log);
      state.players.forEach(p => {
        if (p.id !== player.id) {
          const diff = p.hand.length - (handSizesBefore2[p.id] || 0);
          if (diff > 0) { if (!sideEffectDraws) sideEffectDraws = {}; sideEffectDraws[p.id] = (sideEffectDraws[p.id] || 0) + diff; }
        }
      });
    }

    if (playAgain) {
      log(`${player.name} plays again.`);
      return { success: true, ...(sideEffectDraws ? { sideEffectDraws } : {}) };
    }

    if (needsDirChoice(state)) {
      state.phase = 'DIR_CHOICE';
      log(`Dealer played their final card (${cardStr(card)}) — now choose direction.`);
    } else if (card.r === '10' && card.s === 'Hearts') {
      // 2-player: direction is a non-choice (always effectively clockwise), so resolve
      // immediately via chooseDirection() itself — the single source of truth for how a
      // deferred dealerFinalCard resolves, rather than a second, less complete inline
      // copy of the same logic (the one just below, for A/7/K/J/Q) that never actually
      // handled 10 of Hearts at all. chooseDirection() requires phase===DIR_CHOICE as a
      // precondition, so set that first — mirrors what actionChooseDirection's own
      // "2-player auto" branch already does.
      state.phase = 'DIR_CHOICE';
      const dirResult = chooseDirection(state, 1, log);
      if (dirResult.sideEffectDraws) sideEffectDraws = Object.assign({}, sideEffectDraws, dirResult.sideEffectDraws);
    } else {
      // 2-player: advance to other player directly
      const otherP = alive(state).find(x => x.id !== player.id) || alive(state)[0];
      state.dealerFinalCard = null;
      setCur(state, otherP.id);
      let dm = '';
      if (card.r === 'J') dm = ` Forced rank: ${state.forcedRank}.`;
      if (card.r === 'Q') dm = ` Active suit: ${state.activeSuit}.`;
      if (card.r === 'A') dm = ` ${otherP.name} is skipped.`;
      if (card.r === '7') dm = ` ${otherP.name} must draw ${state.pendDraw}.`;
      if (card.r === 'K' && card.s === 'Leaves') dm = ` ${otherP.name} must draw 5.`;
      log(`2 players — ${otherP.name} goes first.${dm}`);
    }
    return { success: true, ...(sideEffectDraws ? { sideEffectDraws } : {}) };
  }

  // Play again check
  const playAgain = (card.r === '10' && card.s === 'Hearts') || (card.r === '8' && alive(state).length === 2);
  if (!playAgain) setCur(state, nxt(state, player.id));
  return { success: true, ...(sideEffectDraws ? { sideEffectDraws } : {}) };
}

function actionDrawCard(state, playerId) {
  const log = msg => state.log.push(msg);
  const pIdx = state.players.findIndex(p => p.id === playerId);
  if (pIdx !== state.cur) return { success: false, error: 'Not your turn.' };
  if (state.phase !== 'PLAYING') return { success: false, error: 'Game not in playing phase.' };
  const player = state.players[pIdx];

  if (state.pendSkip) return { success: false, error: 'Targeted by Ace — play an Ace or accept the skip.' };
  if (state.forcedRank && !state.pendDraw && player.hand.some(x => x.r === state.forcedRank)) {
    return { success: false, error: `You have a ${state.forcedRank} — you must play it.` };
  }

  if (state.pendDraw > 0) {
    const drawn = drawN(state, state.pendDraw, log);
    player.hand = player.hand.concat(drawn);
    log(`${player.name} drew ${drawn.length} card(s) (forced).`);
    state.pendDraw = 0; state.drawSrc = null;
    setCur(state, nxt(state, player.id));
    return { success: true, drew: drawn };
  }

  if (!state.draw.length && state.play.length <= 1) {
    log('No cards available — turn skipped.');
    setCur(state, nxt(state, player.id));
    return { success: true, drew: [] };
  }

  const drawn = drawN(state, 1, log);
  if (!drawn.length) {
    log('No cards available — turn skipped.');
    setCur(state, nxt(state, player.id));
    return { success: true, drew: [] };
  }

  player.hand = player.hand.concat(drawn);
  const dc = drawn[0];
  log(`${player.name} drew ${cardStr(dc)}.`);

  if (player.hand.length === 1 && dc.r === 'Q' && (!state.forcedRank || state.forcedRank === 'Q')) {
    state.drewQueenEmpty = true;
    log('Drew a Queen with empty hand — must play it!');
    return { success: true, drew: drawn, drewQueenFromEmpty: true };
  }

  if (state.dealerPlaying8) {
    state.dealerPlaying8 = false;
    state.dealerFinalCard = null;
    if (needsDirChoice(state)) {
      state.phase = 'DIR_CHOICE';
    } else {
      state.phase = 'DIR_CHOICE';
      chooseDirection(state, 1, log);
    }
    log('Dealer drew a card — now choose direction.');
    return { success: true, drew: drawn };
  }

  setCur(state, nxt(state, player.id));
  return { success: true, drew: drawn };
}

function actionAcceptSkip(state, playerId) {
  const log = msg => state.log.push(msg);
  const pIdx = state.players.findIndex(p => p.id === playerId);
  if (pIdx !== state.cur) return { success: false, error: 'Not your turn.' };
  if (!state.pendSkip) return { success: false, error: 'No skip to accept.' };
  const player = state.players[pIdx];
  state.pendSkip = false;
  log(`${player.name} accepts the skip.`);
  setCur(state, nxt(state, player.id));
  return { success: true };
}

// ── Round end ─────────────────────────────────────────────────

// Apply pending "leave after round" requests. leavingPids is an array of player ids
// who opted to leave once the current round finished. The dealer-to-be among them
// becomes a ghost leaver (deals one final round automatically, with a random direction
// pick if direction choice is needed, since they're no longer present to choose).
function applyLeavingPlayers(state, leavingPids, log) {
  leavingPids.forEach(pid => {
    const p = state.players.find(x => x.id === pid);
    if (p && !p.out) {
      if (pid === state.dealerPid) {
        p.out = true;
        p.ghostLeaver = true;
        log(`${p.name} is leaving — will deal one final ghost round first.`);
      } else {
        p.out = true;
        log(`${p.name} has left the game.`);
      }
    }
  });
}

function endRound(state, log) {
  state.phase = 'ROUND_END';
  const a = alive(state);
  if (a.length === 0) {
    state.phase = 'GAME_OVER';
    state.winner = null;
    state.abandoned = true;
    log('Game abandoned — no players remaining.');
    return { success: true, roundOver: true, gameOver: true, scores: [], losers: [], winner: null, abandoned: true };
  }
  const scores = a.map(p => {
    let pts = p.hand.reduce((s, c) => s + cardPoints(c), 0);
    if (pts >= 100) pts -= 100;
    return { p, pts, cards: p.hand.length, hand: [...p.hand] };
  });
  // Snapshot round result into state so getPublicState can expose it to all clients
  // (we capture hands here, before losers lose lives and hands change)
  state.roundResult = {
    scores: scores.map(s => ({ pid: s.p.id, pts: s.pts, hand: [...s.hand] })),
    roundWinnerPid: state.roundWinnerPid || null,
  };

  let maxP = Math.max(...scores.map(s => s.pts));
  let losers = scores.filter(s => s.pts === maxP);
  if (losers.length > 1) {
    const maxC = Math.max(...losers.map(s => s.cards));
    losers = losers.filter(s => s.cards === maxC);
  }

  // Round winner is always protected
  if (state.roundWinnerPid) {
    const filtered = losers.filter(s => s.p.id !== state.roundWinnerPid);
    if (filtered.length > 0) losers = filtered;
  }

  // Now that the card-count tiebreaker (and round-winner protection) have narrowed
  // losers down to who's actually about to lose a life, expose that final list to
  // clients. state.roundResult was snapshotted above, before this filtering — without
  // this, the client had no way to know the tiebreaker was even applied and would
  // independently (and incorrectly) re-derive "losers" from points alone.
  state.roundResult.losers = losers.map(l => l.p.id);

  // 1v1 true tie that would eliminate both remaining players simultaneously — replay the round instead of ending in a draw
  if (a.length === 2 && losers.length === 2) {
    const bothWouldBeEliminated = losers.every(ls => (ls.p.losses + 1) > state.startLives);
    if (bothWouldBeEliminated) {
      log(`Round ${state.round} tied — both players would be eliminated. Round replayed.`);
      return { success: true, roundOver: true, tieReplay: true, scores };
    }
  }

  losers.forEach(ls => {
    ls.p.losses++;
    ls.p.lives = Math.max(0, state.startLives - ls.p.losses);
    if (ls.p.losses > state.startLives) ls.p.out = true;
  });

  const ln = losers.map(s => s.p.name).join(' & ');
  log(`Round ${state.round} over. Loser(s): ${ln}.`);

  // Determine next dealer
  state.lastHcd = null;
  state.lastDirDraw = null;
  if (losers.length === 1) {
    // Single loser deals next round (automatically a ghost dealer if eliminated)
    state.dealerPid = losers[0].p.id;
    if (losers[0].p.out) {
      log(`${losers[0].p.name} is eliminated and ghost deals next round.`);
    }
  } else {
    const eliminatedLosers = losers.filter(l => l.p.out);
    if (eliminatedLosers.length === 0) {
      // Nobody eliminated — high card draw among tied losers, lowest card deals normally
      const hcd = highCardDraw(losers.map(l => l.p));
      state.dealerPid = hcd.dealer.id;
      const hcdMsg = losers.map(l => { const cd = hcd.cards[l.p.id]; return `${l.p.name} drew ${cardStr(cd)}`; }).join(', ') + `. ${hcd.dealer.name} deals next round.`;
      log('Tied losers high card draw: ' + hcdMsg);
      state.lastHcd = { cards: hcd.cards, dealerPid: hcd.dealer.id, dealerName: hcd.dealer.name, playerIds: losers.map(l => l.p.id) };
    } else if (eliminatedLosers.length === 1) {
      // Exactly one eliminated — they ghost deal directly, no draw needed
      state.dealerPid = eliminatedLosers[0].p.id;
      log(`${eliminatedLosers[0].p.name} is eliminated and ghost deals next round.`);
    } else {
      // Two or more eliminated — high card draw among the eliminated for who ghost deals
      const hcd = highCardDraw(eliminatedLosers.map(l => l.p));
      state.dealerPid = hcd.dealer.id;
      const hcdMsg = eliminatedLosers.map(l => { const cd = hcd.cards[l.p.id]; return `${l.p.name} drew ${cardStr(cd)}`; }).join(', ') + `. ${hcd.dealer.name} ghost deals next round.`;
      log('Tied eliminated losers high card draw: ' + hcdMsg);
      state.lastHcd = { cards: hcd.cards, dealerPid: hcd.dealer.id, dealerName: hcd.dealer.name, playerIds: eliminatedLosers.map(l => l.p.id) };
    }
  }

  // Check game over
  const remaining = state.players.filter(p => !p.out);
  if (remaining.length <= 1) {
    state.phase = 'GAME_OVER';
    const winner = remaining.length === 1 ? remaining[0] : null;
    state.winner = winner ? winner.id : null;
    state.abandoned = remaining.length === 0;
    log(winner ? `${winner.name} wins the game!` : 'Game abandoned — no players remaining.');
    return { success: true, roundOver: true, gameOver: true, scores, losers: losers.map(l => l.p.id), winner: state.winner, abandoned: state.abandoned, lastHcd: state.lastHcd, roundWinnerPid: state.roundWinnerPid || null };
  }

  return { success: true, roundOver: true, scores, losers: losers.map(l => l.p.id), lastHcd: state.lastHcd, roundWinnerPid: state.roundWinnerPid || null };
}

// ── Public view ───────────────────────────────────────────────

function getPublicState(state, forPlayerId) {
  return {
    phase: state.phase,
    round: state.round,
    direction: state.dir,
    topCard: getTop(state),
    drawDeckCount: state.draw.length,
    pendDraw: state.pendDraw,
    drawSrc: state.drawSrc,
    pendSkip: state.pendSkip,
    forcedRank: state.forcedRank,
    activeSuit: state.activeSuit,
    stripped: state.stripped,
    burnCount: state.burnCount,
    dealerPid: state.dealerPid,
    currentPlayerIndex: state.cur,
    winner: state.winner || null,
    abandoned: state.abandoned || false,
    startLives: state.startLives,
    roundWinnerPid: state.roundWinnerPid || null,
    lastHcd: state.lastHcd || null,
    lastDirDraw: state.lastDirDraw || null,
    roundResult: state.roundResult || null,
    players: state.players.map(p => ({
      id: p.id,
      name: p.name,
      lives: p.lives,
      losses: p.losses,
      out: p.out,
      cardCount: p.hand.length,
      hand: (state.phase === 'ROUND_END' || p.id === forPlayerId) ? p.hand : null,
      oneCardIndicator: p.hand.length === 1 ? (p.hand[0].r === 'Q' ? 'queen' : 'other') : null,
      drewQueenFromEmpty: p.id === forPlayerId ? state.drewQueenEmpty : false,
    })),
    log: state.log.slice(-20),
    logTotal: state.log.length,
  };
}

// ── Exports ───────────────────────────────────────────────────

// Called when a disconnected player's reconnect grace period expires — removes them
// from the round immediately rather than leaving the game stalled waiting on someone
// who isn't coming back. Reuses the same `out` flag as normal elimination/voluntary
// leaving, so ghost-dealer and turn-order logic (which already know to skip `out`
// players) handle them correctly with no further special-casing needed.
function forceRemovePlayer(state, pid, log) {
  const player = state.players.find(p => p.id === pid);
  if (!player || player.out) return { success: true, removed: false };
  const wasPlaying = state.phase === 'PLAYING';

  // Snapshot everyone's current hand (including the disconnecting player's) BEFORE any
  // mutation, so a forced round-end below reflects the moment of disconnect.
  const beforeRemoval = alive(state);

  // A disconnect-timeout elimination is a full loss — same bookkeeping as losing all
  // lives in a normal round — not a soft "removed" state that leaves lives untouched
  // (which previously left the scoreboard/win logic in an inconsistent half-state).
  player.losses = state.startLives + 1;
  player.lives = 0;
  player.out = true;
  log(`${player.name} disconnected and did not reconnect in time — eliminated from the game.`);

  const remaining = state.players.filter(p => !p.out);

  if (wasPlaying) {
    // Their disconnect broke the round in progress — possibly mid-turn, with no way for
    // anyone else to act. Rather than silently continuing without them (which can leave
    // the round waiting on a turn that will never come), end the round right now and show
    // everyone a round-end screen recording the elimination.
    state.phase = 'ROUND_END';
    const scores = beforeRemoval.map(p => {
      let pts = p.hand.reduce((s, c) => s + cardPoints(c), 0);
      if (pts >= 100) pts -= 100;
      return { pid: p.id, pts, cards: p.hand.length, hand: [...p.hand] };
    });
    state.roundResult = {
      scores,
      roundWinnerPid: state.roundWinnerPid || null,
      losers: [pid],
      disconnectedPid: pid,
    };

    if (remaining.length > 0) {
      // Eliminated-by-disconnect ghost-deals the next round, same as any other
      // elimination.
      state.dealerPid = pid;
      log(`${player.name} is eliminated and ghost deals next round.`);
    }

    if (remaining.length <= 1) {
      state.phase = 'GAME_OVER';
      const winner = remaining[0] || null;
      state.winner = winner ? winner.id : null;
      state.abandoned = remaining.length === 0;
      log(winner ? `${winner.name} wins the game!` : 'Game abandoned — no players remaining.');
      return { success: true, removed: true, roundOver: true, gameOver: true, scores, losers: [pid], winner: state.winner, abandoned: state.abandoned, roundWinnerPid: state.roundWinnerPid || null };
    }
    return { success: true, removed: true, roundOver: true, scores, losers: [pid], roundWinnerPid: state.roundWinnerPid || null };
  }

  // Disconnect happened outside active play (e.g. during a ROUND_END/DIR_CHOICE wait) —
  // no need to force a new round-end transition; existing ack-gating (checkNextRoundReady,
  // checkHcdAcks) already excludes disconnected players and will carry the room forward.
  if (remaining.length <= 1) {
    state.phase = 'GAME_OVER';
    const winner = remaining[0] || null;
    state.winner = winner ? winner.id : null;
    state.abandoned = remaining.length === 0;
    log(winner ? `${winner.name} wins the game!` : 'Game abandoned — no players remaining.');
    return { success: true, removed: true, gameOver: true, winner: state.winner, abandoned: state.abandoned };
  }
  return { success: true, removed: true };
}

module.exports = {
  SUITS, RANKS,
  buildDeck, shuffle, cardPoints, cardStr,
  createGame, startRound, startRoundWith,
  actionChooseDirection,
  actionPlayCard,
  actionDrawCard,
  actionAcceptSkip,
  canPlay, playerHasPlayableCard, playerMustPlay,
  getPublicState,
  highCardDraw,
  drawDirectionCard,
  applyLeavingPlayers, endRound, forceRemovePlayer,
  alive, getTop, curP,
};
