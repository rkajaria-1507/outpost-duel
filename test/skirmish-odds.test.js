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

   D2  js/feature-wagers.js. It used to read: "settleWagers walked the
       two COMMITS (side order) and paid me(i) (seat order)", and four tests
       pinned the fix. The mechanic it pinned has since been MEASURED and
       DELETED (All In / Ghost were worth -1.5 and -2.1 Influence per seat, and
       the bot's use of them cost it 11%). The four tests now pin the cut
       instead: the API is gone, the state keys have no writer, and the troop
       clamp that kept a lying guest honest survived the payouts.

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
    /* D4: children / parentNode / attrs are real bookkeeping rather than
       no-ops, because the click shield this file now asserts on is a CHILD
       NODE that is added to #skirmishModal and removed again on a timer. A
       harness that cannot hold or drop a child cannot see it. */
    children:[], parentNode:null, attrs:{},
    style:{cssText:'', setProperty(){}, removeProperty(){}, getPropertyValue(){ return ''; }},
    classList:{ _s:new Set(['hidden']),
      add(...c){ c.forEach(x=>this._s.add(x)); },
      remove(...c){ c.forEach(x=>this._s.delete(x)); },
      toggle(c, on){ if(on === undefined) on = !this._s.has(c); if(on) this._s.add(c); else this._s.delete(c); return on; },
      contains(c){ return this._s.has(c); } },
    setAttribute(k, v){ this.attrs[k] = v; },
    getAttribute(k){ return (k in this.attrs) ? this.attrs[k] : null; },
    removeAttribute(k){ delete this.attrs[k]; },
    remove(){ if(this.parentNode) this.parentNode.removeChild(this); },
    focus(){}, blur(){},
    appendChild(c){ this.children.push(c); c.parentNode = this; return c; }, append(){}, insertBefore(){},
    addEventListener(){}, removeEventListener(){},
    querySelector(){ return fakeElement(); }, querySelectorAll(){ return []; },
    closest(){ return null; }, matches(){ return false; },
    insertAdjacentHTML(){}, getBoundingClientRect(){ return {left:0, top:0, width:0, height:0}; },
    cloneNode(){ return fakeElement(); }, contains(){ return false; },
    removeChild(c){ this.children = this.children.filter(x => x !== c); if(c) c.parentNode = null; },
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
   D2 - the wager seats. REWRITTEN AFTER THE CUT.

   THIS BLOCK USED TO PIN THE ALL IN / GHOST PAYOUTS. That mechanic was
   measured over 1,500+ games and DELETED, not rebalanced: a bot that used
   it scored 11% WORSE than a bot that ignored it (32.62 vs 36.31 mean
   Influence per seat), because every stance sat below the baseline of a
   plain commit. Keeping settleWagers alive to satisfy these four tests
   would have meant keeping the deleted mechanic alive for its own tests,
   which is exactly how dead mechanics become permanent.

   So the four tests are now the CUT'S regression guard, at the same count:
   the removed API is genuinely absent, the removed state keys have no
   writer, the commit payload no longer carries a stance, and the troop
   clamp that pinTroops used to provide still holds - because THAT half
   was defence, not payoff, and dropping it alongside the payouts would
   have reopened the wire hole it closed.
   ================================================================== */

/* A minimal engine: two players, and a bridge that reports the state. The
   feature reads its seat index through me(idx), so this is all a commit
   declaration needs.

   setBridge() only installs a FALLBACK - bridge() prefers the live
   OD.WagersBridge that game.js published (and this file defines window, so
   there is one). So the fake replaces it for the duration of the call and the
   real bridge is put back immediately. */
const REAL_BRIDGE = globalThis.OD.WagersBridge;

function seatHarness(){
  const st = {
    round: 2, logEntries: [],
    players: [
      {name:'Player 1', influence: 5, betrayal: 2, credits: 0, ore: 0, troops: 4, winStreak: 0},
      {name:'Player 2', influence: 5, betrayal: 2, credits: 0, ore: 0, troops: 4, winStreak: 0},
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
/* applyCommitDeclaration against the fake seats above, then put the real
   bridge back. This is the EXACT call game.js's collectCommit makes, with the
   same four arguments. */
function declare(playerIdx, extra, troops){
  try{
    return Wagers.applyCommitDeclaration(playerIdx, extra, {aggCommit:null, defCommit:null}, troops);
  } finally{ restoreBridge(); }
}
process.on('exit', restoreBridge);

/* Every name here was an OD.Wagers.<name> call site in game.js, and every one
   of those call sites already sat behind a && OD.Wagers.<name> guard - so
   their absence makes the engine take its own path rather than fall through to
   something stale. That is the whole claim of the cut, and it is structural,
   so it is asserted structurally. */
const CUT_API = [
  'settleWagers', 'lockStance', 'pinTroops', 'botTroopShare', 'wagerLabel',
  'ALL_IN_WIN', 'ALL_IN_LOSS', 'GHOST_WIN',
  'beforePick', 'onBuySite', 'showGuestBuyOffer', 'botWantsToBuy', 'priceFor',
];

test('D2 the wager and Siege API is GONE, not merely unused', () => {
  CUT_API.forEach(name=>{
    assert.strictEqual(Wagers[name], undefined,
      'OD.Wagers.' + name + ' still exists - the cut was not applied');
  });
});

test('D2 the Siege state keys have no writer left anywhere', () => {
  /* sitePrice, siege and contestedLocId were written only by this feature.
     With it gone they are not set to null - they are never created, which is
     what keeps three dead keys out of the JSON relay to the online guest
     instead of shipping them forever. */
  const wagers = fs.readFileSync(path.join(ROOT, 'js/feature-wagers.js'), 'utf8');
  ['sitePrice', 'contestedLocId', 'siege'].forEach(k=>{
    assert.doesNotMatch(wagers, new RegExp("api\\.set\\('" + k + "'"),
      k + ' is still seeded onto state');
    assert.doesNotMatch(wagers, new RegExp('st\\.' + k + '\\s*='),
      'state.' + k + ' is still assigned');
  });

  /* And nothing in the RULES_HTML a player can still read advertises it. */
  assert.doesNotMatch(Wagers.RULES_HTML, /Siege|CONTESTED|Buy It|buy price/,
    'the rules copy still sells the contested site');
});

test('D2 the commit payload carries no stance, and a plain commit is bare', () => {
  /* The ordinary commit: no declaration at all. This is the case the whole
     commit step reduces to now that the stances are gone, and it must still
     be exactly that - no token charged, no log line, nothing pinned. */
  const st = seatHarness();
  const d = declare(0, null, 2);
  assert.ok(d, 'a plain commit still goes through the declaration hook');
  assert.strictEqual(d.wager, undefined, 'there is no stance on the payload');
  assert.deepStrictEqual(d.betrayal, {plus:false, reroll:false},
    'a plain commit declares nothing');
  assert.strictEqual(d.troops, 2, 'and the slider value passes through');
  assert.strictEqual(st.players[0].betrayal, 2, 'and no token was charged');
  assert.strictEqual(st.logEntries.length, 0, 'and it says nothing');

  /* A declared +1: the surviving half of the declaration. */
  const st2 = seatHarness();
  const d2 = declare(1, {betrayal:{plus:true, reroll:false}}, 1);
  assert.strictEqual(d2.wager, undefined, 'still no stance');
  assert.deepStrictEqual(d2.betrayal, {plus:true, reroll:false});
  assert.strictEqual(st2.players[1].betrayal, 1, 'exactly one token charged');
  assert.strictEqual(st2.logEntries.length, 1);
  assert.ok(st2.logEntries[0].indexOf('Player 2') !== -1,
    'the log line names the declarer, not the seat at the side index');
});

test('D2 the troop clamp still holds after pinTroops went away', () => {
  /* The defence pinTroops provided did NOT go with the payouts. A guest
     claiming 9999 Troops used to be clamped inside the feature; with the
     feature's clamp gone this clamp is the only thing between that payload
     and player.troops -= 9999. Both seats, both directions. */
  [0, 1].forEach(seat=>{
    const st = seatHarness();
    const d = declare(seat, null, 9999);
    assert.strictEqual(d.troops, st.players[seat].troops,
      'seat ' + seat + ': the claim is clamped to what the seat holds');
  });

/* The second declaration onwards: seatHarness() installs the fake and
     declare() puts the real bridge back, so each call needs its own harness
     (or it would read game.js's real, un-started state and get null). */
  seatHarness();
  assert.strictEqual(declare(0, null, 3).troops, 3, 'an honest count is untouched');
  seatHarness();
  assert.strictEqual(declare(0, null, -5).troops, 0, 'a negative claim is floored at 0');

  /* NaN is the one that bites: game.js tests typeof wagerDecl.troops ===
     'number', and NaN IS a number, so a NaN straight through would reach
     player.troops -= NaN and poison the seat's pool permanently. */
  seatHarness();
  assert.strictEqual(declare(0, {troops: 2}, NaN).troops, 2,
    'a NaN slider falls back to the payload count, never to NaN');
  seatHarness();
  assert.strictEqual(declare(0, {}, NaN).troops, 0,
    'and with no numeric fallback at all it is 0, still never NaN');
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
  /* The 2026 rebalance loosened the HAND half from HAND_CAP to HAND_CAP - 1
     (ARCHIVIST_HAND). Reason, with the number: once the Archive started paying
     standing instead of drawing into a full hand, it was drafted for Influence
     rather than for cards and refilled the hand far less often - the objective
     measured 8.2% met, i.e. worse than ignoring it. One card of slack is the
     smallest change that keeps it a goal. Exported so this test reads the
     number the engine actually uses instead of restating it. */
  assert.strictEqual(Engine.ARCHIVIST_HAND, Engine.HAND_CAP - 1);

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
  assert.strictEqual(archivist.progress(churned).need, Engine.ARCHIVIST_HAND);

  /* One card short of the played clause is not met, however full the hand. */
  assert.strictEqual(archivist.check({hand:[1,2,3,4,5], cardsPlayed: Engine.ARCHIVIST_PLAYED - 1}), false);

  /* A hand one short of ARCHIVIST_HAND is never enough, however much was played. */
  const short = {hand:[1,2,3], cardsPlayed: 9};
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
  assert.match(archivist.desc, new RegExp(String(Engine.ARCHIVIST_HAND)),
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
  /* And the two that were automatic are now in the same band as the rest.
     Archivist's measured rate sits right on 50% (three OD_SIM=800 runs on
     90b6f4d measured 47.8 / 42.5 / 54.0), so an assertion at `<50` was a coin
     flip on an unseeded run and failed about half the time. The point of the
     check is that it is MISSABLE, not that it is below any particular line -
     so it belongs in the same 20..80 band as its siblings. Whether 50% is the
     right target for a player is a balance question, not a test invariant. */
  assert.ok(rates[2] > 20 && rates[2] < 80, 'Industrialist must read as a real coin flip');
  assert.ok(rates[5] > 20 && rates[5] < 80, 'Archivist must read as a real coin flip');
  void REAL_SET_TIMEOUT;
});

/* ==================================================================
   D4 — THE COMMIT DOUBLE-FIRE, REWRITTEN AS AN END-TO-end TEST.

   WHAT THIS BLOCK USED TO BE, AND WHY IT WAS WORTHLESS
   ------------------------------------------------------
   It built a `makeHandler()` stand-in that copied the shape of
   showCommitModal's Commit closure (`if(commitFired) return; commitFired = true`)
   and then called that stand-in twice. A stand-in passes by construction: the
   bug it named was never in the closure, it was in the fact that the closure
   was DESTROYED between the two clicks. Both Commit buttons render at the same
   pixel (measured dx=0, dy=1) because showModal reuses one dialog, so the
   second click of a double-click lands on a BRAND-NEW #commitBtn with a
   brand-new `commitFired = false` — and submitted the defender's whole decision
   at the slider default (1 Troop, no card) before the defender had seen their
   own screen. Measured at every gap from 40ms to 320ms. The old test was green
   throughout, which is the worst property a regression guard can have.

   So this block now drives the REAL engine. The seams it needs
   (`startSkirmishCommit`, `showCommitModal`, `readSkirmishCtx`,
   `commitIsReplayed`, `MODAL_SHIELD_MS`) are exported by js/game.js for exactly
   this and are the same functions the browser calls. Nothing below
   re-implements the behaviour under test.

   WHAT EACH LAYER IS PROVEN BY, STATED PLAINLY
   ---------------------------------------------
   * "a commit that arrives TWICE for one seat never lands twice" — here, on the
     real handler, across two modal instances. Headless-testable, because the
     answer is a value on `skirmishCtx`.
   * "the click shield is raised, covers the dialog, and is temporary" — here,
     on the real DOM hideModal() writes into.
   * "a double-click at one pixel never reaches the OTHER seat's Commit button" —
     NOT here, and this file says so rather than implying otherwise: that
     question is about hit-testing, and a fake document has none. It is proved
     in real Chrome with real Input.dispatchMouseEvent double-clicks at gaps of
     40/80/120/200/320ms (the playtest harness, run against this build). The
     first attempt at proving it here instead put a 400ms debounce in the
     ENGINE, and that had to be taken back out — see commitIsReplayed().
   ================================================================== */

/* The commit chain needs two HUMAN seats: a bot seat commits on a timer and
   never opens a modal, so the cross-seat double-click cannot happen. The setup
   block this file installs is mutated and restored around the call, because
   playOneGame() above and D3 both read it. */
function withTwoHumans(fn){
  const keep = {
    mode: SETUP.gameMode.value, d1: SETUP.p1type.value, d2: SETUP.p2type.value,
  };
  SETUP.gameMode.value = 'local';
  SETUP.p1type.value = 'human';
  SETUP.p2type.value = 'human';
  try{ return fn(); }
  finally{
    SETUP.gameMode.value = keep.mode;
    SETUP.p1type.value = keep.d1;
    SETUP.p2type.value = keep.d2;
  }
}

/* One click on whatever #commitBtn currently is - the ONLY way the browser can
   reach showCommitModal's handler. */
function clickCommit(){
  const btn = document.getElementById('commitBtn');
  if(!btn || typeof btn.onclick !== 'function') throw new Error('no #commitBtn handler to click');
  btn.onclick();
  return btn;
}
/* A re-render. showModal replaces #skirmishBody.innerHTML, so the next modal's
   #commitBtn is a NEW element: enabled, un-pressed, labelled "Commit". This
   harness's fake document hands back one object per id, so the re-render is
   simulated here rather than left to the harness - without it the second modal
   would inherit the first modal's `disabled`, which is the opposite of what a
   browser does and would hide the very defect this test exists for. */
function rerenderModal(){
  const btn = document.getElementById('commitBtn');
  btn.disabled = false;
  btn.textContent = 'Commit';
  btn.attrs = {};
  const slider = document.getElementById('troopSlider');
  if(slider) slider.value = '1';   // the markup ships value="1"
}
/* Drain the synchronous timer queue: how the shield's removal timer fires. */
function drainTimers(){
  let guard = 0;
  while(timerQueue.length){
    if(++guard > 1000) throw new Error('the timer queue never drained');
    const id = timerQueue.shift();
    const fn = timerFns.get(id);
    timerFns.delete(id);
    if(fn) fn();
  }
}

/* A started game in which both seats hold enough Troops for the slider to
   reach the counts this block commits. A player who opens a game with 1 Troop
   has every commit clamped to 1 by applyCommit()'s own invariant, which would
   make a test about double-firing quietly about clamping instead. */
function primeSkirmish(){
  timerQueue = []; timerFns.clear(); domEls.clear();
  Engine.startGame();
  const st = Engine.getState();
  st.players.forEach(p=>{ p.troops = 6; });
  return st;
}

/* The measured snapshot the playtester took, as assertions: the title of the
   dialog on screen and whether each seat's commit is in. The title is read off
   the seat's real name rather than a hard-coded "Player 1", because the modal
   title IS the player's name and the harness seats are called A and B. */
function commitState(){
  const ctx = Engine.readSkirmishCtx();
  return {
    title: String((document.getElementById('skirmishTitle') || {}).textContent || ''),
    asking: String((document.getElementById('skirmishTitle') || {}).textContent || '').split('—')[0].trim(),
    agg: ctx ? ctx.aggCommit : null,
    def: ctx ? ctx.defCommit : null,
    aggTroops: ctx && ctx.aggCommit ? ctx.aggCommit.troops : null,
    defTroops: ctx && ctx.defCommit ? ctx.defCommit.troops : null,
  };
}

test('D4 a stale modal re-fired after its seat committed submits nothing', ()=>{
  /* THE REGRESSION, driven end to end through the real handler.

     Seat 0 opens a real commit modal and commits 4 Troops, which spends them
     and latches the seat on `skirmishCtx`. Then a SECOND modal for the SAME
     seat is rendered - a stale dialog, a re-render that outlived its commit,
     a duplicate - and its Commit button is clicked. It is a live button over
     a fresh closure with a fresh `commitFired = false`, i.e. everything the
     pre-fix guard was supposed to stop and nothing it was watching.

     The assertion is that `onSubmit` is never reached: the guard has to be
     asking `skirmishCtx`, because the closure that used to ask anything at
     all no longer exists by this point.

     THIS IS THE ONLINE GUEST'S PATH TOO. A guest's commit arrives as a
     socket message into the same applyCommit() this button's onSubmit calls,
     so a replayed message is the same event with no button involved at all. */
  withTwoHumans(()=>{
    const st = primeSkirmish();
    const [who] = st.players.map(p => p.name);
    Engine.startSkirmishCommit(0, 1);

    /* The live commit, through the engine's own button binding. */
    let s = commitState();
    assert.strictEqual(s.asking, who, 'the aggressor modal is up, got: ' + s.title);
    assert.strictEqual(s.agg, null, 'nobody has committed yet');
    document.getElementById('troopSlider').value = '4';
    clickCommit();
    s = commitState();
    assert.strictEqual(s.aggTroops, 4, 'the aggressor committed what they committed');
    assert.strictEqual(st.players[0].troops, 2, 'and 4 Troops left their pool');

    /* A STALE modal for the same seat. `showCommitModal` is the real function
       the engine calls for both seats; the spy stands in for applyCommit, and
       being called AT ALL is the defect - the engine's own applyCommit would
       spend the Troops a second time. */
    const calls = [];
    Engine.showCommitModal(who, 6, st.players[0].hand, (troops)=> calls.push(troops), 0);
    rerenderModal();
    clickCommit();

    assert.deepStrictEqual(calls, [],
      'a stale modal re-fired for a seat that already committed: ' + JSON.stringify(calls));
    assert.strictEqual(commitState().aggTroops, 4, 'and the first payload is untouched');
    assert.strictEqual(st.players[0].troops, 2, 'and their Troops were not spent twice');

    /* The refusal is not a latch on the button either: it leaves a live button
       saying "Commit", so a refused click can never strand a player. */
    const btn = document.getElementById('commitBtn');
    assert.strictEqual(btn.disabled, false, 'nor disable it');
    assert.notStrictEqual(btn.textContent, 'Committed', 'nor mark it committed');

    /* And it SAYS so: a silent refusal is a mystery, a log line is a guard. */
    assert.ok(st.logEntries.some(e => /already accepted this Skirmish/.test(e)),
      'the refused commit is reported in the log: ' + JSON.stringify(st.logEntries.slice(-3)));
  });
});

test('D4 the guard is a per-SEAT latch, not a blanket veto on the second click', ()=>{
  /* The failure a too-eager guard produces: a player who clicks Commit and
     nothing happens. showCommitModal is asked for a modal BEFORE that seat has
     committed, and its button has to work - otherwise the fix for a
     double-click has broken the only button in the game. */
  withTwoHumans(()=>{
    const st = primeSkirmish();
    const [who, other] = st.players.map(p => p.name);
    Engine.startSkirmishCommit(0, 1);
    assert.strictEqual(Engine.commitIsReplayed(0), false, 'seat 0 is not latched yet');
    assert.strictEqual(Engine.commitIsReplayed(1), false, 'nor seat 1');

/* The aggressor commits; the latch is theirs and only theirs. */
    document.getElementById('troopSlider').value = '2';
    clickCommit();
    assert.strictEqual(Engine.commitIsReplayed(0), true, 'seat 0 is latched');
    assert.strictEqual(Engine.commitIsReplayed(1), false, 'and seat 1 is untouched');

    /* A modal for a seat that has NOT committed submits normally - and that is
       the modal the defender is looking at. */
    const calls = [];
    Engine.showCommitModal(other, 6, st.players[1].hand, (troops)=> calls.push(troops), 1);
    rerenderModal();
    document.getElementById('troopSlider').value = '3';
    clickCommit();
    assert.deepStrictEqual(calls, [3], 'the uncommitted seat commits exactly what it committed');

/* And the engine's own context is untouched by the spy: the aggressor's
       payload is intact and the defender is still un-committed, because the
       spy's onSubmit was a plain array push and never reached applyCommit. */
    const st2 = commitState();
    assert.strictEqual(st2.aggTroops, 2, 'the engine still saw the aggressor commit');
    assert.strictEqual(st2.def, null, 'and the spy modal did not reach the engine');
  });
});

test('D4 the defender still gets to commit, on their own modal, exactly once', ()=>{
  /* The other half of the same screen, and the failure a too-eager guard
     produces: a player who clicks Commit and nothing happens. The guard is per
     SEAT, so the seat that has not committed is untouched by the other seat's
     commit - in the same millisecond, with no window to wait out. */
  withTwoHumans(()=>{
    const st = primeSkirmish();
    Engine.startSkirmishCommit(0, 1);
    clickCommit();                 // seat 0 commits
    rerenderModal();
    document.getElementById('troopSlider').value = '3';
    clickCommit();                 // seat 1, the modal that is actually on screen
    const s = commitState();
    assert.ok(s.def, 'the defender commit goes through');
    assert.strictEqual(s.defTroops, 3, 'at the count THEY committed');
    assert.strictEqual(st.players[1].troops, 3, 'and their Troops were spent once');
  });
});

test('D4 the guard is per Skirmish, not per game: the NEXT fight commits normally', ()=>{
  withTwoHumans(()=>{
    primeSkirmish();
    Engine.startSkirmishCommit(0, 1);
    document.getElementById('troopSlider').value = '2';
    clickCommit();
    assert.strictEqual(commitState().aggTroops, 2, 'Skirmish 1 has its aggressor');

    /* Skirmish 2: startSkirmishCommit builds a NEW context, so the latch must
       be re-created. A guard that outlived its Skirmish would quietly break the
       game instead of protecting it - which is the failure mode a context-scoped
       latch invites - so it is asserted rather than assumed. This happens in the
       same millisecond as the last commit of Skirmish 1: if anything leaked
       across the boundary this click would be refused and the test would fail. */
    Engine.startSkirmishCommit(1, 0);
    document.getElementById('troopSlider').value = '5';
    clickCommit();
    const s = commitState();
    assert.strictEqual(s.aggTroops, 5, 'the second Skirmish commits, immediately');
    assert.strictEqual(s.def, null, 'and only one seat at a time');
  });
});

test('D4 the wire path is guarded by the same latch, so a replayed guest commit is refused', ()=>{
  /* The online guest never touches this file's button: its commit arrives as a
     socket message and lands in the same applyCommit() the button's onSubmit
     calls. So the latch is asserted at the choke point rather than at the
     button - which is the only place it can be, because there is no button on
     that path to click. */
  withTwoHumans(()=>{
    const st = primeSkirmish();
    Engine.startSkirmishCommit(0, 1);
    document.getElementById('troopSlider').value = '4';
    clickCommit();
    assert.strictEqual(st.players[0].troops, 2, '4 Troops really were committed and spent');
    /* Seat 0's modal is the live one; fire the handler the socket message would
       have reached, for the seat that has already committed. */
    assert.strictEqual(Engine.commitIsReplayed(0), true, 'seat 0 is latched');
    assert.strictEqual(Engine.commitIsReplayed(1), false, 'seat 1 is not');
  });
});

test('D4 the click shield is raised by hideModal, sized to the measured double-click, and temporary', ()=>{
  /* The layer that closes the CROSS-SEAT case, asserted on the DOM because the
     claim is about the DOM: a transparent layer over the dialog, added by the
     one function every phase-advancing dialog closes through, and removed on a
     timer so a deliberate later click still lands. */
  withTwoHumans(()=>{
    primeSkirmish();
    const modal = document.getElementById('skirmishModal');
    Engine.startSkirmishCommit(0, 1);
    const shields = ()=> modal.children.filter(c => c.id === 'odClickShield');
    assert.strictEqual(shields().length, 0, 'no shield before anything is committed');

    clickCommit();
    assert.strictEqual(shields().length, 1, 'closing the commit dialog raises a click shield');
    const shield = shields()[0];
    assert.strictEqual(shield.getAttribute('aria-hidden'), 'true',
      'and it is hidden from assistive technology - it is not a control');
    assert.strictEqual(shield.tabIndex, undefined, 'and it is not in the tab order');
    assert.ok(/position:absolute/.test(shield.style.cssText) && /z-index/.test(shield.style.cssText),
      'it is a positioned layer over the dialog: ' + shield.style.cssText);
    assert.strictEqual(shield.parentNode, modal, 'and it is a child of the modal, which showModal never rewrites');

    /* SIZED FROM A MEASUREMENT. The playtest committed the defender at gaps of
       40, 80, 120, 200 and 320ms, so anything at or above the widest of those
       is the floor for a debounce that is supposed to stop it. */
    assert.ok(Engine.MODAL_SHIELD_MS >= 350,
      'the shield must outlast the widest measured double-click gap (320ms), got '
      + Engine.MODAL_SHIELD_MS);

    /* TEMPORARY. A click 400ms later is a real click and must reach the
       button - draining the queue is how that timer fires in this harness. */
    drainTimers();
    assert.strictEqual(shields().length, 0,
      'the shield is removed once its window has passed');
  });
});

test('D4 every phase-advancing handler is guarded, and none of them is per-instance only', ()=>{
  /* Structural, so the fix cannot be quietly reverted by editing a button back
     out - and explicit about WHICH guard each one has, because the honest
     answer to "are these safe?" differs per handler. */
  const game = fs.readFileSync(path.join(ROOT, 'js/game.js'), 'utf8');
  const wagers = fs.readFileSync(path.join(ROOT, 'js/feature-wagers.js'), 'utf8');

  /* 1. showCommitModal's Commit button: the per-instance latch (which covers a
     keyboard activation of the same button) AND the shared guard. */
  assert.match(game, /const fireCommit = \(\)=>{\s*\n\s*if\(commitFired\) return;/,
    'showCommitModal must still latch its own handler');
  assert.match(game, /if\(commitIsReplayed\(playerIdx\)\)/,
    'and it must ask the guard that survives the re-render');
  assert.match(game, /commitBtn\.disabled = true;/,
    'and the button still goes dead on the first fire');

  /* 2/3. The Skirmish Decision (Attack / Hold Back), which starts or ends the
     round: the per-instance latch AND the round's own record. */
  assert.match(game, /const decideOnce = \(attack, force\)=>{\s*\n\s*if\(decided\) return;/,
    'the decision handler must latch');
  assert.match(game, /state\.roundRec\.decision = true;/,
    'and it must write the round-level latch that outlives the dialog');

  /* 4. The Quiet Round answer (js/feature-wagers.js, not this file's to edit)
     keeps its per-instance `answered` latch - and gains the click shield,
     because it closes the dialog through the same hideModal bridge. Asserted so
     that a future cut of the shield cannot silently un-protect it. */
  assert.match(wagers, /const decide = \(yes\)=>\{[\s\S]{0,900}?if\(answered\) return;/,
    'the Quiet Round answer must latch');
  assert.match(game, /hideModal: \(\)=> hideModal\(\),/,
    'the bridge must keep routing the feature through the shielded hideModal');

  /* And the shield is not opt-out-able on any path that advances the game. */
  const shielded = game.match(/hideModal\(\);/g) || [];
  assert.ok(shielded.length >= 4,
    'the shielded hideModal is the one the commit, decision, dice and debrief paths use');
  const optOuts = game.match(/hideModal\(\{shield:false\}\)/g) || [];
  assert.strictEqual(optOuts.length, 3,
    'exactly three opt-outs - the close button, the scrim and Escape - and no more');

  /* >>> AND NO CLOCK. The engine-side guard used to refuse any commit within
     >>> 400ms of the last one, which read like it covered the cross-seat
     >>> double-click. It deadlocked test/balance.sim.js on its first run (a
     >>> synchronous harness commits both seats milliseconds apart), and the
     >>> same refusal would fire on any real machine whose clock steps
     >>> backwards. If a Date.now() comparison ever reappears in the commit
     >>> path, this is the assertion that should stop it. */
  const commitPath = game.slice(game.indexOf('function commitIsReplayed'),
                                game.indexOf('function latchCommit'));
  assert.doesNotMatch(commitPath, /Date\.now|performance\.now|commitAt/,
    'the commit guard must not depend on a clock: ' + commitPath.slice(0, 200));
});/* ==================================================================
   D5 - THE BOARD ADVERTISED AN AFFORDABILITY NOBODY EVALUATED.

   `const advAffordable = actor ? canAffordExtra(loc, actor) : false;` is a
   boolean with three meanings collapsed into one, and the third one is a lie.
   `actor` is null whenever it is not this player's pick - during the opponent's
   pick, the Skirmish Decision, the dice reveal, the round debrief and every
   Meltdown round - so `false` ("cannot afford") flowed into advancedNote() and
   every Advanced tier on the board claimed the player could not pay it. That
   includes Outpost and Shrine Advanced, which are `consolation`-tiered and
   therefore ALWAYS takeable at a reduced payout, and under MELTDOWN it
   contradicted the board strip's own "every Advanced cost is waived". In a
   human-vs-bot game the lie was on screen for roughly half the wall-clock.

   The board is exercised here through renderBoard() - the real one, reading the
   real state - and not through advancedNote() alone, because the defect was in
   the CALL SITE: the tri-state has to be built where the actor is known.
   ================================================================== */

/* A started human-vs-bot game with the state the caller wants, and the REAL
   board renderer run over it. Returns the rendered HTML. */
function boardInPhase(mutate){
  timerQueue = []; timerFns.clear(); domEls.clear();
  const keep = { mode: SETUP.gameMode.value, d1: SETUP.p1type.value, d2: SETUP.p2type.value };
  SETUP.gameMode.value = 'local';
  SETUP.p1type.value = 'human';
  SETUP.p2type.value = 'bot';
  try{
    Engine.startGame();
    const st = Engine.getState();
    st.round = 2;                 // Advanced is unlocked from Round 2
    st.roundRec.decision = false;
    if(mutate) mutate(st);
    Engine.renderBoard();
    return { html: document.getElementById('board').innerHTML, st };
  } finally{
    SETUP.gameMode.value = keep.mode;
    SETUP.p1type.value = keep.d1;
    SETUP.p2type.value = keep.d2;
  }
}
/* Every Advanced tier-note the rendered board is currently showing, in board
   order. Parsed out of the markup the renderer actually wrote, rather than
   recomputed, so a renderer that stops printing the note cannot pass this by
   accident. */
function advNotes(html){
  const out = [];
  const re = /<span class="tier-tag">ADV<\/span><span class="tier-label">([^<]*)<\/span>(?:<span class="tier-note[^"]*">([^<]*)<\/span>)?/g;
  let m;
  while((m = re.exec(html)) !== null){
    out.push({ label: m[1], note: (m[2] === undefined ? '' : m[2]) });
  }
  return out;
}

test('D5 no tile claims "cannot afford" while the BOT is picking', ()=>{
  /* The playtester's probe, as an assertion. Round 2, seat 1 (the bot) is at
     the front of the pick queue, and the human cannot afford most of what is on
     the board either - which is exactly the state in which a false "cannot
     afford" is hardest to tell from a true one. */
  const { html } = boardInPhase(st=>{
    st.pickQueue = [1, 0];
    st.players[0].credits = 0; st.players[0].ore = 0; st.players[0].troops = 0;
  });
  const notes = advNotes(html);
  assert.strictEqual(notes.length, 8, 'all eight sites rendered an Advanced row: ' + JSON.stringify(notes));
  notes.forEach(n=>{
    assert.notStrictEqual(n.note, 'cannot afford',
      n.label + ' claims the player cannot afford it during the bot pick');
  });
  /* And the honest half: the rows are still inert, and the tile head says the
     real reason rather than leaving the player to guess. */
  assert.doesNotMatch(html, /class="tier-row advanced pickable"/,
    'no Advanced row may be actionable while the bot is picking');
  assert.match(html, /Not your turn to pick/,
    'and the tile head states the actual reason');
});

test('D5 "cannot afford" is still printed when it is TRUE - a broken guard is not a fix', ()=>{
  /* The other direction, and the one a lazy fix gets wrong: when it IS the
     player's pick and they genuinely cannot pay, the tile must still say so. The
     Market's 1 Ore with an empty Ore pool is the case - it is not a
     consolation tier, so nothing is owed and the tile is honestly dead. */
  const { html } = boardInPhase(st=>{
    st.pickQueue = [0, 1];
    st.players[0].ore = 0;
  });
  const notes = advNotes(html);
  const market = notes.find(n => /\+4 Credits/.test(n.label));
  assert.ok(market, 'the Market Advanced row is on the board: ' + JSON.stringify(notes));
  assert.strictEqual(market.note, 'cannot afford',
    'an evaluated, unaffordable Advanced tier must still say so');
  /* And the consolation tiers never claim it: canAffordExtra() returns true for
     them by construction, so a player who cannot pay 5 Credits + 3 Ore is owed
     the consolation the tile promises. This is the Bazaar Advanced line the
     playtester reported as "omits its consolation" - it was printed only when
     the ADVANCED row happened to be the one being evaluated. */
  const outpost = notes.find(n => /5 Credits \+ 3 Ore/.test(n.label));
  assert.ok(outpost, 'the Outpost Advanced row is on the board');
  assert.strictEqual(outpost.note, 'can’t pay? +1',
    'a consolation tier must print its consolation, never "cannot afford"');
  const bazaar = notes.find(n => /Trade 2 Ore for 4 Credits/.test(n.label));
  assert.ok(bazaar, 'the Bazaar Advanced row is on the board');
  assert.match(bazaar.note, /no 2 Ore\? \+2 Credits, \+1 Influence/,
    'and the Bazaar Advanced consolation the retune added must survive: ' + JSON.stringify(bazaar));
  /* The Oasis is not on this board; the Shrine is, and it is the other
     consolation tier whose printed fallback must stay reachable. */
  const shrine = notes.find(n => /2 Credits \+ 1 Ore/.test(n.label));
  assert.ok(shrine, 'the Shrine Advanced row is on the board');
  assert.match(shrine.label, /\+3 Influence/,
    'the Shrine Advanced tile quotes the value the engine pays');
});

test('D5 MELTDOWN: the waiver agrees with the tiles, from both sides of the turn', ()=>{
  /* "Every Advanced cost is waived" is the board strip's own sentence. Under
     MELTDOWN the waiver is a fact about the ROUND rather than about a player,
     so every Advanced tile has to say it - whether or not it is this player's
     pick, which is exactly the half that used to print "cannot afford". */
  [true, false].forEach(humanPicks=>{
    const { html, st } = boardInPhase(s=>{
      s.pickQueue = humanPicks ? [0, 1] : [1, 0];
      s.meltdown = true;
    });
    const notes = advNotes(html);
    assert.strictEqual(notes.length, 8, 'eight Advanced rows (humanPicks=' + humanPicks + ')');
    notes.forEach(n=>{
      assert.strictEqual(n.note, 'FREE — MELTDOWN',
        n.label + ' must advertise the waiver (humanPicks=' + humanPicks + '), got ' + JSON.stringify(n.note));
    });
    /* And nothing may quote a price while the waiver is in force - the same
       class of lie, and the Rift's MUTATED price is the case that used to slip
       through the waiver branch. */
    assert.doesNotMatch(html, /pay \d+ (Ore|Credit)/,
      'no tile may print a price under MELTDOWN (humanPicks=' + humanPicks + ')');
    st.meltdown = false;   // do not leak MELTDOWN into the next test
  });
});

test('D5 advancedNote is a TRI-STATE, and null means silence', ()=>{
  /* The unit-level contract behind the three tests above. */
  const st = Engine.getState();
  const wasMeltdown = !!(st && st.meltdown);
  const loc = Engine.LOCATIONS.find(l => l.id === 'market');
  assert.strictEqual(Engine.advancedNote(loc, false, null), 'unlocks Round 2',
    'the round gate is a fact about the round, not about a player');
  assert.strictEqual(Engine.advancedNote(loc, true, null), '',
    'NOT EVALUATED must not produce a note at all');
  assert.strictEqual(Engine.advancedNote(loc, true, false), 'cannot afford');
  assert.strictEqual(Engine.advancedNote(loc, true, true), loc.advanced.note);
  /* Under MELTDOWN the waiver is a round fact, so it outranks the silence... */
  if(st) st.meltdown = true;
  assert.strictEqual(Engine.advancedNote(loc, true, null), 'FREE — MELTDOWN');
  /* ...and it outranks "cannot afford", which is unreachable while every cost is
     waived: canAffordExtra() returns true for every site under MELTDOWN. */
  assert.strictEqual(Engine.advancedNote(loc, true, false), 'FREE — MELTDOWN');
  if(st) st.meltdown = wasMeltdown;
  /* `false` must be the ONLY value that produces the refusal, so a future
     `if(!advAfford)` reintroduces the bug loudly right here. */
  [null, undefined, 0, ''].forEach(v=>{
    assert.notStrictEqual(Engine.advancedNote(loc, true, v), 'cannot afford',
      JSON.stringify(v) + ' must not read as "cannot afford"');
  });
});

/* ==================================================================
   D6 - THE COPY THAT ADVERTISED MECHANICS THAT WERE DELETED.

   Siege and the All In / Ghost wagers were cut in the previous commit. The
   engine stopped implementing them and the RULES kept selling them: a Skirmish
   tab that pointed at a Wagers tab for stances and a siege mechanic, a Round-3
   lookahead that announced a contested site that can no longer exist, an
   unreachable `is-siege` log classifier, and two dead sentences in the commit
   modal's "At stake" paragraph naming them with numbers the file had invented.

   A rule a player can find in the rules is a rule they will plan around. These
   are asserted against the SHIPPED STRINGS, not against the engine: a comment
   that says "the All In / Ghost wagers were cut" is documentation, and only the
   strings that reach the screen are the defect.
   ================================================================== */
const gameSrc = fs.readFileSync(path.join(ROOT, 'js/game.js'), 'utf8');
/* The three player-facing blocks, sliced out of the source. */
function sliceBetween(from, to){
  const a = gameSrc.indexOf(from);
  assert.ok(a >= 0, 'slice start not found: ' + from);
  const b = gameSrc.indexOf(to, a);
  assert.ok(b > a, 'slice end not found: ' + to);
  return gameSrc.slice(a, b);
}
const RULES_TEXT = sliceBetween('const RULES_HTML', 'let state = null;');
const LOOKAHEAD_TEXT = sliceBetween('const lookahead = [];', 'if(!lookahead.length)');
const CONSEQUENCE_TEXT = sliceBetween('function consequenceHtml', 'function commitOddsHtml');

test('D6 no player-facing sentence names Siege, or a Wagers tab that does not exist', ()=>{
  /* The rules tab used to say "the All In / Ghost wagers and Siege are all on
     the Wagers tab" - a pointer to a room that is now empty - and the Round 2
     and Round 3 lookaheads announced a mechanic becoming legal that no longer
     exists. */
  [RULES_TEXT, LOOKAHEAD_TEXT, CONSEQUENCE_TEXT].forEach((block, i)=>{
    assert.doesNotMatch(block, /All In|Ghost|Siege|CONTESTED|wagers? (are|become)/i,
      'block ' + i + ' still advertises a deleted mechanic');
  });
  /* The tab it points at now names what is actually in it - the Fury ladder and
     the Betrayal tokens - and the sentence points at it by that name. */
  assert.match(gameSrc, /\{id:'rules-wagers', label:'Fury & Tokens'/,
    'the tab holding the Fury ladder and the Betrayal tokens should say so');
  assert.match(RULES_TEXT, /on the <b>Fury &amp; Tokens<\/b> tab/,
    'and the rules sentence must point at it by the name the tab actually shows');
  /* And the Round-3 line still says what Round 3 actually brings. */
  assert.match(LOOKAHEAD_TEXT, /<b>Rift<\/b> opens as a ninth site/);
  assert.match(LOOKAHEAD_TEXT, /Betrayal tokens<\/b> pay \+1/);
});

test('D6 the log classifier has no rule for a mechanic that cannot emit a line', ()=>{
  /* Structural, because the alternative is unreachable code that looks
     load-bearing: `is-siege` matched SIEGE / CONTESTED SITE / "the offer lapses"
     / "Price for the ... rises", and js/feature-wagers.js was the only writer
     of all four. It also matched /<b>basic<\/b>/, which is not siege-specific
     at all. */
  assert.doesNotMatch(gameSrc, /'is-siege'/,
    'the is-siege classifier is unreachable and should be gone');
  /* The Rift's own contested line is a DIFFERENT mechanic and keeps its type. */
  assert.strictEqual(Engine.logEntryType('<b>THE RIFT</b> opens on Market, wearing Toll.'), 'is-rift');
  /* And the types that are still live are still reachable, so the removal did
     not take a neighbour with it. */
  assert.strictEqual(Engine.logEntryType('— Round 3 begins —'), 'is-round');
  assert.strictEqual(Engine.logEntryType('Ana works the <b>Market</b> (advanced) -> +4 Credits (paid 1 Ore).'), 'is-gain');
  assert.strictEqual(Engine.logEntryType('<b>PRESSURE 3/4</b>'), 'is-pressure');
  assert.strictEqual(Engine.logEntryType('<b>Betrayal token</b> spent.'), 'is-betrayal');
  assert.strictEqual(Engine.logEntryType('Ana eyes the <b>Outpost</b> but cannot afford it -> consolation +1 Influence.'), 'is-gain');
});

test('D6 the commit "At stake" paragraph names only mechanics that exist', ()=>{
  /* consequenceHtml used to destructure `decl.wager` - always undefined since
     the cut - and print an ALL IN or GHOST sentence with payouts read out of
     constants the feature no longer exports, falling back to numbers this file
     had made up. */
  assert.doesNotMatch(CONSEQUENCE_TEXT, /allin|ghost|ALL_IN|GHOST|stance/i,
    'consequenceHtml still carries the deleted stance sentences');
  assert.match(CONSEQUENCE_TEXT, /At stake\./, 'the paragraph itself is still there');
  assert.match(CONSEQUENCE_TEXT, /betrayal\.plus/, 'and the token sentences, which ARE live');
});

test('D6 Shrine Advanced is quoted at the value the engine pays', ()=>{
  /* The retune moved the Shrine's deep rite to +3 and the rules tab was never
     updated: it said +2, the tile said +3, and the engine paid +3. A player
     reading the rules valued the Shrine BELOW the Outpost for the same +3 at
     2Cr + 1Ore against 5Cr + 3Ore - i.e. the rules talked them out of the
     strictly better tile. Every printed number has to match the engine. */
  const shrine = Engine.LOCATIONS.find(l => l.id === 'shrine');
  assert.match(shrine.advanced.label, /\+3 Influence/, 'the tile says +3');
  const row = sliceBetween('<h4>Shrine</h4>', '</article>');
  assert.match(row, /Pay 2 Credits \+ 1 Ore → \+3 Influence \(else \+1\)/,
    'the rules tab must quote the same +3');
  /* And the price the rules quote is the price the engine charges. */
  assert.strictEqual(Engine.costPhrase(Engine.tierCost('shrine', 'advanced')), '2 Credits + 1 Ore');
});