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
  /* cardModParts reports the CARD's own dice. The base d6 that both seats
     always roll is not a card and is not counted here - projectSide adds it,
     which is why a Wildcard side ends up on TWO dice. `rollMode` says HOW the
     card's dice fold: 'sum' (one die is the sum of one die) or 'max'. There is
     no third 'single' shape; the old value described a card-only projection
     that no longer exists. */
  const plain = Rules.cardModParts('wild', {});
  assert.strictEqual(plain.dice, 1);
  assert.strictEqual(plain.rollMode, 'sum');
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

  /* The whole point: gambit's expected MODIFIER is 161/36 (4.47), which is
     what game.js already lists as CARD_DEFS.gambit.avg. If it were the sum
     of two dice the answer would be 7, and if it were the minimum the answer
     would be 91/36 (2.53).

     The mean of the WHOLE SIDE also carries the base d6 both seats always
     roll, so the card's contribution is read as `mean - E_D6`. Subtracting
     the base die rather than dropping it is the point: the projection must
     never report a Skirmish with no die in it. */
  const p = Rules.projectSide({troops: 0, cardId: 'gambit'});
  close(p.mean - Rules.E_D6, 161 / 36);
  assert.notStrictEqual(p.mean - Rules.E_D6, 91 / 36);
  assert.notStrictEqual(p.mean - Rules.E_D6, 7);
});

test('cardModParts: unknown card throws instead of silently returning 0', () => {
  assert.throws(() => Rules.cardModParts('nope', {}), /unknown tactic card/);
});

/* ------------------------------------------------------------ projection */

/* >>> DEFECT 1 (the severe one). These tests used to assert that a side with
   >>> NO card has `dist === [1]`, `min === max === base` and `dice === 0` -
   >>> i.e. that a Skirmish has no die in it. It does: resolveSkirmish rolls
   >>> one d6 for both seats every fight. The old assertions pinned that bug,
   >>> which is how the commit modal's "YOUR ODDS" panel could print WIN 100%
   >>> and TIE 100% for a 1-Troop-vs-1-Troop fight while the engine went on to
   >>> roll - worth up to 41.7 points of win probability, on 14 of the 16
   >>> Tactic cards that supply no dice of their own. They now assert the
   >>> ground truth: at least one d6, always. */
test('projectSide: NO card still rolls the base d6 - a side is never a fixed total', () => {
  const p = Rules.projectSide({troops: 3});
  assert.strictEqual(Rules.BASE_DICE, 1, 'both seats roll exactly one base die');
  assert.deepStrictEqual(p.dist, Rules.diceDist(1));
  assert.strictEqual(p.dice, 1);
  assert.strictEqual(p.rollMode, 'sum');
  assert.strictEqual(p.base, 3);
  assert.strictEqual(p.min, 4, '3 troops + a 1');
  assert.strictEqual(p.max, 9, '3 troops + a 6');
  assert.strictEqual(p.mean, 3 + 3.5);
  assert.strictEqual(p.fixedBonus, 0);
});

test('projectSide: Wildcard is the base d6 PLUS its own, summed - two dice', () => {
  const p = Rules.projectSide({troops: 2, cardId: 'wild'});
  assert.strictEqual(p.base, 2);
  assert.strictEqual(p.min, 4, '2 troops + 1 + 1');
  assert.strictEqual(p.max, 14, '2 troops + 6 + 6');
  close(sum(p.dist), 1);
  close(p.mean, 2 + 7, 1e-9, 'base d6 + Wildcard d6 = E[2d6] = 7');
  assert.strictEqual(p.dice, 2, 'card dice are ADDITIONAL to the base die');
  assert.strictEqual(p.rollMode, 'sum');
  assert.strictEqual(p.dist.length, 11);
  /* A sum of two dice has the classic 2d6 peak at 7 and dead weight below 2,
     neither of which a lone d6 has - so this is not the old card-only
     six-entry uniform vector. */
  assert.strictEqual(p.dist.indexOf(Math.max(...p.dist)), 5);
  close(p.dist[0], 1 / 36, 1e-12, 'double ones');
  close(p.dist[10], 1 / 36, 1e-12, 'double sixes');
});

test('projectSide: Gambit is base d6 + max-of-2d6 - THREE dice, a composite', () => {
  const p = Rules.projectSide({troops: 2, cardId: 'gambit'});
  assert.strictEqual(p.dice, 3, 'one base die plus the two Gambit chooses between');
  /* A genuine composite is neither 'sum' nor 'max', and saying so is what
     stops a caller folding it as if it were one of the two. */
  assert.strictEqual(p.rollMode, null);
  assert.strictEqual(p.min, 4, '2 troops + 1 + max(1,1)');
  assert.strictEqual(p.max, 14, '2 troops + 6 + max(6,6)');
  close(p.mean, 2 + 3.5 + 161 / 36, 1e-9);
  assert.strictEqual(p.dist.length, 11, 'a 6-entry max folded onto a 6-entry d6');
  close(sum(p.dist), 1);
  /* And it really is NEITHER of the two single-group shapes. */
  const maxOnly = Rules.maxDiceDist(2);
  const sumOnly = Rules.diceDist(3);
  assert.ok(!p.dist.every((v, i) => Math.abs(v - (maxOnly[i] || 0)) < 1e-12),
    'the composite is not a bare max-of-2');
  assert.ok(!p.dist.every((v, i) => Math.abs(v - (sumOnly[i] || 0)) < 1e-12),
    'the composite is not a sum of 3');
});

test('projectSide: Gambler leader adds a fixed +1 to a die card', () => {
  const plain = Rules.projectSide({troops: 2, cardId: 'wild'});
  const lucky = Rules.projectSide({troops: 2, cardId: 'wild', isGambler: true});
  assert.strictEqual(lucky.fixedBonus, plain.fixedBonus + 1);
  close(lucky.mean, plain.mean + 1);
});

test('projectSide: fizzle lowers the projection, not just the card', () => {
  /* Onslaught with 0 Credits resolves as +1, so the side is 2 troops + 1 and
     then the base d6 on top: totals 4..9. Pay the 2 Credits and it becomes
     2 troops + 4 + d6: totals 7..12. The DIE IS STILL THERE either way - the
     old version of this test asserted min === max, which was the bug. */
  const broke = Rules.projectSide({troops: 2, cardId: 'onslaught', credits: 0});
  assert.strictEqual(broke.card.fizzled, true);
  assert.strictEqual(broke.fixedBonus, 1);
  assert.strictEqual(broke.min, 4);
  assert.strictEqual(broke.max, 9);
  close(broke.mean, 6.5);

  const paid = Rules.projectSide({troops: 2, cardId: 'onslaught', credits: 2});
  assert.strictEqual(paid.card.fizzled, false);
  assert.strictEqual(paid.fixedBonus, 4);
  assert.strictEqual(paid.min, 7);
  assert.strictEqual(paid.max, 12);
});

/* ============================== FURY LADDER (G7) ==========================
   The engine's flat "Momentum: +1 at two wins" rule is GONE. It was replaced
   by a four-rung ladder, and these are the numbers the odds panel in the
   commit modal is computed from, so they are pinned here rather than only in
   the rules copy. */

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
  /* base = troops + Fury + card, so every component is independently visible in
     base; the die then rides on top of that floor, identically. A regression
     that replaced rather than added would show up as base ===
     max(troops+fury, troops+card). */
  const p = Rules.projectSide({troops: 2, winStreak: 3, cardId: 'berserker'});
  assert.strictEqual(p.base, 9);            // 2 troops + Fury 2 + Berserker 5
  assert.strictEqual(p.fixedBonus, 2 + 5);
  assert.strictEqual(p.min, 10, 'base + the lowest die');
  assert.strictEqual(p.max, 15, 'base + the highest die');
  close(p.mean, 9 + 3.5);
});

/* ============================ CATCHING UP: DELETED =========================

   The anti-snowball valve (leader on a 3+ streak hands the trailer +2) was
   removed from js/rules.js rather than rebalanced — it fired 0.23x/game, and
   deleting it was worth +0.11 pts/seat against only a 0.4% change in decided
   winners, while retuning it to fire ~2.5x more often scored -0.27 pts/seat
   (z = -2.43). The Collapse clock already does this job. See the tombstone in
   js/rules.js. Its behaviour is deliberately NOT re-specified here; the guard
   below exists only so the rule cannot quietly return. */

test('Catching Up is gone: no rule member, no projection field', () => {
  assert.strictEqual(Rules.catchingUp, undefined);
  assert.strictEqual(Rules.CATCHING_UP, undefined);
  const p = Rules.projectSkirmish(
    {troops: 2, winStreak: 0},
    {troops: 3, winStreak: 3}
  );
  assert.ok(!('catchingUp' in p), 'projectSkirmish must not report the valve');
});

test('projectSkirmish: a hot leader no longer flatters the trailer', () => {
  /* The exact framing the deleted valve used to exploit. With the rule gone
     the only thing a streak still buys is the ladder bonus and the Influence
     cap, so leading into a hot opponent is now strictly worse than trailing
     into a cold one by the same margin — which is the intent. */
  const asTrailer = Rules.projectSkirmish(
    {troops: 2, winStreak: 0},
    {troops: 3, winStreak: 3}
  );
  const asLeader = Rules.projectSkirmish(
    {troops: 3, winStreak: 0},
    {troops: 2, winStreak: 3}
  );
  assert.ok(asTrailer.winPct < asLeader.winPct,
    'trailing against a hot leader is now strictly worse than the reverse');
});

/* ==================== head-to-head margin convolution =====================
   A regression guard for a bug that every pre-G7 test missed: the margin
   distribution used to accumulate at `i + j`, which is the mirror of the
   correct `i - j`. A UNIFORM distribution hides it (reversing 1/6 six times
   is a relabelling), so Wildcard-vs-nothing passed. Desperate Gambit is
   skewed and exposed it. These are checked against a brute-force enumeration
   of every reachable outcome, not against a hand-copied number. */

test('headToHead: matches a brute-force enumeration even on a SKEWED distribution', () => {
  /* 3 troops + Wildcard (base d6 + the card's own d6, SUMMED) vs 2 troops +
     Desperate Gambit (base d6 + max of 2d6). Six faces on my two dice and
     six * six on theirs: 6 * 6 * 6 * 6 * 6 * 6 = 7,776 equally likely
     outcomes. The enumeration below is the ENGINE's rule written out by hand -
     total = d6 + troops + cardMod - nothing else - which is the only
     definition of "correct" worth testing against.

     This is the same test the file already had, with the enumeration widened:
     the old version enumerated 216 outcomes on a Wildcard worth ONE die and a
     Gambit worth two, i.e. it pinned the projection that had no base die in
     it (defect 1). */
  const mine = Rules.projectSide({troops: 3, cardId: 'wild'});
  const theirs = Rules.projectSide({troops: 2, cardId: 'gambit'});
  const h = Rules.headToHead(mine, theirs, 4);

  const faces = d => Array.from({length: 6}, (_, i) => i + 1);
  let w = 0, t = 0, l = 0;
  faces().forEach(m1 => faces().forEach(m2 => faces().forEach(g => faces().forEach(g2 => faces().forEach(g3 => {
    const mineTotal = 3 + m1 + m2;
    const theirTotal = 2 + g + Math.max(g2, g3);
    if(mineTotal > theirTotal) w++; else if(mineTotal === theirTotal) t++; else l++;
  })))));
  assert.strictEqual(w + t + l, 7776);

  close(h.winPct,  w / 7776 * 100, 1e-9, 'win');
  close(h.tiePct,  t / 7776 * 100, 1e-9, 'tie');
  close(h.losePct, l / 7776 * 100, 1e-9, 'lose');
  /* Two independent traps this must not fall into: the mirrored-convolution
     answer (74.5% pre-fix) and the die-less projection (which reported 100%
     here). The true figure is a near coin flip: 44.2%. */
  assert.ok(h.winPct < 50, 'not the mirrored-convolution answer');
  assert.ok(h.winPct > 30, 'not the die-less answer');
  assert.strictEqual(w, 3437);
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
  /* Both sides are 2 troops + 2 summed dice, so there are 36 * 36 = 1,296
     equally likely ordered outcomes. P(the two 2d6 sums are equal) =
     sum(count_s^2) / 36^2 = (1+4+9+16+25+36+25+16+9+4+1) / 1296 = 146/1296,
     and the 1,150 non-tied outcomes split evenly: 575 each way.
     Note win > tie, as always - a tie is one point of measure whereas every
     non-tie pair is a "difference", so the two are not comparable at 1:1. */
  close(h.tiePct, 14600 / 1296, 1e-9);
  close(h.winPct, 57500 / 1296, 1e-9);
  /* E[min(margin, 4)] over the same 1,296 pairs = 1526/1296. */
  close(h.ev, 1526 / 1296, 1e-9);
});

test('headToHead: hand-checked - 3 troops against 2 troops + a Wildcard', () => {
  /* mine = 3 + d6 (totals 4..9, one sixth each); theirs = 2 + two summed dice
     (totals 4..14, triangular over 36). Enumerated below rather than
     hand-tallied: the old version of this test enumerated a DIE-LESS enemy,
     which reported a flat 0% / 16.7% / 83.3% for a fight the engine decides
     with a roll - the defect this file's sibling tests also pinned. */
  const mine = Rules.projectSide({troops: 3});
  const theirs = Rules.projectSide({troops: 2, cardId: 'wild'});
  const h = Rules.headToHead(mine, theirs, 4);
  let w = 0, t = 0, l = 0, ev = 0;
  const f = [1,2,3,4,5,6];
  f.forEach(m => f.forEach(a => f.forEach(b => {
    const margin = (3 + m) - (2 + a + b);
    if(margin > 0){ w++; ev += Math.min(margin, 4); } else if(margin === 0) t++; else l++;
  })));
  assert.strictEqual(w + t + l, 216);
  assert.strictEqual(w, 35, 'the enumerated win count, so the fractions are pinned');
  close(h.winPct,  w / 216 * 100, 1e-9);
  close(h.tiePct,  t / 216 * 100, 1e-9);
  close(h.losePct, l / 216 * 100, 1e-9);
  close(h.ev, ev / 216, 1e-9);
  /* My floor is 3 and their EXPECTED total is 2 + E[2d6] = 9, so a 6 is the
     first face that reaches it. Quoted as the engine computes it: their mean
     lands on 8.999999999999998 (the distribution sums to 1 - 2e-16), so
     `3 + 6 > mean` is literally true and thresholdToBeat answers 6. Note this
     is the "beat their MEAN" reading of the number, which is optimistic for a
     side as wide as two summed dice - the win rate here is 16%, not 17% -
     but that sentence's framing is unchanged by this fix and out of its scope. */
  assert.strictEqual(h.threshold, 6);
});

test('headToHead: hand-checked threshold - Wildcard vs Wildcard needs a 5', () => {
  /* Both sides roll two summed dice. Mine: base 6. Theirs: 4 troops + 2 summed
     dice, expected total 4 + 7 = 11. 6 + 4 = 10 does NOT clear 11; 6 + 5 = 11
     is not strictly greater either; 6 + 6 = 12 is. So the smallest winning
     face is 5 - one of the six faces wins outright, which is what
     thresholdSentence() turns into its "N of 6 faces win outright" count. */
  const mine = Rules.projectSide({troops: 6, cardId: 'wild'});
  const theirs = Rules.projectSide({troops: 4, cardId: 'wild'});
  const h = Rules.headToHead(mine, theirs, 4);
  assert.strictEqual(h.threshold, 5);
  /* Their BEST possible total is 4 + 6 + 6 = 16. thresholdToBeat only ever
     contemplates ONE extra die, and 6 + 6 = 12 does not clear 16, so it
     honestly reports 7 - unchanged behaviour, new projection. */
  assert.strictEqual(h.thresholdBest, 7);
  close(h.theirMean, 11);
  assert.strictEqual(h.theirMax, 16);
});

test('headToHead: threshold is 0 when I already lead on average', () => {
  /* base = 6 troops + Fury 3 = 9, and their expected total is
     1 troop + d6 + max-of-2d6 = 1 + 3.5 + 4.4722 = 8.9722. 9 > 8.9722, so
     no die is needed to lead on average and thresholdToBeat answers 0. */
  const mine = Rules.projectSide({troops: 6, winStreak: 4});
  const theirs = Rules.projectSide({troops: 1, cardId: 'gambit'});
  const h = Rules.headToHead(mine, theirs, 4);
  assert.strictEqual(h.threshold, 0, 'a floor of 9 is already past their expected 8.97');
  /* Enumerated over my 6 faces against their 6 * 6 * 6 (the base d6 plus the
     two Gambit chooses between) = 1,296 equally likely outcomes - the only
     honest way to state a three-dice skew. */
  let w = 0, t = 0, l = 0;
  const f = [1,2,3,4,5,6];
  f.forEach(m => f.forEach(g => f.forEach(g2 => f.forEach(g3 => {
    const mm = (9 + m) - (1 + g + Math.max(g2, g3));
    if(mm > 0) w++; else if(mm === 0) t++; else l++;
  }))));
  assert.strictEqual(w + t + l, 1296);
  close(h.winPct,  w / 1296 * 100, 1e-9);
  close(h.tiePct,  t / 1296 * 100, 1e-9);
  close(h.losePct, l / 1296 * 100, 1e-9);
});

test('headToHead: ev respects the Influence cap', () => {
  const mine = Rules.projectSide({troops: 9, cardId: 'berserker'});   // 14 fixed
  const theirs = Rules.projectSide({troops: 1});                      // 1 + d6
  /* every outcome wins by >= 8, so ev must equal the cap exactly */
  const capped = Rules.headToHead(mine, theirs, 4);
  close(capped.ev, 4);
  close(Rules.headToHead(mine, theirs, 6).ev, 6);
});

test('headToHead: ev counts real margins below the cap', () => {
  /* mine = 3 + two summed dice (totals 5..15), theirs = 1 + d6 (2..7).
     6 * 6 * 6 = 216 equally likely outcomes, enumerated rather than
     hand-tallied - a sum of two dice has 11 entries, two of them at 1/36. */
  const mine = Rules.projectSide({troops: 3, cardId: 'wild'});
  const theirs = Rules.projectSide({troops: 1});
  const evAt = (cap)=>{
    let ev = 0, n = 0;
    const f = [1,2,3,4,5,6];
    f.forEach(a => f.forEach(b => f.forEach(d => {
      const margin = (3 + a + b) - (1 + d);
      /* A LOSS pays nothing and a TIE pays nothing: headToHead accumulates
         ev over winning margins only, and an EV that counted the negative
         side of the fight would be describing a different game. */
      if(margin > 0) ev += Math.min(margin, cap);
      n++;
    })));
    assert.strictEqual(n, 216);
    return ev / 216;
  };
  const h = Rules.headToHead(mine, theirs, 4);
  close(h.ev, evAt(4), 1e-9);
  close(h.ev, 743 / 216, 1e-9, 'the enumerated figure, pinned');
  close(Rules.headToHead(mine, theirs, 6).ev, evAt(6), 1e-9);
  /* The OUTCOME does not depend on the cap: 206 of the 216 pairs win, 6 tie
     and 4 are a loss. The old die-less "flat 100%" assertion is gone. */
  assert.strictEqual(h.winPct, 100 * 206 / 216);
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
