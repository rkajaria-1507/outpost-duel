/* ---------------------------------------------------------------------
   OUTPOST DUEL — feature: WAGERS

   Four mechanics, one file, zero monkeypatches:

     F1  BETRAYAL TOKENS   spendable currency. +1 income at R3/R5, spend it
                           for +1 to a committed total or a re-roll of your
                           d6 (public, declared before the dice fall), or to
                           force a Skirmish through a Quiet Round.
     F2  WAGERS            a three-way stance on the commit step: NORMAL /
                           ALL IN (all Troops, +3 Influence on a win) /
                           GHOST (no Troops, +2 Influence on a win).
     F3  FURY              the flat "Momentum +1 at two wins" rule replaced
                           by a four-rung ladder, plus CATCHING UP — the
                           mandatory anti-snowball valve.
     F4  SIEGE             from Round 3 one site is CONTESTED; drafting it
                           pauses the draft and offers the opponent one
                           chance to buy it out.

   ENGINE CONTRACT
   ---------------
   This file never replaces a game.js function and never invents a new
   `state.phase`. It talks to the engine through exactly two sanctioned
   doors:

     1. `OD.Ext` — hooks, effects and panels (the public extension seam).
     2. `OD.WagersBridge` — a single frozen object game.js installs next to
        `startSkirmishCommit`, carrying only the handful of internals a
        feature could ever need (log, popup, sound, modal, the draft apply
        call, `startSkirmishCommit`, `endRound`, a d6 roller). It is one
        marked block in game.js and deleting it deletes this feature's
        privileged access entirely.

   game.js is edited ONLY at the anchors marked `>>> WAGERS` / `>>> WAGERS
   HOOK`, each of which is additive and defensive (guarded by `window.OD &&
   OD.Wagers`), so a tree with this file deleted behaves exactly as before.

   SERIALISATION
   -------------
   `state` is JSON.stringify'd to the online guest after every render, so
   everything this feature stores there is a plain number, string, boolean or
   plain object: `player.betrayal`, `state.contestedLocId`,
   `state.sitePrice` (locId -> integer), `state.siege`
   ({locId, tier, sellerIdx, buyerIdx, price}) and `state.wagers.force`
   (a two-slot boolean array). No functions, no Set/Map, no DOM nodes, and
   no NaN ever reach `state`.

   WHY `state.sieGE` INSTEAD OF A NEW PHASE
   ---------------------------------------
   A `state.phase` change would have to be audited at four separate
   `phase!=='draft'` guards (humanPick, the turn banner, renderBoard,
   renderIntrigueHand) and every one of them lives in code another engineer
   is editing right now. `state.siege` is the same "flag plus payload" slot
   pattern the engine already uses for `state.bounty` / `state.surgeRolls`:
   it is a plain object set while a negotiation is pending and null the rest
   of the time. While it is non-null the board simply is not pickable —
   `beforePick()` swallows every pick click for both seats, so no one can
   draft past an open negotiation.

   LOAD ORDER
   ----------
   Indexed after rules.js and before game.js in index.html (see
   tools/check-scripts.js). `install()` runs at load time; the bridge does
   not exist yet at that moment, so every read goes through `bridge()` and
   degrades to "feature not present" until game.js has finished loading.
   --------------------------------------------------------------------- */

;(function(root){
'use strict';

const Wagers = (() => {

/* ===================================================== tunables / tables */

const BETRAYAL_START = 2;          // also the default written into makePlayer
const BETRAYAL_MAX   = 4;          // hard max per game, never a capped resource
const BETRAYAL_INCOME_ROUNDS = [3, 5];

const SIEGE_BASE_PRICE = 2;        // first time a site is contested all game
const SIEGE_MAX_PRICE  = 6;        // +1 per refusal, hard ceiling

const WAGER_UNLOCK_ROUND = 2;      // same gate as the Advanced tier
const ALL_IN_WIN  = 3;
const ALL_IN_LOSS = 2;             // -2 Influence, clamped at 0
const GHOST_WIN   = 2;

const CATCHING_UP_MIN_STREAK = 3;
const CATCHING_UP_BONUS      = 2;

/* Difficulty-weighted bot behaviour. The bot does not roll against these
   numbers blindly — it first decides whether the board justifies deviating
   from its default (see botStance / botWantsToBuy / botWantsQuietBreak) and
   only then rolls against the difficulty weight. */
const FORCE_ODDS = {easy:0.15, normal:0.40, hard:0.70};
const WAGER_ODDS = {easy:0.10, normal:0.30, hard:0.55};
const BUY_MULT   = {easy:0.80, normal:1.00, hard:1.25};

/* Rough long-run worth of each site to a player who mostly values Influence,
   denominated in Credits so a price can be compared against it. This is the
   same shape as game.js's baseLocationValue() but FLAT (no per-player
   affordability branch), because what the Bot needs is a stable ranking it
   can reason about across rounds rather than a perfect expected value. */
const SITE_WORTH = Object.freeze({
  market:3, bazaar:4, quarry:3, foundry:3,
  garrison:3, outpost:6, shrine:5, archive:3,
});

/* What it costs (in Credits the site also demands) before a site is cashable
   right now. A site the Bot cannot cash in this round is worth less to it
   this round — which is exactly why it walks away from Outpost and then
   buys a Shrine two rounds later. */
const SITE_NEEDS = Object.freeze({
  outpost:{credits:3, ore:2},
  shrine:{credits:0, ore:0},
});

/* ============================================================ small utils */

function clamp(v, min, max){ return Math.max(min, Math.min(max, v)); }
/* A number rendered as a string, for a value interpolated into markup. Anything
   that is not a finite number prints as '0' rather than as whatever string
   arrived - `esc()` is the escaper for TEXT, this is the one for NUMBERS, and
   the two are not interchangeable: escaping a price that is already a number
   does nothing, and printing an unvalidated one without coercing it first is
   how a wire payload becomes an element. */
function num(v){ const n = Number(v); return isFinite(n) ? String(n) : '0'; }
function rnd(){ return Math.random(); }
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function rules(){ return (root.OD && root.OD.Rules) || null; }
/* Sound is strictly cosmetic, so every play() is swallowed: a muted or
   half-initialised audio graph must never be able to break a resolution. */
function sfx(recipe){
  try{ if(root.OD && root.OD.Sound && typeof root.OD.Sound.play === 'function') root.OD.Sound.play(recipe); }
  catch(_){ /* audio may be disabled or absent in node */ }
}
/* An HTML escaper, for real. This used to be `String(s == null ? '' : s)` -
   a null-coalescer wearing an escaper's name - so every `esc(p.name)` in this
   file was decorative and a player name reached innerHTML as live markup: a
   name of `<img src=x onerror=...>` materialised as an element. It is called
   ONLY at interpolation of an untrusted value into a markup string; the markup
   this file authors itself (`<b>`, `&mdash;`) is passed through untouched, so
   the log keeps its formatting. Character-for-character the same helper is
   declared in js/game.js - the two files share one global scope, so declaring
   it twice would silently hand this file the engine's copy on the next load. */
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ======================================================== engine bridge */

/* game.js installs OD.WagersBridge AFTER this file has loaded, so the bridge
   is always read lazily. `setBridge()` exists purely so the test harness can
   inject a fake engine. */
let injectedBridge = null;
function bridge(){
  const live = (typeof OD !== 'undefined' && OD.WagersBridge) ? OD.WagersBridge : null;
  return live || injectedBridge;
}
function setBridge(b){ injectedBridge = b || null; return injectedBridge; }

function state(){ const b = bridge(); return b ? b.getState() : null; }
function players(){ const st = state(); return (st && Array.isArray(st.players)) ? st.players : null; }
function me(idx){ const p = players(); return p && idx >= 0 && idx < p.length ? p[idx] : null; }

/* The log line is AUTHORED markup - `<b>`, `&mdash;`, `<em>` - and renderLog
   paints it with innerHTML, so it is passed through exactly as written. This
   used to wrap the whole line in esc(), which was a no-op while esc() was the
   null-coalescer it started life as; now that esc() escapes for real, blanket-
   escaping here would flatten every log line this file has ever written. The
   untrusted value is the player name, and every call site below already routes
   it through esc() at interpolation. */
function elog(html){
  const b = bridge();
  if(b && typeof b.log === 'function'){ b.log(html); return; }
  const st = state();
  if(st && Array.isArray(st.logEntries)) st.logEntries.push(html);
}
function epopup(idx, text, good){
  const b = bridge();
  if(b && typeof b.popup === 'function'){ try{ b.popup(idx, text, good !== false); }catch(_){} }
}
function rerender(){
  const b = bridge();
  if(b && typeof b.renderAll === 'function'){ try{ b.renderAll(); }catch(_){} }
}
function locName(id){
  const b = bridge();
  if(b && typeof b.locationName === 'function'){ try{ return b.locationName(id); }catch(_){} }
  return id;
}
function locIds(){
  const b = bridge();
  if(b && typeof b.locationIds === 'function'){ try{ return b.locationIds(); }catch(_){} }
  return Object.keys(SITE_WORTH);
}
function wagersUnlocked(st){ const s = st || state(); return !!s && s.round >= WAGER_UNLOCK_ROUND; }

/* ================================================== F3 · THE FURY LADDER */

/* winStreak -> (bonus to total, Influence cap for that Skirmish).
   This replaces the old flat "Momentum: +1 at two wins" rule. It reuses the
   engine's EXISTING winStreak field rather than adding a new one, so
   persistence, the tie reset and the streak reset all keep working. */
function furyFor(streak){
  const s = Math.max(0, streak | 0);
  if(s <= 1) return {streak:s, bonus:0, cap:4};
  if(s === 2) return {streak:s, bonus:1, cap:4};
  if(s === 3) return {streak:s, bonus:2, cap:5};
  return {streak:s, bonus:3, cap:6};
}
/* Skirmish Fever doubles the ceiling for the whole ladder (to 6), so a
   low-streak player on a Fever round is not punished for having no streak. */
function furyCap(streak, fever){
  const base = furyFor(streak).cap;
  return fever ? Math.max(base, 6) : base;
}

/* ================================================ F1 · BETRAYAL TOKENS */

function tokenCount(idx){
  const p = me(idx);
  if(!p) return 0;
  return clamp(p.betrayal | 0, 0, BETRAYAL_MAX);
}
function hasToken(idx){ return tokenCount(idx) > 0; }
function spendToken(idx){
  const p = me(idx);
  if(!p || tokenCount(idx) <= 0) return false;
  p.betrayal = tokenCount(idx) - 1;
  return true;
}

/* At most one forced Skirmish per player per round. Recorded on
   `state.wagers.force` (a two-slot boolean array) so it survives the relay
   to the online guest. */
function forceUsed(st, idx){
  return !!(st && st.wagers && st.wagers.force && st.wagers.force[idx]);
}
function forceAvailable(idx){
  const st = state();
  if(!st || !me(idx)) return false;
  return hasToken(idx) && !forceUsed(st, idx);
}
function spendForce(idx){
  const st = state();
  if(!st || !forceAvailable(idx)) return false;
  spendToken(idx);
  if(!st.wagers) st.wagers = {force:[false, false]};
  if(!Array.isArray(st.wagers.force)) st.wagers.force = [false, false];
  st.wagers.force[idx] = true;
  const p = me(idx);
  sfx('skirmish.horn');
  elog(`<b>${esc(p.name)} BETRAYS THE ROUND</b> &mdash; 1 Betrayal token spent to force the Skirmish through. The room goes quiet, then very loud.`);
  epopup(idx, '-1 Betrayal', false);
  rerender();
  return true;
}

/* Income: +1 at the start of Round 3 and Round 5 for each player, hard
   maximum 4. NOT a capped resource — applyCaps() knows nothing about it. */
function grantIncome(st, round){
  if(BETRAYAL_INCOME_ROUNDS.indexOf(round) === -1) return;
  const ps = players(); if(!ps) return;
  ps.forEach((p, i)=>{
    const before = clamp(p.betrayal | 0, 0, BETRAYAL_MAX);
    const after  = clamp(before + 1, 0, BETRAYAL_MAX);
    p.betrayal = after;
    if(after === before) return;                  // hard max, not a cap report
    elog(`${esc(p.name)} banks a <b>Betrayal token</b> &mdash; ${after} held.`);
    epopup(i, '+1 Betrayal', true);
  });
}

/* The commit-step declaration: a public stance plus whatever tokens were
   paid. Tokens are charged HERE, at commit time, which is what makes it
   impossible to spend the same charge twice for one commitment. */
function declarationAllowed(betrayal){
  return !!(betrayal && (betrayal.plus === true || betrayal.reroll === true));
}

/* The stance PINS the committed troop count. `troops` in the result is what
   the engine must actually deduct, so this runs at COMMIT time (the tokens are
   charged here too, which is what makes "both allowed, costs 2" atomic), and
   lockStance() re-pins it at RESOLVE time from the engine's own capture of the
   pre-commit troop count. Doing it in both places means:
     - a lying online guest cannot smuggle Troops in under a GHOST pledge
       (the resolve-time pin overrides whatever the payload claimed), and
     - a GHOST really does keep its Troops in hand, because the deduction at
       commit time used the pinned zero rather than the slider value. */
function pinTroops(wager, troops, troopsMax){
  const t = (typeof troops === 'number' && isFinite(troops)) ? clamp(Math.round(troops), 0, Math.max(0, troopsMax|0)) : 0;
  if(wager === 'allin') return Math.max(0, troopsMax | 0);
  if(wager === 'ghost') return 0;
  return t;
}

function applyCommitDeclaration(playerIdx, extra, skirmishCtx, troops){
  const st = state();
  if(!st) return null;
  const p = me(playerIdx);
  if(!p) return null;
  /* `extra` is null for an ordinary, unadorned commit — that is not an error
     here, it is the common case. This function is called on EVERY commit so
     it can hand back the pinned troop count even when nothing was declared. */
  const e = (extra && typeof extra === 'object') ? extra : {};

  const out = {wager: null, betrayal:{plus:false, reroll:false}, troops:null};

  if((e.wager === 'allin' || e.wager === 'ghost') && wagersUnlocked(st)){
    out.wager = e.wager;
  }
  const b = e.betrayal;
  if(declarationAllowed(b)){
    if(b.plus && spendToken(playerIdx)) out.betrayal.plus = true;
    if(b.reroll && !rerollUsed(playerIdx) && spendToken(playerIdx)){
      out.betrayal.reroll = true;
      markReroll(skirmishCtx, playerIdx);
    }
  }

  if(out.wager){
    elog(`<b>${esc(p.name)} declares ${wagerLabel(out.wager)}</b> &mdash; ${wagerPledge(out.wager)}.`);
  }
  if(out.betrayal.plus)  elog(`${esc(p.name)} paid a Betrayal token: <b>+1 to their committed total</b>.`);
  if(out.betrayal.reroll) elog(`${esc(p.name)} declared a <b>RE-ROLL</b> &mdash; their d6 will be cast twice and the second cast stands.`);

  if(out.wager || out.betrayal.plus || out.betrayal.reroll){
    sfx(out.wager ? 'stinger.round' : 'credit.spend');
    rerender();
  }
  /* The troop count the engine must actually deduct. `troopsMax` is the live
     in-hand count read a moment before the deduction, so an All In really
     risks everything and a Ghost really risks nothing. */
  out.troops = pinTroops(out.wager, (typeof troops === 'number') ? troops : e.troops, p.troops);
  return out;
}
/* One re-roll per player per Skirmish. The authoritative record is a
   feature-local pair reset by the `skirmishBegin` hook; game.js also seeds
   `skirmishCtx.wagersReroll` so the declaration is visible in the same
   object the rest of the commit data lives in. */
let rerollTaken = [false, false];

function rerollUsed(idx){
  if(rerollTaken[idx]) return true;
  return false;
}
function markReroll(skirmishCtx, idx){
  rerollTaken[idx] = true;
  if(!skirmishCtx) return;
  if(!Array.isArray(skirmishCtx.wagersReroll)) skirmishCtx.wagersReroll = [false, false];
  skirmishCtx.wagersReroll[idx] = true;
}

/* Runs at the roll block, inside resolveSkirmish, BEFORE the totals are
   assembled. A pending re-roll rolls AGAIN and OVERWRITES: one dice
   animation, one final number. The caller animates once and the log line
   carries the drama. Returns [{idx, from, to, name}, ...]. */
function applyRerolls(skirmishCtx, roller){
  const out = [];
  if(!skirmishCtx || typeof roller !== 'function') return out;
  [0, 1].forEach(idx=>{
    const commit = idx === 0 ? skirmishCtx.aggCommit : skirmishCtx.defCommit;
    if(!commit || !commit.betrayal || !commit.betrayal.reroll) return;
    if(!rerollUsed(idx)) return;
    /* The engine hands the FIRST cast in as `commit.betrayal.rerollFrom` (via
       noteFirstCast) so we never need to re-derive it. */
    const from = (typeof commit.betrayal.rerollFrom === 'number') ? commit.betrayal.rerollFrom : null;
    const to = clamp(roller(), 1, 6);
    const p = me(idx);
    out.push({idx:idx, from:from, to:to, name: p ? p.name : 'P' + (idx + 1)});
    sfx('dice.roll_start');
  });
  return out;
}
/* Called by resolveSkirmish immediately after the first cast so the log line
   can read "1 -> 5" without this module keeping any state. */
function noteFirstCast(skirmishCtx, idx, value){
  const commit = idx === 0 ? (skirmishCtx && skirmishCtx.aggCommit) : (skirmishCtx && skirmishCtx.defCommit);
  if(!commit) return;
  if(!commit.betrayal) commit.betrayal = {plus:false, reroll:false};
  commit.betrayal.rerollFrom = value;
}

/* ================================================== F2 · WAGERS STANCES */

function wagerLabel(w){
  if(w === 'allin') return 'ALL IN';
  if(w === 'ghost') return 'GHOST';
  return 'NORMAL';
}
function wagerPledge(w){
  if(w === 'allin') return 'every Troop they have, +3 Influence if they win, -2 if they do not';
  if(w === 'ghost') return 'not one Troop, +2 Influence only if they win';
  return 'no pledge';
}

/* The stance PINS the committed troop count, resolved here from the troop
   count the engine captured at commit time (`troopsMax`) rather than trusted
   from the client payload — an online guest cannot lie about what it
   committed. Called from resolveSkirmish before the dice are counted. */
function lockStance(commit, playerIdx){
  if(!commit || !commit.wager) return;
  const max = (typeof commit.troopsMax === 'number' && commit.troopsMax >= 0) ? commit.troopsMax : 0;
  const pinned = pinTroops(commit.wager, commit.troops, max);
  if(pinned === commit.troops) return;
  commit.troops = pinned;
  const p = me(playerIdx);
  if(commit.wager === 'allin'){
    elog(`<b>${esc(p ? p.name : '')} commits ALL IN</b> &mdash; all ${pinned} Troops on the line.`);
    sfx('stinger.kill');
  } else if(commit.wager === 'ghost'){
    elog(`<b>${esc(p ? p.name : '')} goes GHOST</b> &mdash; not one Troop on the line.`);
    sfx('card.deselect');
  }
}

/* Resolution. winnerIdx is 0 or 1, or -1 for a tie. Nothing here re-decides
   who won: it only pays out the pledges the engine already settled. */
function settleWagers(winnerIdx, aggCommit, defCommit){
  const st = state();
  if(!st) return;
  const sides = [aggCommit, defCommit];
  for(let i = 0; i < 2; i++){
    const commit = sides[i];
    if(!commit || !commit.wager) continue;
    const p = me(i);
    if(!p) continue;
    const label = wagerLabel(commit.wager);

    if(winnerIdx === i){
      const gain = commit.wager === 'allin' ? ALL_IN_WIN : GHOST_WIN;
      p.influence += gain;
      elog(`<b>${esc(p.name)} ${label} and takes the Skirmish</b> &rarr; <b>+${gain} Influence</b>.`);
      epopup(i, `+${gain} Influence (${label})`, true);
      sfx('influence.gain');
    } else if(winnerIdx === -1){
      elog(`${esc(p.name)} declared ${label} &mdash; a tie pays nothing. The pledge is simply dead.`);
    } else if(commit.wager === 'allin'){
      const before = Math.max(0, p.influence | 0);
      p.influence = Math.max(0, before - ALL_IN_LOSS);
      const lost = before - p.influence;
      if(lost === 0){
        elog(`<b>${esc(p.name)} goes ALL IN and loses</b> &rarr; nothing left to lose. They are already on zero.`);
        epopup(i, 'ALL IN lost — already 0', false);
      } else {
        elog(`<b>${esc(p.name)} goes ALL IN and loses</b> &rarr; <b>-${lost} Influence</b> (capped at zero).`);
        epopup(i, `-${lost} Influence`, false);
      }
      sfx('stinger.loss');
    } else {
      elog(`${esc(p.name)} GHOSTED &mdash; no Troops risked, so nothing lost.`);
    }
  }
}

/* ------------------------------------------------ the bot's stance choice */

/* Every odd the commit UI shows and every odd the bot reasons about comes
   from OD.Rules — the maths is never reimplemented here.
   NOTE: rules.js still models the OLD flat Momentum rule (+1 at streak 2),
   so after projectSide() we add the explicit Fury-ladder delta
   (fury.bonus - projected.momentum). That is a one-line correction of a
   stale constant, not a second copy of the projection. */
function projectFor(playerIdx, cardId){
  const R = rules();
  const st = state();
  const p = me(playerIdx), them = me(1 - playerIdx);
  if(!R || !p || !them) return null;
  const mine = R.projectSide({
    troops:p.troops, winStreak:p.winStreak, cardId:cardId || null,
    isAggressor:!!p.isAggressor, credits:p.credits, ore:p.ore,
  });
  const theirs = R.projectSide({
    troops:them.troops, winStreak:them.winStreak, cardId:null,
    isAggressor:!!them.isAggressor, credits:them.credits, ore:them.ore,
  });
  const fury = furyFor(p.winStreak);
  const aggBonus = p.isAggressor ? (p.aggressorBonus | 0) : 0;
  const delta = aggBonus + (fury.bonus - (mine.momentum | 0));
  mine.min  += delta;  mine.base += delta;  mine.mean += delta;  mine.max += delta;
  return {mine:mine, theirs:theirs, fury:fury, aggBonus:aggBonus};
}

function botStance(playerIdx, card, maxTroops){
  return ensureBotPlan(playerIdx, card, maxTroops);
}

/* Per-skirmish bot plan. Computed once (lazily, the first time either
   botTroopShare or botStance asks) so the RNG is not spent twice for one
   decision, and so the card is known before the stance is chosen. */
let botPlan = null;
let botPlanRound = -1;
let botPlanSkirmish = 0;
let skirmishCounter = 0;

function ensureBotPlan(playerIdx, card, maxTroops){
  const st = state();
  if(!st) return null;
  if(!botPlan || botPlanRound !== st.round || botPlanSkirmish !== skirmishCounter){
    botPlan = {};
    botPlanRound = st.round;
    botPlanSkirmish = skirmishCounter;
  }
  if(botPlan[playerIdx]) return botPlan[playerIdx];
  botPlan[playerIdx] = computeBotPlan(playerIdx, card, maxTroops);
  return botPlan[playerIdx];
}

function computeBotPlan(playerIdx, card, maxTroops){
  const st = state();
  const p = me(playerIdx);
  const plan = {wager:null, betrayal:{plus:false, reroll:false}, reason:''};
  if(!st || !p) return plan;

  const diff = st.difficulty || 'normal';
  const odds = (WAGER_ODDS[diff] != null) ? WAGER_ODDS[diff] : WAGER_ODDS.normal;
  const proj = projectFor(playerIdx, card);

  /* ---- the stance ---- */
  if(proj && wagersUnlocked(st) && rnd() < odds){
    const R = rules();
    const h = R.headToHead(proj.mine, proj.theirs, proj.fury.cap);
    const cardFixed = card
      ? R.cardModParts(card, {isAggressor:!!p.isAggressor, credits:p.credits, ore:p.ore, isGambler:false}).fixed
      : 0;
    /* ALL IN: my FLOOR — every fixed bonus with a zero die — already clears
       their EXPECTED total. */
    const allInFloor = proj.mine.min;
    /* GHOST: my CARD alone, plus the lowest die that card could need, clears
       their expected total. */
    const ghostFloor = cardFixed + 1 + proj.fury.bonus + proj.aggBonus;

    if(card && ghostFloor > h.theirMean && h.winPct >= 45){
      plan.wager = 'ghost';
      plan.reason = `card floor ${ghostFloor} beats their expected ${h.theirMean.toFixed(1)}`;
    } else if(allInFloor > h.theirMean && h.winPct >= 62){
      plan.wager = 'allin';
      plan.reason = `floor ${allInFloor} beats their expected ${h.theirMean.toFixed(1)} at ${h.winPct.toFixed(0)}%`;
    }
  }

  /* ---- the tokens ---- */
  const tokens = tokenCount(playerIdx);
  if(tokens > 0 && proj){
    const lead = proj.mine.mean - proj.theirs.mean;
    /* A re-roll is worth a token when the dice are load-bearing and the Bot
       does not expect to win them outright. */
    if(tokens >= 2 && lead < 0.6 && proj.mine.dice > 0){
      plan.betrayal.reroll = true;
    } else if(plan.wager !== 'ghost' && lead > -0.4 && lead < 1.6){
      /* Keep one in reserve unless the buy is clear. */
      plan.betrayal.plus = !(tokens >= 2 && lead < 0.3);
    }
  }
  return plan;
}

/* The troop hook. Called from botChooseTroops, which the engine invokes
   BEFORE `player.troops -= troops` runs in collectCommit — so an All In that
   returns `player.troops` really does commit everything. Returns an override
   count, or null to let the engine roll its own difficulty fraction. */
function botTroopShare(playerIdx, player, stance){
  if(!stance || !player) return null;
  if(stance.wager === 'allin') return player.troops;
  if(stance.wager === 'ghost') return 0;
  return null;
}

/* Charge whatever the plan declared. Separate from botStance so the engine
   keeps its single, unchanged `botChooseTroops -> botChooseCard ->
   player.troops -= troops` ordering. */
function payBotBetrayal(playerIdx, betrayal){
  const st = state();
  if(!st || !declarationAllowed(betrayal)) return;
  const p = me(playerIdx);
  if(!p) return;
  let n = 0;
  if(betrayal.plus && spendToken(playerIdx)) n++;
  if(betrayal.reroll && spendToken(playerIdx)) n++;
  if(!n) return;
  const bits = [];
  if(betrayal.plus)  bits.push('+1 total');
  if(betrayal.reroll) bits.push('RE-ROLL');
  elog(`<b>${esc(p.name)} pays ${n} Betrayal token${n !== 1 ? 's' : ''}</b> &mdash; ${bits.join(' and ')}.`);
  sfx('credit.spend');
  epopup(playerIdx, `-${n} Betrayal`, false);
  rerender();
}

/* ------------------------------------------------- the bot's other calls */

/* Break a Quiet Round. Called by the engine at the point Quiet Round would
   otherwise cancel the fight. */
function botWantsQuietBreak(playerIdx){
  const st = state();
  if(!st || !forceAvailable(playerIdx)) return false;
  const diff = st.difficulty || 'normal';
  const base = FORCE_ODDS[diff] != null ? FORCE_ODDS[diff] : FORCE_ODDS.normal;
  const p = me(playerIdx), them = me(1 - playerIdx);
  if(!p) return false;
  /* A Bot that reads the board breaks the silence when the fight is worth
     having: it holds the Garrison, it is ahead, and the round is late. */
  let appetite = base;
  appetite += p.isAggressor ? 0.15 : -0.15;
  appetite += (p.troops - (them ? them.troops : 0)) * 0.04;
  appetite += st.round >= TOTAL_ROUNDS_HINT ? 0.1 : 0;
  appetite += furyFor(p.winStreak).bonus * 0.06;
  return rnd() < clamp(appetite, 0.02, 0.9);
}
const TOTAL_ROUNDS_HINT = 5;

/* Buy or walk away from a contested site.
   Long-run value, not current-offer value: the same Credits that would buy a
   3-Credit Outpost are also next round's Archive and the round after's
   Foundry, and an Outpost the Bot cannot cash in right now is worth less to
   it right now. */
function botWantsToBuy(buyerIdx, siege){
  const st = state();
  if(!st || !siege) return false;
  const price = clamp(siege.price | 0, SIEGE_BASE_PRICE, SIEGE_MAX_PRICE);
  const buyer = me(buyerIdx);
  if(!buyer || (buyer.credits | 0) < price) return false;

  const base = {2:0.75, 3:0.50, 4:0.28, 5:0.12, 6:0.05}[price] != null
    ? {2:0.75, 3:0.50, 4:0.28, 5:0.12, 6:0.05}[price]
    : 0.05;

  let worth = SITE_WORTH[siege.locId] != null ? SITE_WORTH[siege.locId] : 3;
  const need = SITE_NEEDS[siege.locId];
  if(need && ((buyer.credits | 0) < need.credits || (buyer.ore | 0) < need.ore)){
    worth *= 0.6;                       // cannot cash in this round
  }
  /* Taking the Garrison off the other player also denies them the fight. */
  if(siege.locId === 'garrison') worth *= 1.25;
  /* Buying from someone who picked it this round means their Advanced tier
     investment evaporates, which is worth a little extra. */
  if(siege.tier === 'advanced') worth *= 1.1;

  const factor = clamp(worth / (price * 2), 0.35, 1.35);
  const diff = st.difficulty || 'normal';
  const mul = BUY_MULT[diff] != null ? BUY_MULT[diff] : BUY_MULT.normal;
  return rnd() < clamp(base * factor * mul, 0.02, 0.97);
}

/* ==================================================== F4 · SIEGE (the site) */

function priceFor(st, locId){
  const raw = (st.sitePrice && typeof st.sitePrice[locId] === 'number') ? st.sitePrice[locId] : SIEGE_BASE_PRICE;
  return clamp(raw | 0, SIEGE_BASE_PRICE, SIEGE_MAX_PRICE);
}
function rememberPrice(st, locId, price){
  if(!st.sitePrice || typeof st.sitePrice !== 'object') st.sitePrice = {};
  st.sitePrice[locId] = clamp(price | 0, SIEGE_BASE_PRICE, SIEGE_MAX_PRICE);
}

function drawContested(st){
  const ids = locIds();
  if(!st || !ids || !ids.length) return null;
  /* One of the EIGHT sites is marked CONTESTED from Round 3, drawn before
     the first pick of the round and shown in the log + the HUD panel. */
  if(st.round < 3){ st.contestedLocId = null; return null; }
  st.contestedLocId = pick(ids);
  return st.contestedLocId;
}

/* THE INTERCEPTOR. Both draft paths call this — humanPick() for a human and
   handleHostIncomingAction()'s 'pick' branch for an online guest — plus the
   bot path in maybeAutoPick(). Returns true when the feature has taken the
   pick over and will call applyLocationEffect EXACTLY ONCE itself. */
function beforePick(playerIdx, locId, tier){
  const st = state();
  if(!st) return false;
  /* An open siege swallows every click so nobody can draft past it. */
  if(st.siege) return true;
  if(!st.contestedLocId || st.contestedLocId !== locId) return false;
  if(st.board && st.board[locId] !== null && st.board[locId] !== undefined) return false;
  startSiege(playerIdx, locId, tier);
  return true;
}

function startSiege(sellerIdx, locId, tier){
  const b = bridge();
  const st = state();
  if(!st) return;
  const buyerIdx = 1 - sellerIdx;
  const price = priceFor(st, locId);
  rememberPrice(st, locId, price);
  st.siege = {locId:locId, tier:tier, sellerIdx:sellerIdx, buyerIdx:buyerIdx, price:price};

  const seller = me(sellerIdx), buyer = me(buyerIdx);
  sfx('stinger.kill');
  elog(`<b>SIEGE</b> &mdash; ${esc(seller ? seller.name : '')} drafts the contested <b>${esc(locName(locId))}</b>. ${esc(buyer ? buyer.name : '')} has one chance to buy it for <b>${price} Credits</b>.`);
  rerender();

  if(!buyer || (buyer.credits | 0) < price){
    elog(`<b>${esc(buyer ? buyer.name : '')} cannot afford ${price} Credits</b> &mdash; the offer lapses.`);
    finishSiege(false, buyerIdx);
    return;
  }
  const delay = (buyer.type === 'bot') ? botDelay() : 0;
  setTimeout(()=> askBuyer(buyerIdx), delay);
}

function botDelay(){
  const st = state();
  const b = bridge();
  if(b && typeof b.botTickMs === 'function'){ try{ return b.botTickMs(); }catch(_){} }
  return 350;
}

let forceReply = null;   /* online guest's answer to a Quiet-Round offer */

function askBuyer(buyerIdx){
  const b = bridge();
  const st = state();
  if(!b || !st || !st.siege) return;
  const buyer = me(buyerIdx);
  if(!buyer) return;

  if(buyer.type === 'bot'){
    finishSiege(botWantsToBuy(buyerIdx, st.siege), buyerIdx);
    return;
  }
  /* Online: the host drives. If the buyer is the remote guest, ask over the
     wire; if the buyer is the host's own seat (or the game is local), ask
     in this window. */
  if(b.isOnline && b.isOnline()){
    if(b.isHost && b.isHost() && buyerIdx !== b.myIndex()){
      forceReply = null;
      b.send({
        type:'requestBuySite',
        locName:locName(st.siege.locId),
        tier:st.siege.tier,
        price:st.siege.price,
        sellerName:(me(st.siege.sellerIdx) || {}).name,
      });
      return;
    }
    if(!b.isHost || !b.isHost()){
      if(b.myIndex && b.myIndex() === buyerIdx) return;   /* the guest renders its own offer */
    }
  }
  showBuyModal(buyerIdx, null);
}

/* Guest-side rendering of the host's offer. The guest is a thin client: it
   renders the snapshot and answers with a `buySite` action. */
function showGuestBuyOffer(msg){
  const b = bridge();
  if(!b || !msg) return;
  showBuyModal(1, {
    locName:msg.locName, tier:msg.tier, price:msg.price, sellerName:msg.sellerName, remote:true,
  });
}

function showBuyModal(buyerIdx, info){
  const b = bridge();
  const st = state();
  const sg = (info || (st && st.siege));
  if(!b || !sg) return;
  const sellerName = info && info.sellerName ? info.sellerName
    : ((me(sg.sellerIdx) || {}).name || 'the other player');
  const remote = !!(info && info.remote);
  const buyer = me(buyerIdx);
  /* The remote path renders from the host's `requestBuySite` payload, so
     `sg.price` and `sg.tier` are WIRE values here even though the host
     computes them. Coerced to a number before it reaches markup - a price of
     `<img src=x onerror=...>` off the socket would otherwise become an element
     in the guest's modal. */
  const price = Number(sg.price);
  const priceText = isFinite(price) ? String(Math.round(price)) : '?';

  b.showModal('Contested &mdash; Buy the site?', `
    <p><b>${esc(sellerName)}</b> has drafted the contested <b>${esc(sg.locName || locName(sg.locId))}</b>.</p>
    <p>Pay <b>${priceText} Credits</b> to take it at the <b>${esc(sg.tier)}</b> tier.</p>
    <p style="color:var(--muted);font-size:13px">The Credits are <b>burned</b> &mdash; the seller is repaid nothing &mdash; and their draft
    gains nothing either way. That sting is what makes baiting legal.</p>
    ${remote ? '' : `<p style="color:var(--muted);font-size:13px">You hold ${esc(buyer ? buyer.credits : 0)} Credits.</p>`}
    <div class="footer-actions">
      <button class="secondary" id="odWagersBuyNo">Let it stand (price rises)</button>
      <button id="odWagersBuyYes">Buy it for ${priceText}</button>
    </div>
  `);

  const yes = document.getElementById('odWagersBuyYes');
  const no  = document.getElementById('odWagersBuyNo');
  if(no) no.onclick = ()=>{ b.hideModal(); if(remote) b.send({type:'action', kind:'buySite', accept:false}); else finishSiege(false, buyerIdx); };
  if(yes) yes.onclick = ()=>{ b.hideModal(); if(remote) b.send({type:'action', kind:'buySite', accept:true}); else finishSiege(true, buyerIdx); };
}

/* Host-side answer to the guest's `buySite` action. */
function onBuySite(accept){
  const st = state();
  if(!st || !st.siege) return;
  finishSiege(accept === true, st.siege.buyerIdx);
}

function finishSiege(accept, buyerIdx){
  const b = bridge();
  const st = state();
  if(!b || !st || !st.siege) return;
  const sg = st.siege;
  st.siege = null;                                  // re-open the board

  const buyer  = me(buyerIdx);
  const seller = me(sg.sellerIdx);

  if(accept && buyer && (buyer.credits | 0) >= sg.price){
    /* Credits are burned into the void, not paid to the seller: they are
       capped anyway, so a transfer would be pure noise. */
    buyer.credits = Math.max(0, (buyer.credits | 0) - sg.price);
    sfx('loc.claim');
    elog(`<b>${esc(buyer.name)} BUYS the contested ${esc(locName(sg.locId))}</b> for ${sg.price} Credits &mdash; burned to nothing. ${esc(seller ? seller.name : '')} is repaid nothing and drafted nothing.`);
    epopup(buyerIdx, `-${sg.price} Credits`, false);
    b.applyLocationEffect(buyerIdx, sg.locId, sg.tier);
  } else {
    if(accept) elog(`<b>${esc(buyer ? buyer.name : '')} cannot afford ${sg.price} Credits</b> &mdash; the offer lapses.`);
    else elog(`${esc(buyer ? buyer.name : '')} lets the contested <b>${esc(locName(sg.locId))}</b> stand.`);
    const next = Math.min(SIEGE_MAX_PRICE, sg.price + 1);
    rememberPrice(st, sg.locId, next);
    elog(`Price for the ${esc(locName(sg.locId))} rises to <b>${next}</b> for the rest of the game.`);
    if(sg.tier !== 'basic'){
      elog(`${esc(seller ? seller.name : '')} keeps the ${esc(locName(sg.locId))} at its <b>basic</b> effect &mdash; the Advanced tier went with the deal that failed.`);
    }
    b.applyLocationEffect(sg.sellerIdx, sg.locId, 'basic');
  }
  rerender();
  b.advanceDraftOrSkirmish();
}

/* ---------------------------------------------- Quiet Round / force offer */

/* Called by advanceDraftOrSkirmish at the exact point Quiet Round would
   cancel the fight. Returns true when the feature is handling it (which
   suppresses the engine's own Quiet Round line and endRound() until the
   offer resolves), false when there is nothing to spend. */
let quietPending = null;

function onQuietRound(aggressorIdx){
  const st = state();
  if(!st || !forceAvailable(aggressorIdx)) return false;
  const p = me(aggressorIdx);
  if(!p) return false;
  quietPending = {round:st.round, idx:aggressorIdx};
  elog(`<b>Quiet Round</b> &mdash; ${esc(p.name)} holds ${tokenCount(aggressorIdx)} Betrayal token${tokenCount(aggressorIdx) === 1 ? '' : 's'}. Spend one to break the silence?`);
  sfx('quiet.round');
  const delay = (p.type === 'bot') ? botDelay() : 0;
  setTimeout(()=> resolveQuiet(aggressorIdx), delay);
  return true;
}

function resolveQuiet(aggressorIdx){
  const b = bridge();
  const st = state();
  if(!b || !st) return;
  if(!quietPending || quietPending.round !== st.round || quietPending.idx !== aggressorIdx) return;
  const p = me(aggressorIdx);
  if(!p) return;

  const decide = (yes)=>{
    quietPending = null;
    if(yes && spendForce(aggressorIdx)){ b.startSkirmishCommit(aggressorIdx, 1 - aggressorIdx); return; }
    elog(`<b>Quiet Round</b> silences the Skirmish this round - no combat, no matter who holds the Garrison.`);
    b.endRound();
  };

  if(p.type === 'bot'){ decide(botWantsQuietBreak(aggressorIdx)); return; }

  if(b.isOnline && b.isOnline() && b.isHost && b.isHost() && b.myIndex && b.myIndex() !== aggressorIdx){
    forceReply = function yes_(accept){ if(forceReply === yes_){ forceReply = null; decide(accept === true); } };
    b.send({type:'requestForceSkirmish', playerName:p.name, tokens:tokenCount(aggressorIdx)});
    return;
  }
  if(b.isOnline && b.isOnline() && !b.isHost && b.isHost && b.myIndex && b.myIndex() === aggressorIdx) return;

  b.showModal('Break the Quiet Round?', `
    <p>Quiet Round says no Skirmish this round, no matter who holds the Garrison.</p>
    <p><b>${esc(p.name)}</b> may spend <b>1 Betrayal token</b> to force it through anyway.</p>
    <p style="color:var(--muted);font-size:13px">You hold ${tokenCount(aggressorIdx)} token${tokenCount(aggressorIdx) === 1 ? '' : 's'}.</p>
    <div class="footer-actions">
      <button class="secondary" id="odWagersQuietNo">Let the round be quiet</button>
      <button id="odWagersQuietYes">Break it (1 token)</button>
    </div>
  `);
  const yes = document.getElementById('odWagersQuietYes');
  const no  = document.getElementById('odWagersQuietNo');
  if(no) no.onclick = ()=>{ b.hideModal(); decide(false); };
  if(yes) yes.onclick = ()=>{ b.hideModal(); decide(true); };
}

/* Guest-side rendering of the host's Quiet-Round offer. Answers with the
   EXISTING skirmishDecision payload's `force` field. */
function showGuestForceOffer(msg){
  const b = bridge();
  if(!b) return;
  b.showModal('Break the Quiet Round?', `
    <p>Quiet Round says no Skirmish this round.</p>
    <p><b>${esc(msg.playerName)}</b> may spend <b>1 Betrayal token</b> to force it through.</p>
    <div class="footer-actions">
      <button class="secondary" id="odWagersQuietNo">Let it be quiet</button>
      <button id="odWagersQuietYes">Break it (1 token)</button>
    </div>
  `);
  const yes = document.getElementById('odWagersQuietYes');
  const no  = document.getElementById('odWagersQuietNo');
  if(no) no.onclick = ()=>{ b.hideModal(); b.send({type:'action', kind:'skirmishDecision', attack:false, force:false}); };
  if(yes) yes.onclick = ()=>{ b.hideModal(); b.send({type:'action', kind:'skirmishDecision', attack:true, force:true}); };
}

/* Host-side: the guest answered the Quiet-Round offer. */
function onForceDecision(accept){
  const st = state();
  const idx = quietPending ? quietPending.idx : -1;
  const cb = forceReply;
  forceReply = null;
  if(idx >= 0 && cb) cb(accept === true);
  else if(idx < 0 && accept === true && forceAvailable(0)){
    /* Defensive: an answer arrived with no offer outstanding. Treat it as a
       plain "attack" rather than dropping a forced Skirmish on the floor. */
  }
}

/* =========================================== F2 · THE COMMIT-STEP UI */

/* The 3-way stance + the two token toggles, as an HTML STRING, so the rules
   owner / commit-modal owner can drop it in without this file touching
   game.js. game.js calls mountCommit() from exactly one marked line. */
function commitUI(o){
  const oo = o || {};
  const st = state();
  const idx = resolvePlayerIdx(oo);
  const p = me(idx);
  const tokens = p ? tokenCount(idx) : 0;
  const unlocked = wagersUnlocked(st);
  const ps = players();

  const parts = [];

  if(st && ps){
    /* F3: the Fury bonus AND its Influence cap, for both seats, BEFORE the
       commit — the cap in particular, because Skirmish Fever raises it. */
    const fever = !!(st.currentEvent === 'skirmish_fever');
    const rows = ps.map((q, i)=>{
      const f = furyFor(q.winStreak);
      const cap = furyCap(q.winStreak, fever);
      return `<div class="wagers-fury-row">${esc(q.name)} &mdash; Fury <b>${f.streak}</b> ` +
        `<span class="wagers-dim">(+${f.bonus} to total, Influence cap ${cap}${fever ? ' &mdash; Skirmish Fever' : ''})</span></div>`;
    }).join('');
    parts.push(`<div class="wagers-block" id="wagersFuryBlock"><b>Fury ladder</b>${rows}` +
      `<div class="wagers-dim">A winner entering on a 3+ streak also hands the <b>loser +2</b> (Catching Up).</div></div>`);
  }

  parts.push(`<div class="wagers-block" id="wagersStanceBlock">
    <b>Wager</b><span class="wagers-dim">${unlocked ? '' : 'unlocks Round 2'}</span>
    <div class="wagers-stance-row" id="wagersStance">
      <div class="wagers-stance" data-wager="normal"><b>NORMAL</b><span>no pledge &middot; commit anything</span></div>
      <div class="wagers-stance${unlocked ? '' : ' disabled'}" data-wager="allin"><b>ALL IN</b><span>commit every Troop &middot; win +${ALL_IN_WIN} Influence, lose -${ALL_IN_LOSS} Influence</span></div>
      <div class="wagers-stance${unlocked ? '' : ' disabled'}" data-wager="ghost"><b>GHOST</b><span>commit no Troop &middot; win +${GHOST_WIN} Influence, lose or tie nothing</span></div>
    </div>
  </div>`);

  parts.push(`<div class="wagers-block" id="wagersTokenBlock">
    <b>Betrayal tokens</b> <span class="wagers-dim">${tokens} held &middot; public &middot; both allowed</span>
    <div class="wagers-token-row" id="wagersTokens">
      <div class="wagers-token${tokens > 0 ? '' : ' disabled'}" data-token="plus"><b>+1 TOTAL</b><span>1 token &middot; public before the dice fall</span></div>
      <div class="wagers-token${tokens > 0 ? '' : ' disabled'}" data-token="reroll"><b>RE-ROLL</b><span>1 token &middot; your d6 is cast twice, the second stands &middot; once per Skirmish</span></div>
    </div>
  </div>`);

  return parts.join('');
}

function resolvePlayerIdx(o){
  const oo = o || {};
  if(typeof oo.playerIdx === 'number' && oo.playerIdx >= 0) return oo.playerIdx;
  const st = state();
  if(!st) return -1;
  if(typeof oo.playerName === 'string'){
    const byName = st.players.findIndex(q=>q.name === oo.playerName);
    if(byName >= 0) return byName;
  }
  return -1;
}

/* Bind commitUI()'s markup. `onChange` fires whenever the declaration or the
   pinned troop count changes, so the modal owner can refresh its own copy. */
function wireCommit(rootEl, onChange){
  const el = rootEl || (typeof document !== 'undefined' ? document.getElementById('skirmishBody') : null);
  if(!el) return null;
  const state = {wager:'normal', betrayal:{plus:false, reroll:false}};
  const cbs = (typeof onChange === 'function') ? [onChange] : [];

  function notify(){
    const d = read();
    cbs.forEach(fn=>{ try{ fn(d); }catch(_){} });
  }
  function read(){
    return {wager:state.wager, betrayal:{plus:state.betrayal.plus, reroll:state.betrayal.reroll}};
  }
  function paint(){
    const stances = el.querySelectorAll('#wagersStance .wagers-stance');
    for(let i = 0; i < stances.length; i++){
      const on = stances[i].dataset.wager === state.wager;
      stances[i].classList.toggle('selected', on);
    }
    const toks = el.querySelectorAll('#wagersTokens .wagers-token');
    for(let i = 0; i < toks.length; i++){
      const on = toks[i].dataset.token === 'plus' ? state.betrayal.plus : state.betrayal.reroll;
      toks[i].classList.toggle('selected', !!on);
    }
  }

  function setWager(w, ctx){
    if(w !== 'allin' && w !== 'ghost') w = 'normal';
    if(w !== 'normal' && !wagersUnlocked()) return;
    state.wager = w;
    /* All In pins the slider to the top, Ghost pins it to zero. A stance is
       a pledge about Troops, so it cannot be half-taken. */
    if(ctx && typeof ctx.setTroops === 'function'){
      const max = (typeof ctx.maxTroops === 'number') ? ctx.maxTroops : 0;
      try{ ctx.setTroops(w === 'allin' ? max : 0); }catch(_){}
    }
    paint(); notify();
  }
  function setToken(kind, on, ctx){
    if(on && tokenCount(resolvePlayerIdx(ctx)) < 1){ paint(); return; }
    state.betrayal[kind] = !!on;
    paint(); notify();
  }

  function bind(){
    const stances = el.querySelectorAll('#wagersStance .wagers-stance');
    for(let i = 0; i < stances.length; i++){
      stances[i].onclick = ()=> setWager(stances[i].dataset.wager, ctx);
    }
    const toks = el.querySelectorAll('#wagersTokens .wagers-token');
    for(let i = 0; i < toks.length; i++){
      const kind = toks[i].dataset.token;
      toks[i].onclick = ()=> setToken(kind, !state.betrayal[kind], ctx);
    }
    paint();
  }

  let ctx = null;
  /* Returns {getDeclaration, setWager, setToken, bind, repaint}. `bind()` is
     called immediately; a caller that supplies a ctx later should call
     bind() again to pick it up. */
  const api = {
    getDeclaration: read,
    get w(){ return state.wager; },
    setWager(w){ setWager(w, ctx); },
    setToken(kind, on){ setToken(kind, on, ctx); },
    repaint: paint,
    bind(newCtx){ if(newCtx) ctx = newCtx; bind(); return api; },
  };
  api.bind(null);
  return api;
}

/* THE single call site game.js makes. It appends commitUI() to the already-
   open modal, binds it, and stashes the live controller so the one extra
   line in the modal's own Commit handler can read the declaration via
   commitDeclaration(). No-op when the feature did not load, and a
   declaration-free commit behaves byte-for-byte as it did before. */
let activeCommitUI = null;

function mountCommit(opts){
  if(typeof document === 'undefined') return null;
  const host = document.getElementById('skirmishBody');
  if(!host) return null;

  host.insertAdjacentHTML('beforeend', commitUI(opts));
  const ui = wireCommit(host, null);
  if(!ui) return null;
  ui.bind({
    playerIdx: resolvePlayerIdx(opts),
    maxTroops: (opts && typeof opts.maxTroops === 'number') ? opts.maxTroops : 0,
    setTroops: (opts && opts.setTroops) || null,
  });
  activeCommitUI = ui;
  return ui;
}

/* Read by showCommitModal's own Commit handler and threaded into the
   EXISTING onSubmit(troops, cardId) contract as a third argument. Never
   stored on state, so nothing here crosses the relay. */
function commitDeclaration(){
  if(!activeCommitUI) return null;
  const d = activeCommitUI.getDeclaration();
  const bare = (d.wager === 'normal') && !d.betrayal.plus && !d.betrayal.reroll;
  if(bare) return null;
  return d;
}

/* ==================================================== HUD + PANELS */

/* Injected into the Skirmish decision modal when a Betrayal token is held.
   Sits next to "Hold Back": a token is the only way to turn a decision you
   were leaning towards into a decision you have to live with. */
function forceAttackHtml(playerIdx){
  if(!forceAvailable(playerIdx)) return '';
  const held = tokenCount(playerIdx);
  return `<div class="wagers-block" id="wagersForceBlock">` +
    `<button type="button" class="secondary" id="wagersForceAttack" data-token="1">` +
    `Force the Skirmish &mdash; spend 1 Betrayal token (${held} held)</button>` +
    `<div class="wagers-dim">A token breaks a Quiet Round, or buys the attack you were about to hold back from.</div>` +
    `</div>`;
}

/* Per-player HUD fragment rendered by renderHud() through its ONE marked
   call site. Shows the Fury rung instead of the old flat Momentum pill, and
   the public Betrayal tokens as pips for BOTH players. */
function hudPill(p){
  if(!p) return '';
  const out = [];
  const f = furyFor(p.winStreak);
  if(p.winStreak >= 1){
    out.push(`<span class="pill fury" title="Fury ladder">Fury ${f.streak} &rarr; +${f.bonus}, cap ${f.cap}</span>`);
  }
  const b = clamp(p.betrayal | 0, 0, BETRAYAL_MAX);
  if(b > 0){
    let pips = '';
    for(let i = 0; i < b; i++) pips += '<i class="od-pip"></i>';
    out.push(`<span class="pill betrayal" title="Betrayal tokens">${pips} ${b} Betrayal</span>`);
  }
  return out.join('');
}

/* The Ext panel: Fury for both seats, the contested site and its live buy
   price, an open siege, and the current Skirmish's public declarations. */
let declarations = {};

function panelHtml(st){
  const s = st || state();
  if(!s || !Array.isArray(s.players)) return '';
  const fever = (s.currentEvent === 'skirmish_fever');
  const lines = [];

  lines.push(s.players.map((p, i)=>{
    const f = furyFor(p.winStreak);
    const cap = furyCap(p.winStreak, fever);
    const b = clamp(p.betrayal | 0, 0, BETRAYAL_MAX);
    let pips = '';
    for(let k = 0; k < b; k++) pips += '<i class="od-pip"></i>';
    return `<span class="wagers-line">${esc(p.name)}: <b>Fury ${f.streak}</b> ` +
      `<span class="wagers-dim">(+${f.bonus}, cap ${cap})</span> ` +
      `<span class="wagers-dim">${pips} ${b}</span></span>`;
  }).join(' '));

  if(s.contestedLocId){
    const price = priceFor(s, s.contestedLocId);
    lines.push(`<span class="wagers-line wagers-contested">CONTESTED: <b>${esc(locName(s.contestedLocId))}</b> ` +
      `<span class="wagers-dim">&mdash; buy price ${price} Credit${price === 1 ? '' : 's'}</span></span>`);
  }
  if(s.siege){
    const seller = me(s.siege.sellerIdx);
    lines.push(`<span class="wagers-line wagers-siege"><b>SIEGE</b> &mdash; ${esc(seller ? seller.name : '')} holds ` +
      `${esc(locName(s.siege.locId))}, ${esc(locName(s.siege.locId))} on the block for ${esc(num(s.siege.price))} Credits.</span>`);
  }
  const keys = Object.keys(declarations);
  keys.forEach(k=>{
    const d = declarations[k];
    const p = me(k | 0);
    if(!d || !p) return;
    const bits = [];
    if(d.wager && d.wager !== 'normal') bits.push(wagerLabel(d.wager));
    if(d.betrayal && d.betrayal.plus) bits.push('+1 token');
    if(d.betrayal && d.betrayal.reroll) bits.push('RE-ROLL');
    if(!bits.length) return;
    lines.push(`<span class="wagers-line wagers-decl">${esc(p.name)} declares <b>${esc(bits.join(' + '))}</b></span>`);
  });
  return lines.join('<br>');
}

/* ======================================================== hook wiring */

let installed = false;

function install(){
  if(installed) return false;
  if(!root.OD || !root.OD.Ext) return false;   // seam not loaded: stay inert
  installed = true;
  const H = root.OD.Ext.hooks;

  /* gameStart — seed the feature's own state slots. Doing it here (rather
     than in the state literal) keeps game.js untouched for a feature that
     might not load, and it runs before the first beginRound. */
  H.on('gameStart', (ctx)=>{
    const api = ctx.api;
    api.set('contestedLocId', null);
    api.set('sitePrice', {});
    api.set('siege', null);
    api.set('wagers', {force:[false, false]});
    const ps = ctx.state.players || [];
    ps.forEach((p)=>{ if(typeof p.betrayal !== 'number') p.betrayal = BETRAYAL_START; });
    botPlan = null; botPlanRound = -1;
    declarations = {};
    forceReply = null; quietPending = null;
    rerollTaken = [false, false];
  }, {priority:100});

  /* roundBegin — token income, and the contested-site draw (which happens
     before the first pick of the round, so it is visible from the start). */
  H.on('roundBegin', (ctx)=>{
    const st = ctx.state;
    if(!st.sitePrice || typeof st.sitePrice !== 'object') st.sitePrice = {};
    st.siege = null;
    st.wagers = {force:[false, false]};
    declarations = {};
    rerollTaken = [false, false];
    botPlan = null; botPlanRound = -1;
    grantIncome(st, st.round);
    const id = drawContested(st);
    if(id){
      sfx('stinger.round');
      elog(`<b>CONTESTED SITE:</b> this round the <b>${esc(locName(id))}</b> is for sale. Whoever drafts it offers it to their opponent first &mdash; from ${priceFor(st, id)} Credits.`);
    }
    rerender();
  }, {priority:100});

  /* skirmishBegin — reset the once-per-Skirmish records. */
  H.on('skirmishBegin', (ctx)=>{
    rerollTaken = [false, false];
    declarations = {};
    skirmishCounter++;
    botPlan = null; botPlanRound = -1;
  }, {priority:100});

  /* skirmishCommitted — record the PUBLIC declaration so the panel can show
     the opponent the badge before the dice fall. */
  H.on('skirmishCommitted', (ctx)=>{
    const idx = ctx.playerIdx;
    if(typeof idx !== 'number' || idx < 0) return;
    declarations[idx] = {
      wager: (ctx.commit && ctx.commit.wager) || null,
      betrayal: ctx.commit && ctx.commit.betrayal ? ctx.commit.betrayal : null,
    };
    rerender();
  }, {priority:100});

  /* skirmishResolved — the Fury / Catching Up / wager summary. The ladder's
     arithmetic is applied inline in resolveSkirmish (a hook fires too late to
     influence a total); this is the announcement beat. */
  H.on('skirmishResolved', (ctx)=>{
    const st = ctx.state;
    if(!st || !Array.isArray(st.players)) return;
    const res = ctx.result;
    const fever = (st.currentEvent === 'skirmish_fever');
    if(res && res.winnerName && !res.tie){
      const wi = res.winnerName === st.players[0].name ? 0 : 1;
      const f = furyFor(st.players[wi].winStreak);
      elog(`<b>FURY ${f.streak}</b> for ${esc(res.winnerName)} &rarr; +${f.bonus} to their total, Influence cap ${furyCap(f.streak, fever)} this Skirmish.`);
    }
    declarations = {};
  }, {priority:100});

  /* One HUD widget so the render owner can place it if they want a second
     copy of the same information next to the board. */
  try{
    root.OD.Ext.panels.register('wagers', {
      label:'Wagers', order:10,
      render(ctx){ return panelHtml(ctx && ctx.state ? ctx.state : null); },
    });
  }catch(_){ /* a duplicate id from a re-install is harmless */ }

  return true;
}

/* ============================================================ rules copy */

const RULES_HTML = `
<div class="rules-extra" id="rules-wagers">
  <h4>Betrayal Tokens &amp; Wagers</h4>
  <p>Every player starts with <b>2 Betrayal tokens</b> and banks <b>+1</b> at the start of
  <b>Round 3</b> and <b>Round 5</b>. The hard maximum is <b>4</b> and it is
  <i>not</i> a capped resource &mdash; it is never lost to a cap. Tokens are
  <b>public</b>: both players can see both counts at all times.</p>

  <h5>Spending a token</h5>
  <ul>
    <li><b>+1 to your committed total</b> &mdash; 1 token, declared at the commit step.</li>
    <li><b>RE-ROLL</b> &mdash; 1 token. Your d6 is cast twice and <b>the second cast
      stands</b> (no second dice animation; one roll of the animation, one final
      number). <b>Once per Skirmish.</b></li>
    <li><b>Force a Skirmish</b> &mdash; 1 token. Breaks a <b>Quiet Round</b>, or buys
      the attack you were about to hold back from. Once per round.</li>
  </ul>
  <p>Both commit-step spends (+1 and RE-ROLL) may be taken together, for 2 tokens.
  The declaration is <b>public and happens before the dice fall</b>, so your opponent
  knows exactly what they are fighting.</p>

  <h5>Wagers &mdash; All In and Ghost <span class="wagers-dim">(unlocks Round 2)</span></h5>
  <p>Alongside the Troop slider you pick one of three stances.</p>
  <table class="stats-table">
    <thead><tr><th>Stance</th><th>Must commit</th><th>Win</th><th>Lose</th><th>Tie</th></tr></thead>
    <tbody>
      <tr><td><b>NORMAL</b></td><td>anything you like</td><td>margin</td><td>&mdash;</td><td>&mdash;</td></tr>
      <tr><td><b>ALL IN</b></td><td><b>every Troop you have</b></td><td><b>+${ALL_IN_WIN} Influence</b></td>
        <td><b>-${ALL_IN_LOSS} Influence</b> (never below 0)</td><td>nothing</td></tr>
      <tr><td><b>GHOST</b></td><td><b>0 Troops</b></td><td><b>+${GHOST_WIN} Influence</b></td>
        <td>nothing</td><td>nothing</td></tr>
    </tbody>
  </table>
  <p>Both stances are legal on either side of the Skirmish, and both stack with
  tokens, Fury, Guard, Feint, Fortify and every other card. Playing Fortify or
  Feint with a GHOST wager is a wasted card &mdash; the game will not stop you. That
  is the joke.</p>

  <h5>Fury <span class="wagers-dim">(replaces the old flat Momentum bonus)</span></h5>
  <p>Consecutive Skirmish wins build a Fury ladder. The rung is read
  <b>before</b> the dice are cast, and its Influence cap applies to that Skirmish.</p>
  <table class="stats-table">
    <thead><tr><th>Win streak</th><th>Added to your total</th><th>Influence cap that Skirmish</th></tr></thead>
    <tbody>
      <tr><td>0&ndash;1</td><td>+0</td><td>4 (6 on Skirmish Fever)</td></tr>
      <tr><td>2</td><td>+1</td><td>4</td></tr>
      <tr><td>3</td><td>+2</td><td>5</td></tr>
      <tr><td>4+</td><td>+3</td><td>6</td></tr>
    </tbody>
  </table>
  <p>Any tie resets <b>both</b> streaks to zero.</p>

  <p class="rules-extra-callout"><b>CATCHING UP</b> &mdash; if the player who
  <i>wins</i> a Skirmish walked into it on a streak of <b>3 or more</b>, the
  <b>loser adds +2</b> to their committed total before the result is decided.
  It is applied to the totals, not to the Influence, so it can flip a loss into
  a win or tie it. This is the anti-snowball valve: the hotter you are, the more
  the fight is worth taking off you.</p>

  <h5>Siege &mdash; the contested site <span class="wagers-dim">(from Round 3)</span></h5>
  <p>From Round 3, one of the eight sites is marked <b>CONTESTED</b> each round and
  announced before the first pick. If anybody drafts that site, the draft
  <b>pauses</b> and the <i>other</i> player is offered <b>Buy It</b>.</p>
  <ul>
    <li>Price starts at <b>2 Credits</b> the first time that site is contested all game.</li>
    <li><b>Decline</b> and the site stands with the original picker at its
      <b>basic</b> effect, and the price rises by <b>1</b>.</li>
    <li>The price is <b>remembered per site for the rest of the game</b> and is
      <b>capped at 6</b>.</li>
    <li><b>Accept</b> and you pay the Credits &mdash; <b>burned into the void</b>, not
      handed to the seller (they are capped anyway) &mdash; and you take the site
      <b>at the tier the original picker chose</b>.</li>
    <li>The original picker <b>gains nothing and loses nothing</b>. That sting is
      deliberate: it is what makes <b>baiting legal</b>.</li>
    <li>If you cannot afford the price the offer <b>automatically lapses</b>.</li>
  </ul>
  <p>The board is not pickable while an offer is open, for either player.</p>
</div>
`;

/* ================================================================ export */

const api = Object.freeze({
  id: 'wagers',
  install,
  setBridge,
  bridge,
  RULES_HTML,

  /* tables, so tests and the rules copy can never drift */
  FURY: furyFor,
  BETRAYAL_START, BETRAYAL_MAX, BETRAYAL_INCOME_ROUNDS,
  SIEGE_BASE_PRICE, SIEGE_MAX_PRICE,
  ALL_IN_WIN, ALL_IN_LOSS, GHOST_WIN,
  CATCHING_UP_MIN_STREAK, CATCHING_UP_BONUS,
  wagerLabel,

  /* the commit-step UI */
  commitUI, wireCommit, mountCommit, commitDeclaration,

  /* F1 tokens */
  tokenCount, hasToken, spendForce, forceAvailable, onQuietRound,
  applyCommitDeclaration, applyRerolls, noteFirstCast,

  /* F2 wagers */
  lockStance, pinTroops, settleWagers, botStance, botTroopShare, payBotBetrayal,

  /* F3 fury */
  furyCap,

  /* F4 siege */
  beforePick, onBuySite, showGuestBuyOffer, showGuestForceOffer, onForceDecision,
  botWantsToBuy, botWantsQuietBreak, forceAttackHtml, priceFor,

  /* panels / HUD */
  hudPill, panelHtml,
});

install();
return api;
})();

root.OD = root.OD || {};
root.OD.Wagers = Wagers;
/* F2 commit UI, readable from the commit-modal owner */
function forceAttackHtml(playerIdx){
  if(!forceAvailable(playerIdx)) return '';
  const held = tokenCount(playerIdx);
  return `<div class="wagers-block" id="wagersForceBlock">` +
    `<button type="button" class="secondary" id="wagersForceAttack" data-token="1">` +
    `Force the Skirmish &mdash; spend 1 Betrayal token (${held} held)</button>` +
    `<div class="wagers-dim">A token breaks a Quiet Round, or buys the attack you were about to hold back from.</div>` +
    `</div>`;
}

root.OD = root.OD || {};
root.OD.Wagers = Wagers;
if(typeof module !== 'undefined' && module.exports) module.exports = {Wagers: Wagers};

})(typeof globalThis !== 'undefined' ? globalThis : this);