/* THE FURY LADDER and CATCHING UP — the two rules that replaced the old flat
   "two wins in a row = +1" streak bonus.

   These live in js/rules.js, not in js/feature-wagers.js, for a load-order
   reason: rules.js loads BEFORE the feature and cannot import it, and the
   projection maths is pure. That makes this module the single source of truth
   for two things the game is judged on:

     1. The bonus the ladder adds to a committed total, and
     2. The Influence CEILING that Skirmish pays out under.

   Both are read by three consumers that must never disagree - the resolution
   in game.js (which applies the live feature's rung), the odds the UI prints
   (which come from here), and the bot's reasoning (which also comes from
   here, through a compatibility alias). A disagreement is not a cosmetic bug:
   it means the number on the commit screen is not the number the dice are
   rolled against.

   test/rules.test.js covers the projection maths these feed. This file covers
   the LADDER ITSELF as a contract — the exact table, the monotonicity and
   clamping properties that make it safe to reason about, Catching Up's
   boundary behaviour, and the one alias whose whole job is to stop the bot
   double-counting its own Fury. */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {Rules} = require('../js/rules.js');

/* The contract, written out once. If a future rebalance changes the table,
   this is the line that fails - and it should fail, because the table below is
   also what the rules copy in js/feature-wagers.js prints to the player. */
const LADDER = [
  {streak: 0, bonus: 0, cap: 4},
  {streak: 1, bonus: 0, cap: 4},
  {streak: 2, bonus: 1, cap: 4},
  {streak: 3, bonus: 2, cap: 5},
  {streak: 4, bonus: 3, cap: 6},
  {streak: 5, bonus: 3, cap: 6},
  {streak: 9, bonus: 3, cap: 6},
];

/* -------------------------------------------------------------- the table */

test('Fury ladder: the exact bonus and cap for every rung', () => {
  LADDER.forEach(({streak, bonus, cap}) => {
    const f = Rules.furyFor(streak);
    assert.strictEqual(f.streak, streak, `Fury ${streak} reports its own streak`);
    assert.strictEqual(f.bonus, bonus, `Fury ${streak} bonus`);
    assert.strictEqual(f.cap, cap, `Fury ${streak} Influence cap`);
  });
});

test('Fury ladder: the four rungs the game actually names, in one assertion', () => {
  /* The literal acceptance criterion for the ladder: streak 1 -> +0,
     2 -> +1, 3 -> +2, 4 -> +3. Asserted as four values rather than four
     separate tests so a regression reads as one broken ladder instead of
     four unrelated failures. */
  assert.deepStrictEqual(
    [1, 2, 3, 4].map(s => Rules.furyFor(s).bonus),
    [0, 1, 2, 3],
    'streak 1/2/3/4 must pay +0/+1/+2/+3'
  );
});

test('Fury ladder: the cap is 4 / 4 / 5 / 6 across the four rungs', () => {
  assert.deepStrictEqual(
    [1, 2, 3, 4].map(s => Rules.furyFor(s).cap),
    [4, 4, 5, 6],
    'the ceiling must rise with the streak'
  );
});

test('Fury ladder: the top rung is a plateau, not a ramp', () => {
  /* 4+ pays +3 at cap 6 forever. If this ever became unbounded, a long
     streak would be a runaway and the table above would need extending. */
  assert.strictEqual(Rules.furyFor(4).bonus, Rules.furyFor(97).bonus);
  assert.strictEqual(Rules.furyFor(4).cap, Rules.furyFor(97).cap);
});

test('Fury ladder: bonus and cap are both monotonic in the streak', () => {
  for(let s = 0; s < 12; s++){
    const a = Rules.furyFor(s), b = Rules.furyFor(s + 1);
    assert.ok(b.bonus >= a.bonus, `bonus must not drop from ${s} to ${s+1}`);
    assert.ok(b.cap >= a.cap, `cap must not drop from ${s} to ${s+1}`);
  }
});

test('Fury ladder: a negative or nonsense streak reads as zero, never as a bonus', () => {
  [-5, -1, 0, NaN, undefined, null, 'three', {}].forEach(v => {
    const f = Rules.furyFor(v);
    assert.ok(f.streak >= 0, `streak ${String(v)} must clamp to >= 0`);
    assert.ok(f.bonus >= 0 && f.cap >= 1, `streak ${String(v)} must be a valid rung`);
  });
  assert.strictEqual(Rules.furyFor(-5).bonus, 0);
  assert.strictEqual(Rules.furyFor(-5).cap, 4);
});

/* ----------------------------------------------------------------- fever */

test('furyCap: Skirmish Fever lifts every rung to 6, including a cold one', () => {
  /* The point of Fever is that it lifts the CEILING for the whole table.
     A player on no streak is not punished for having no streak - otherwise
     a player who drew the Fever event would be playing a different, worse
     game than one who did not. */
  [0, 1, 2, 3, 4, 5].forEach(s => {
    assert.strictEqual(Rules.furyCap(s, true), Rules.FURY_FEVER_CAP,
      `Fury ${s} on Fever`);
  });
});

test('furyCap: without Fever the cap is the plain rung cap', () => {
  assert.strictEqual(Rules.furyCap(0, false), 4);
  assert.strictEqual(Rules.furyCap(2, false), 4);
  assert.strictEqual(Rules.furyCap(3, false), 5);
  assert.strictEqual(Rules.furyCap(4, false), 6);
});

test('furyCap: Fever can only raise the cap, never lower it', () => {
  for(let s = 0; s < 10; s++){
    assert.ok(Rules.furyCap(s, true) >= Rules.furyCap(s, false),
      `Fever must not reduce the cap at streak ${s}`);
  }
});

test('FURY_FEVER_CAP is 6 and is higher than every plain cap', () => {
  assert.strictEqual(Rules.FURY_FEVER_CAP, 6);
  [0, 1, 2, 3, 4, 5].forEach(s => {
    assert.ok(Rules.furyCap(s, false) <= Rules.FURY_FEVER_CAP);
  });
});

/* ------------------------------------------- the ladder inside a projection */

test('projectSide: the ladder is the ONLY source of the streak bonus', () => {
  /* A player with no card, no Garrison bonus and no declared token. The
     difference between the base and the troop count IS the streak bonus, so
     this is a direct read of what a committed total will actually be. */
  const bonusFor = (winStreak) => {
    const p = Rules.projectSide({troops: 3, winStreak});
    return p.base - 3;
  };
  assert.deepStrictEqual(
    [1, 2, 3, 4].map(bonusFor),
    [0, 1, 2, 3],
    'the ladder bonus must be added to the committed total'
  );
});

test('projectSide: a card modifier and the ladder ADD, they do not replace', () => {
  /* base = troops + Fury + card, so every component is independently
     visible. A regression that replaced rather than added would show up
     here as base === max(troops+fury, troops+card). Ambush is the +2 card
     because it has no cost to fizzle and no dice to fold in. */
  const plain  = Rules.projectSide({troops: 3, winStreak: 3});                 // +0
  const carded = Rules.projectSide({troops: 3, winStreak: 3, cardId:'ambush'}); // +2
  assert.strictEqual(plain.base, 5);    // 3 troops + Fury 2
  assert.strictEqual(carded.base, 7);   // 3 troops + Fury 2 + Ambush 2
  assert.strictEqual(carded.base - plain.base, 2, 'the card is additive');
});

test('projectSide: it reports the rung and the cap it is standing on', () => {
  const p = Rules.projectSide({troops: 1, winStreak: 4});
  assert.strictEqual(p.fury.bonus, 3);
  assert.strictEqual(p.fury.cap, 6);
  assert.strictEqual(p.winStreak, 4, 'the projection carries its own streak');
});

/* The bot's compatibility patch. js/feature-wagers.js corrects its projection
   with `(fury.bonus - projected.momentum)`. For that to be a no-op rather
   than a silent DOUBLE COUNT of the streak bonus, `momentum` has to report
   the bonus already baked into `base`. It used to report the retired flat
   +1, so at every streak >= 2 the bot reasoned about a total one point too
   high and picked its wagers accordingly - a bug with no visible symptom,
   because the bot's commit is not shown to the player. This is the test that
   makes the alias's contract explicit. */
test('the deprecated `momentum` alias is a NO-OP against the ladder', () => {
  for(const streak of [0, 1, 2, 3, 4, 5, 8]){
    const p = Rules.projectSide({troops: 2, winStreak: streak});
    const delta = p.fury.bonus - (p.momentum | 0);
    assert.strictEqual(delta, 0,
      `at streak ${streak} the correction must be exactly 0, got ${delta}`);
  }
});

test('the deprecated `momentum` alias is never undefined', () => {
  /* `undefined | 0` is 0, which happens to be the right answer at streak
     0-1 and the WRONG answer everywhere else. The alias has to be a real
     number or the bot silently double-counts from streak 2 up. */
  for(const streak of [0, 1, 2, 3, 4, 5]){
    const p = Rules.projectSide({troops: 1, winStreak: streak});
    assert.strictEqual(typeof p.momentum, 'number',
      `momentum must be a number at streak ${streak}`);
    assert.strictEqual(p.momentum, Rules.furyFor(streak).bonus);
  }
});

/* ---------------------------------------------------------- catching up */

test('Catching Up: fires at exactly streak 3 and not one below', () => {
  /* The boundary is the whole rule. One rung lower and the valve is inert;
     one rung higher and it is a tax on being good at the game. */
  const fires = Rules.catchingUp(10, 7, Rules.CATCHING_UP.minStreak, 1);
  const doesNot = Rules.catchingUp(10, 7, Rules.CATCHING_UP.minStreak - 1, 1);
  assert.strictEqual(fires.applied, Rules.CATCHING_UP.bonus);
  assert.strictEqual(doesNot.applied, 0);
  assert.strictEqual(Rules.CATCHING_UP.minStreak, 3);
  assert.strictEqual(Rules.CATCHING_UP.bonus, 2);
});

test('Catching Up: the +2 lands on the TRAILER and only the trailer', () => {
  const r = Rules.catchingUp(10, 7, 4, 1);
  assert.strictEqual(r.applied, 2);
  assert.strictEqual(r.leaderIdx, 0, 'the aggressor was ahead');
  assert.strictEqual(r.defTotal, 9, 'the trailer gains the 2');
  assert.strictEqual(r.aggTotal, 10, 'the leader is untouched');
});

test('Catching Up: it is symmetric - the trailer can be the one on the streak', () => {
  const r = Rules.catchingUp(6, 9, 1, 5);
  assert.strictEqual(r.applied, 2);
  assert.strictEqual(r.leaderIdx, 1, 'the defender was ahead');
  assert.strictEqual(r.aggTotal, 8, 'the aggressor, trailing, gains the 2');
  assert.strictEqual(r.defTotal, 9, 'the leader is untouched');
});

test('Catching Up: a tie has no winner, so it never fires', () => {
  /* No leader means no streak to punish. A tie that triggered the valve
     would hand +2 to a coin-flip winner for no reason at all. */
  [[8,8,4,4], [0,0,9,9], [5,5,3,0]].forEach(([a,d,as,ds]) => {
    const r = Rules.catchingUp(a, d, as, ds);
    assert.strictEqual(r.applied, 0);
    assert.strictEqual(r.leaderIdx, -1);
  });
});

test('Catching Up: it keys off the LEADER\'s streak, not the loser\'s', () => {
  /* A trailing player on their own hot streak (they just lost, so their
     streak is 0 - but construct it directly) must not trigger the valve
     against themselves. */
  const loserIsHot = Rules.catchingUp(10, 7, 0, 5);
  assert.strictEqual(loserIsHot.applied, 0,
    'a 5-streak on the LOSING side is not what triggers the valve');
});

test('Catching Up: it can flip a loss into a win and a loss into a tie', () => {
  /* Which is the entire reason it exists. If it could not change an outcome
     it would be a rounding error dressed up as an anti-snowball measure. */
  const flipped = Rules.catchingUp(7, 8, 0, 3);
  assert.strictEqual(flipped.applied, 2);
  assert.strictEqual(flipped.aggTotal, 9);
  assert.ok(flipped.aggTotal > flipped.defTotal, 'a loss became a win');

  const tied = Rules.catchingUp(7, 9, 0, 3);
  assert.strictEqual(tied.applied, 2);
  assert.strictEqual(tied.aggTotal, tied.defTotal, 'a loss became a tie');

  const cold = Rules.catchingUp(7, 9, 0, 0);
  assert.strictEqual(cold.applied, 0, 'with no streak it stays a loss');
});

test('Catching Up: it is a single pass, applied to the TOTALS not the Influence', () => {
  /* Re-checking would compound. The engine applies it once inside
     resolveSkirmish, and this must be the same rule or the odds panel would
     be describing a game the game does not play. The totals here are already
     post-application, so applying the rule again must not be idempotent-by-
     accident: it is simply not applied twice because there is no loop. */
  const r = Rules.catchingUp(10, 7, 4, 1);
  assert.strictEqual(r.applied, 2);
  assert.strictEqual(r.streak, 4, 'it reports the streak it fired on');
  /* The function returns the ADJUSTED totals in one pass. There is no
     second application, which is what "single pass" means. */
  assert.strictEqual(r.defTotal - r.applied, 7, 'the pre-adjustment total');
});

/* ------------------------------------------------- through projectSkirmish */

test('projectSkirmish: Catching Up makes the trailer look better on screen', () => {
  /* The preview is the rule, applied to the two sides' MEANS. Without it the
     commit modal would tell a trailing player on a 3+ streak's opponent
     that they are dead when the engine is about to hand them +2. */
  const asLeader = Rules.projectSkirmish(
    {troops: 5, winStreak: 4},   // the leader, hot
    {troops: 3, winStreak: 0},
    {}
  );
  const asTrailer = Rules.projectSkirmish(
    {troops: 3, winStreak: 0},   // me, trailing
    {troops: 5, winStreak: 4},
    {}
  );
  assert.ok(asLeader.catchingUp.applied > 0, 'it fires in both framings');
  assert.strictEqual(asLeader.catchingUp.theirDelta, 2, 'the opponent gets +2');
  assert.strictEqual(asTrailer.catchingUp.mineDelta, 2, 'I get +2');
  /* Symmetric by construction: the same fight, described from two seats. */
  assert.ok(Math.abs(asLeader.winPct - asTrailer.losePct) < 1e-9,
    'the leader sees exactly the trailer\'s loss rate');
});

test('projectSkirmish: no 3+ streak means no Catching Up at all', () => {
  const p = Rules.projectSkirmish(
    {troops: 5, winStreak: 2},
    {troops: 3, winStreak: 0},
    {}
  );
  assert.strictEqual(p.catchingUp.applied, 0);
  assert.strictEqual(p.catchingUp.mineDelta, 0);
  assert.strictEqual(p.catchingUp.theirDelta, 0);
});

test('projectSkirmish: the reported cap is the higher Fury rung, lifted by Fever', () => {
  const plain = Rules.projectSkirmish({troops: 2, winStreak: 2}, {troops: 2, winStreak: 0}, {});
  assert.strictEqual(plain.cap, 4, 'both sides are on a cap-4 rung');

  const fever = Rules.projectSkirmish({troops: 2, winStreak: 2}, {troops: 2, winStreak: 0}, {fever:true});
  assert.strictEqual(fever.cap, Rules.FURY_FEVER_CAP, 'Fever lifts the paid cap');
  assert.strictEqual(fever.myCap, Rules.FURY_FEVER_CAP);
  assert.strictEqual(fever.theirCap, Rules.FURY_FEVER_CAP);
});

test('projectSkirmish: a hot leader inflates the cap the UI promises', () => {
  /* The cap is the single most decision-changing number in the whole Skirmish
     and it used to be invisible. It has to be right. */
  const p = Rules.projectSkirmish({troops: 3, winStreak: 4}, {troops: 3, winStreak: 0}, {});
  assert.strictEqual(p.cap, 6, 'a 4-streak leader raises the ceiling to 6');
  assert.strictEqual(p.myCap, 6);
  assert.strictEqual(p.theirCap, 4, 'the cold side keeps the floor cap');
});
