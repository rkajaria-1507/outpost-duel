/* ---------------------------------------------------------------------
   OUTPOST DUEL — feature: BETRAYAL TOKENS + FURY

   Two mechanics, one file, zero monkeypatches:

     F1  BETRAYAL TOKENS   spendable currency. +1 income at R3/R5, spend it
                           for +1 to a committed total or a re-roll of your
                           d6 (public, declared before the dice fall), or to
                           force a Skirmish through a Quiet Round.
     F3  FURY              the flat "Momentum +1 at two wins" rule replaced
                           by a four-rung ladder, plus CATCHING UP — the
                           mandatory anti-snowball valve.

   WHAT WAS CUT, AND WHY
   ---------------------
   Two mechanics were removed from this file after a 25,000-game simulation.
   Both were not merely weak, they were ANTI-PRODUCTIVE: they cost the player
   expected score. Neither was rebalanced — both were deleted. The evidence is
   recorded here because the numbers are the reason, and a future engineer who
   finds the git history will want them.

   SIEGE (the contested-site buyout). From Round 3 one site was marked
   CONTESTED and drafting it paused the draft to offer the opponent one chance
   to buy it for an escalating 2-6 Credits. Measured: ACCEPTED 0 TIMES IN
   2,408 GAMES. Every single time, the player who drafted a good Advanced site
   had it downgraded to Basic — a guaranteed loss with no upside. It was not a
   negotiation; it was a tax on playing well. It also cost a whole rules tab, a
   wire message kind (`buySite`), a modal and a per-site price table.

   THE ALL IN / GHOST STANCES. Mean Influence per seat, 1,500+ games:

       commit everything, NO wager .................. 36.31   (baseline)
       Ghost  (commit 0,  +2 on a win) .............. 34.77   -1.54
       All In (commit all, +3 win / -2 loss) ........ 34.25   -2.06
       the bot's own stance logic ................... 32.62   -3.69  (-11%)

   Every option is below the baseline, so the correct play is always to decline
   the choice — which is exactly what a bot reasoning about them should have
   concluded, and did not. They also added a whole decision axis to the game's
   most decision-critical screen, which already has a Troop slider, a hand of
   cards and an odds panel.

   WHAT SURVIVED THE CUT, AND WHY IT IS NOT A LOOSE END
   ----------------------------------------------------
   The engine calls into this file at lines another engineer owns, so several
   names here survive their mechanics: `botStance` no longer returns a stance
   (it returns a token plan, `wager: null`), `state.wagers` survives as the
   name of the once-per-round force latch now that the wagers it was named for
   are gone, and the panel id is still `wagers` because game.js keys a render
   step off `panelId === 'wagers'`. Every one of these is a name kept alive for
   a coupling, not a mechanic. Removing a name here without touching game.js
   would be a `ReferenceError` in the middle of a Skirmish, which is strictly
   worse than a stale identifier.

   ENGINE CONTRACT
   ---------------
   This file never replaces a game.js function and never invents a new
   `state.phase`. It talks to the engine through exactly two sanctioned
   doors:

     1. `OD.Ext` — hooks, effects and panels (the public extension seam).
     2. `OD.WagersBridge` — a single frozen object game.js installs next to
        `startSkirmishCommit`, carrying only the handful of internals a
        feature could ever need (log, popup, sound, modal, `startSkirmishCommit`,
        `endRound`, a d6 roller). It is one marked block in game.js and
        deleting it deletes this feature's privileged access entirely.

   game.js is edited ONLY at the anchors marked `>>> WAGERS`, each of which is
   additive and defensive (guarded by `window.OD && OD.Wagers`), so a tree with
   this file deleted behaves exactly as before. Every call site the cut
   orphaned — `beforePick`, `onBuySite`, `showGuestBuyOffer`, `lockStance`,
   `settleWagers`, `botTroopShare` — was behind such a guard, so removing the
   member makes the guard fall through to the engine's own behaviour rather
   than to anything stale. That is the seam: delete this file and the engine
   returns to clean behaviour, with no edit to game.js.

   SERIALISATION
   -------------
   `state` is JSON.stringify'd to the online guest after every render, so
   everything this feature stores there is a plain number, string, boolean or
   plain object: `player.betrayal` (an integer count) and `state.wagers`
   ({force:[bool, bool]}). No functions, no Set/Map, no DOM nodes, and no NaN
   ever reach `state`. The three Siege keys this file used to write —
   `sitePrice`, `siege`, `contestedLocId` — are gone from both here and from
   the engine, so they never appear at all.

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

const CATCHING_UP_MIN_STREAK = 3;
const CATCHING_UP_BONUS      = 2;

/* Difficulty-weighted bot behaviour. The bot does not roll against this
   number blindly — it first decides whether the board justifies spending a
   token at all (see botWantsQuietBreak) and only then rolls against the
   difficulty weight. */
const FORCE_ODDS = {easy:0.15, normal:0.40, hard:0.70};

/* ============================================================ small utils */

function clamp(v, min, max){ return Math.max(min, Math.min(max, v)); }
function rnd(){ return Math.random(); }
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
   used to wrap the whole line in esc(), which was a no-op while esc() was
   the null-coalescer it started life as; now that esc() escapes for real,
   blanket-escaping here would flatten every log line this file has ever
   written. The untrusted value is the player name, and every call site below
   already routes it through esc() at interpolation. */
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
   to the online guest. The KEY is still called `wagers` and nothing else lives
   under it: it is a serialized state key that the engine relays verbatim, and
   renaming it buys the player nothing while making an older guest's snapshot
   disagree with a newer host's. The name outlived the wagers; the flag did not. */
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

/* The commit-step declaration. Tokens are charged HERE, at commit time, which
   is what makes it impossible to spend the same charge twice for one
   commitment. */
function declarationAllowed(betrayal){
  return !!(betrayal && (betrayal.plus === true || betrayal.reroll === true));
}

/* Called on EVERY commit, for both seats, so it can hand back the clamped
   troop count even when nothing was declared. `extra` is null for an ordinary,
   unadorned commit — that is not an error here, it is the common case.
   THE RETURNED SHAPE IS THE COMMIT PAYLOAD, and it no longer carries a
   `wager`: game.js reads `wagerDecl.betrayal` (the +1 the token bought) and
   `wagerDecl.troops` (what to deduct), and its own `wager` field stays null
   because there is nothing left to put in it. `troops` is still clamped here
   against the live in-hand count as a second line of defence behind the
   engine's own clamp, so a forged guest payload cannot smuggle Troops in. */
function applyCommitDeclaration(playerIdx, extra, skirmishCtx, troops){
  const st = state();
  if(!st) return null;
  const p = me(playerIdx);
  if(!p) return null;
  const e = (extra && typeof extra === 'object') ? extra : {};

  const out = {betrayal:{plus:false, reroll:false}, troops:null};

  const b = e.betrayal;
  if(declarationAllowed(b)){
    if(b.plus && spendToken(playerIdx)) out.betrayal.plus = true;
    if(b.reroll && !rerollUsed(playerIdx) && spendToken(playerIdx)){
      out.betrayal.reroll = true;
      markReroll(skirmishCtx, playerIdx);
    }
  }

  if(out.betrayal.plus)  elog(`${esc(p.name)} paid a Betrayal token: <b>+1 to their committed total</b>.`);
  if(out.betrayal.reroll) elog(`${esc(p.name)} declared a <b>RE-ROLL</b> &mdash; their d6 will be cast twice and the second cast stands.`);

  if(out.betrayal.plus || out.betrayal.reroll){
    sfx('credit.spend');
    rerender();
  }
  /* The troop count the engine must actually deduct: the slider's value,
     clamped to what this seat is actually holding. */
  const t = (typeof troops === 'number' && isFinite(troops)) ? Math.round(troops) : (typeof e.troops === 'number' ? e.troops : 0);
  out.troops = clamp(t, 0, Math.max(0, p.troops | 0));
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

/* ------------------------------------------------- the bot's token plan */

/* Every odd the bot reasons about comes from OD.Rules — the maths is never
   reimplemented here.
   NOTE: rules.js still models the OLD flat Momentum rule (+1 at streak 2), so
   after projectSide() we add the explicit Fury-ladder delta
   (fury.bonus - projected.momentum). That is a one-line correction of a stale
   constant, not a second copy of the projection. */
function projectFor(playerIdx, cardId){
  const R = rules();
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

/* Per-skirmish bot plan. Computed once (lazily, the first time the token
   logic asks for it) so the RNG is not spent twice for one decision, and so
   the card is known before the tokens are chosen. */
let botPlan = null;
let botPlanRound = -1;
let botPlanSkirmish = 0;
let skirmishCounter = 0;

function ensureBotPlan(playerIdx, card){
  const st = state();
  if(!st) return null;
  if(!botPlan || botPlanRound !== st.round || botPlanSkirmish !== skirmishCounter){
    botPlan = {};
    botPlanRound = st.round;
    botPlanSkirmish = skirmishCounter;
  }
  if(botPlan[playerIdx]) return botPlan[playerIdx];
  botPlan[playerIdx] = computeBotPlan(playerIdx, card);
  return botPlan[playerIdx];
}

function computeBotPlan(playerIdx, card){
  const p = me(playerIdx);
  /* `wager` stays in the shape as a literal null, because game.js reads
     `plan.wager` on the line that cannot be edited. There is no longer any
     such thing to put in it. */
  const plan = {wager:null, betrayal:{plus:false, reroll:false}, reason:''};
  if(!p) return plan;

  const proj = projectFor(playerIdx, card);
  if(!proj) return plan;

  const tokens = tokenCount(playerIdx);
  if(tokens <= 0) return plan;

  const lead = proj.mine.mean - proj.theirs.mean;
  /* A re-roll is worth a token when the dice are load-bearing and the Bot
     does not expect to win them outright. */
  if(tokens >= 2 && lead < 0.6 && proj.mine.dice > 0){
    plan.betrayal.reroll = true;
  } else if(lead > -0.4 && lead < 1.6){
    /* Keep one in reserve unless the buy is clear. */
    plan.betrayal.plus = !(tokens >= 2 && lead < 0.3);
  }
  return plan;
}

/* THE NAME IS game.js's. It calls `OD.Wagers.botStance(...)` at a line this
   file does not own, so the identifier survives the cut of the stances it
   used to name. What it returns is now a token plan and nothing else. */
function botStance(playerIdx, card){
  return ensureBotPlan(playerIdx, card);
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

/* -------------------------------------------------- break a Quiet Round */

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

let quietPending = null;
let forceReply = null;   /* online guest's answer to a Quiet-Round offer */

/* Called by the engine at the point Quiet Round would otherwise cancel the
   fight. Returns true when the feature is handling it (which suppresses the
   engine's own Quiet Round line and endRound() until the offer resolves),
   false when there is nothing to spend. */
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

function botDelay(){
  const st = state();
  const b = bridge();
  if(b && typeof b.botTickMs === 'function'){ try{ return b.botTickMs(); }catch(_){} }
  return 350;
}

function resolveQuiet(aggressorIdx){
  const b = bridge();
  const st = state();
  if(!b || !st) return;
  if(!quietPending || quietPending.round !== st.round || quietPending.idx !== aggressorIdx) return;
  const p = me(aggressorIdx);
  if(!p) return;

  let answered = false;
  const decide = (yes)=>{
    /* >>> D4: ONE answer. This is the same double-fire class as the engine's
       >>> Commit button (see js/game.js showCommitModal): both answer buttons
       >>> are one-shot, and the second click arrived after `quietPending` had
       >>> been cleared and a Skirmish had already been started - so it spent a
       >>> SECOND Betrayal token and re-entered startSkirmishCommit underneath
       >>> the first, replacing `skirmishCtx` mid-chain. The latch is the
       >>> load-bearing guard; the disables below make it visible. */
    if(answered) return;
    answered = true;
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
  /* The buttons go dead on the first click as well as latching, so the fix is
     visible to the player rather than merely silent. */
  if(no) no.onclick = ()=>{ b.hideModal(); if(no) no.disabled = true; if(yes) yes.disabled = true; decide(false); };
  if(yes) yes.onclick = ()=>{ b.hideModal(); if(no) no.disabled = true; if(yes) yes.disabled = true; decide(true); };
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
  const idx = quietPending ? quietPending.idx : -1;
  const cb = forceReply;
  forceReply = null;
  if(idx >= 0 && cb) cb(accept === true);
}

/* ========================================== THE COMMIT-STEP UI (F1 only) */

/* The Fury readout and the two token toggles, as an HTML STRING, so the
   commit-modal owner can drop it in without this file touching game.js.
   game.js calls mountCommit() from exactly one marked line.

   There are TWO token chips and no third. The All In / Ghost stance chips
   used to sit above them in this same block, and they are gone: measured over
   1,500 games, every stance lost expected Influence, and the bot that reasoned
   about them scored 11% worse than one that ignored them. The commit step now
   has the Troop slider, the hand, the odds panel and two token chips, and
   nothing else to decide. */
function commitUI(o){
  const oo = o || {};
  const idx = resolvePlayerIdx(oo);
  const p = me(idx);
  const tokens = p ? tokenCount(idx) : 0;
  const st = state();
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

/* Bind commitUI()'s markup. `onChange` fires whenever the declaration changes,
   so the modal owner can refresh its own copy. The returned controller has no
   `setWager` any more — the keyboard path in game.js activates a chip with
   `chip.click()`, and with two chips left that is still the whole surface. */
function wireCommit(rootEl, onChange){
  const el = rootEl || (typeof document !== 'undefined' ? document.getElementById('skirmishBody') : null);
  if(!el) return null;
  const declaration = {betrayal:{plus:false, reroll:false}};
  const cbs = (typeof onChange === 'function') ? [onChange] : [];

  function notify(){
    const d = read();
    cbs.forEach(fn=>{ try{ fn(d); }catch(_){} });
  }
  function read(){
    return {betrayal:{plus:declaration.betrayal.plus, reroll:declaration.betrayal.reroll}};
  }
  function paint(){
    const toks = el.querySelectorAll('#wagersTokens .wagers-token');
    for(let i = 0; i < toks.length; i++){
      const on = toks[i].dataset.token === 'plus' ? declaration.betrayal.plus : declaration.betrayal.reroll;
      toks[i].classList.toggle('selected', !!on);
    }
  }

  function setToken(kind, on, ctx){
    if(on && tokenCount(resolvePlayerIdx(ctx)) < 1){ paint(); return; }
    declaration.betrayal[kind] = !!on;
    paint(); notify();
  }

  function bind(){
    const toks = el.querySelectorAll('#wagersTokens .wagers-token');
    for(let i = 0; i < toks.length; i++){
      const kind = toks[i].dataset.token;
      toks[i].onclick = ()=> setToken(kind, !declaration.betrayal[kind], ctx);
    }
    paint();
  }

  let ctx = null;
  /* Returns {getDeclaration, setToken, bind, repaint}. `bind()` is called
     immediately; a caller that supplies a ctx later should call bind() again
     to pick it up. */
  const api = {
    getDeclaration: read,
    setToken(kind, on){ setToken(kind, on, ctx); },
    repaint: paint,
    bind(newCtx){ if(newCtx) ctx = newCtx; bind(); return api; },
  };
  api.bind(null);
  return api;
}

/* THE single call site game.js makes. It appends commitUI() to the already-
   open modal, binds it, and stashes the live controller so the one extra line
   in the modal's own Commit handler can read the declaration via
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
  ui.bind({playerIdx: resolvePlayerIdx(opts)});
  activeCommitUI = ui;
  return ui;
}

/* Read by showCommitModal's own Commit handler and threaded into the EXISTING
   onSubmit(troops, cardId, extra) contract. Returns null when the player
   declared nothing, so the ordinary payload is unchanged — which is now the
   ONLY unadorned path, since the stance that used to sit on it is gone.
   Never stored on state, so nothing here crosses the relay. */
function commitDeclaration(){
  if(!activeCommitUI) return null;
  const d = activeCommitUI.getDeclaration();
  if(!d.betrayal.plus && !d.betrayal.reroll) return null;
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

/* The Ext panel: Fury for both seats and the current Skirmish's public token
   declarations. The CONTESTED chip and the open-siege line that used to sit
   between them are gone with the mechanic that produced them. */
let declarations = {};

function panelHtml(st){
  const s = st || state();
  if(!s || !Array.isArray(s.players)) return '';
  const fever = (s.currentEvent === 'skirmish_fever');
  const lines = [];

  lines.push(s.players.map((p)=>{
    const f = furyFor(p.winStreak);
    const cap = furyCap(p.winStreak, fever);
    const b = clamp(p.betrayal | 0, 0, BETRAYAL_MAX);
    let pips = '';
    for(let k = 0; k < b; k++) pips += '<i class="od-pip"></i>';
    return `<span class="wagers-line">${esc(p.name)}: <b>Fury ${f.streak}</b> ` +
      `<span class="wagers-dim">(+${f.bonus}, cap ${cap})</span> ` +
      `<span class="wagers-dim">${pips} ${b}</span></span>`;
  }).join(' '));

  Object.keys(declarations).forEach(k=>{
    const d = declarations[k];
    const p = me(k | 0);
    if(!d || !p || !d.betrayal) return;
    const bits = [];
    if(d.betrayal.plus) bits.push('+1 token');
    if(d.betrayal.reroll) bits.push('RE-ROLL');
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
    api.set('wagers', {force:[false, false]});
    const ps = ctx.state.players || [];
    ps.forEach((p)=>{ if(typeof p.betrayal !== 'number') p.betrayal = BETRAYAL_START; });
    botPlan = null; botPlanRound = -1;
    declarations = {};
    forceReply = null; quietPending = null;
    rerollTaken = [false, false];
  }, {priority:100});

  /* roundBegin — token income. The contested-site draw that used to sit here
     is gone, and with it the only writer of state.sitePrice / state.siege /
     state.contestedLocId: those three keys are no longer created anywhere, so
     they are absent from state rather than left null. */
  H.on('roundBegin', (ctx)=>{
    const st = ctx.state;
    st.wagers = {force:[false, false]};
    declarations = {};
    rerollTaken = [false, false];
    botPlan = null; botPlanRound = -1;
    grantIncome(st, st.round);
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
     the opponent the badge before the dice fall. Tokens only: there is no
     stance to publish. */
  H.on('skirmishCommitted', (ctx)=>{
    const idx = ctx.playerIdx;
    if(typeof idx !== 'number' || idx < 0) return;
    declarations[idx] = {
      betrayal: ctx.commit && ctx.commit.betrayal ? ctx.commit.betrayal : null,
    };
    rerender();
  }, {priority:100});

  /* skirmishResolved — the Fury / Catching Up announcement. The ladder's
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
     copy of the same information next to the board. The ID stays `wagers`
     because game.js keys a render step off `panelId === 'wagers'` (it strips
     the duplicated per-seat Fury rows); only the visible label changed, since
     there is nothing left in here to wager. */
  try{
    root.OD.Ext.panels.register('wagers', {
      label:'Tokens', order:10,
      render(ctx){ return panelHtml(ctx && ctx.state ? ctx.state : null); },
    });
  }catch(_){ /* a duplicate id from a re-install is harmless */ }

  return true;
}

/* ============================================================ rules copy */

const RULES_HTML = `
<div class="rules-extra" id="rules-wagers">
  <h4>Betrayal Tokens &amp; Fury</h4>
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
</div>
`;

/* ================================================================ export */

/* The members game.js still calls are listed with the reason they are still
   here; the ones the cut orphaned (beforePick, onBuySite, showGuestBuyOffer,
   lockStance, pinTroops, settleWagers, botTroopShare, botWantsToBuy,
   priceFor, wagerLabel, ALL_IN_WIN, ALL_IN_LOSS, GHOST_WIN) are GONE, and every
   one of their call sites was already behind a `&& OD.Wagers.<name>` guard, so
   the engine takes its own path instead. */
const api = Object.freeze({
  id: 'wagers',
  install,
  setBridge,
  bridge,
  RULES_HTML,

  /* tables, so tests and the rules copy can never drift */
  FURY: furyFor,
  BETRAYAL_START, BETRAYAL_MAX, BETRAYAL_INCOME_ROUNDS,
  CATCHING_UP_MIN_STREAK, CATCHING_UP_BONUS,

  /* the commit-step UI */
  commitUI, wireCommit, mountCommit, commitDeclaration,

  /* F1 tokens */
  tokenCount, hasToken, spendForce, forceAvailable, onQuietRound,
  applyCommitDeclaration, applyRerolls, noteFirstCast,
  botStance, payBotBetrayal,
  botWantsQuietBreak, forceAttackHtml,
  showGuestForceOffer, onForceDecision,

  /* F3 fury */
  furyCap,

  /* panels / HUD */
  hudPill, panelHtml,
});

install();
return api;
})();

root.OD = root.OD || {};
root.OD.Wagers = Wagers;
if(typeof module !== 'undefined' && module.exports) module.exports = {Wagers: Wagers};

})(typeof globalThis !== 'undefined' ? globalThis : this);