/* ---------------------------------------------------------------------
   OUTPOST DUEL — pure rules maths (no DOM, no timers, no Math.random)

   Everything here is a pure function of its arguments, which is what makes
   the game's actual maths unit-testable. game.js owns the randomness; this
   module only ever answers "what are the odds".

   Conventions
   -----------
   * A "distribution" is a plain array of probabilities sorted low to high,
     but the two flavours here are indexed DIFFERENTLY, and that matters:
       - diceDist(n)     index i is the total `i + n`   (offset 0, total 0
                         is impossible and carries probability 0)
       - maxDiceDist(n)  index t is the maximum `t + 1`  (no dead entries)
     so "expected value" needs the offset: `expect(dist)` for a diceDist,
     `expect(dist, 1)` for a maxDiceDist.
   * All probabilities are in [0, 1] unless a name ends in `Pct`.
--------------------------------------------------------------------- */

;(function(root){
'use strict';

const D6_SUM = 36;          // outcomes for 2d6
const E_D6 = 3.5;           // E[d6]

/* E[max of 2d6] = sum over t of t * (2t-1)/36
                 = (2 * sum(t^2) - sum(t)) / 36
                 = (2 * 91 - 21) / 36
                 = 161 / 36 = 4.4722...
   NOTE: 91/36 = 2.5277 is E[MIN of 2d6], not the max. max + min = sum, and
   E[sum] = 7, so the two sum to 161/36 + 91/36 = 7 exactly. Anything
   claiming "the higher of two dice averages 2.53" has the min and the max
   swapped — see the gambit note in CARD_MODS below. */
const E_MAX_2D6 = 161 / D6_SUM;

/* Base modifiers, mirroring CARD_DEFS in js/game.js. Kept as its own frozen
   table so this module stays standalone-loadable in node (it cannot import
   game.js, which is a browser script with DOM side effects).
   KEEP IN SYNC with CARD_DEFS[].mod in js/game.js. */
const CARD_MODS = Object.freeze({
  ambush:    {mod: 2},
  overrun:   {mod: 3, fizzle: {resource: 'ore',     cost: 1, reducesTo: 0}},
  berserker: {mod: 5},
  blitz:     {mod: 2, onlyAggressor: true},
  onslaught: {mod: 4, fizzle: {resource: 'credits', cost: 2, reducesTo: 1}},
  ambuscade: {mod: 3},
  feint:     {mod: 0},
  guard:     {mod: 1},
  fortify:   {mod: 0},
  rally:     {mod: 1},
  scout:     {mod: 1},
  undermine: {mod: 0, opponentMod: -2},
  sabotage:  {mod: 1},
  insight:   {mod: 2},
  /* `dice` / `rollMode` describe the CARD'S OWN dice only. The base d6 both
     seats always roll is NOT part of a card - see BASE_DICE in projectSide. */
  wild:      {mod: null, dice: 1, rollMode: 'sum'},
  /* Desperate Gambit keeps the HIGHER of two d6, so its expected modifier
     is E[max of 2d6] = 161/36 = 4.4722, NOT 91/36 = 2.5277 (that is the
     expected MINIMUM, i.e. the "bad roll" case). game.js lists it as
     avg 4.47, which is already correct — see js/game.js. */
  gambit:    {mod: null, dice: 2, rollMode: 'max'},
});

/* Expected value of a distribution. `offset` is the value at index 0
   (0 for a diceDist, 1 for a maxDiceDist). */
function expect(dist, offset){
  const base = (offset === undefined ? 0 : offset);
  let mass = 0, sum = 0;
  for(let i = 0; i < dist.length; i++){ sum += (base + i) * dist[i]; mass += dist[i]; }
  return mass === 0 ? 0 : sum / mass;
}

/* ------------------------------------------------------------------ dice */

/* Distribution of the SUM of `nDice` d6.
   Returns 5*nDice + 1 probabilities; index i is the total `i + nDice`.
   Sums below nDice (0..nDice-1) are impossible and carry probability 0 —
   the offset exists so a single uniform `expect()` works for every nDice.
   (nDice = 6 gives i + 6, which is where the shorthand in the spec comes
   from; the offset scales with the number of dice.) */
function diceDist(nDice){
  const n = Math.max(1, Math.floor(nDice) || 1);
  /* Integer convolution, then one division at the end — exact to the last
     bit for any nDice a d6 game will ever use. `counts[i]` is the number of
     outcomes so far summing to `i + nSoFar`. */
  let counts = [1];
  for(let d = 0; d < n; d++){
    /* Adding a die extends the reachable range by 5 (faces 1..6), and a
       face of f maps to index i + (f - 1) under the new offset. */
    const next = new Array(counts.length + 5);
    for(let k = 0; k < next.length; k++) next[k] = 0;
    for(let i = 0; i < counts.length; i++){
      for(let face = 1; face <= 6; face++) next[i + (face - 1)] += counts[i];
    }
    counts = next;
  }
  const total = Math.pow(6, n);
  return counts.map(c => c / total);
}

/* Distribution of the MAXIMUM of `nDice` d6.
   Returns 6 probabilities; index t is P(max === t + 1).
   P(max <= t) = (t/6)^n, so P(max = t) = (t^n - (t-1)^n) / 6^n.
   This is what Desperate Gambit ("keep the higher die") actually uses. */
function maxDiceDist(nDice){
  const n = Math.max(1, Math.floor(nDice) || 1);
  const total = Math.pow(6, n);
  const out = [];
  for(let t = 1; t <= 6; t++) out.push((Math.pow(t, n) - Math.pow(t - 1, n)) / total);
  return out;
}

/* --------------------------------------------------- composing dice groups */

/* A die group is one of the two shapes above, tagged with the value its index
   0 carries: a `diceDist(n)` group has offset n (index i is the total i + n), a
   `maxDiceDist(n)` group has offset 1 (index t is the maximum t + 1). Keeping
   the offset with the group is what stops the two conventions from being mixed
   up at the seam. */
function dieGroup(nDice, mode){
  const n = Math.max(1, Math.floor(nDice) || 1);
  return (mode === 'max')
    ? {dist: maxDiceDist(n), offset: 1, mode: 'max', dice: n}
    : {dist: diceDist(n),  offset: n, mode: 'sum', dice: n};
}

/* Sum INDEPENDENT die groups into one distribution, e.g. the base d6 plus a
   Wildcard's d6 (a sum of 2) or the base d6 plus Desperate Gambit's max-of-2
   (a three-dice composite). Each group is built by diceDist / maxDiceDist -
   this only adds them together, which is the same `i + j` accumulation
   headToHead already performs on two finished distributions.

   Index arithmetic: a group entry at local index k has value k + g.offset, so
   a pair (i, j) lands at i + j and the combined offset is the SUM of the group
   offsets. Returns `compose`: 'sum' when every group is a sum (the shape the
   whole side adds up as), 'max' when a single max group IS the whole side, and
   null for any genuine composite - which is exactly the 'sum' | 'max' | null
   shape projectSide reports as `rollMode`. */
function combineDice(groups){
  const list = (groups || []).filter(g => g && Array.isArray(g.dist));
  if(!list.length) return {dist:[1], offset:0, compose:'sum'};
  let dist = [1], offset = 0, hasMax = false, allSum = true;
  for(const g of list){
    const next = new Array(dist.length + g.dist.length - 1);
    for(let k = 0; k < next.length; k++) next[k] = 0;
    for(let i = 0; i < dist.length; i++){
      if(!dist[i]) continue;
      for(let j = 0; j < g.dist.length; j++){
        if(!g.dist[j]) continue;
        next[i + j] += dist[i] * g.dist[j];
      }
    }
    dist = next;
    offset += g.offset;
    if(g.mode === 'max') hasMax = true; else allSum = true;
  }
  let compose;
  if(hasMax) compose = (list.length > 1) ? null : 'max';   // composite vs a lone max
  else compose = allSum ? 'sum' : null;
  return {dist, offset, compose};
}

/* ----------------------------------------------------------------- cards */

/* Break a Tactic card's combat modifier into a deterministic part and a
   dice part, resolving both cost-based fizzles exactly as resolveSkirmish's
   cardModifier() does in js/game.js.

   Returns:
     fixed      effective non-dice modifier (already fizzle-adjusted)
     dice       number of dice rolled (0, 1, or 2)
     fizzle     {resource, cost, reducesTo} for cards that need a payment,
                else null
     reducesTo  the value `fixed` collapses to when the payment fails
     fizzled    true when the payment could NOT be made
     rollMode   'single' | 'max' | null  (how to fold the dice in)
     opponentMod  amount the card subtracts from the OPPONENT's total
                 (Undermine), else 0

   Notes on the two fizzles, straight from the rules:
     Overrun   — needs 1 Ore,  otherwise resolves as +0
     Onslaught — needs 2 Credits, otherwise resolves as +1 */
function cardModParts(cardId, opts){
  if(typeof cardId !== 'string' || !CARD_MODS[cardId]){
    throw new Error('OD.Rules.cardModParts: unknown tactic card "' + cardId + '"');
  }
  const o = opts || {};
  const def = CARD_MODS[cardId];
  const isAggressor = !!o.isAggressor;
  const isGambler = !!o.isGambler;

  /* `dice` here is the CARD's own dice. The base d6 is not a card and is not
     counted here - projectSide adds it. */
  const out = {
    fixed: 0, dice: 0, fizzle: null, reducesTo: null,
    fizzled: false, rollMode: null, opponentMod: def.opponentMod || 0,
  };

  if(def.fizzle){
    const have = typeof o[def.fizzle.resource] === 'number' ? o[def.fizzle.resource] : 0;
    const canPay = have >= def.fizzle.cost;
    out.fizzle = Object.freeze({resource: def.fizzle.resource, cost: def.fizzle.cost, reducesTo: def.fizzle.reducesTo});
    out.reducesTo = def.fizzle.reducesTo;
    out.fizzled = !canPay;
    out.fixed = canPay ? def.mod : def.fizzle.reducesTo;
    return out;
  }

  if(def.dice){
    out.dice = def.dice;
    out.rollMode = def.rollMode;
    out.fixed = isGambler ? 1 : 0;   // Gambler leader adds +1 to the result
    return out;
  }

  /* Blitz is a conditional rather than a cost: +2 only on the aggressor
     side, +0 everywhere else. No fizzle, it just resolves low. */
  out.fixed = (def.onlyAggressor && !isAggressor) ? 0 : def.mod;
  return out;
}

/* ---------------------------------------------------------------- FURY */

/* THE FURY LADDER — winStreak -> {bonus added to the committed total,
   cap on the Influence that Skirmish can pay out}.

   This replaced the old flat "Momentum: +1 at two wins in a row" rule, which
   is why it lives here rather than in a feature file: js/rules.js loads
   BEFORE js/feature-wagers.js and cannot import it, and the projection maths
   is pure. The numbers below are the contract — the ladder table in
   feature-wagers.js's own RULES_HTML is generated from the same three
   constants, and game.js reads the live feature (`OD.Wagers.FURY`) for the
   actual Skirmish total so the two can never disagree about what the game
   did; this copy exists so the ODDS THE UI SHOWS and the maths the UI TESTS
   are the same maths. See FURY in the export block. */
const FURY_STREAK_2 = 2, FURY_STREAK_3 = 3, FURY_STREAK_4 = 4;
const FURY_BONUS_2 = 1, FURY_BONUS_3 = 2, FURY_BONUS_4 = 3;
const FURY_CAP_2 = 4, FURY_CAP_3 = 5, FURY_CAP_4 = 6;
const FURY_FEVER_CAP = 6;   // Skirmish Fever lifts every rung's ceiling to 6

function furyFor(streak){
  const s = Math.max(0, num(streak, 0) | 0);
  if(s < FURY_STREAK_2) return Object.freeze({streak:s, bonus:0, cap:FURY_CAP_2});
  if(s < FURY_STREAK_3) return Object.freeze({streak:s, bonus:FURY_BONUS_2, cap:FURY_CAP_2});
  if(s < FURY_STREAK_4) return Object.freeze({streak:s, bonus:FURY_BONUS_3, cap:FURY_CAP_3});
  return Object.freeze({streak:s, bonus:FURY_BONUS_4, cap:FURY_CAP_4});
}

/* Skirmish Fever raises the ceiling for the whole ladder, so a player on no
   streak is not punished for having no streak. Mirrors OD.Wagers.furyCap. */
function furyCap(streak, fever){
  const base = furyFor(streak).cap;
  return fever ? Math.max(base, FURY_FEVER_CAP) : base;
}

/* THE ANTI-SNOWBALL VALVE IS NOT HERE ANY MORE.

   A "Catching Up" rule used to live in this file: if the player who WALKED IN
   ahead on a 3+ win streak, the trailing side added +2 to their total before
   the result was decided. It was measured over ~4,500 simulated games and it
   fired 0.23 times per game. Deleting it outright was worth +0.11 points per
   seat and changed the winner in 0.4% of decided games - the weakest effect of
   any system measured. Retuning it was WORSE than deleting it: forcing it to
   fire ~2.5x more often (streak 2 instead of 3) scored -0.27 points per seat
   (z = -2.43). It could not be fixed by lowering the threshold either, because
   a 2-win streak dies at the next fight, which caps the achievable fire rate
   at ~0.45x/game even in the best case.

   Meanwhile the Collapse clock is doing this job already, and it flips 9.7% of
   winners. So the rule is GONE, not rebalanced. The Collapse clock is the
   game's only anti-snowball system and is not represented in this module.

   Nothing here needs a tombstone for backwards compatibility: resolveSkirmish
   in js/game.js reads `OD.Rules.catchingUp` behind an
   `&& OD.Rules.catchingUp` truthiness guard, so an absent member already
   degrades to "no adjustment" rather than throwing. See the note on
   projectSkirmish below for the preview-side equivalent. */

/* -------------------------------------------------------------- projection */

/* THE BASE DIE. resolveSkirmish() casts one d6 for BOTH seats every single
   Skirmish - `aggRoll` and `defRoll` - and adds it to the committed total:

     total = d6 + troops + cardMod + fury + betrayal + garrison

   A projection that forgets that die is not a conservative estimate, it is a
   DIFFERENT GAME: with no die in the distribution `dist` collapses to [1] and
   the panel reports a deterministic 100% / 0% / 0% while the engine goes on
   to roll. That was worth up to 41.7 points of win-probability on an ordinary
   no-card commit (14 of the 16 Tactic cards supply no dice at all), and it is
   why the commit modal could print "WIN 100%" next to the honest sentence
   "no single die can get you there".

   Card dice are ADDITIONAL to this one, never a replacement for it:
     no card           1 die                       -> diceDist(1)
     Wildcard          base d6 + its own d6, summed -> 2 dice, diceDist(2)
     Desperate Gambit  base d6 + max of 2d6         -> 3 dice, a composite
   Anything that wanted to describe "no dice at all" was describing a Skirmish
   the engine cannot produce. */
const BASE_DICE = 1;

/* Full outcome distribution for one side of a Skirmish.
   total = committed troops + Fury bonus + `bonus` + card modifier + BASE_DICE
   + any dice the card adds

   `bonus` is a caller-supplied flat addition for the PUBLIC modifiers that
   are not the card: the Advanced Garrison +1 and a declared Betrayal +1
   token. Both are announced on the HUD before the dice fall, so folding
   them in here is showing the player information they already have rather
   than guessing.

   Returns the spec'd {dist, mean, min, max, fixedBonus} plus the extra
   fields `headToHead` needs to answer "what do I need to roll?": base
   (everything except the dice) and dice (how many dice are in play). */
function projectSide(spec){
  const s = spec || {};
  const troops = Math.max(0, num(s.troops, 0));
  const winStreak = Math.max(0, num(s.winStreak, 0));
  const fury = furyFor(winStreak);

  const card = s.cardId ? cardModParts(s.cardId, {
    isAggressor: !!s.isAggressor,
    credits: num(s.credits, 0),
    ore: num(s.ore, 0),
    isGambler: !!s.isGambler,
  }) : null;

  const fixedBonus = fury.bonus + num(s.bonus, 0) + (card ? card.fixed : 0);
  const base = troops + fixedBonus;

  /* >>> THE DIE IS NEVER OPTIONAL. The base d6 is always in the distribution
     and a card's dice ride on top of it. */
  const groups = [dieGroup(BASE_DICE, 'sum')];
  if(card && card.dice > 0) groups.push(dieGroup(card.dice, card.rollMode));
  const rolled = combineDice(groups);

  const dist = rolled.dist;
  const min = rolled.offset;
  const max = min + dist.length - 1;
  const diceMean = expect(dist, min);
  const dice = groups.reduce((n, g) => n + g.dice, 0);

  return {
    dist,
    mean: base + diceMean,
    min: base + min,
    max: base + max,
    fixedBonus,
    /* extras consumed by headToHead */
    base, dice, troops,
    /* The value the dice contribute on an average roll, and the lowest /
       highest total they can produce on their own. The log line the engine
       prints ("rolls 4 + 3 troops + Ambush(2) = 9") and this projection are
       now answering from the same numbers. */
    diceMean, diceMin: min, diceMax: max,
    /* The Fury rung this side walked in on: `bonus` is folded into
       fixedBonus above, and `cap` is the Influence ceiling that applies to the
       Skirmish this side is about to fight. */
    fury,
    winStreak: fury.streak,
    /* DEPRECATED ALIAS, kept on purpose. feature-wagers.js corrects this
       projection with `(fury.bonus - projected.momentum)`, a one-line patch
       that used to exist because this module still added the flat
       "Momentum" +1 while the feature wanted the ladder. The ladder now
       lives HERE, so the correction has nothing left to do - but the field
       it reads must not be undefined, or `undefined | 0` silently becomes 0
       and the bot DOUBLE-COUNTS its own Fury at every streak >= 2. So the
       alias reports the streak bonus already baked into `base`, which makes
       the patch a genuine no-op instead of a silent double count. */
    momentum: fury.bonus,
    /* 'sum' | 'max' | null - null for a genuine composite (Desperate
       Gambit), which is neither a plain sum nor a plain max-of-N. */
    rollMode: rolled.compose,
    card: card || null,
  };
}

function num(v, dflt){
  return (typeof v === 'number' && isFinite(v)) ? v : dflt;
}

/* Accepts either a raw distribution array or a projectSide() result. */
function asSide(x){
  if(Array.isArray(x)){
    return {dist: x, min: 0, max: x.length - 1, base: 0, dice: 0, mean: expect(x)};
  }  if(!x || !Array.isArray(x.dist)) throw new Error('OD.Rules.headToHead: expected a distribution or a projectSide() result');
  const base = (typeof x.base === 'number') ? x.base : x.min;
  return {
    dist: x.dist,
    min: num(x.min, 0),
    max: num(x.max, x.dist.length - 1),
    base,
    dice: num(x.dice, 0),
    mean: (typeof x.mean === 'number') ? x.mean : base + expect(x.dist),
  };
}

/* -------------------------------------------------------------- head to head */

/* Win / tie / loss odds and the actionable line for the UI.
   `mine` and `theirs` are projectSide() results (or bare distributions).
   `cap` is the Skirmish Influence cap (4, or 6 on Skirmish Fever).

   Returns:
     winPct / tiePct / losePct   percentages, sum to 100
     ev                          expected Influence awarded, given `cap`
     threshold                   the minimum d6 face (1-6) that lifts me past
                                 the opponent's EXPECTED total.
                                 0 = I already win on average without a die,
                                 7 = no single die can get there.
     thresholdBest               same, but against their BEST possible total
     theirMean / theirMax        the reference points used, so the UI can
                                 print the sentence honestly

   Plus `marginDist` / `marginLo` (the distribution of my margin, mine - theirs)
   for anyone who wants a full curve. */
function headToHead(mine, theirs, cap){
  const a = asSide(mine), b = asSide(theirs);
  const capValue = Math.max(0, num(cap, 4));

  /* Margin of the lowest possible outcome, and the index arithmetic that
     goes with it. margin(i,j) = (a.min + i) - (b.min + j) = a.min - b.min
     + (i - j), so a pair (i, j) lands at k = (i - j) + (b.dist.length - 1)
     and the k=0 entry is worth a.min - b.max.

     The `- j` is the whole point. Accumulating at `i + j` instead looks
     fine and is invisible for every uniform distribution (a Wildcard, or no
     card at all) because reversing a uniform vector is a relabelling, not a
     change of shape - which is why it survived every test that used one. It
     is wrong the moment a side's distribution is skewed, i.e. for Desperate
     Gambit (max of 2d6) and for any 2+ dice: 3 troops + Wildcard against
     2 troops + Desperate Gambit reports a 74.5% win where the true figure,
     over all 216 equally likely outcomes, is 42.1%. */
  const lb = b.dist.length - 1;
  const lo = a.min - b.max;
  const size = a.dist.length + b.dist.length - 1;
  const diff = new Array(size);
  for(let k = 0; k < size; k++) diff[k] = 0;
  for(let i = 0; i < a.dist.length; i++){
    if(a.dist[i] === 0) continue;
    for(let j = 0; j < b.dist.length; j++){
      if(b.dist[j] === 0) continue;
      diff[i - j + lb] += a.dist[i] * b.dist[j];
    }
  }

  let pWin = 0, pTie = 0, pLose = 0, ev = 0;
  for(let k = 0; k < size; k++){
    const margin = lo + k;
    const p = diff[k];
    if(margin > 0){
      pWin += p;
      ev += Math.min(margin, capValue) * p;         // capped, so a blowout
    } else if(margin === 0){
      pTie += p;
    } else {
      pLose += p;
    }
  }

  return {
    winPct:  pWin  * 100,
    tiePct:  pTie  * 100,
    losePct: pLose * 100,
    ev,
    threshold:     thresholdToBeat(a, b.mean),
    thresholdBest: thresholdToBeat(a, b.max),
    theirMean: b.mean,
    theirMax:  b.max,
    myMean: a.mean,
    myMin: a.min,
    myMax: a.max,
    cap: capValue,
    marginDist: diff,
    marginLo: lo,
  };
}

/* Smallest d6 face that gets me strictly past `opponentTotal`.
   0 means "already there, no die needed"; 7 means "no single die gets there". */
function thresholdToBeat(side, opponentTotal){
  if(side.base > opponentTotal) return 0;
  if(side.dice <= 0) return 7;
  for(let d = 1; d <= 6; d++) if(side.base + d > opponentTotal) return d;
  return 7;
}

/* --------------------------------------------------------- whole-skirmish */

/* The one call the UI should make: two projections, then the win/tie/loss
   readout.

   `mine` / `theirs` are projectSide() specs. `cap` defaults to the HIGHER of
   the two Fury caps, lifted to 6 by `fever` — which is exactly the cap
   resolveSkirmish pays out under, so the Influence number on screen is the
   number the game will actually award. `oppCard` / `myCard` are the HIDDEN
   cards: pass what you know (the defender knows the aggressor's Troops but
   not their card) and the resulting percentages are the honest ones.

   There is NO anti-snowball adjustment between the two projections any more
   (see the tombstone above): both sides are now decided from their own
   projected totals, unmodified. The returned object no longer carries a
   `catchingUp` key. A consumer still reading one - catchingUpLine() in
   js/game.js does - gets `undefined` and returns its empty string, because it
   guards with `if(!cu || !cu.applied)`. That is why the key can be removed
   outright instead of being pinned at `{applied: 0}`.

   Returns the raw projections as well as the head-to-head, because the UI
   needs the per-side means and caps to print its own sentence. */
function projectSkirmish(mine, theirs, opts){
  const o = opts || {};
  const a = projectSide(mine);
  const b = projectSide(theirs);
  const fever = !!o.fever;
  const cap = (typeof o.cap === 'number') ? Math.max(0, o.cap)
           : Math.max(furyCap(a.winStreak, fever), furyCap(b.winStreak, fever));
  return Object.assign({
    mine: a, theirs: b,
    myCap: furyCap(a.winStreak, fever),
    theirCap: furyCap(b.winStreak, fever),
    fever,
  }, headToHead(a, b, cap));
}

/* The sentence a human can act on: "you win if you roll >= 3". Returns
   null when the answer is 0 (already ahead on the dice you control) or 7
   (no single die gets there) so the caller can say THAT instead of lying. */
function thresholdSentence(threshold){
  if(threshold === 0) return 'You already win on the dice you control - any roll takes it.';
  if(threshold >= 7) return 'No single die can get you there - this is a roll of the whole commit.';
  return `You win if you roll &ge; ${threshold}.`;
}

const Rules = Object.freeze({
  diceDist, maxDiceDist, dieGroup, combineDice, cardModParts, projectSide, headToHead,
  projectSkirmish, thresholdSentence,
  /* the Fury ladder, as the single source of truth */
  furyFor, furyCap, FURY_FEVER_CAP,
  /* the die both seats always roll. NEVER 0 for a live Skirmish. */
  BASE_DICE,
  CARD_MODS, E_D6, E_MAX_2D6,
});

root.OD = root.OD || {};
root.OD.Rules = Rules;

if(typeof module !== 'undefined' && module.exports) module.exports = {Rules: Rules};

})(typeof globalThis !== 'undefined' ? globalThis : this);
