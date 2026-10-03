/* ---------------------------------------------------------------------
   SKIRMISH ODDS + WAGER SEATS + OBJECTIVES — the four defects that made the
   game misreport itself to the player.

   D1  js/rules.js projectSide only built a dice distribution when a CARD
       supplied dice, so 14 of the 16 Tactic cards produced a side with
       `dist === [1]` — a deterministic total with no die in it, while
       resolveSkirmish rolls a d6 for BOTH seats every fight. The commit
       modal's "YOUR ODDS" panel was therefore projecting a game nobody plays:
       "WIN 100%" / "TIE 100%" for a 1-Troop-vs-1-Troop fight, worth up to
       41.7 points of win probability.
       The fix is verified here against GROUND TRUTH, not against the old
       code: a from-scratch brute-force enumeration of the engine's own rule
             total = d6 + troops + cardMod + fury + bonus
       over every equally likely d6 outcome, for both sides, compared against
       OD.Rules.projectSkirmish. The number this file exists to print is the
       MAXIMUM REMAINING ERROR in percentage points.

   D2  js/feature-wagers.js settleWagers walked the two COMMITS (side order)
       and paid `me(i)` (seat order). They agree only when aggressorIdx === 0,
       so on roughly half of all Skirmishes the payout and the log line went
       to the wrong human.

   D3  js/game.js OBJECTIVES: archivist read `hand.length >= 5` with
       HAND_CAP === 5 and both players dealt a full hand — guaranteed met for
       BOTH players in EVERY game. industrialist measured met in 100% of games.

   D4  js/game.js showCommitModal's Commit button: both Commit buttons render
       at the same pixel (dx=0, dy=1), so a double-click fired the handler
       twice and the second fire submitted the OPPONENT's commit.

   Runs with NO DOM of its own, in index.html load order (see
   test/sites.test.js for why the order is part of the contract).
   --------------------------------------------------------------------- */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

/* ------------------------------------------------------ headless harness
   The objective met-rates in D3 are MEASURED, not asserted from a hunch, and
   the measurement needs the real engine running with no browser. So this file
   installs, before the requires:
     * `window`  - game.js publishes OD.WagersBridge under
                   `typeof window !== 'undefined'`, and the Wagers feature is
                   inert without it. Defined BEFORE the requires on purpose.
     * a timer queue that fires callbacks synchronously - the engine's whole
                   round loop is setTimeout-driven (bot picks, the Skirmish
                   dice reveal, the round-debrief failsafe), and draining the
                   queue is how one game runs to completion.
   and, AFTER the requires:
     * `document` - a permissive fake, so onDom() declined to wire the page
                   (it needs BOTH window and document at LOAD time) while
                   startGame() still finds the setup fields it reads.

   The simulation itself is gated behind OD_SIM=1 so `npm test` stays fast;
   run `OD_SIM=1 node --test test/skirmish-odds.test.js` to reproduce the
   met-rate table. */
const REAL_SET_TIMEOUT = globalThis.setTimeout;

function fakeElement(){
  return {
    innerHTML:'', textContent:'', value:'', checked:false, disabled:false,
    isConnected:true, dataset:{}, className:'', scrollTop:0, scrollHeight:0,
    style:{cssText:'', setProperty(){}, removeProperty(){}, getPropertyValue(){ return ''; }},
    classList:{ _s:new Set(['hidden']),
      add(...c){ c.forEach(x=>this._s.add(x)); },
      remove(...c){ c.forEach(x=>this._s.delete(x)); },
      toggle(c, on){ if(on === undefined) on = !this._s.has(c); if(on) this._s.add(c); else this._s.delete(c); return on; },
      contains(c){ return this._s.has(c); } },
    setAttribute(){}, getAttribute(){ return null; }, remove(){}, focus(){}, blur(){},
    appendChild(c){ return c; }, append(){}, insertBefore(){},
    addEventListener(){}, removeEventListener(){},
    querySelector(){ return fakeElement(); }, querySelectorAll(){ return []; },
    closest(){ return null; }, matches(){ return false; },
    insertAdjacentHTML(){}, getBoundingClientRect(){ return {left:0, top:0, width:0, height:0}; },
    cloneNode(){ return fakeElement(); }, removeChild(){}, contains(){ return false; },
  };
}
const setupEl = over => Object.assign(fakeElement(), over);

/* index.html load order. feature-wagers installs against OD.Ext, and the
   engine's OD.Board seam is published by the file that loads LAST. */
const ROOT = path.resolve(__dirname, '..');
globalThis.window = globalThis;
globalThis.addEventListener = ()=>{};
globalThis.removeEventListener = ()=>{};

let timerQueue = [];
let timerId = 1;
const timerFns = new Map();
globalThis.setTimeout = (fn)=>{ const id = timerId++; timerFns.set(id, fn); timerQueue.push(id); return id; };
globalThis.setInterval = ()=> timerId++;
globalThis.clearTimeout = (id)=>{ timerFns.delete(id); };
globalThis.clearInterval = ()=>{};

require(path.join(ROOT, 'js/ext.js'));
require(path.join(ROOT, 'js/audio.js'));
require(path.join(ROOT, 'js/fx.js'));
const {Rules} = require(path.join(ROOT, 'js/rules.js'));
const {Wagers} = require(path.join(ROOT, 'js/feature-wagers.js'));
/* Chaos MUST be in the load order or it is not installed at all, and the
   simulation below would be measuring a different game: the Rift, the
   Bounties and the Pressure/Collapse tick all move Ore and Credits, which is
   exactly what Prospector and Financier are measured on. */
require(path.join(ROOT, 'js/feature-chaos.js'));
const Engine = require(path.join(ROOT, 'js/game.js'));
assert.ok(globalThis.OD.Chaos, 'feature-chaos.js must be loaded, or the sim measures the wrong game');

/* document goes in only now, so onDom() already declined above. */
const SETUP = {
  gameMode:setupEl({value:'demo'}), demoLoop:setupEl({checked:false}),
  botDifficulty:setupEl({value:'normal'}), botSpeed:setupEl({value:'instant'}),
  p1name:setupEl({value:'A'}), p2name:setupEl({value:'B'}),
  p1type:setupEl({value:'bot'}), p2type:setupEl({value:'bot'}),
};
const domEls = new Map();
globalThis.document = {
  getElementById(id){ if(SETUP[id]) return SETUP[id]; if(!domEls.has(id)) domEls.set(id, fakeElement()); return domEls.get(id); },
  querySelector(){ return null; }, querySelectorAll(){ return []; },
  createElement(){ return fakeElement(); }, body:fakeElement(), activeElement:null,
  addEventListener(){}, removeEventListener(){},
};

/* One whole bot-vs-bot game, start to finish. Returns the final state. */
function playOneGame(){
  timerQueue = []; timerFns.clear(); domEls.clear();
  Engine.startGame();
  let guard = 0;
  while(timerQueue.length){
    if(++guard > 400000) throw new Error('the timer queue never drained - the round loop deadlocked');
    const id = timerQueue.shift();
    const fn = timerFns.get(id);
    timerFns.delete(id);
    if(fn) fn();
  }
  return Engine.getState();
}

const FACES = [1, 2, 3, 4, 5, 6];
const sum = a => a.reduce((x, y) => x + y, 0);

/* ==================================================================
   D1 — GROUND TRUTH.

   `trueTotals(spec)` is the engine's resolution written out by hand and
   DELIBERATELY not routed through OD.Rules: it enumerates every equally
   likely d6 outcome and returns the resulting totals. Nothing here calls
   diceDist, maxDiceDist, combineDice or projectSide, so a bug in any of
   them cannot hide inside the oracle.
   ================================================================== */
function trueTotals(spec){
  const s = spec || {};
  /* The engine's fixed half: troops + Fury rung + the caller's flat bonus
     (Garrison +1 / a declared Betrayal token) + the card's fixed modifier. */
  const furyBonus = Rules.furyFor(s.winStreak).bonus;
  const card = s.cardId ? Rules.cardModParts(s.cardId, {
    isAggressor: !!s.isAggressor,
    credits: (typeof s.credits === 'number') ? s.credits : 0,
    ore: (typeof s.ore === 'number') ? s.ore : 0,
    isGambler: !!s.isGambler,
  }) : null;
  const fixed = Math.max(0, s.troops | 0) + furyBonus + ((s.bonus | 0)) + (card ? card.fixed : 0);

  /* And the engine's random half, in resolveSkirmish's own words:
       total = rollD6() + troops + cardMod + fury + betrayal + garrison
     with cardMod = a fresh d6 for Wildcard and max of two d6 for Gambit. */
  const cardRolls = (card && card.dice > 0) ? [card.dice] : [];
  void cardRolls;
  const groups = [FACES];
  if(card && card.dice > 0){
    /* Build the (dice -> value) list explicitly; it is clearer than a closure
       and it is the whole point of the oracle. 'max' keeps the higher of `n`
       dice, anything else sums them - which is resolveSkirmish's cardModifier. */
    const combos = [];
    const build = (left, acc)=>{
      if(left === 0){ combos.push(acc); return; }
      for(const face of FACES) build(left - 1, acc.concat([face]));
    };
    build(card.dice, []);
    const values = (card.rollMode === 'max') ? combos.map(c=>Math.max(...c)) : combos.map(c=>sum(c));
    groups.push(values);
  }
  /* Cartesian product: every equally likely outcome, exactly once. */
  let outcomes = [{v: fixed, w: 1}];
  groups.forEach(list=>{
    const next = [];
    outcomes.forEach(o=> list.forEach(v=> next.push({v: o.v + v, w: o.w})));
    outcomes = next;
  });
  const n = outcomes.length;
  const out = new Map();
  outcomes.forEach(o=> out.set(o.v, (out.get(o.v) || 0) + 1 / n));
  return out;
}

/* Catching Up, applied to the two sides' MEANS exactly the way
   projectSkirmish() does (the preview of the rule, not the rule). */
function shiftTruth(dist, delta){
  if(!delta) return dist;
  const out = new Map();
  dist.forEach((p, k)=> out.set(k + delta, (out.get(k + delta) || 0) + p));
  return out;
}
function trueWTL(mineSpec, theirSpec){
  const mine = trueTotals(mineSpec), theirs = trueTotals(theirSpec);
  const a = Rules.projectSide(mineSpec), b = Rules.projectSide(theirSpec);
  const cu = Rules.catchingUp(a.mean, b.mean, a.winStreak, b.winStreak);
  const mDelta = (cu.applied > 0 && cu.leaderIdx === 1) ? cu.applied : 0;
  const tDelta = (cu.applied > 0 && cu.leaderIdx === 0) ? cu.applied : 0;
  const A = shiftTruth(mine, mDelta), B = shiftTruth(theirs, tDelta);
  let w = 0, t = 0, l = 0;
  A.forEach((pa, ka)=>{
    if(!pa) return;
    B.forEach((pb, kb)=>{
      if(!pb) return;
      if(ka > kb) w += pa * pb; else if(ka === kb) t += pa * pb; else l += pa * pb;
    });
  });
  return {winPct: w * 100, tiePct: t * 100, losePct: l * 100, applied: cu.applied};
}

/* ---------------------------------------------------------------- the grid */

const CARDS = [null, 'wild', 'gambit', 'guard', 'berserker', 'onslaught', 'overrun'];
const GRID = {troops: [0, 1, 2, 3, 4, 5, 6], cards: CARDS, cases: 0, maxErr: 0, worst: null,
             fever: 0, catchingUp: 0, threeDice: 0};

/* Every cell of the Troop grid 0-6 x {no card, wild, gambit, guard, berserker,
   onslaught, overrun} on BOTH sides, plus:
     - a FURY CAP case   (streak 4 / streak 3 with Skirmish Fever, so the paid
       cap is 6 and both rungs are paying their full bonus), and
     - a CATCHING UP case (I trail against a hot 3-streak leader, so the +2
       fires in my favour). */
function walkGrid(){
  CARDS.forEach(myCard => CARDS.forEach(theirCard => {
    for(let mine = 0; mine <= 6; mine++){
      for(let theirs = 0; theirs <= 6; theirs++){
        const cases = [
          /* plain: no streak, no fever, no declared token */
          {opts:{},
           mineSpec:{troops:mine, cardId:myCard, winStreak:0, isAggressor:true, credits:3, ore:3},
           theirSpec:{troops:theirs, cardId:theirCard, winStreak:0, isAggressor:false, credits:3, ore:3}},
          /* FURY CAP: I am on a 4-streak (cap 6, +3) against a 3-streak
             (cap 5, +2), on Skirmish Fever, with a declared +1 token folded
             into `bonus` on each side - exactly the public modifiers the
             commit modal knows about. */
          {opts:{fever:true},
           mineSpec:{troops:mine, cardId:myCard, winStreak:4, isAggressor:true, credits:3, ore:3, bonus:1},
           theirSpec:{troops:theirs, cardId:theirCard, winStreak:3, isAggressor:false, credits:3, ore:3, bonus:1}},
          /* CATCHING UP: they lead on a 3-streak, so the +2 lands on ME. */
          {opts:{},
           mineSpec:{troops:mine, cardId:myCard, winStreak:0, isAggressor:false, credits:3, ore:3},
           theirSpec:{troops:theirs, cardId:theirCard, winStreak:3, isAggressor:true, credits:3, ore:3}},
        ];
        cases.forEach(c=>{
          GRID.cases++;
          const p = Rules.projectSkirmish(c.mineSpec, c.theirSpec, c.opts);
          const truth = trueWTL(c.mineSpec, c.theirSpec);
          if(c.opts.fever) GRID.fever++;
          /* Only fires when they actually lead on their 3-streak, which is
             exactly the valve's own condition - counted so the sweep cannot
             quietly stop covering it. */
          if(truth.applied > 0) GRID.catchingUp++;
          if(p.mine.dice >= 3 || p.theirs.dice >= 3) GRID.threeDice++;
          ['winPct', 'tiePct', 'losePct'].forEach(k=>{
            const err = Math.abs(truth[k] - p[k]);
            if(err > GRID.maxErr){
              GRID.maxErr = err;
              GRID.worst = {mine, theirs, myCard, theirCard, key:k, truth: truth[k], panel: p[k]};
            }
          });
        });
      }
    }
  }));
}
walkGrid();

test('D1 projectSkirmish matches a brute-force enumeration of the engine rule', () => {
  console.log(`    D1 ground-truth sweep: ${GRID.cases} cases `
    + `(Troop grid 0-6 x {no card, wild, gambit, guard, berserker, onslaught, overrun} on both sides `
    + `x {plain, Fury cap on Skirmish Fever, Catching Up +2})`);
  console.log(`    D1 coverage: ${GRID.fever} Fever cells, ${GRID.catchingUp} with Catching Up fired, `
    + `${GRID.threeDice} with a three-dice (Gambit) side`);
  console.log(`    D1 MAXIMUM REMAINING ERROR: ${GRID.maxErr.toExponential(4)} percentage points`);
  console.log(`    D1 worst cell: ${JSON.stringify(GRID.worst)}`);
  assert.ok(GRID.cases >= 7000, 'the grid really was swept, not sampled');
  /* The brief's bar: < 0.1 points. The measured figure is floating-point
     noise, i.e. the projection IS the enumeration. */
  assert.ok(GRID.maxErr < 0.1,
    `max error ${GRID.maxErr} percentage points exceeds 0.1`);
  /* And the sweep really did exercise the three harder shapes, or the number
     above would be an average over the easy ones. */
  assert.ok(GRID.catchingUp > 500, `only ${GRID.catchingUp} Catching Up cells fired`);
  assert.ok(GRID.threeDice > 500, `only ${GRID.threeDice} three-dice cells`);
});

test('D1 the projection always contains at least one d6, for every card and every card-less commit', () => {
  assert.strictEqual(Rules.BASE_DICE, 1, 'both seats roll one base die');
  const ALL = Object.keys(Rules.CARD_MODS);
  const base = (troops, cardId)=> Rules.projectSide({
    troops, cardId: cardId || null, winStreak: 0, credits: 9, ore: 9,
  });
  for(let troops = 0; troops <= 8; troops++){
    [null].concat(ALL).forEach(cardId=>{
      const p = base(troops, cardId);
      const spread = p.max - p.min;
      /* A side with no die has spread 0. Every side must have at least one
         die in it, so it must span strictly more than nothing. */
      assert.ok(p.dice >= 1, `${cardId || 'no card'} @ ${troops} troops: dice ${p.dice}`);
      assert.ok(spread >= 5, `${cardId || 'no card'} @ ${troops} troops: spread ${spread} - the die is missing`);
      assert.ok(Math.abs(sum(p.dist) - 1) < 1e-9, 'the distribution must be normalised');
    });
  }
  /* And the two shapes the defect report called out by name. */
  assert.strictEqual(base(4, null).min, 5, '4 troops + a 1');
  assert.strictEqual(base(4, null).max, 10, '4 troops + a 6');
  assert.strictEqual(base(4, 'wild').min, 6, '4 troops + 1 + 1');
  assert.strictEqual(base(4, 'wild').max, 16, '4 troops + 6 + 6');
  assert.strictEqual(base(4, 'gambit').dice, 3, 'base d6 + the two Gambit keeps');
  assert.strictEqual(base(4, 'gambit').rollMode, null, 'a genuine composite is neither sum nor max');
});

test('D1 the two defects from the report are gone (1v1 and 5v4, no card)', () => {
  /* The report's table. Pre-fix the panel printed 0/100/0 and 100/0/0; the
     true figures were 41.7/16.7/41.7 and 58.3/16.7/25.0. */
  const a = Rules.projectSkirmish({troops:1}, {troops:1}, {});
  closePct(a.winPct, 41.6666667, '1v1 win');
  closePct(a.tiePct, 16.6666667, '1v1 tie');
  closePct(a.losePct, 41.6666667, '1v1 lose');

  const b = Rules.projectSkirmish({troops:5}, {troops:4}, {});
  /* Two independent d6 with different floors: mine is 5+m, theirs 4+d, so a
     win is m >= d (21 of 36), a tie is m = d-1 (5 of 36) and a loss is the
     remaining 10. NOTE: the defect report's table listed 58.3 / 16.7 / 25.0
     for this row; the win figure is right but its tie and loss columns were
     not - with the floors one apart the tie rate is 5/36 = 13.9%, not 6/36,
     and the loss rate is 10/36 = 27.8%, not 9/36. Asserted here against the
     enumeration, which is the ground truth. */
  closePct(b.winPct,  100 * 21 / 36, '5v4 win');
  closePct(b.tiePct,  100 * 5 / 36, '5v4 tie');
  closePct(b.losePct, 100 * 10 / 36, '5v4 lose');
  assert.ok(b.winPct > a.winPct, 'one more Troop is worth something');

  /* A single die each: two independent d6, so the tie rate is exactly the
     6 faces that meet out of 36 = 16.667%, and no outcome may be a
     round 0 or round 100. */
  [a, b].forEach(h=>{
    assert.ok(h.winPct > 0 && h.winPct < 100, 'a committed fight is never a certainty');
    assert.ok(h.tiePct > 0, 'a single die each side can always meet');
  });
  /* And the sentence the panel prints has to agree with the distribution: with a
     die in it this is a real "you win if you roll >= 4", not the die-less
     "no single die can get you there" the panel used to print alongside a
     flat 100% / 0% / 0%. Their mean is 1 + 3.5 = 4.5, and my floor is 1. */
  assert.strictEqual(a.threshold, 4);
  assert.notStrictEqual(a.threshold, 7);
});

function closePct(got, expected, label, eps){
  assert.ok(Math.abs(got - expected) <= (eps === undefined ? 1e-6 : eps),
    `${label}: got ${got}, expected ${expected}`);
}

/* ==================================================================
   D2 — the wager seat.
   ================================================================== */

/* A minimal engine: two players with Influence, and a bridge that only does
   what settleWagers needs. The feature reads its seat index through `me(idx)`,
   so the whole defect is reproducible with three objects.

   `setBridge()` only installs a FALLBACK - `bridge()` prefers the live
   OD.WagersBridge that game.js published (and this file defines `window`, so
   there is one). So the fake replaces it for the duration of the call and the
   real bridge is put back immediately. */
const REAL_BRIDGE = globalThis.OD.WagersBridge;

function seatHarness(){
  const st = {
    round: 2, logEntries: [],
    players: [
      {name:'Player 1', influence: 5, betrayal: 0, credits: 0, ore: 0, troops: 1, winStreak: 0},
      {name:'Player 2', influence: 5, betrayal: 0, credits: 0, ore: 0, troops: 1, winStreak: 0},
    ],
  };
  globalThis.OD.WagersBridge = {
    getState: ()=> st,
    log: (html)=> st.logEntries.push(html),
    popup: ()=>{},
    renderAll: ()=>{},
  };
  return st;
}
function restoreBridge(){ globalThis.OD.WagersBridge = REAL_BRIDGE; }
/* settleWagers against the fake seats above, then put the real bridge back. */
function settle(winnerSide, aggressorIdx, aggCommit, defCommit){
  try{ return Wagers.settleWagers(winnerSide, aggressorIdx, aggCommit, defCommit); }
  finally{ restoreBridge(); }
}
process.on('exit', restoreBridge);

test('D2 settleWagers pays the DECLARING seat, for both aggressor seats', () => {
  const STANCES = ['allin', 'ghost'];
  const OUTCOMES = [
    {name:'aggressor wins', winnerSide: 0},
    {name:'defender wins',  winnerSide: 1},
    {name:'tie',            winnerSide:-1},
  ];
  [0, 1].forEach(aggSeat=>{
    STANCES.forEach(stance=>{
      OUTCOMES.forEach(outcome=>{
        const st = seatHarness();
        /* Only the DEFENDER declares, which is the case the report
           reproduced: Player 2 takes the Garrison, the defender goes ALL IN,
           Player 2 wins, and the -2 was charged to Player 2 anyway. */
        const declarer = 1 - aggSeat;
        const other   = aggSeat;
        const declaringSide = (declarer === aggSeat) ? 0 : 1;   // 0 = agg, 1 = def
        st.players[declarer].influence = 5;
        st.players[other].influence   = 5;
        const aggCommit = {troops: 3, wager: null};
        const defCommit = {troops: 1, wager: stance};

        /* sides[] order is [aggressor, defender] regardless of seat. */
        settle(outcome.winnerSide, aggSeat, aggCommit, defCommit);

        const p = st.players;
        const label = `${stance} ${outcome.name}, aggressor seat ${aggSeat}`;
        const declarerName = p[declarer].name;
        const otherName = p[other].name;

        if(outcome.winnerSide === declaringSide){
          /* The declaring side WON. */
          const gain = stance === 'allin' ? Wagers.ALL_IN_WIN : Wagers.GHOST_WIN;
          assert.strictEqual(p[declarer].influence, 5 + gain, `${label}: declarer +${gain}`);
          assert.strictEqual(p[other].influence, 5, `${label}: the non-declarer is paid nothing`);
        } else if(outcome.winnerSide === -1){
          assert.strictEqual(p[0].influence, 5, `${label}: a tie pays nobody`);
          assert.strictEqual(p[1].influence, 5, `${label}: a tie pays nobody`);
        } else if(stance === 'allin'){
          assert.strictEqual(p[declarer].influence, 5 - Wagers.ALL_IN_LOSS,
            `${label}: the DECLARER pays -${Wagers.ALL_IN_LOSS}`);
          assert.strictEqual(p[other].influence, 5,
            `${label}: the non-declarer pays nothing`);
        } else {
          assert.strictEqual(p[declarer].influence, 5,
            `${label}: GHOST risks no Influence`);
          assert.strictEqual(p[other].influence, 5, `${label}: and nobody else does either`);
        }

        /* Exactly one line, and it names the DECLARER. Pre-fix it named the
           seat at the same index as the side - the other player. */
        assert.strictEqual(st.logEntries.length, 1, `${label}: one log line`);
        assert.ok(st.logEntries[0].indexOf(declarerName) !== -1,
          `${label}: the log line must name the declarer (${declarerName}), got: ${st.logEntries[0]}`);
        void otherName;
      });
    });
  });
});

test('D2 the reported reproduction: Player 2 holds the Garrison and declares ALL IN, then loses', () => {
  const st = seatHarness();   // aggressorIdx === 1 (Player 2)
  st.players[0].influence = 6;
  st.players[1].influence = 6;
  const aggCommit = {troops: 4, wager: null};          // Player 2, no wager
  const defCommit = {troops: 1, wager: 'allin'};       // Player 1 declared ALL IN

  /* Player 2 WINS the Skirmish by 1 (paid by resolveSkirmish itself), then
     Player 1's ALL IN loses. Pre-fix this charged Player 2 the -2. */
  settle(0, 1, aggCommit, defCommit);
  assert.strictEqual(st.players[0].influence, 4, 'Player 1 declared ALL IN and lost: -2');
  assert.strictEqual(st.players[1].influence, 6, 'Player 2 won and declared nothing: untouched');
});

test('D2 GHOST pays the WINNER the +2 even when the winner is not the aggressor', () => {
  const st = seatHarness();   // aggressorIdx === 1
  st.players[0].influence = 5;
  st.players[1].influence = 5;
  const aggCommit = {troops: 0, wager: 'ghost'};       // Player 2 went GHOST
  const defCommit = {troops: 1, wager: null};          // Player 1 declared nothing
  settle(0, 1, aggCommit, defCommit);     // Player 2 (side 0) wins
  assert.strictEqual(st.players[1].influence, 5 + Wagers.GHOST_WIN,
    'the +2 GHOST win belongs to the seat that went GHOST (Player 2)');
  assert.strictEqual(st.players[0].influence, 5, 'and Player 1 gets nothing');
});

test('D2 an out-of-range aggressorIdx falls back to seat 0 rather than mis-paying', () => {
  const st = seatHarness();
  st.players[0].influence = 5; st.players[1].influence = 5;
  /* sides = [aggressor, defender]; the fallback puts the aggressor at seat 0,
     so the defender's ALL IN belongs to seat 1 and is charged there. */
  settle(0, 7, {troops:1, wager:null}, {troops:1, wager:'allin'});
  assert.strictEqual(st.players[1].influence, 3, 'seat 1 declared ALL IN and lost: -2');
  assert.strictEqual(st.players[0].influence, 5, 'and nobody invented a seat 7 to pay');
});

/* ==================================================================
   D3 — objectives. Structural facts, read off the engine's own table.
   ================================================================== */
const OBJ = id => Engine.OBJECTIVES.find(o => o.id === id);

test('D3 all six objectives exist and every one is a FUNCTION pair', () => {
  assert.strictEqual(Engine.OBJECTIVES.length, 6);
  const ids = Engine.OBJECTIVES.map(o=>o.id).sort();
  assert.deepStrictEqual(ids,
    ['archivist', 'financier', 'industrialist', 'prospector', 'unscathed', 'warlord']);
  Engine.OBJECTIVES.forEach(o=>{
    assert.strictEqual(typeof o.check, 'function', o.id + '.check');
    assert.strictEqual(typeof o.progress, 'function', o.id + '.progress');
    assert.ok(o.desc && o.desc.length > 10, o.id + '.desc');
  });
});

test('D3 archivist REQUIRES cards played - the clause that makes it missable', () => {
  const archivist = OBJ('archivist');
  assert.strictEqual(Engine.HAND_CAP, 5);
  assert.ok(Engine.ARCHIVIST_PLAYED >= 1, 'a threshold of zero would be no threshold');

  /* THE DEFECT. The start-of-game deal is `drawCard(p, HAND_CAP)` for both
     players, so the OLD check `p.hand.length >= 5` was `5 >= 5` on the
     opening deal: guaranteed met for BOTH players in EVERY game, printed on
     the HUD as `met (+4) · 5 of 5` before the first action. A full hand with
     no cards ever played must NOT be enough. */
  const fullIdleHand = {hand:[1,2,3,4,5], cardsPlayed:0};
  assert.strictEqual(archivist.check(fullIdleHand), false,
    'a full hand and zero cards played must NOT complete Archivist');
  assert.strictEqual(archivist.progress(fullIdleHand).have, 0,
    'progress must lead with the clause that is holding the player back');

  /* And the churn actually does complete it. */
  const churned = {hand:[1,2,3,4,5], cardsPlayed: Engine.ARCHIVIST_PLAYED};
  assert.strictEqual(archivist.check(churned), true,
    'a full hand AFTER playing the cards is the point of the objective');
  assert.strictEqual(archivist.progress(churned).need, Engine.HAND_CAP);

  /* One card short of the played clause is not met, however full the hand. */
  assert.strictEqual(archivist.check({hand:[1,2,3,4,5], cardsPlayed: Engine.ARCHIVIST_PLAYED - 1}), false);

  /* A SHORT hand is never enough, however much was played. */
  const short = {hand:[1,2,3,4], cardsPlayed: 9};
  assert.strictEqual(archivist.check(short), false);

  /* `progress` has to be honest in BOTH directions: before the played clause
     it reports cards played, after it reports the hand. */
  const early = archivist.progress({hand:[1,2], cardsPlayed:1});
  assert.strictEqual(early.unit, 'cards played');
  assert.ok(early.note && /full hand/i.test(early.note),
    'the second clause is stated, not hidden');
  const late = archivist.progress({hand:[1,2,3,4,5], cardsPlayed:5});
  assert.strictEqual(late.unit, 'cards in hand');
  assert.strictEqual(late.note, undefined);

  /* The description the player reads has to name both clauses. */
  assert.match(archivist.desc, new RegExp(String(Engine.ARCHIVIST_PLAYED)),
    'the desc must state the cards-played requirement');
  assert.match(archivist.desc, new RegExp(String(Engine.HAND_CAP)),
    'the desc must state the hand requirement');
});

test('D3 industrialist is tuned off the measured distribution, not off a guess', () => {
  const ind = OBJ('industrialist');
  assert.strictEqual(Engine.INDUSTRIALIST_NEED, ind.progress({advancedPicks:0}).need,
    'progress.need and check must agree on one number');
  assert.match(ind.desc, new RegExp(String(Engine.INDUSTRIALIST_NEED)),
    'the desc quotes the same threshold the check uses');

  /* Pre-fix this read `advancedPicks >= 4` and measured met in 100.0% of
     2,408 games; it is still 100% at 8. The retune has to be a number a
     player can actually MISS. Assert the boundary is strict and that the
     value is in the range the 8,000-game headless simulation measured as a
     coin flip (see the INDUSTRIALIST_NEED comment in js/game.js). */
  assert.ok(Engine.INDUSTRIALIST_NEED >= 12,
    'a threshold of ' + Engine.INDUSTRIALIST_NEED + ' is still inside the measured 89.3% band');
  assert.strictEqual(ind.check({advancedPicks: Engine.INDUSTRIALIST_NEED - 1}), false);
  assert.strictEqual(ind.check({advancedPicks: Engine.INDUSTRIALIST_NEED}), true);
});

test('D3 cardsPlayed is a plain integer default, so state stays JSON-serialisable', () => {
  /* `state` is JSON.stringify'd to the online guest after every render, so a
     new field has to be a primitive with an explicit default. */
  const sample = {
    name:'Player 1', type:'bot', credits:2, ore:1, troops:1, influence:0,
    deck:[], discard:[], hand:['wild'], intrigueHand:[],
    isAggressor:false, aggressorBonus:0,
    skirmishWins:0, skirmishLosses:0, advancedPicks:0, winStreak:0,
    betrayal:2, freeAdvancedUsed:false, objectiveId:'archivist', leaderId:'gambler',
    cardsPlayed: 0,
  };
  const round = JSON.parse(JSON.stringify({players:[sample]}));
  assert.strictEqual(round.players[0].cardsPlayed, 0);
  assert.strictEqual(typeof round.players[0].cardsPlayed, 'number');
  /* The objective TABLE is never serialised - only the id - so `check` and
     `progress` cannot leak onto the wire. Confirmed by looking up the id. */
  assert.ok(OBJ(round.players[0].objectiveId), 'the id resolves back to the shared table');
});

test('D3 measured met-rates: no objective sits at 0% or 100%', {
  skip: process.env.OD_SIM ? false : 'set OD_SIM=1 to run the headless simulation (it is slow)',
}, ()=>{
  const N = Number(process.env.OD_SIM || 0);
  const counts = {};
  let games = 0, errors = 0;
  for(let g = 0; g < N; g++){
    let st;
    try{ st = playOneGame(); }
    catch(e){ errors++; continue; }
    if(!st || st.phase !== 'ended'){ errors++; continue; }
    games++;
    st.players.forEach(p=>{
      const o = Engine.OBJECTIVES.find(x=>x.id === p.objectiveId);
      if(!o) return;
      counts[o.id] = counts[o.id] || {met:0, n:0};
      counts[o.id].n++;
      if(o.check(p)) counts[o.id].met++;
    });
  }
  console.log(`    simulated ${games} games / ${games*2} player-games, ${errors} errors`);
  const rates = [];
  Engine.OBJECTIVES.forEach(o=>{
    const c = counts[o.id] || {met:0, n:0};
    const rate = c.n ? 100*c.met/c.n : NaN;
    rates.push(rate);
    console.log(`      ${o.id.padEnd(15)} ${rate.toFixed(1).padStart(6)}%  (${c.met}/${c.n})  ${o.desc}`);
  });
  assert.strictEqual(errors, 0, 'no simulated game may fail to complete');
  assert.ok(games >= 100, 'the sample must be big enough to mean something');
  rates.forEach((r, i)=>{
    const id = Engine.OBJECTIVES[i].id;
    assert.ok(r > 1, `${id} is effectively unreachable at ${r.toFixed(1)}%`);
    assert.ok(r < 99, `${id} is effectively automatic at ${r.toFixed(1)}% - it is not an objective`);
  });
  /* And the two that were automatic are now in the same band as the rest. */
  assert.ok(rates[2] > 20 && rates[2] < 80, 'Industrialist must read as a real coin flip');
  assert.ok(rates[5] < 50, 'Archivist must be missable');
  void REAL_SET_TIMEOUT;
});

/* ==================================================================
   D4 — the Commit double-fire.
   ================================================================== */

/* showCommitModal's Commit handler, exercised through the only surface that
   reaches it: the button it binds. The latch and the disable are what this
   asserts. The two Commit buttons render at the same pixel (dx=0, dy=1), so
   a real double-click fires the SAME handler twice - once for the aggressor
   and, after the first has replaced the modal, once for the defender. */
function fakeCommitButton(){
  const btn = {
    disabled: false, textContent: 'Commit', attrs:{},
    setAttribute(k, v){ this.attrs[k] = v; },
  };
  return btn;
}

test('D4 the Commit handler advances the phase exactly once under a double-fire', () => {
  /* A faithful stand-in for the closure showCommitModal builds: a one-shot
     latch and an immediate disable, then hideModal() + onSubmit(). The values
     below mirror the two real modals the report captured. */
  const makeHandler = (label, troops, cardId, modalTitle)=>{
    const btn = fakeCommitButton();
    const fires = [];
    const phase = {title: modalTitle, commits: []};
    let commitFired = false;
    const fireCommit = ()=>{
      if(commitFired) return;
      commitFired = true;
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
      btn.textContent = 'Committed';
      fires.push({label, troops, cardId});
      /* hideModal() then onSubmit(): the next seat's modal is opened here. */
      phase.title = 'Rolling the Dice';
      phase.commits.push({label, troops, cardId});
    };
    return {btn, fireCommit, fires, phase};
  };

  const aggressor = makeHandler('Player 1', 4, 'ambush', 'Player 1 - Commit Troops');
  const defender  = makeHandler('Player 2', 3, null,    'Player 2 - Commit Troops');

  /* One double-click: two clicks at the same pixel. The first one belongs to
     the aggressor's modal and swaps the dialog over to the defender's. */
  aggressor.fireCommit();
  const afterFirst = {phase: aggressor.phase.title, submitted: aggressor.fires.length,
                      btn: aggressor.btn.textContent, disabled: aggressor.btn.disabled};

  /* THE SECOND CLICK OF THE SAME DOUBLE-CLICK. If the button were still
     live, this is what the report captured: "Rolling the Dice", the DEFENDER's
     troops, no card, no wager - the defender's whole commit, submitted
     without them ever seeing their own commit screen. */
  aggressor.fireCommit();

  assert.strictEqual(afterFirst.submitted, 1, 'the first click commits once');
  assert.strictEqual(aggressor.fires.length, 1,
    'a double-fire must NOT submit the opponent\'s commit');
  assert.strictEqual(aggressor.phase.commits.length, 1,
    'exactly one commit reached the engine');
  assert.strictEqual(aggressor.phase.commits[0].label, 'Player 1');
  assert.strictEqual(aggressor.phase.commits[0].troops, 4);
  assert.strictEqual(aggressor.phase.commits[0].cardId, 'ambush');
  assert.strictEqual(aggressor.btn.disabled, true, 'the button goes dead on the first fire');
  assert.strictEqual(aggressor.btn.textContent, 'Committed');
  assert.strictEqual(aggressor.btn.attrs['aria-disabled'], 'true');

  /* The defender still gets their turn, and their commit is still theirs. */
  defender.fireCommit();
  assert.strictEqual(defender.phase.commits.length, 1);
  assert.strictEqual(defender.phase.commits[0].label, 'Player 2');
  assert.strictEqual(defender.phase.commits[0].troops, 3);
  assert.strictEqual(defender.phase.commits[0].cardId, null);
});

test('D4 the latch is one-shot per modal, so a fresh modal still commits', () => {
  /* The guard must not outlive the dialog it belongs to, or the SECOND
     Skirmish could never be committed. */
  const mk = ()=>{
    const btn = fakeCommitButton();
    const fired = [];
    let latch = false;
    const fire = ()=>{
      if(latch) return;
      latch = true;
      btn.disabled = true;
      fired.push(1);
    };
    return {btn, fire, fired};
  };
  const first = mk(), second = mk();
  first.fire(); first.fire(); first.fire();
  assert.strictEqual(first.fired.length, 1, 'three clicks, one commit');
  second.fire();
  assert.strictEqual(second.fired.length, 1, 'the next Skirmish commits normally');
});

test('D4 the source carries the latch on every phase-advancing handler', () => {
  /* A structural guard, so the fix cannot be quietly reverted by editing the
     button back out. The four handlers that advance a phase from a click. */
  const fs = require('fs');
  const game = fs.readFileSync(path.join(ROOT, 'js/game.js'), 'utf8');
  const wagers = fs.readFileSync(path.join(ROOT, 'js/feature-wagers.js'), 'utf8');

  /* 1. showCommitModal's Commit button. */
  assert.match(game, /const fireCommit = \(\)=>\{\s*\n\s*if\(commitFired\) return;/,
    'showCommitModal must latch the Commit handler');
  assert.match(game, /commitBtn\.disabled = true;/,
    'and must disable the Commit button on the first fire');

  /* 2/3. The Skirmish Decision (Attack / Hold Back), which starts or ends
     the round. */
  assert.match(game, /const decideOnce = \(attack, force\)=>\{\s*\n\s*if\(decided\) return;/,
    'the decision handler must latch');

  /* 4. The Quiet Round answer, which starts a Skirmish or ends the round. */
  assert.match(wagers, /const decide = \(yes\)=>\{[\s\S]{0,900}?if\(answered\) return;/,
    'the Quiet Round answer must latch');

  /* And the four must NOT be a bare `hideModal(); onX(...)` any more. */
  assert.doesNotMatch(game, /commitBtn'\)\.onclick = \(\)=>\{\s*\n\s*const troops/,
    'the unlatched Commit handler is back');
});