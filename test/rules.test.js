/* OD.Rules — the game's actual maths, unit-tested.
   Every assertion here is a closed-form value, so a regression in the
   engine's maths is caught without booting a browser or rolling a die. */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {Rules} = require('../js/rules.js');

/* diceDist(n) is offset-indexed (index i is the total i + n); maxDiceDist is
   value-indexed (index t is the maximum t + 1). The two need different
   offsets, which is exactly the trap the module documents. */
const sum = a => a.reduce((x, y) => x + y, 0);
const meanAt = (a, offset) => sum(a.map((v, i) => v * (i + offset))) / sum(a);
const diceMean = (n, a) => meanAt(a, n);
/* maxDiceDist starts at 1, so its offset is 1. */
const valueMean = a => meanAt(a, 1);
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps),
  (msg || 'not close') + ': got ' + a + ', expected ' + b);

/* ------------------------------------------------------------------ dice */

test('diceDist(1): a flat d6, sums to 1', () => {
  const d = Rules.diceDist(1);
  assert.strictEqual(d.length, 6, '5n+1 for n=1 die');
  close(sum(d), 1);
  d.forEach(p => close(p, 1 / 6));
  /* A single die is perfectly flat, so index 3 (the total 4) is a maximum —
     but it TIES all five others rather than peaking. The genuinely peaked
     case is covered by the 2d6 test below. */
  close(d[3], Math.max(...d));
  close(d[3], Math.min(...d));
});

test('diceDist(1) mean is 3.5', () => {
  close(diceMean(1, Rules.diceDist(1)), 3.5);
});

test('diceDist(2): 2d6 sums, mean is 7, peak at 7', () => {
  const d = Rules.diceDist(2);
  assert.strictEqual(d.length, 11);
  close(sum(d), 1);
  close(diceMean(2, d), 7);
  /* index 5 is the total 7 - the classic 2d6 mode, and here it is a real
     peak rather than a tie. */
  const peak = d.indexOf(Math.max(...d));
  assert.strictEqual(peak, 5);
  close(d[5], 6 / 36);
  close(d[0], 1 / 36);   // double ones
  close(d[10], 1 / 36);  // double sixes
});

test('diceDist(3) mean is 10.5 and sums to 1', () => {
  const d = Rules.diceDist(3);
  assert.strictEqual(d.length, 16);
  close(sum(d), 1);
  close(diceMean(3, d), 10.5);
});

test('maxDiceDist(1) is a flat d6', () => {
  const d = Rules.maxDiceDist(1);
  assert.strictEqual(d.length, 6);
  close(sum(d), 1);
  d.forEach(p => close(p, 1 / 6));
});

test('maxDiceDist(2): P(max === t) === (2t-1)/36', () => {
  const d = Rules.maxDiceDist(2);
  assert.strictEqual(d.length, 6);
  close(sum(d), 1);
  for(let t = 1; t <= 6; t++) close(d[t - 1], (2 * t - 1) / 36, 1e-12, 'P(max=' + t + ')');
  close(d[0], 1 / 36);  // both dice showed a 1
  close(d[5], 11 / 36); // at least one die showed a 6
});

test('maxDiceDist(2): E[max of 2d6] === 161/36, NOT 91/36', () => {
  /* E[max] = sum t*(2t-1)/36 = (2*91 - 21)/36 = 161/36 = 4.4722...
     91/36 = 2.5278 is E[MIN of 2d6] - the "bad roll" case, and it is the
     number the original spec quoted for the max. max + min = sum, so
     161/36 + 91/36 = 7 = E[2d6 sum] exactly, which is the cross-check. */
  const d = Rules.maxDiceDist(2);
  close(sum(d), 1);
  close(valueMean(d), 161 / 36);
  close(Rules.E_MAX_2D6, 161 / 36);
  /* the same distribution reversed is the distribution of the MINIMUM */
  const minDist = d.slice().reverse();
  close(valueMean(minDist), 91 / 36);
  close(Rules.E_MAX_2D6 + 91 / 36, 7);
});

test('maxDiceDist(3) sums to 1 and E[max] is between E[2d6 max] and 6', () => {
  const d = Rules.maxDiceDist(3);
  close(sum(d), 1);
  const e = valueMean(d);
  assert.ok(e > Rules.E_MAX_2D6, 'E[max of 3] > E[max of 2]');
  assert.ok(e < 6);
  /* sum t*(3t^2-3t+1)/216 = (3*441 - 3*91 + 21)/216 = 1071/216 */
  close(e, 1071 / 216, 1e-9);
});

/* ----------------------------------------------------------------- cards */

test('cardModParts: plain fixed modifiers', () => {
  close(Rules.cardModParts('berserker', {}).fixed, 5);
  close(Rules.cardModParts('ambush', {}).fixed, 2);
  close(Rules.cardModParts('feint', {}).fixed, 0);
  close(Rules.cardModParts('undermine', {}).opponentMod, -2);
  assert.strictEqual(Rules.cardModParts('rally', {}).fizzle, null);
});

test('cardModParts: blitz only counts on the aggressor side', () => {
  close(Rules.cardModParts('blitz', {isAggressor: true}).fixed, 2);
  close(Rules.cardModParts('blitz', {isAggressor: false}).fixed, 0);
});

test('cardModParts: Overrun fizzles to 0 without 1 Ore', () => {
  const paid = Rules.cardModParts('overrun', {ore: 1});
  assert.strictEqual(paid.fixed, 3);
  assert.strictEqual(paid.fizzled, false);
  assert.deepStrictEqual(paid.fizzle, {resource: 'ore', cost: 1, reducesTo: 0});

  const broke = Rules.cardModParts('overrun', {ore: 0});
  assert.strictEqual(broke.fixed, 0, 'no Ore -> resolves as +0');
  assert.strictEqual(broke.fizzled, true);
  assert.strictEqual(broke.reducesTo, 0);
});

test('cardModParts: Onslaught drops to 1 without 2 Credits', () => {
  const paid = Rules.cardModParts('onslaught', {credits: 2});
  assert.strictEqual(paid.fixed, 4);
  assert.strictEqual(paid.fizzled, false);
  assert.deepStrictEqual(paid.fizzle, {resource: 'credits', cost: 2, reducesTo: 1});

  const short = Rules.cardModParts('onslaught', {credits: 1});
  assert.strictEqual(short.fixed, 1, 'short on Credits -> resolves as +1');
  assert.strictEqual(short.fizzled, true);
  assert.strictEqual(short.reducesTo, 1);
});

test('cardModParts: Wildcard is 1 die, +1 for the Gambler leader', () => {
  const plain = Rules.cardModParts('wild', {});
  assert.strictEqual(plain.dice, 1);
  assert.strictEqual(plain.rollMode, 'single');
  assert.strictEqual(plain.fixed, 0);

  const gambler = Rules.cardModParts('wild', {isGambler: true});
  assert.strictEqual(gambler.dice, 1);
  assert.strictEqual(gambler.fixed, 1);
});

test('cardModParts: Desperate Gambit is the MAX of 2 dice, not the sum', () => {
  const plain = Rules.cardModParts('gambit', {});
  assert.strictEqual(plain.dice, 2);
  assert.strictEqual(plain.rollMode, 'max');
  assert.strictEqual(plain.fixed, 0);

  const gambler = Rules.cardModParts('gambit', {isGambler: true});
  assert.strictEqual(gambler.fixed, 1);

  /* The whole point: gambit's expected modifier is 161/36 (4.47), which is
     what game.js already lists as CARD_DEFS.gambit.avg. If it were the sum
     of two dice the answer would be 7. */
  const p = Rules.projectSide({troops: 0, cardId: 'gambit'});
  close(p.mean, 161 / 36);
  assert.notStrictEqual(p.mean, 7);
});

test('cardModParts: unknown card throws instead of silently returning 0', () => {
  assert.throws(() => Rules.cardModParts('nope', {}), /unknown tactic card/);
});

/* ------------------------------------------------------------ projection */

test('projectSide: no card, no dice - a single spike', () => {
  const p = Rules.projectSide({troops: 3});
  assert.deepStrictEqual(p.dist, [1]);
  assert.strictEqual(p.mean, 3);
  assert.strictEqual(p.min, 3);
  assert.strictEqual(p.max, 3);
  assert.strictEqual(p.fixedBonus, 0);
  assert.strictEqual(p.dice, 0);
});

test('projectSide: Wildcard spans 1..6 around a fixed base', () => {
  const p = Rules.projectSide({troops: 2, cardId: 'wild'});
  assert.strictEqual(p.base, 2);
  assert.strictEqual(p.min, 3);
  assert.strictEqual(p.max, 8);
  close(sum(p.dist), 1);
  close(p.mean, 2 + 3.5);
  assert.strictEqual(p.dist.length, 6);
});

test('projectSide: Gambit uses the max distribution', () => {
  const p = Rules.projectSide({troops: 2, cardId: 'gambit'});
  assert.strictEqual(p.min, 3);
  assert.strictEqual(p.max, 8);
  close(p.mean, 2 + 161 / 36);
  /* identical shape to maxDiceDist(2) */
  Rules.maxDiceDist(2).forEach((v, i) => close(p.dist[i], v, 1e-12));
});

test('projectSide: Gambler leader adds a fixed +1 to a die card', () => {
  const plain = Rules.projectSide({troops: 2, cardId: 'wild'});
  const lucky = Rules.projectSide({troops: 2, cardId: 'wild', isGambler: true});
  assert.strictEqual(lucky.fixedBonus, plain.fixedBonus + 1);
  close(lucky.mean, plain.mean + 1);
});

test('projectSide: fizzle lowers the projection, not just the card', () => {
  /* Onslaught with 0 Credits resolves as +1, so the whole side is 2 troops
     + 1 = a flat 3. Pay the 2 Credits and it becomes a flat 6. */
  const broke = Rules.projectSide({troops: 2, cardId: 'onslaught', credits: 0});
  assert.strictEqual(broke.card.fizzled, true);
  assert.strictEqual(broke.fixedBonus, 1);
  assert.strictEqual(broke.min, 3);
  assert.strictEqual(broke.max, 3);
  close(broke.mean, 3);

  const paid = Rules.projectSide({troops: 2, cardId: 'onslaught', credits: 2});
  assert.strictEqual(paid.card.fizzled, false);
  assert.strictEqual(paid.fixedBonus, 4);
  assert.strictEqual(paid.max, 6);
});

/* ============================== FURY LADDER (G7) ==========================
   The engine's flat "Momentum: +1 at two wins" rule is GONE. It was replaced
   by a four-rung ladder plus Catching Up, and these are the numbers the odds
   panel in the commit modal is computed from, so they are pinned here rather
   than only in the rules copy. */

test('Fury ladder: the exact bonus/cap table, rung by rung', () => {
  /* streak 1 -> +0 cap 4 | 2 -> +1 cap 4 | 3 -> +2 cap 5 | 4+ -> +3 cap 6 */
  const expect = [
    [0, 0, 4], [1, 0, 4], [2, 1, 4], [3, 2, 5], [4, 3, 6], [5, 3, 6], [9, 3, 6],
  ];
  expect.forEach(([streak, bonus, cap]) => {
    const f = Rules.furyFor(streak);
    assert.strictEqual(f.streak, streak);
    assert.strictEqual(f.bonus, bonus, `Fury ${streak} bonus`);
    assert.strictEqual(f.cap, cap, `Fury ${streak} cap`);
  });
});

test('Fury ladder: projectSide folds the rung into fixedBonus, and reports the cap', () => {
  /* The acceptance figure: +0 / +1 / +2 / +3 for streaks 1 / 2 / 3 / 4. */
  close(Rules.projectSide({troops: 1, winStreak: 1}).fixedBonus, 0);
  close(Rules.projectSide({troops: 1, winStreak: 2}).fixedBonus, 1);
  close(Rules.projectSide({troops: 1, winStreak: 3}).fixedBonus, 2);
  close(Rules.projectSide({troops: 1, winStreak: 4}).fixedBonus, 3);
  /* And the OLD rule is definitively gone: 5 wins used to be worth the same
     +1 as 2 wins. It is now the top rung and stays there. */
  close(Rules.projectSide({troops: 1, winStreak: 5}).fixedBonus, 3);
  assert.strictEqual(Rules.projectSide({troops: 1, winStreak: 6}).fury.cap, 6);
});

test('Fury ladder: Skirmish Fever lifts every rung to a cap of 6', () => {
  [0, 1, 2, 3, 4].forEach(streak => {
    assert.strictEqual(Rules.furyCap(streak, true), 6, `Fever cap at streak ${streak}`);
  });
  /* Without Fever the cap is the rung's own, and never above 6. */
  assert.strictEqual(Rules.furyCap(0, false), 4);
  assert.strictEqual(Rules.furyCap(2, false), 4);
  assert.strictEqual(Rules.furyCap(3, false), 5);
  assert.strictEqual(Rules.furyCap(4, false), 6);
});

test('Fury bonus and a card modifier add up, they do not replace one another', () => {
  /* base = troops + Fury + card, so every component is visible in min/max. */
  const p = Rules.projectSide({troops: 2, winStreak: 3, cardId: 'berserker'});
  assert.strictEqual(p.fixedBonus, 2 + 5);
  assert.strictEqual(p.min, 2 + 2 + 5);
  assert.strictEqual(p.max, 2 + 2 + 5);
});

/* ============================ CATCHING UP (G7) ============================ */

test('Catching Up: fires at a 3+ streak on the leader and adds +2 to the loser', () => {
  const r = Rules.catchingUp(10, 7, 4, 1);   // aggressor leads on a 4-streak
  assert.strictEqual(r.applied, 2);
  assert.strictEqual(r.leaderIdx, 0);
  assert.strictEqual(r.streak, 4);
  assert.strictEqual(r.aggTotal, 10, 'the leader is untouched');
  assert.strictEqual(r.defTotal, 9, 'the trailer gets +2');
});

test('Catching Up: a 2-streak leader does not trigger it', () => {
  const r = Rules.catchingUp(10, 7, 2, 1);
  assert.strictEqual(r.applied, 0);
  assert.strictEqual(r.leaderIdx, -1);
  assert.strictEqual(r.defTotal, 7, 'the totals are returned untouched');
});

test('Catching Up: the TRAILER can be the one on the hot streak', () => {
  /* Defender ahead on a 5-streak, so the +2 goes to the aggressor. */
  const r = Rules.catchingUp(6, 9, 1, 5);
  assert.strictEqual(r.applied, 2);
  assert.strictEqual(r.leaderIdx, 1);
  assert.strictEqual(r.aggTotal, 8);
  assert.strictEqual(r.defTotal, 9);
});

test('Catching Up: a tie has no winner, so it never fires', () => {
  const r = Rules.catchingUp(8, 8, 4, 4);
  assert.strictEqual(r.applied, 0);
  assert.strictEqual(r.aggTotal, 8);
  assert.strictEqual(r.defTotal, 8);
});

test('Catching Up: it can flip a loss into a win and a loss into a tie, which is the point', () => {
  /* I am behind by 1 and the LEADER is on a 3-streak, so the +2 turns a
     clear loss into a win. Without the rule the fight was already over. */
  const flipped = Rules.catchingUp(7, 8, 0, 3);
  assert.strictEqual(flipped.applied, 2);
  assert.ok(flipped.aggTotal > flipped.defTotal, 'the trailer is now AHEAD: 9 vs 8');

  /* Behind by exactly 2 against the same hot leader: +2 lands it on a tie,
     which still pays nothing, and is still better than the loss. */
  const tied = Rules.catchingUp(7, 9, 0, 3);
  assert.strictEqual(tied.aggTotal, 9);
  assert.strictEqual(tied.defTotal, 9);

  /* Same deficit, nobody on a streak: untouched, and still a loss. */
  const cold = Rules.catchingUp(7, 9, 0, 0);
  assert.strictEqual(cold.applied, 0);
  assert.ok(cold.aggTotal < cold.defTotal);
});

/* ==================== head-to-head margin convolution =====================
   A regression guard for a bug that every pre-G7 test missed: the margin
   distribution used to accumulate at `i + j`, which is the mirror of the
   correct `i - j`. A UNIFORM distribution hides it (reversing 1/6 six times
   is a relabelling), so Wildcard-vs-nothing passed. Desperate Gambit is
   skewed and exposed it. These are checked against a brute-force enumeration
   of every reachable outcome, not against a hand-copied number. */

test('headToHead: matches a brute-force enumeration even on a SKEWED distribution', () => {
  /* 3 troops + Wildcard (1 die, 4..9) vs 2 troops + Desperate Gambit
     (max of 2d6). 6 * 36 = 216 equally likely outcomes. */
  const mine = Rules.projectSide({troops: 3, cardId: 'wild'});
  const theirs = Rules.projectSide({troops: 2, cardId: 'gambit'});
  const h = Rules.headToHead(mine, theirs, 4);

  const faces = d => Array.from({length: 6}, (_, i) => i + 1);
  let w = 0, t = 0, l = 0;
  faces().forEach(m => faces().forEach(a => faces().forEach(b => {
    const mineTotal = 3 + m;
    const theirTotal = 2 + Math.max(a, b);
    if(mineTotal > theirTotal) w++; else if(mineTotal === theirTotal) t++; else l++;
  })));

  close(h.winPct, w / 216 * 100, 1e-9, 'win');
  close(h.tiePct, t / 216 * 100, 1e-9, 'tie');
  close(h.losePct, l / 216 * 100, 1e-9, 'lose');
  /* The pre-fix figure was 74.54% - assert we are nowhere near it. */
  assert.ok(h.winPct < 50, 'not the mirrored-convolution answer');
});

test('headToHead: swapping the two sides swaps the three percentages', () => {
  const a = Rules.projectSide({troops: 1, cardId: 'gambit'});
  const b = Rules.projectSide({troops: 4, cardId: 'wild'});
  const ab = Rules.headToHead(a, b, 4);
  const ba = Rules.headToHead(b, a, 4);
  close(ab.winPct, ba.losePct, 1e-9);
  close(ab.losePct, ba.winPct, 1e-9);
  close(ab.tiePct, ba.tiePct, 1e-9);
});

/* ========================== projectSkirmish (G8) ==========================
   The single call the commit modal's odds panel makes. */

test('projectSkirmish: percentages total 100 and the cap defaults to the higher Fury rung', () => {
  const p = Rules.projectSkirmish(
    {troops: 3, winStreak: 0},
    {troops: 2, cardId: 'wild', winStreak: 2}
  );
  close(p.winPct + p.tiePct + p.losePct, 100, 1e-9);
  /* Defender walks in on a 2-streak, which is cap 4 - so the cap is 4 even
     though the aggressor could climb higher on a later round. */
  assert.strictEqual(p.myCap, 4);
  assert.strictEqual(p.theirCap, 4);
  assert.strictEqual(p.cap, 4);
});

test('projectSkirmish: Skirmish Fever raises the paid cap to 6', () => {
  const plain = Rules.projectSkirmish({troops: 6}, {troops: 1}, {});
  const fever = Rules.projectSkirmish({troops: 6}, {troops: 1}, {fever: true});
  assert.strictEqual(plain.cap, 4);
  assert.strictEqual(fever.cap, 6);
  assert.ok(fever.ev > plain.ev, 'a bigger cap pays a bigger blowout');
});

test('projectSkirmish: a 3+ streak on the leader makes the trailer look better', () => {
  /* Identical commits, but the defender is on a 3-streak, so the
     anti-snowball valve fires in MY favour as the trailer. */
  const asTrailer = Rules.projectSkirmish(
    {troops: 2, winStreak: 0},
    {troops: 3, winStreak: 3}
  );
  const asLeader = Rules.projectSkirmish(
    {troops: 3, winStreak: 0},
    {troops: 2, winStreak: 3}
  );
  assert.ok(asTrailer.catchingUp.applied === 2, 'the +2 is applied to me');
  assert.strictEqual(asTrailer.catchingUp.mineDelta, 2);
  assert.ok(asTrailer.winPct > asLeader.losePct - 1e-9,
    'being the trailer against a hot leader is not worse than leading into it');
});

test('thresholdSentence: speaks plain English for all three cases', () => {
  assert.match(Rules.thresholdSentence(0), /already win/i);
  assert.match(Rules.thresholdSentence(3), /&ge; 3/, 'the >= is an HTML entity, the modal is HTML');
  assert.match(Rules.thresholdSentence(7), /no single die/i);
});


/* ----------------------------------------------------------- head to head */

test('headToHead: identical sides are symmetric', () => {
  const side = Rules.projectSide({troops: 2, cardId: 'wild'});
  const h = Rules.headToHead(side, side, 4);
  close(h.winPct, h.losePct, 1e-9, 'two identical sides win and lose equally often');
  close(h.winPct + h.tiePct + h.losePct, 100, 1e-9);
  /* Six equally likely faces: 6 of 36 ordered pairs tie, the other 30 split
     evenly, so tie 1/6 and win = lose = 5/12. Note win is *larger* than tie -
     a tie is a single point of measure, whereas every non-tie pair is a
     "difference", so the two are not comparable at 1:1. */
  close(h.tiePct, 100 / 6, 1e-9);
  close(h.winPct, 500 / 12, 1e-9);
  /* Ties pay nothing, but the non-tie pairs do: P(margin === m) is
     (6-m)/36, so E[min(margin, 4)] = (5 + 8 + 9 + 8 + 4)/36 = 34/36. */
  close(h.ev, 34 / 36, 1e-9);
});

test('headToHead: hand-checked - 3 troops against 2 troops + a Wildcard', () => {
  /* theirs = 2 + d6, so mine (a flat 3) can never win. It ties only on a
     1, and that tie pays nothing. */
  const mine = Rules.projectSide({troops: 3});
  const theirs = Rules.projectSide({troops: 2, cardId: 'wild'});
  const h = Rules.headToHead(mine, theirs, 4);
  close(h.winPct, 0);
  close(h.tiePct, 100 / 6, 1e-9);
  close(h.losePct, 500 / 6, 1e-9);
  close(h.ev, 0);
  assert.strictEqual(h.threshold, 7, 'no die can lift a fixed 3 past 2+d6');
});

test('headToHead: hand-checked threshold - Wildcard vs Wildcard needs a 4', () => {
  /* Both sides: 2 troops + Wildcard. base = 2, their mean = 5.5.
     2 + 4 = 6 > 5.5, so a 4 is the first face that beats their expected
     total; 2 + 3 = 5 does not. */
  const mine = Rules.projectSide({troops: 2, cardId: 'wild'});
  const theirs = Rules.projectSide({troops: 2, cardId: 'wild'});
  const h = Rules.headToHead(mine, theirs, 4);
  assert.strictEqual(h.threshold, 4);
  assert.strictEqual(h.thresholdBest, 7, 'their best case is 8, and 2+6=8 is not strictly greater');
  close(h.theirMean, 5.5);
  close(h.theirMax, 8);
});

test('headToHead: threshold is 0 when I already lead on average', () => {
  const mine = Rules.projectSide({troops: 6});
  const theirs = Rules.projectSide({troops: 2, cardId: 'wild'});   // totals 3..8
  const h = Rules.headToHead(mine, theirs, 4);
  assert.strictEqual(h.threshold, 0, 'a flat 6 is already past their expected 5.5');
  /* 6 beats 3, 4 and 5 - three of their six faces, and ties the fourth. */
  close(h.winPct, 50);
  close(h.tiePct, 100 / 6, 1e-9);
});

test('headToHead: ev respects the Influence cap', () => {
  const mine = Rules.projectSide({troops: 9, cardId: 'berserker'});   // 14 fixed
  const theirs = Rules.projectSide({troops: 1});                      // 1 fixed
  /* every outcome wins by >= 12, so ev must equal the cap exactly */
  const capped = Rules.headToHead(mine, theirs, 4);
  close(capped.ev, 4);
  close(Rules.headToHead(mine, theirs, 6).ev, 6);
});

test('headToHead: ev counts real margins below the cap', () => {
  /* mine = 3 + d6 (totals 4..9, one sixth each), theirs = a flat 1.
     Margins are 3..8; with a cap of 4 that is 3,4,4,4,4,4 -> 23/6. */
  const mine = Rules.projectSide({troops: 3, cardId: 'wild'});
  const theirs = Rules.projectSide({troops: 1});
  const h = Rules.headToHead(mine, theirs, 4);
  close(h.ev, 23 / 6, 1e-9);
  close(h.winPct, 100);
});

test('headToHead: probabilities always total 100', () => {
  const cases = [
    [Rules.projectSide({troops: 0, cardId: 'gambit'}), Rules.projectSide({troops: 5, cardId: 'gambit'})],
    [Rules.projectSide({troops: 4, cardId: 'wild'}), Rules.projectSide({troops: 4, cardId: 'undermine'})],
    [Rules.projectSide({troops: 2, cardId: 'onslaught', credits: 0}), Rules.projectSide({troops: 2})],
  ];
  cases.forEach(([a, b]) => {
    const h = Rules.headToHead(a, b, 4);
    close(h.winPct + h.tiePct + h.losePct, 100, 1e-9);
    assert.ok(h.ev >= 0 && h.ev <= 4);
  });
});

test('headToHead: accepts a bare distribution array', () => {
  const h = Rules.headToHead([1], [1], 4);
  close(h.winPct, 0);
  close(h.tiePct, 100);
  close(h.ev, 0);
});
