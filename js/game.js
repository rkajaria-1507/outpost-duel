/* ---------------------------------------------------------------------
   OUTPOST DUEL — self-contained 2-player hotseat/online/demo game
--------------------------------------------------------------------- */

const CARD_DEFS = {
  // Aggressive - raw combat power, usually at a cost
  ambush:    {name:"Ambush",           mod:2,    avg:2,    category:'Aggressive', desc:"+2 combat. If you still lose, lose 1 extra Troop."},
  overrun:   {name:"Overrun",          mod:3,    avg:3,    category:'Aggressive', desc:"+3 combat. Costs 1 Ore to play (else acts as +0)."},
  berserker: {name:"Berserker",        mod:5,    avg:5,    category:'Aggressive', desc:"+5 combat - the biggest swing in the deck. You lose 2 Troops regardless of the outcome."},
  blitz:     {name:"Blitz",            mod:2,    avg:2,    category:'Aggressive', desc:"+2 combat if you are the Aggressor this round, else +0."},
  onslaught: {name:"Onslaught",        mod:4,    avg:4,    category:'Aggressive', desc:"+4 combat. Costs 2 Credits to play (else acts as +1)."},
  ambuscade: {name:"Ambuscade",        mod:3,    avg:3,    category:'Aggressive', desc:"+3 combat. If you win, your opponent loses 1 extra Troop."},
  // Defensive - protect your position
  feint:     {name:"Feint",            mod:0,    avg:0,    category:'Defensive',  desc:"+0 combat. If you lose, your committed Troops are returned."},
  guard:     {name:"Guard",            mod:1,    avg:1,    category:'Defensive',  desc:"+1 combat. If you lose, reduce the winner's margin by 1."},
  fortify:   {name:"Fortify",          mod:0,    avg:0,    category:'Defensive',  desc:"+0 combat. Your committed Troops are always returned, win or lose."},
  // Utility - economy, information, and momentum
  rally:     {name:"Rally",            mod:1,    avg:1,    category:'Utility',    desc:"+1 combat. If you win, gain +1 bonus Influence."},
  scout:     {name:"Scout",            mod:1,    avg:1,    category:'Utility',    desc:"+1 combat. Draw 1 extra card after the Skirmish resolves."},
  undermine: {name:"Undermine",        mod:0,    avg:2,    category:'Utility',    desc:"+0 combat, but subtracts 2 from your opponent's total instead."},
  sabotage:  {name:"Sabotage",         mod:1,    avg:1,    category:'Utility',    desc:"+1 combat. After the Skirmish, your opponent discards one random card from their hand."},
  insight:   {name:"Insight",          mod:2,    avg:2,    category:'Utility',    desc:"+2 combat. You draw 1 Tactic card after the Skirmish, win or lose."},
  // Chaos - high variance, high ceiling
  wild:      {name:"Wildcard",         mod:null, avg:3.5,  category:'Chaos',      desc:"Modifier equals a fresh d6 roll (1-6). High variance."},
  /* avg 4.47 is the EXPECTED VALUE of the higher of two d6, which is
     161/36 = 4.4722 - the "keep the higher die" rule, exactly as cardModifier()
     implements it. (2.53 would be 91/36, the expected *lowest* of two dice.)
     Verified against OD.Rules.maxDiceDist(2) in test/rules.test.js. */
  gambit:    {name:"Desperate Gambit", mod:null, avg:4.47, category:'Chaos',      desc:"Roll two d6, modifier equals the higher of the two."},
};
const DECK_TEMPLATE = Object.keys(CARD_DEFS);
/* The rules copy quotes the deck size, and it quoted "14" while this table held
   16 - in two separate places. A player who counts the cards in the Tactic
   Cards tab and then reads "14-card deck" has no reason to believe any other
   number on the page either. Derived, so the count cannot drift again. */
const DECK_SIZE = DECK_TEMPLATE.length;
const CATEGORY_ORDER = ['Aggressive','Defensive','Utility','Chaos'];

/* Cards are grouped by category for display (hand and the Skirmish commit
   picker), highest-impact first within each group. Since each player's deck
   has exactly one of each card id, cards can always be identified and
   removed by id - display order never has to match array index, so grouping
   is purely cosmetic and never risks selecting or discarding the wrong
   card.

   >>> A GROUP WITH NO CARDS IS NEVER EMITTED (G3). The final `.filter` is the
   >>> whole reason the hand rail cannot show a dangling "CHAOS" label over
   >>> nothing: a player holding no Chaos cards gets no Chaos group at all,
   >>> rather than a header and an empty well that reads as a missing card
   >>> rather than as an empty category. renderHand() additionally skips a
   >>> group whose card list is empty, so the invariant survives a future
   >>> caller that builds groups some other way.

   >>> The filter callback also skips card ids that are not in CARD_DEFS. It
   >>> used to dereference CARD_DEFS[c].category unguarded, so one unknown id
   >>> (a card from a deck that no longer exists, say) threw and took the whole
   >>> hand panel with it - the player sees no hand and no explanation. */
function groupHand(hand){
  return CATEGORY_ORDER
    .map(category=>({
      category,
      cards: hand.filter(c=> CARD_DEFS[c] && CARD_DEFS[c].category===category)
        .sort((a,b)=> CARD_DEFS[b].avg-CARD_DEFS[a].avg || CARD_DEFS[a].name.localeCompare(CARD_DEFS[b].name)),
    }))
    .filter(g=>g.cards.length>0);
}

/* Eight sites, each with a free Basic action and a pricier Advanced one —
   sixteen meaningful choices on an eight-slot board.

   >>> SINGLE SOURCE OF TRUTH FOR COST (BLOCKER 1 fix). Every price a site
   >>> charges used to live in ONE of two places: the `cost` field below, or a
   >>> literal inside applyLocationEffect()'s switch. Outpost, Bazaar and
   >>> Shrine had an EMPTY `cost` and their real prices were hardcoded in the
   >>> switch, so the two disagreed — and js/feature-chaos.js, which prices the
   >>> Rift's Toll / Open Hands mutations, could only see the `cost` field. A
   >>> Rift-of-Outpost with Open Hands therefore charged the player 5 Credits +
   >>> 3 Ore and then logged "Advanced was free anyway", while Toll silently
   >>> did nothing. Now `cost` is the ONLY place a price is written: it is
   >>> complete for all eight sites and all sixteen tiers, every charge in
   >>> applyLocationEffect is driven by tierCost(), and OD.Board (published
   >>> below) hands the same numbers to a feature so no second copy can exist.
   >>> test/sites.test.js is the structural guard on that promise. */
/* >>> THE TWO CONDITIONAL CLAUSES, and why there are two and not one.

   Every site below pays a RESOURCE and then a small, scaling amount of
   Influence. Which resource it keys off, and in which DIRECTION, is the whole
   design, and the first attempt got it wrong in a way the simulator caught:

   * POVERTY (Market / Quarry / Foundry / Bazaar) pays when the resource you
     need is GONE. Being rich is worth nothing to these tiles; being broke is.
     That is the brief's "a site that rewards a resource you're short on", and
     it deliberately does NOT reward hoarding - a player who banks Credits never
     sees the Market clause fire.
   * ARMY (Garrison) pays for Troops you already hold, and it is the only tile
     that does. That is the tile that makes HOLDING BACK worth something: the
     army you did not spend keeps paying you standing, so spending it in a
     Skirmish costs you next round's Income. Without it, attacking was strictly
     free and the Hold Back button was dead.

   >>> WHAT THE MEASUREMENT TAUGHT (kept here because it is easy to regress
   into). The first pass keyed EVERY clause to a pool being FULL - "Market: +1
   Influence per 4 Credits you hold" and so on - which reads like a reward for
   efficiency and is in fact a reward for PASSIVITY. A bot that holds back
   keeps its Troops AND its Credits, so every one of those clauses paid it, and
   the difficulty ladder inverted: Easy banked 8.22 Influence a game at the
   Garrison and 3.90 at the Shrine while Hard banked 1.65 and 0.83 - and Hard's
   9 points a game of extra Skirmish Influence were more than cancelled. Easy
   29.73 / Normal 29.97 / Hard 28.62 Influence per seat: the slider ran
   backwards. Keying the clauses to POVERTY instead removes the passive income
   and the ladder has somewhere to go again.

   The Advanced PRICES are unchanged on purpose: they are the numbers
   test/sites.test.js pins and the numbers js/feature-chaos.js prices the Rift's
   Toll and Open Hands mutations against. Only the yields moved. */
const LOCATIONS = [
  {id:'market',   name:'Market',
    basic:{label:'+2 Credits, +1 Influence if you have no Credits', cost:{}},
    advanced:{label:'+4 Credits, +1 Influence if you have no Credits', cost:{ore:1}, note:'pay 1 Ore'}},
  {id:'quarry',   name:'Quarry',
    basic:{label:'+2 Ore, +1 Troop, +1 Influence if you have no Troops', cost:{}},
    advanced:{label:'+3 Ore, +2 Troops, +1 Influence if you have no Troops', cost:{credits:1}, note:'pay 1 Credit'}},
  {id:'garrison', name:'Garrison',
    basic:{label:'+2 Troops, +1 Influence per Troop you hold (max 1)', cost:{}},
    advanced:{label:'+4 Troops, +1 per Troop you hold (max 2), +1 combat', cost:{ore:1}, note:'pay 1 Ore'}},
  {id:'outpost',  name:'Outpost',
    basic:{label:'Pay 3 Credits + 2 Ore → +1 Influence', cost:{credits:3, ore:2}, note:'can’t pay? +1', consolation:true},
    advanced:{label:'Pay 5 Credits + 3 Ore → +3 Influence', cost:{credits:5, ore:3}, note:'can’t pay? +1', consolation:true}},
  {id:'archive',  name:'Archive',
    basic:{label:'Draw 1 Tactic card — hand full? +1 Influence instead', cost:{}},
    advanced:{label:'Draw 3 Tactic cards — hand full? +1 Influence instead', cost:{credits:1}, note:'pay 1 Credit'}},
  {id:'foundry',  name:'Foundry',
    basic:{label:'+1 Credit, +1 Ore, +1 Influence if you have no Ore', cost:{}},
    advanced:{label:'+3 Credits, +2 Ore, +1 Influence if you have no Ore', cost:{troops:1}, note:'pay 1 Troop'}},
  {id:'bazaar',   name:'Bazaar',
    basic:{label:'Trade 2 Ore for 2 Credits', cost:{ore:2}, note:'no 2 Ore? +1 Credit, +1 Influence', consolation:true},
    advanced:{label:'Trade 2 Ore for 4 Credits', cost:{ore:2}, note:'no 2 Ore? +2 Credits, +1 Influence', consolation:true}},
  {id:'shrine',   name:'Shrine',
    basic:{label:'+1 Influence', cost:{}},
    advanced:{label:'Pay 2 Credits + 1 Ore → +3 Influence', cost:{credits:2, ore:1}, note:'can’t pay? +1', consolation:true}},
];

/* POVERTY: the clause the Market / Quarry / Foundry / Bazaar key off. 1
   Influence when the pool is empty, nothing otherwise. Deliberately not a
   function of how MUCH you hold - see the block comment above. */
function povertyInfluence(held){
  return (typeof held === 'number' && isFinite(held) && held <= 0) ? 1 : 0;
}
/* ARMY: what the Garrison pays for the Troops already in the holder's pool.
   `per` units buy 1 Influence and `max` bounds the clause, so a full hand of
   Troops cannot pay for itself twice. Returns a non-negative integer. */
function surplusInfluence(held, per, max){
  const h = (typeof held === 'number' && isFinite(held)) ? held : 0;
  const p = (typeof per === 'number' && per > 0) ? per : 0;
  const m = (typeof max === 'number' && max > 0) ? max : 0;
  if(h <= 0 || p <= 0 || m <= 0) return 0;
  return Math.min(m, Math.floor(h / p));
}

/* `consolation:true` on a tier means "always takeable" - the printed rule
   reads "Pay 5 Credits + 3 Ore → +3 Influence (else +1)", so a player who
   cannot pay the full price is owed a consolation, not a greyed-out tile.
   Those three tiers carry the flag because filling in their real price would
   otherwise make canAffordExtra() hide a choice the rules promise. Nothing
   else sets it, and a tier without it keeps the strict pay-or-not behaviour. */
function tierIsAlwaysTakeable(id, tier){
  const loc = LOCATIONS.find(l => l.id === id);
  const t = (loc && (tier === 'basic' || tier === 'advanced')) ? loc[tier] : null;
  return !!(t && t.consolation);
}

/* The three resources a site can be priced in. Anything else is a yield, not
   a cost, so it never appears in a cost object. */
const COST_RESOURCES = ['credits','ore','troops'];

/* What `id` at `tier` costs, as a frozen {credits,ore,troops} with the absent
   resources zeroed. Total by contract: an unknown id or tier comes back as
   three zeros rather than undefined, so a caller can neither crash on a typo
   nor — the part that mattered — silently treat a MISSING price as a free one.
   That is the whole bug this function exists to remove. */
function tierCost(id, tier){
  const loc = LOCATIONS.find(l => l.id === id);
  const t = (loc && (tier === 'basic' || tier === 'advanced')) ? loc[tier] : null;
  const c = (t && t.cost) || {};
  const out = {};
  COST_RESOURCES.forEach(res =>{ const n = c[res]; out[res] = (typeof n === 'number' && n > 0) ? n : 0; });
  return Object.freeze(out);
}
/* Can this player pay `cost` in full? All-or-nothing, so a half-paid site is
   never a thing the rules have to describe. */
function canPayCost(player, cost){
  return COST_RESOURCES.every(res => (player[res] || 0) >= ((cost && cost[res]) || 0));
}
/* Take what the player actually has, up to `cost`, and RETURN what was taken.
   The return value is what makes the Rift's mutations honest: Open Hands
   refunds exactly this number and Toll charges exactly this number again, so
   neither can invent a refund for a price that was never paid or a toll on a
   price the player never paid. */
function takeCost(player, cost){
  const spent = {credits:0, ore:0, troops:0};
  COST_RESOURCES.forEach(res =>{
    const want = ((cost && cost[res]) || 0);
    if(want <= 0) return;
    const have = player[res] || 0;
    const n = Math.min(have, want);
    player[res] = have - n;
    spent[res] = n;
  });
  return spent;
}
/* "1 Ore" / "5 Credits + 3 Ore" — the price as the log and the Rift's reveal
   both want it read, built from the same object they charge from. Ore is a
   mass noun in this game's copy ("+3 Ore", never "+3 Ores"), so it does not
   pluralise; Credits and Troops do. */
const COST_NOUN = {credits:'Credit', ore:'Ore', troops:'Troop'};
const costPhrase = (cost)=> COST_RESOURCES
  .filter(res => ((cost && cost[res]) || 0) > 0)
  .map(res => {
    const n = cost[res];
    const plural = (res === 'ore' || n === 1) ? '' : 's';
    return `${n} ${COST_NOUN[res]}${plural}`;
  })
  .join(' + ');
/* " (paid 1 Ore)" appended to a site log line — zero-length when the tier is
   free, so a Basic pick never grows a stray "paid". */
function paidNote(cost){
  const phrase = costPhrase(cost);
  return phrase ? ` (paid ${phrase})` : '';
}

const TOTAL_ROUNDS = 6;
const CAPS = {credits:8, ore:6, troops:6};
/* Every Objective pays the same bonus. Declared up here (rather than inline
   in each entry) so the rules copy in RULES_HTML can quote it and the two
   can never drift apart. */
const OBJECTIVE_BONUS = 2;
/* >>> STAKES: the three declarations and their two numbers, declared HERE for
   >>> the same reason OBJECTIVE_BONUS is. RULES_HTML is a top-level template
   >>> literal evaluated while this file loads, so anything it interpolates has
   >>> to exist above it or the whole file dies at require() time with a
   >>> temporal-dead-zone ReferenceError that `node --check` cannot see (it is a
   >>> runtime error, and it took test/sites.test.js down when it happened).
   >>> The accessor FUNCTIONS - declaredStakes, bloodMinCommit, skirmishCap -
   >>> live further down, beside the Fury ladder they read; only the constants
   >>> are here. */
const STANCE_HOLD = 'hold', STANCE_ORDINARY = 'ordinary', STANCE_BLOOD = 'blood';
/* The BLOOD ceiling. It is the same number Skirmish Fever lifts every Fury rung
   to, which is deliberate: two rules that both mean "this fight may pay six"
   must not be able to argue about which of them is larger. If BLOOD and Fever
   land together the answer is 6 either way - BLOOD cannot be raised above 6 and
   Fever cannot lower it below 6 - so the two compose instead of competing, and
   `skirmishCap()` is written as a max() over both for exactly that reason. */
const BLOOD_CAP = 6;
/* What a declared HOLD BACK pays. Deliberately 1, and deliberately not more:
   measured, a flat +1 here is worth +0.25 pts/seat (z = 2.36) and lifts the
   Bounty claim rate from 30.8% to 41.5% - real, and small enough that it cannot
   become the plan. It is a stopgap, not a design: it is a flat additive
   modifier, which is the pattern this game already suffers from (the Surge, the
   Bounty, Catching Up are all flat adds). What makes it a decision rather than a
   receipt is the Pressure floor beneath it - hold too often and the sky opens on
   you. */
const HOLD_BACK_INFLUENCE = 1;
/* How long the end screen waits before looping into the next demo game. Long
   enough to actually read the final tally, and now visible + cancellable. */
const DEMO_LOOP_SECONDS = 8;
let demoLoopTimer = null;
/* The pending bot tick's timer handle (D4). Declared HERE, beside demoLoopTimer
   and above startGame() - a `let` is in its temporal dead zone until its
   declaration is evaluated, so declaring this down beside maybeAutoPick() would
   make the startGame() clear a ReferenceError on the very first Play Again.
   MODULE-LEVEL and deliberately NOT on `state`: state is JSON.stringify'd to
   the online guest on every render, and a timer handle is neither serialisable
   nor meaningful to the receiver. */
let botTickTimer = null;
let BOT_TICK_MS = 500;

/* ------------------------------ Sound ------------------------------
   All real audio lives in js/audio.js (OD.Sound): 36 procedurally
   synthesized recipes through a shared filter -> ADSR -> panner -> master
   -> compressor graph, with a generated convolution reverb and rate-limited
   dice ticks. Everything below is a thin shim so the handful of legacy
   identifiers the rest of this file still uses keep working untouched. */
let soundOn = OD.Sound.enabled;

function ensureAudioCtx(){ return OD.Sound.ensure(); }

/* Legacy one-shot helper. Nothing in this file calls it any more - the sfx
   table below maps to named recipes - but it stays as the documented
   escape hatch for a one-off tone. */
function beep(freq, durationMs, type, volume, delayMs){
  OD.Sound.tone({freq, dur: (durationMs||200)/1000, type, gain: volume, at: (delayMs||0)/1000});
}

const sfx = {
  click:      ()=> OD.Sound.play('ui.click'),
  diceTick:   ()=> OD.Sound.play('dice.tick'),
  diceSettle: ()=> OD.Sound.play('dice.settle'),
  gain:       ()=> OD.Sound.play('stat.gain'),
  win:        ()=> OD.Sound.play('stinger.win'),
  lose:       ()=> OD.Sound.play('stinger.loss'),
};

/* >>> THE SOUND TOGGLES WERE INVISIBLE TO A KEYBOARD AND TO A SCREEN READER.
   Both are <div class="sound-toggle"> with cursor:pointer: measured role null,
   tabindex null, on both the setup copy and the in-game copy. Unreachable with
   Tab, unannounced, and - because the label is the TEXT - a screen reader
   could not have told "Sound: On" from a heading anyway.

   Upgraded from JS (index.html is not this file's). role="switch" rather than
   role="button", because a switch is a two-state control and announces
   "on"/"off" from aria-checked. aria-label is the CONSTANT ("Sound") and the
   changing "On"/"Off" stays in the text: a name that flips with the value
   makes the control announce as two different controls. The structural change
   that would make this markup is reported in the handover. */
function setSoundUI(){
  [document.getElementById('soundToggle'), document.getElementById('soundToggleGame')].forEach(el=>{
    if(!el) return;
    el.textContent = `Sound: ${soundOn?'On':'Off'}`;
    el.classList.toggle('on', soundOn);
    el.setAttribute('role', 'switch');
    el.setAttribute('aria-label', 'Sound');
    el.setAttribute('aria-checked', soundOn ? 'true' : 'false');
    el.tabIndex = 0;
  });
}
function toggleSound(){
  soundOn = OD.Sound.setEnabled(!soundOn);
  setSoundUI();
  if(soundOn) sfx.click();
}

const INTRIGUE_PLAY_COST = 2;
const HAND_CAP = 5;

const RULES_HTML = `
  <div class="rules-panels">
    <section class="rules-panel active" id="rules-objective" role="tabpanel" aria-labelledby="rules-tab-objective">
      <div class="rules-lead">
        <p class="rules-win"><strong>Win condition.</strong> Play ${TOTAL_ROUNDS} rounds. Most Influence wins. Equal Influence is a draw.</p>
        <p>Each player starts with <b>2 Credits</b>, <b>1 Ore</b>, <b>1 Troop</b>, <b>0 Influence</b>, and a personal deck of ${DECK_SIZE} Tactic cards. Caps are <b>Credits ${CAPS.credits} · Ore ${CAPS.ore} · Troops ${CAPS.troops}</b>, and they are <b>hard ceilings that clamp the moment you gain</b> — not an end-of-round trim. Anything over the cap is discarded immediately and never reaches your pool.</p>
      </div>
      <h3 class="rules-h">Each round (5 steps)</h3>
      <ol class="rules-steps">
        <li><span class="rules-step-title">Event</span> From Round 3, both players draw one shared Round Event that applies to you equally.</li>
        <li><span class="rules-step-title">Intrigue</span> From Round 2, both players draw 1 Intrigue card from the shared pool.</li>
        <li><span class="rules-step-title">Draft</span> 8 sites, 3 picks each (6 total) in snake order. Two sites go unused — or one, the round the Rift is open (see <b>Meltdown</b>). First-picker alternates each round. Taking a site resolves Basic (free) or Advanced (costs more, pays more) immediately. You may also play one Intrigue card on your turn — free, it does not cost a pick.</li>
        <li><span class="rules-step-title">Skirmish</span> If someone took Garrison, they may attack. Otherwise skip this step.</li>
        <li><span class="rules-step-title">Upkeep</span> Anything over a cap is trimmed (it was already trimmed on the way in), then the next round begins.</li>
      </ol>
      <div class="rules-callout">
        <strong>Complexity ramp.</strong> Round 1 is Basic-only — no Intrigue or Events. Advanced + Intrigue unlock Round 2; Round Events from Round 3.
      </div>
    </section>

    <section class="rules-panel" id="rules-board" role="tabpanel" aria-labelledby="rules-tab-board" hidden>
      <p class="rules-intro">Eight sites. Each has a free <b>Basic</b> tier and a pricier <b>Advanced</b> tier. Two sites sit unused every round — unless the Rift is open, which makes it <b>nine sites and six picks</b>. The Rift is announced at the start of every round from Round 3; its mutations are on the <b>Meltdown</b> tab.</p>
      <div class="rules-callout">
        <strong>Most sites also pay a bonus, and the two kinds run in opposite directions.</strong>
        <b>Poverty</b> (Market, Quarry, Foundry, Bazaar): +1 Influence when the resource that
        site works in is <b>gone</b> — an empty treasury, no Troops at all, no Ore, or no 2 Ore
        to trade. Being rich earns nothing here; being broke earns standing.
        <b>Army</b> (Garrison): +1 Influence per Troop you <b>already hold</b>, up to the tier's
        cap. This is the one that makes <b>holding back</b> worth taking — the army you do not
        commit to a Skirmish keeps paying you, so spending it costs you next round.
      </div>
      <div class="rules-sites">
        <article class="rules-site">
          <h4>Market</h4>
          <div class="rules-tier basic"><span class="rules-tier-tag">Basic</span><span>+2 Credits, +1 Influence if you have no Credits</span></div>
          <div class="rules-tier advanced"><span class="rules-tier-tag">Adv</span><span>Pay 1 Ore → +4 Credits, +1 Influence if you have no Credits</span></div>
        </article>
        <article class="rules-site">
          <h4>Quarry</h4>
          <div class="rules-tier basic"><span class="rules-tier-tag">Basic</span><span>+2 Ore, +1 Troop, +1 Influence if you have no Troops</span></div>
          <div class="rules-tier advanced"><span class="rules-tier-tag">Adv</span><span>Pay 1 Credit → +3 Ore, +2 Troops, +1 Influence if you have no Troops</span></div>
        </article>
        <article class="rules-site">
          <h4>Garrison</h4>
          <div class="rules-tier basic"><span class="rules-tier-tag">Basic</span><span>+2 Troops, +1 Influence per Troop you hold (max 1), become Aggressor</span></div>
          <div class="rules-tier advanced"><span class="rules-tier-tag">Adv</span><span>Pay 1 Ore → +4 Troops, +1 Influence per Troop you hold (max 2), Aggressor +1 Skirmish</span></div>
        </article>
        <article class="rules-site">
          <h4>Outpost</h4>
          <div class="rules-tier basic"><span class="rules-tier-tag">Basic</span><span>Pay 3 Credits + 2 Ore → +1 Influence (else +1)</span></div>
          <div class="rules-tier advanced"><span class="rules-tier-tag">Adv</span><span>Pay 5 Credits + 3 Ore → +3 Influence (else +1)</span></div>
        </article>
        <article class="rules-site">
          <h4>Archive</h4>
          <div class="rules-tier basic"><span class="rules-tier-tag">Basic</span><span>Draw 1 Tactic card — hand full? +1 Influence instead</span></div>
          <div class="rules-tier advanced"><span class="rules-tier-tag">Adv</span><span>Pay 1 Credit → draw 3, or +1 Influence if your hand is full</span></div>
        </article>
        <article class="rules-site">
          <h4>Foundry</h4>
          <div class="rules-tier basic"><span class="rules-tier-tag">Basic</span><span>+1 Credit, +1 Ore, +1 Influence if you have no Ore</span></div>
          <div class="rules-tier advanced"><span class="rules-tier-tag">Adv</span><span>Pay 1 Troop → +3 Credits, +2 Ore, +1 Influence if you have no Ore</span></div>
        </article>
        <article class="rules-site">
          <h4>Bazaar</h4>
          <div class="rules-tier basic"><span class="rules-tier-tag">Basic</span><span>2 Ore → 2 Credits (no 2 Ore? +1 Credit, +1 Influence)</span></div>
          <div class="rules-tier advanced"><span class="rules-tier-tag">Adv</span><span>2 Ore → 4 Credits (no 2 Ore? +2 Credits, +1 Influence)</span></div>
        </article>
        <article class="rules-site">
          <h4>Shrine</h4>
          <div class="rules-tier basic"><span class="rules-tier-tag">Basic</span><span>+1 Influence, free</span></div>
          <div class="rules-tier advanced"><span class="rules-tier-tag">Adv</span><span>Pay 2 Credits + 1 Ore → +3 Influence (else +1)</span></div>
        </article>
      </div>
    </section>

    <section class="rules-panel" id="rules-cards" role="tabpanel" aria-labelledby="rules-tab-cards" hidden>
      <p class="rules-intro">${DECK_SIZE}-card personal deck (one of each). Played <b>face-down only in a Skirmish</b>. Your hand starts <b>full</b> at ${HAND_CAP} and can never hold more than ${HAND_CAP}.</p>
      <div class="rules-callout">
        <strong>Your hand starts full.</strong> Archive, Foresight, Scout and Insight all draw Tactic cards — and all of them draw <b>zero</b> while your hand is at ${HAND_CAP}. Cards only ever leave your hand when you play one in a Skirmish, so drawing is a <b>rewards-for-spending</b> bonus, not a build-up. If the log says a card “drew 0”, you were at the cap. The <b>Archive</b> is the one exception: with a full hand it pays <b>+1 Influence</b> on either tier instead of drawing, so a full hand is a standing pick rather than a dead one.
      </div>
      <div class="rules-card-group">
        <h3 class="rules-h">Aggressive <span class="rules-h-sub">raw power, usually at a cost</span></h3>
        <ul class="rules-card-list">
          <li><b>Ambush</b><span class="rules-mod">+2</span><span class="rules-card-desc">If you still lose, lose 1 extra Troop.</span></li>
          <li><b>Overrun</b><span class="rules-mod">+3</span><span class="rules-card-desc">+3 combat, but it costs 1 Ore to play. Without that Ore the +3 is lost entirely — it resolves as +0.</span></li>
          <li><b>Berserker</b><span class="rules-mod">+5</span><span class="rules-card-desc">Biggest swing. Lose 2 Troops win or lose.</span></li>
          <li><b>Blitz</b><span class="rules-mod">+2</span><span class="rules-card-desc">Only if you are Aggressor this round; else +0.</span></li>
          <li><b>Onslaught</b><span class="rules-mod">+4</span><span class="rules-card-desc">Costs 2 Credits; else acts as +1.</span></li>
          <li><b>Ambuscade</b><span class="rules-mod">+3</span><span class="rules-card-desc">If you win, opponent loses 1 extra Troop.</span></li>
        </ul>
      </div>
      <div class="rules-card-group">
        <h3 class="rules-h">Defensive <span class="rules-h-sub">protect your position</span></h3>
        <ul class="rules-card-list">
          <li><b>Feint</b><span class="rules-mod">+0</span><span class="rules-card-desc">If you lose, committed Troops return.</span></li>
          <li><b>Guard</b><span class="rules-mod">+1</span><span class="rules-card-desc">If you lose, reduce winner's margin by 1.</span></li>
          <li><b>Fortify</b><span class="rules-mod">+0</span><span class="rules-card-desc">Committed Troops always return, win or lose.</span></li>
        </ul>
      </div>
      <div class="rules-card-group">
        <h3 class="rules-h">Utility <span class="rules-h-sub">economy and information</span></h3>
        <ul class="rules-card-list">
          <li><b>Rally</b><span class="rules-mod">+1</span><span class="rules-card-desc">If you win, +1 bonus Influence.</span></li>
          <li><b>Scout</b><span class="rules-mod">+1</span><span class="rules-card-desc">Draw 1 extra card after Skirmish.</span></li>
          <li><b>Undermine</b><span class="rules-mod">+0</span><span class="rules-card-desc">−2 to opponent's total instead.</span></li>
          <li><b>Sabotage</b><span class="rules-mod">+1</span><span class="rules-card-desc">Opponent discards 1 random hand card.</span></li>
          <li><b>Insight</b><span class="rules-mod">+2</span><span class="rules-card-desc">Draw 1 after Skirmish, win or lose.</span></li>
        </ul>
      </div>
      <div class="rules-card-group">
        <h3 class="rules-h">Chaos <span class="rules-h-sub">high variance</span></h3>
        <ul class="rules-card-list">
          <li><b>Wildcard</b><span class="rules-mod">d6</span><span class="rules-card-desc">Modifier = fresh d6 (1–6).</span></li>
          <li><b>Desperate Gambit</b><span class="rules-mod">2d6</span><span class="rules-card-desc">Roll two d6; take the higher.</span></li>
        </ul>
      </div>
    </section>

    <section class="rules-panel" id="rules-skirmish" role="tabpanel" aria-labelledby="rules-tab-skirmish" hidden>
      <p class="rules-intro">Only happens if someone took <b>Garrison</b> this round. That player is the Aggressor.</p>
      <ol class="rules-steps">
        <li><span class="rules-step-title">Declare</span> Aggressor declares one of three stances. <b>Hold Back</b> &mdash; no Skirmish, you bank <b>+1 Influence</b>, and Pressure rises by 1 instead of 2. <b>Ordinary</b> &mdash; the rules below, nothing declared. <b>Blood</b> &mdash; the Influence ceiling is <b>${BLOOD_CAP}</b> whatever the Fury ladder says, you must commit at least <b>half your Troops</b>, and <b>the loser keeps their committed Troops</b> (a tie returns both sides&rsquo;). Worth it only if the margin reaches ${BLOOD_CAP-1}. In MELTDOWN, Hold Back is not on the table.</li>
        <li><span class="rules-step-title">Commit</span> Aggressor picks troops (0&ndash;all) and may play one Tactic face-down.</li>
        <li><span class="rules-step-title">Respond</span> Defender does the same — and commits <b>second</b>, so they see what the aggressor committed and which stance was declared. The commit window shows you the exact odds before you commit; the aggressor's window does not, because they do not know yet either.</li>
        <li><span class="rules-step-title">Spend</span> Committed troops are spent by both sides unless a card returns them (e.g. Feint, Fortify) — or unless Blood was declared, which returns the <b>loser&rsquo;s</b> to them.</li>
        <li><span class="rules-step-title">Resolve</span> Each side: d6 + troops + card mod (+1 if Advanced Garrison Aggressor). Undermine subtracts 2 from the other total.</li>
        <li><span class="rules-step-title">Score</span> Higher total wins Influence equal to the margin, capped at your <b>Fury</b> rung&rsquo;s ceiling (or ${BLOOD_CAP} on Skirmish Fever, or under Blood). Tie = no Influence; troops still spent unless Blood was declared. Some cards fire regardless of winner.</li>
      </ol>
      <div class="rules-callout">
        <strong>The streak bonus is the Fury ladder, not a flat one.</strong> Two wins in a row is no longer worth the same as four. The full ladder and the Betrayal tokens are both on the <b>Fury &amp; Tokens</b> tab — that tab is owned by the feature that implements them, so it cannot drift out of date with the game.
      </div>
    </section>

    <section class="rules-panel" id="rules-extras" role="tabpanel" aria-labelledby="rules-tab-extras" hidden>
      <div class="rules-extra">
        <h3 class="rules-h">Objectives</h3>
        <p>Each player gets one secret Objective at game start — visible in both HUDs, with live progress. Complete it by Round ${TOTAL_ROUNDS} for <b>+${OBJECTIVE_BONUS} Influence</b>, on top of everything you scored in the Skirmishes. Deny your opponent's goal when you can — theirs is shown to you too.</p>
      </div>
      <div class="rules-extra">
        <h3 class="rules-h">Intrigue Cards</h3>
        <p>Shared pool, 1 card each from Round 2. Play face-up on your draft turn as a free action (does not cost a site pick). <b>Cost: ${INTRIGUE_PLAY_COST} Credits</b>.</p>
        <ul class="rules-inline-list">
          <li><b>Raid</b> — steal up to 2 Credits</li>
          <li><b>Requisition</b> — +2 Ore, +1 Credit</li>
          <li><b>Coup</b> — +3 Influence</li>
          <li><b>Sabotage Supply</b> — opponent −1 Troop</li>
          <li><b>Foresight</b> — draw 2 Tactics</li>
          <li><b>Windfall</b> — +3 Credits</li>
          <li><b>Reinforce</b> — +2 Troops</li>
          <li><b>Marketplace</b> — 2 Ore → 4 Credits</li>
        </ul>
      </div>
      <div class="rules-extra">
        <h3 class="rules-h">Leaders</h3>
        <p>One persistent ability each, shown in the HUD:</p>
        <ul class="rules-inline-list">
          <li><b>Merchant</b> — +1 Credit from Market/Bazaar</li>
          <li><b>Engineer</b> — +1 Ore from Quarry/Foundry</li>
          <li><b>Warmonger</b> — +1 Troop from Garrison</li>
          <li><b>Diplomat</b> — +1 Influence from Shrine/Outpost</li>
          <li><b>Scholar</b> — +1 card from Archive</li>
          <li><b>Gambler</b> — +1 to Wildcard &amp; Gambit</li>
        </ul>
      </div>
      <div class="rules-extra">
        <h3 class="rules-h">Round Events</h3>
        <p>Drawn each round from Round 3, applies to both players (shown under Board):</p>
        <ul class="rules-inline-list">
          <li><b>Windfall / Trade Winds / Recruitment</b> — resource bump</li>
          <li><b>Council Session</b> — extra Tactic card</li>
          <li><b>Skirmish Fever</b> — Influence cap 4 → 6</li>
          <li><b>Quiet Round</b> — no Skirmish this round</li>
        </ul>
      </div>
    </section>

    <section class="rules-panel" id="rules-modes" role="tabpanel" aria-labelledby="rules-tab-modes" hidden>
      <div class="rules-modes">
        <article class="rules-mode">
          <h4>Same Screen</h4>
          <p>Two people, one device. Pass and play on your turn.</p>
        </article>
        <article class="rules-mode">
          <h4>Online</h4>
          <p>Host creates a short room code. Friend joins from another device.</p>
        </article>
        <article class="rules-mode">
          <h4>Demo</h4>
          <p>Two bots play automatically. Pick speed; optional loop after each game.</p>
        </article>
      </div>
    </section>
  </div>
`;

let state = null;

function rollD6(){ return 1 + Math.floor(Math.random()*6); }
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
  return arr;
}
function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }

function makeDeck(){ return shuffle(DECK_TEMPLATE.slice()); }

function makePlayer(name, type){
  return {
    name, type, // type: 'human' | 'bot'
    credits:2, ore:1, troops:1, influence:0,
    deck: makeDeck(), discard:[], hand:[],
    intrigueHand:[],
    isAggressor:false, aggressorBonus:0,
    skirmishWins:0, skirmishLosses:0, advancedPicks:0, winStreak:0,
    /* Tactic cards this player has actually PLAYED in a Skirmish - i.e. cards
       that left the hand. A plain integer, so it survives the JSON relay.
       This is the field that separates "holding five cards" from "cycling
       five cards", and Archivist is gated on it: with HAND_CAP 5 and both
       players dealt a full hand, a `hand.length >= 5` check is guaranteed true
       for BOTH players in EVERY game, which is not an objective, it is a free
       +4 Influence printed on the HUD before the first action. */
    cardsPlayed:0,
    /* Feature-owned counters. Declared here with explicit defaults so a
       feature never has to write a `?? 3` at every read site. All of them
       are plain JSON: `state` is serialized wholesale for the online relay
       and must contain no functions. */
    betrayal:2,          // charges of the "betray" feature
    freeAdvancedUsed:false, // whether this player's free Advanced pick is spent
    // Store only the id - the full definition (with its check/progress
    // functions) can't survive JSON.stringify over the online-play
    // WebSocket relay, so it's looked back up from the shared client-side
    // OBJECTIVES array instead.
    objectiveId: OBJECTIVES[Math.floor(Math.random()*OBJECTIVES.length)].id,
    leaderId: LEADERS[Math.floor(Math.random()*LEADERS.length)].id,
  };
}
function getObjective(player){
  return OBJECTIVES.find(o=>o.id===player.objectiveId);
}

/* Intrigue cards - a second, distinct card type (Dune Imperium-style):
   drawn from one shared pool instead of a personal deck, played on your own
   draft turn (doesn't cost a worker placement), and resolving immediately
   rather than being held face-down for a Skirmish. They're NOT free to play,
   though - each one costs INTRIGUE_PLAY_COST Credits, so you're always
   weighing the effect against the spend. That cost is what keeps them
   valuable instead of pure upside. */

/* Tactic (Skirmish) hand limit. You start each game with a full hand of
   HAND_CAP cards and it can never hold more than that - the only way to draw
   new Tactic cards is to place a worker on the Archive (or hit a Round Event
   that draws them). That keeps the hand tight and makes card draw a real
   board choice instead of an ever-growing pile. */
const INTRIGUE_DEFS = {
  raid:            {name:'Raid',             desc:'Steal up to 2 Credits from your opponent.'},
  requisition:     {name:'Requisition',      desc:'Gain 2 Ore and 1 Credit.'},
  coup:            {name:'Coup',             desc:'Gain 2 Influence immediately.'},
  sabotage_supply: {name:'Sabotage Supply',  desc:"Your opponent loses 1 Troop."},
  foresight:       {name:'Foresight',        desc:'Draw 2 Tactic cards immediately.'},
  windfall:        {name:'Windfall',         desc:'Gain 3 Credits.'},
  reinforce:       {name:'Reinforce',        desc:'Gain 2 Troops immediately.'},
  marketplace:     {name:'Marketplace',      desc:'If you have 2+ Ore: trade it for 4 Credits. Otherwise, gain 1 Credit instead.'},
};
const INTRIGUE_DECK_TEMPLATE = [...Object.keys(INTRIGUE_DEFS), ...Object.keys(INTRIGUE_DEFS)]; // 2 copies each

function drawIntrigue(player, n=1){
  for(let i=0;i<n;i++){
    if(state.intrigueDeck.length===0){
      if(state.intrigueDiscard.length===0) return;
      state.intrigueDeck = shuffle(state.intrigueDiscard);
      state.intrigueDiscard = [];
    }
    player.intrigueHand.push(state.intrigueDeck.pop());
  }
}

function applyIntrigueEffect(playerIdx, cardId){
  const player = state.players[playerIdx];
  const opp = state.players[1-playerIdx];
  switch(cardId){
    case 'raid': {
      const stolen = Math.min(2, opp.credits);
      opp.credits -= stolen; player.credits += stolen;
      log(`${esc(player.name)} plays <b>Raid</b> -> steals ${stolen} Credits from ${esc(opp.name)}.`);
      break;
    }
    case 'requisition':
      player.ore += 2; player.credits += 1;
      log(`${esc(player.name)} plays <b>Requisition</b> -> +2 Ore, +1 Credit.`);
      break;
    case 'coup':
      player.influence += 2;
      log(`${esc(player.name)} plays <b>Coup</b> -> +3 Influence.`);
      break;
    case 'sabotage_supply': {
      const lost = Math.min(1, opp.troops);
      opp.troops -= lost;
      log(`${esc(player.name)} plays <b>Sabotage Supply</b> -> ${esc(opp.name)} loses ${lost} Troop${lost!==1?'s':''}.`);
      break;
    }
    case 'foresight':
      {
        const drew = drawCard(player, 2);
        log(`${esc(player.name)} plays <b>Foresight</b> -> ${drawLog(player, 2, drew, 'hand already at the limit')}`);
      }
      break;
    case 'windfall':
      player.credits += 3;
      log(`${esc(player.name)} plays <b>Windfall</b> -> +3 Credits.`);
      break;
    case 'reinforce':
      player.troops += 2;
      log(`${esc(player.name)} plays <b>Reinforce</b> -> +2 Troops.`);
      break;
    case 'marketplace':
      if(player.ore>=2){
        player.ore-=2; player.credits+=4;
        log(`${esc(player.name)} plays <b>Marketplace</b> -> trades 2 Ore for +4 Credits.`);
      } else {
        player.credits+=1;
        log(`${esc(player.name)} plays <b>Marketplace</b> without enough Ore -> consolation +1 Credit.`);
      }
      break;
  }
  /* Features run BEFORE the caps clamp so they see (and can act on) the raw
     post-card numbers, exactly like the location path. */
  if(canRunExtensions()) OD.Ext.hooks.run('intriguePlayed', extCtx('draft', playerIdx, {cardId}));

  const lostP = applyCaps(player), lostO = applyCaps(opp);
  const trimmed = reportCaps(player, lostP) + reportCaps(opp, lostO);
  popupGain(playerIdx, `Intrigue: ${INTRIGUE_DEFS[cardId].name} (-${INTRIGUE_PLAY_COST})${trimmed}`, !trimmed);
}

function canPlayIntrigue(player){
  return player.credits >= INTRIGUE_PLAY_COST;
}

function playIntrigueCard(playerIdx, cardId){
  const player = state.players[playerIdx];
  const idx = player.intrigueHand.indexOf(cardId);
  if(idx<0) return;
  if(!canPlayIntrigue(player)){
    log(`${esc(player.name)} can't afford to play <b>${INTRIGUE_DEFS[cardId].name}</b> (needs ${INTRIGUE_PLAY_COST} Credits).`);
    return;
  }
  player.credits -= INTRIGUE_PLAY_COST;
  player.intrigueHand.splice(idx,1);
  state.intrigueDiscard.push(cardId);
  applyIntrigueEffect(playerIdx, cardId);
  renderAll();
}

/* >>> A DOUBLE-CLICK PLAYED THE SAME CARD TWICE (D5).
   playIntrigueCard() guards with `intrigueHand.indexOf(cardId)` and splices
   ONE entry out, and the Intrigue deck ships TWO COPIES OF EVERY CARD
   (INTRIGUE_DECK_TEMPLATE), so `indexOf` still found the second copy and the
   second click played it. The guard that looks like a duplicate-play guard is
   a guard against a card you do not hold - it does nothing at all about a card
   you hold twice.

   The latch is keyed on the CARD, so a deliberate second play of a DIFFERENT
   card is never blocked, and it is time-boxed, so a deliberate second play of
   the same card (two copies in hand, which the deck makes possible) is not
   blocked either. The window is a few hundred milliseconds: long enough to
   swallow the second click of a real double-click, far too short to touch a
   decision.

   >>> AND A PER-CARD LATCH ALONE WAS NOT ENOUGH - MEASURED. The first version
   of this latch swallowed the second click, and the second click still played a
   second card: playing the first one re-renders #intrigueHand, the row is one
   card shorter, and the SAME PIXEL is now a different card's button. Measured
   (Round 4, hand [marketplace, foresight, windfall]): one double-click at one
   point removed TWO cards and charged 4 Credits. So a fire is also swallowed
   when it lands within a few pixels of the previous one inside the window -
   two clicks at the same point are one decision, while two clicks on two cards
   a card-width apart are two. A keyboard fire has no coordinates, so it falls
   back to the card key alone and behaves exactly as before.

   Not on `state`, because state is JSON.stringify'd to the online guest on
   every render; this is a UI latch, and the guest path is covered too because
   the check sits before the socket branch. */
const INTRIGUE_LATCH_MS = 400;
const INTRIGUE_LATCH_SLOP = 24;   // px - about half a card button
let intrigueLatch = null;          // {card, x, y, t}
function intrigueLatched(cardId, ev){
  const now = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
    ? performance.now() : Date.now();
  const prev = intrigueLatch;
  const px = (ev && typeof ev.clientX === 'number') ? ev.clientX : null;
  const py = (ev && typeof ev.clientY === 'number') ? ev.clientY : null;
  intrigueLatch = { card:cardId, x:px, y:py, t:now };
  if(!prev) return false;
  if((now - prev.t) >= INTRIGUE_LATCH_MS) return false;
  if(prev.card === cardId) return true;
  if(prev.x === null || px === null) return false;
  return Math.abs(prev.x - px) <= INTRIGUE_LATCH_SLOP && Math.abs(prev.y - py) <= INTRIGUE_LATCH_SLOP;
}

function humanPlayIntrigue(cardId, ev){
  const idx = currentPicker();
  if(idx===null || state.phase!=='draft') return;
  if(intrigueLatched(cardId, ev)) return;
  if(online.enabled){
    if(online.isHost){ if(idx!==0) return; }
    else { wsSend({type:'action', kind:'intrigue', cardId}); return; }
  } else if(state.players[idx].type!=='human'){
    return;
  }
  if(!canPlayIntrigue(state.players[idx])){
    const who = state.players[idx].name;
    log(`<b>${esc(who)}</b> can't afford that Intrigue card - it costs ${INTRIGUE_PLAY_COST} Credits.`);
    /* The refusal now says itself. It used to be reachable only by calling this
       function from a console: the button was `disabled`, so it could not be
       clicked and no key could reach it. See renderIntrigueHand(). */
    srWrite([srFact('intrigueRefuse', `${idx}:${who}:${INTRIGUE_PLAY_COST}`,
      `Refused: ${who} cannot afford an Intrigue card. It costs ${INTRIGUE_PLAY_COST} Credits.`)]);
    return;
  }
  playIntrigueCard(idx, cardId);
}

/* Public race-condition objectives - both players can see both targets, which
   adds tension (deny the site your opponent needs) without requiring any
   hidden-information plumbing over the network relay.

   `progress(p)` reports live {have, need, unit} for the HUD so a goal reads as
   "2 of 4" instead of a bare met / not-yet. It is a FUNCTION, which is why
   state only ever stores `objectiveId` (see makePlayer) - the whole object
   can't survive JSON.stringify over the online-play relay. `progress` may also
   return a `note`, printed after the count, for a goal that has more than one
   clause (Archivist).

   >>> AN OBJECTIVE MUST BE POSSIBLE TO MISS. Two of these used not to be, and
   >>> both were a free OBJECTIVE_BONUS of Influence handed out on the HUD
   >>> before the first action:
     - archivist read `hand.length >= 5`, but HAND_CAP is 5 and BOTH players
       are dealt exactly HAND_CAP cards at startGame(). The check was
       `5 >= 5` for both players in every single game, so it read "met (+4)
       5 of 5" from the opening hand and the player never had a decision to
       make. Rewritten below as what it was clearly reaching for - a full hand
       AT THE END, which means the hand has to have been REFILLED, which means
       cards have to have been played. See ARCHIVIST_PLAYED.
     - industrialist read `advancedPicks >= 4`, measured met in 100.0% of
       2,408 simulated games. Advanced is roughly 75% of all picks, so a
       threshold of 4 against ~13 picks per game was never a target. Retuned
       against the measured distribution. */

/* Archivist: cards that must have left the hand for the hand to still be full
   at the end. Without this clause the objective is arithmetic, not play.

   Retuned DOWNWARD once more in the 2026 rebalance. The Archive itself changed
   in that pass: a full hand used to be a DEAD PICK (it drew nothing, 2.4 times
   a game) and now pays standing instead, which means the Archive is drafted for
   Influence rather than for cards and refills the hand far less often. Measured
   after that change, "played >= 3 AND a full hand" read 5.6% - worse than
   ignoring it. Threshold lowered to 2 played cards, which is the smallest
   number of cards a player can spend and still refill from. */
const ARCHIVIST_PLAYED = 2;
/* The hand half of Archivist. It used to be HAND_CAP - "end with a FULL hand" -
   which, after the Archive started paying standing instead of drawing into a
   full hand, reads 8.2% (measured: 250 games / 85 player-games). One card of
   slack is the smallest change that makes the goal reachable without making it
   free: a hand of four still has to have been refilled from somewhere. */
const ARCHIVIST_HAND = HAND_CAP - 1;

/* Industrialist: Advanced picks a player has to take. Advanced is about 75% of
   every pick the bot makes (botChoosePick values it at 1.6x the Basic tier and
   it only declines when it cannot pay), so a threshold of 4 against ~13
   Advanced-or-basic picks a game was never a target - measured met in 100.0%
   of 2,408 simulated games, and still 100.0% at 8.

   Tuned on the MEASURED distribution, never on a guess. Headless bot-vs-bot
   simulation of the real engine (fake DOM + a synchronous timer queue, see the
   module.exports comment at the foot of this file), 8,000 games / 16,000
   player-games, 0 errors:

     P(advancedPicks >= 10)  99.2%      P(advancedPicks >= 15)  27.6%
     P(advancedPicks >= 12)  89.3%      P(advancedPicks >= 16)  11.0%
     P(advancedPicks >= 13)  73.4%      P(advancedPicks >= 17)   3.1%
     P(advancedPicks >= 14)  51.1%  <-- this one: a coin flip.

   Full distribution: 7:1 8:24 9:101 10:390 11:1189 12:2558 13:3557 14:3767
   15:2651 16:1264 17:413 18:80 19:5. 14 is also the honest design ask: 14 of
   the ~18 picks a player gets, taken at Advanced, which is a plan for the
   whole game rather than a rounding error.

   >>> 2026 REBALANCE: raised 14 -> 16. The board got flatter, so Advanced
   stopped being the scarce thing it was - the measured advanced-pick mean is
   14.15 of 18 possible, unchanged by the retune, and a threshold of 14 read
   83.1% met. 16 sits at roughly the middle of the upper tail. */
const INDUSTRIALIST_NEED = 15;

/* Warlord / Unscathed: the two Skirmish objectives, retuned together.
   `UNSCATHED_LOSSES` is the whole change. "Fight one and never lose one" over
   ~5 fights measured 8.6% before the rebalance and 6.7% after it, which is
   worse than not having the objective at all: at that rate a player should
   ignore it. One loss of slack is the smallest change that makes a five-fight
   game winnable - P(2+ wins and at most 1 loss over 5 fights) = 18.8%. */
const UNSCATHED_LOSSES = 1;

/* Financier / Prospector: the two end-of-game pool objectives. Both thresholds
   dropped with the yields they measure. The measured final pools moved from
   ~7.2 Credits / 4.4 Ore to ~4.5 Credits / 2.7 Ore when every site's resource
   yield was roughly halved (the cap-discard rate fell from 33.9 units a game to
   8.7, which was the point of T4), so a threshold of 7 Credits became a
   different objective entirely. Both are now aimed at the new distribution. */
const FINANCIER_NEED = 6;
const PROSPECTOR_NEED = 4;

const OBJECTIVES = [
  {id:'warlord',       name:'Warlord',       desc:'Win 3 or more Skirmishes.',                         bonus:OBJECTIVE_BONUS, check:p=> p.skirmishWins>=3,
   progress:p=> ({have: Math.min(p.skirmishWins, 3), need: 3, unit: 'wins'})},
  {id:'unscathed',     name:'Unscathed',     desc:`Win at least 2 Skirmishes and lose at most ${UNSCATHED_LOSSES}.`, bonus:OBJECTIVE_BONUS,
   check:p=> p.skirmishWins>=2 && p.skirmishLosses<=UNSCATHED_LOSSES,
   progress:p=> {
     const done = (p.skirmishWins>=2 && p.skirmishLosses<=UNSCATHED_LOSSES) ? 1 : 0;
     return {have: done, need: 1, unit: '2+ wins, at most ' + UNSCATHED_LOSSES + ' loss'};
   }},
  {id:'industrialist', name:'Industrialist', desc:`Take the Advanced tier ${INDUSTRIALIST_NEED} or more times.`, bonus:OBJECTIVE_BONUS,
   check:p=> p.advancedPicks>=INDUSTRIALIST_NEED,
   progress:p=> ({have: Math.min(p.advancedPicks, INDUSTRIALIST_NEED), need: INDUSTRIALIST_NEED, unit: 'advanced picks'})},
  {id:'financier',     name:'Financier',     desc:`End the game with ${FINANCIER_NEED} or more Credits.`, bonus:OBJECTIVE_BONUS, check:p=> p.credits>=FINANCIER_NEED,
   progress:p=> ({have: Math.min(p.credits, FINANCIER_NEED), need: FINANCIER_NEED, unit: 'Credits'})},
  {id:'prospector',    name:'Prospector',    desc:`End the game with ${PROSPECTOR_NEED} or more Ore.`, bonus:OBJECTIVE_BONUS, check:p=> p.ore>=PROSPECTOR_NEED,
   progress:p=> ({have: Math.min(p.ore, PROSPECTOR_NEED), need: PROSPECTOR_NEED, unit: 'Ore'})},
  /* Both clauses, and `progress` reports the one that is holding the player
     back rather than always printing the friendlier number. */
  {id:'archivist',     name:'Archivist',     desc:`End the game with ${ARCHIVIST_HAND} or more cards in hand, having played at least ${ARCHIVIST_PLAYED} cards.`,
   bonus:OBJECTIVE_BONUS,
   check:p=> p.hand.length>=ARCHIVIST_HAND && p.cardsPlayed>=ARCHIVIST_PLAYED,
   progress:p=>{
     const played = Math.min(p.cardsPlayed|0, ARCHIVIST_PLAYED);
     if(played < ARCHIVIST_PLAYED){
       return {have: played, need: ARCHIVIST_PLAYED, unit: 'cards played',
               note: 'and a full hand at the end'};
     }
     return {have: Math.min(p.hand.length, ARCHIVIST_HAND), need: ARCHIVIST_HAND, unit: 'cards in hand'};
   }},
];

/* Leaders - a random persistent passive ability each player is dealt at game
   start (asymmetric powers, Dune Imperium-style). Applied as small +1 checks
   at the handful of existing effect points they touch, so no new resolution
   pipeline is needed. */
const LEADERS = [
  {id:'merchant',  name:'Merchant',  desc:'Market and Bazaar give +1 extra Credit.'},
  {id:'engineer',  name:'Engineer',  desc:'Quarry and Foundry give +1 extra Ore.'},
  {id:'warmonger', name:'Warmonger', desc:'Garrison gives +1 extra Troop.'},
  {id:'diplomat',  name:'Diplomat',  desc:'Shrine and Outpost give +1 extra Influence.'},
  {id:'scholar',   name:'Scholar',   desc:'Archive gives +1 extra Tactic card.'},
  {id:'gambler',   name:'Gambler',   desc:'Wildcard and Desperate Gambit get +1 to their result.'},
];
function getLeader(player){
  return LEADERS.find(l=>l.id===player.leaderId);
}

/* Round Events - a shared random modifier drawn fresh each round, applying
   to both players equally. Keeps the optimal strategy shifting round to
   round instead of every round playing out the same way. */
const EVENTS = [
  {id:'windfall_round',      name:'Windfall Round',      desc:'Both players immediately gain +2 Credits.'},
  {id:'trade_winds',         name:'Trade Winds',         desc:'Both players immediately gain +1 Ore.'},
  {id:'recruitment_drive',   name:'Recruitment Drive',   desc:'Both players immediately gain +1 Troop.'},
  {id:'council_session',     name:'Council Session',     desc:'Both players immediately draw 1 extra Tactic card.'},
  {id:'skirmish_fever',      name:'Skirmish Fever',      desc:'This round, the Skirmish Influence cap is raised from 4 to 6.'},
  {id:'quiet_round',         name:'Quiet Round',         desc:'This round, no Skirmish may occur, no matter who takes the Garrison.'},
];
function getEvent(){
  return EVENTS.find(e=>e.id===state.currentEvent);
}

/* =============================================================================
   LOG TYPING (G2)
   -----------------------------------------------------------------------------
   renderLog() used to emit `<div class="entry">${e}</div>` for all ~45 distinct
   kinds of line, so a resource GAIN, a LOSS, a system note, an unlock
   announcement, a cap discard and a Chaos beat were pixel-identical and only
   readable by scrolling. css/style.css already authors eleven `.entry.is-*`
   variants (is-gain, is-loss, is-system, is-unlock, is-danger, is-round, plus
   is-fury / is-betrayal / is-rift / is-pressure / is-bounty /
   is-meltdown / is-surge) and not one of them was ever bound.

   >>> D4: `is-siege` was the thirteenth, and it is GONE from both this list
   >>> and (in the same commit that cut the mechanic) from the stylesheet. It
   >>> was unreachable the moment Siege was: no line in the game can contain
   >>> SIEGE, CONTESTED SITE, "the offer lapses" or "Price for the ... rises"
   >>> any more, because js/feature-wagers.js was the only writer of all four.
   >>> A classifier for a deleted mechanic is worse than no classifier - it is
   >>> a rule that looks load-bearing and is not, so the next engineer
   >>> preserves it. The Rift's own `contested` line is a DIFFERENT mechanic
   >>> and keeps its own rule above.

   WHY CLASSIFY AT RENDER TIME AND NOT AT LOG TIME. `state` is JSON-serialised
   wholesale to the online guest, so an entry cannot become a {html,type} pair
   without changing the wire format every feature and every snapshot already
   shares - and js/feature-wagers.js and js/ext.js push strings into
   `state.logEntries` directly, bypassing log() entirely. Classifying on the way
   out means one classifier covers the engine, both features and the guest's
   re-render of a host snapshot, with zero change to the stored shape.

   The classifier is deliberately conservative: it is an ordered first-match
   list, so a line that matches nothing lands on `is-system` (the neutral
   default) rather than on a wrong claim. Every variant carries a glyph and a
   weight change in the stylesheet as well as a colour, so the type survives
   greyscale and deuteranopia. */
const LOG_MAX_ENTRIES = 300;

/* Ordered, first match wins. The order is the whole design; each entry below
   says which real log line it is protecting against the next one. */
const LOG_TYPE_RULES = [
  /* The round opener is the only line that names a round boundary, and it is
     the anchor a player scrolls back to find "what was I doing in round 3". */
  ['is-round',     /—\s*Round\s+\d+\s+begins\s*—/i],

  /* A Round Event is a shared modifier BOTH players received equally, so it is
     a system announcement - and this has to sit ABOVE the gain test, because
     three of the six event descriptions contain the word "gain". */
  ['is-system',    /^Round Event:/],

  /* The feature beats announce themselves in caps. They are checked as a block
     before the generic rules because each of them also contains a number and
     would otherwise be swallowed by is-gain ("THE SURGE ... straight to
     Influence", "PRESSURE 4/4", "claims the Bounty -> +2 Influence"). */
  ['is-meltdown',  /\bMELTDOWN\b/],
  ['is-surge',     /\bTHE SURGE\b/i],
  ['is-bounty',    /\bBOUNTY PUBLISHED\b|\bclaims the Bounty\b|\bNobody claims the Bounty\b/i],
  ['is-pressure',  /\bPRESSURE\s*\d|\bTHE SKY (OPENS|CLOSES)\b|\bCollapse\s+\d/i],
  ['is-rift',      /\bTHE RIFT\b|\bRift (mutates|opens|is live)\b|\bNine sites on the board\b/i],
  ['is-betrayal',  /\bBETRAYS THE ROUND\b|\bBetrayal token/i],
  ['is-fury',      /\bFURY\s*\d|\breaches <b>Fury\b/i],

  /* A mechanic becoming LEGAL. Every remaining "something opened" line in the
     game that has no feature beat of its own is here: the Advanced tier, the
     wagers, the Rift's arrival. */
  ['is-unlock',    /\bunlock(?:s|ed|ing)?\b|\bbecomes? legal\b|\bgo(?:es)? live\b|\bare available\b/i],

  /* A consolation payout - "but can't afford it -> consolation +1 Influence".
     This DOES pay out, so it is a gain, and it must be matched before the
     danger rule below sees the words "can't afford it". */
  ['is-gain',      /\bconsolation\b/i],

  /* A LOSS printed as a number: "-> -3 Influence". Ahead of is-danger so an
     All-In loss reads as the loss it is rather than as a generic hazard. */
  ['is-loss',      /(^|[^-\w])-\d+\s*(Influence|Troops?|Credits?|Ore)/i],

  /* DANGER - something was lost, seized, capped away or taken. The resource-cap
     discard ("gained and immediately discarded, never banked") is the one that
     matters most: the number on the line was never really the player's. */
  ['is-danger',    /discarded, not banked|\blost to cap\b|\bloses the Skirmish\b|\bbackfires\b|\bcosts (them|him|her)\b|\bforces .* to discard\b|\bTHE SKY OPENS\b|\bsteals\b|\bloses \d+ Troop|\bcan'?t afford\b|\bcannot afford\b|\bnothing left to lose\b|\bthe offer lapses\b|\bgets nothing\b/i],

  /* Anything else that handed a player a number. */
  ['is-gain',      /\+\d+\s*(Influence|Credits?|Ore|Troops?|Tactic card)|\bcompletes their objective\b|\bgains?\b/i],
];
const LOG_TYPE_DEFAULT = 'is-system';

function logEntryType(html){
  const s = String(html == null ? '' : html);
  for(let i=0;i<LOG_TYPE_RULES.length;i++){
    if(LOG_TYPE_RULES[i][1].test(s)) return LOG_TYPE_RULES[i][0];
  }
  return LOG_TYPE_DEFAULT;
}

/* The log is the one panel that grows without bound - ~30 lines a round, six
   rounds, plus every feature beat - and it is rendered by full innerHTML
   replacement on every single line. Oldest lines are dropped from the FRONT
   so the newest stays at the top (newest is pinned first), and the drop
   happens on the way out AND on the way in so feature writes that bypass
   log() are trimmed too. 300 entries is roughly four full rounds of play: far
   more than anyone scrolls back through, small enough to re-render cheaply. */
function trimLog(){
  const arr = state && state.logEntries;
  if(!Array.isArray(arr) || arr.length <= LOG_MAX_ENTRIES) return;
  arr.splice(0, arr.length - LOG_MAX_ENTRIES);
}

/* The engine's HTML escaper, for interpolation of an untrusted value into a
   markup string.

   >>> WHY THE LOG IS NOT ESCAPED AS A WHOLE. `log()` takes AUTHORED markup
   >>> (every one of its ~45 call sites writes `<b>`, `<em>`, `&mdash;` by
   >>> hand) and renderLog paints it with innerHTML. Escaping the entry would
   >>> flatten every log line in the game. So the rule is: the NAME is escaped
   >>> where it is interpolated, and the surrounding sentence is not. Every
   >>> `${...name}` in this file is wrapped in esc() for exactly that reason;
   >>> a name is the only player-controllable string that reaches innerHTML,
   >>> and it reached it at ~114 sites.

   js/feature-wagers.js declares a character-identical esc() inside its own
   closure. That is deliberate and not duplication for its own sake: the two
   files share one global scope, and a second top-level `function esc` in
   game.js would overwrite the feature's copy wholesale on the next page load,
   handing feature-wagers the engine's implementation with no test to notice. */
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* A number for interpolation into markup or into an attribute value, from a
   value that may have arrived over the wire. Anything that is not a finite
   number becomes `fallback`, so a payload of `<img src=x onerror=...>` in a
   field the UI prints as a count cannot become an element. Distinct from esc():
   this COERCES and rejects, where esc() would faithfully print the junk. */
function numOr(v, fallback){
  const n = Number(v);
  return isFinite(n) ? Math.round(n) : fallback;
}

/* Signature UNCHANGED and deliberately so: `log(msg)` is called from ~45 places
   in this file plus js/feature-wagers.js and js/ext.js through the
   OD.WagersBridge / OD.Ext seams. The type is derived at render time, so no
   call site had to be touched to get a typed log. */
function log(msg){
  state.logEntries.push(msg);
  trimLog();
  renderLog();
}

/* ---------------------------- Extension seam ----------------------------
   Features never touch game.js internals. They get a context object from
   extCtx() and mutate only through the api it carries, and every callback
   is individually try/caught inside OD.Ext so a broken feature degrades
   instead of bricking the game. */

/* Build the context every hook and effect receives:
     {state, api, side, player, opp, playerIdx, ...extra}
   `side` is 'aggressor' | 'defender' | 'draft' | null. `extra` is the
   hook-specific payload (locId, cardId, result, …) merged in directly. */
function extCtx(side, playerIdx, extra){
  const ctx = Object.assign({
    state,
    api: OD.Ext.makeApi(state),
    side: side || null,
    player: (playerIdx >= 0 && state.players) ? state.players[playerIdx] : null,
    opp: (playerIdx === 0) ? state.players[1] : (playerIdx === 1 ? state.players[0] : null),
    playerIdx,
  }, extra || {});
  return ctx;
}

/* The online guest is a thin client: it renders snapshots the host sends
   and never mutates anything. Firing hooks there would double-apply every
   feature effect, so the engine only dispatches on the host / local seats. */
function canRunExtensions(){
  return !(online.enabled && !online.isHost);
}

/* The two things OD.Ext.makeApi() cannot know on its own. `draw` must use
   the engine's deck/shuffle/hand-cap logic, and `popup` needs the HUD
   geometry that lives in popupGain(). */
OD.Ext.setAdapters({
  draw: (player, n)=> drawCard(player, n),
  popup: (i, text, good)=> popupGain(i, text, good),
});

/* Draws up to `n` Tactic cards and RETURNS how many it actually drew.
   The hand starts at HAND_CAP and can never exceed it, so a draw while the
   hand is full legitimately returns 0 - which is why every call site has to
   report the real number rather than the number it asked for. */
function drawCard(player, n=1){
  let drew = 0;
  for(let i=0;i<n;i++){
    if(player.hand.length >= HAND_CAP) return drew;
    if(player.deck.length===0){
      if(player.discard.length===0) return drew;
      player.deck = shuffle(player.discard);
      player.discard = [];
    }
    player.hand.push(player.deck.pop());
    drew++;
  }
  /* >>> CHAOS (feature-chaos.js) — the "drew more Tactic cards" Bounty needs
     the number that actually landed, which cannot be reconstructed from the
     Archive pick: this loop early-returns while the hand is full, so a
     player can ask for three and receive none. Counted here, on the only
     place in the game that knows the truth. */
  if(drew > 0 && state && state.roundRec && Array.isArray(state.roundRec.cards)){
    const who = state.players ? state.players.indexOf(player) : -1;
    if(who >= 0) state.roundRec.cards[who] += drew;
  }
  return drew;
}

/* Truthful one-liner for a card draw: says "drew 0 - hand is full" instead
   of claiming a draw that never happened. */
function drawLog(player, asked, drew, reason){
  if(drew > 0){
    const extra = (drew < asked) ? ` (${reason})` : '';
    return `${esc(player.name)} draws ${drew} Tactic card${drew!==1?'s':''}${extra}.`;
  }
  return `${esc(player.name)} draws nothing - ${reason}.`;
}

/* ------------------------------ Online play ------------------------------
   Host runs the authoritative game engine (all functions below). The guest
   is a thin client: it renders whatever `state` snapshot the host broadcasts,
   and forwards its own clicks to the host as small action messages instead
   of mutating anything locally. A dumb WebSocket relay (server.js) just pairs
   host+guest by room code and forwards messages verbatim between them. */
const online = {
  enabled:false, isHost:false, ws:null, roomCode:null, myIndex:0, guestReady:false,
};
let pendingGuestDecision = null;
let pendingGuestCommit = null;
const handRenderCache = {}; // playerIdx -> Set of card ids already shown, so only truly new draws animate in
let prevBoardSnapshot = null; // locId -> owner idx|null, so only the just-taken site flashes
const stageBanner = {lastRound: 0}; // tracks which round's banner has already been shown

function wsSend(msg){
  if(online.ws && online.ws.readyState===1) online.ws.send(JSON.stringify(msg));
}
function wsUrl(){
  const proto = location.protocol==='https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

/* >>> THE FOUR MODE CARDS WERE UNREACHABLE BY KEYBOARD. They are bare <div>s
      with a click handler and no tabindex, no role and no accessible name, and
      #gameMode - the only form control behind them - is `class="hidden"`, so a
      keyboard player had NO way to choose a game mode at all: the measured tab
      order went #botSpeed -> #p1name -> ... -> #startBtn, and Start Game
      silently used whatever mode was default. One of four decisions the setup
      screen exists to ask, unreachable, and invisible: the "Selected" flag
      said Local while nothing said it was a choice.

      index.html is not this file's to edit, so the group is upgraded from here
      instead. The structural change that would make this markup is reported in
      the handover: <div class="mode-cards" role="radiogroup"
      aria-labelledby="..."> with each card a real radio.

      Standard radiogroup behaviour, which is NOT what four focusable divs with
      a click handler give you:
        * ONE stop for the whole group (roving tabindex), so Tab enters and
          leaves the group in one press instead of parking on four cards;
        * Arrow keys MOVE and SELECT together - a radiogroup is not a set of
          independent buttons, so arrowing to a card is choosing it;
        * Enter/Space activate the focused card;
        * aria-checked carries which one is chosen, so it is announced rather
          than only drawn. */
function syncModeCardsA11y(){
  const group = document.getElementById('modeCards');
  const select = document.getElementById('gameMode');
  if(!group || !select) return;
  const mode = select.value;
  if(!group.hasAttribute('aria-label')) group.setAttribute('aria-label', 'How will you play?');
  group.setAttribute('role', 'radiogroup');
  const cards = group.querySelectorAll('.mode-card');
  cards.forEach(card=>{
    const on = (card.dataset.mode === mode);
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', on ? 'true' : 'false');
    /* Roving tabindex: exactly one card is a tab stop, and it is the SELECTED
       one - so Tab reaches the group's current answer, and arrowing away from
       it leaves a stop behind at the new answer. */
    card.tabIndex = on ? 0 : -1;
  });
}

function updateModeUI(){
  const mode = document.getElementById('gameMode').value;
  document.querySelectorAll('.mode-card').forEach(c=> c.classList.toggle('selected', c.dataset.mode===mode));
  syncModeCardsA11y();
  document.getElementById('onlinePanel').classList.toggle('hidden', mode!=='host' && mode!=='join');
  document.getElementById('hostPanel').classList.toggle('hidden', mode!=='host');
  document.getElementById('joinPanel').classList.toggle('hidden', mode!=='join');
  document.getElementById('demoPanel').classList.toggle('hidden', mode!=='demo');
  document.getElementById('setupMain').classList.toggle('hidden', mode==='join');
  const p1type = document.getElementById('p1type');
  const p2type = document.getElementById('p2type');
  if(mode==='host'){
    p2type.value='human'; p2type.disabled=true; p1type.disabled=false;
    document.getElementById('startBtn').disabled = !online.guestReady;
  } else if(mode==='demo'){
    p1type.value='bot'; p2type.value='bot'; p1type.disabled=true; p2type.disabled=true;
    document.getElementById('startBtn').disabled=false;
  } else {
    p1type.disabled=false; p2type.disabled=false;
    document.getElementById('startBtn').disabled=false;
  }
}

function handleHostSocketMessage(msg){
  if(msg.type==='hosted'){
    online.roomCode = msg.code;
    document.getElementById('hostStatus').textContent = `Room code: ${msg.code} — share this with your friend. Waiting for them to connect…`;
  } else if(msg.type==='guestJoined'){
    online.guestReady = true;
    document.getElementById('hostStatus').textContent = `Friend connected! Click Start Game.`;
    document.getElementById('startBtn').disabled = false;
  } else if(msg.type==='peerLeft'){
    online.guestReady = false;
    if(!document.getElementById('setup').classList.contains('hidden')){
      document.getElementById('hostStatus').textContent = `Your friend disconnected.`;
      document.getElementById('startBtn').disabled = true;
      showNotice('Your friend disconnected. Share a new room code to keep playing.', {id:'odNoticePeer'});
    } else log(`<b>Your friend disconnected.</b>`);
  } else if(msg.type==='action'){
    handleHostIncomingAction(msg);
  }
}

/* ======================================================================
   THE AUTHORITATIVE BOUNDARY.

   Everything below runs on whatever arrived over the WebSocket, and server.js
   is a dumb relay that forwards a guest's message VERBATIM. So the payload
   is untrusted input, and this function is the only place it is allowed to
   become game state. Each branch is held to the SAME standard humanPick()
   holds a local click to - not a looser one.

   >>> THE BUG THIS BLOCK IS A FIX FOR (D2). The pick branch validated the
   >>> PHASE and that the site was EMPTY, and nothing else. It never checked
   >>> advancedUnlocked() or canAffordExtra() - the two guards humanPick
   >>> applies - so a guest sitting on 0 Credits, 0 Ore and 0 Troops could take
   >>> every Advanced tier over the wire, INCLUDING in Round 1 where Advanced
   >>> does not exist yet. Measured 20/20 unaffordable Advanced picks accepted
   >>> that the local UI rejects outright. It also passed msg.tier straight
   >>> into applyLocationEffect(), so any unvalidated string ('SUPREME',
   >>> '<img src=x>') persisted into state.board unfiltered - and state is
   >>> broadcast to the guest and painted with innerHTML.
   >>>
   >>> The guard below is deliberately the humanPick sequence, in the same
   >>> order, resolving the site through the same LOCATIONS.find() /
   >>> OD.Chaos.riftLoc() pair: an unknown locId is rejected here for exactly
   >>> the reason it is rejected locally (it is not on the board).
   ====================================================================== */
function handleHostIncomingAction(msg){
  if(msg.kind==='pick'){
    const idx = currentPicker();
    if(idx!==1 || state.phase!=='draft') return;
    /* Tier whitelist BEFORE anything else touches the payload. Without it an
       arbitrary string reached state.board and, via the site log line, the
       log panel's innerHTML. */
    if(msg.tier!=='basic' && msg.tier!=='advanced') return;
    if(!state.board || state.board[msg.locId]!==null) return;
    /* Same resolution humanPick uses, so the Rift (which is not in LOCATIONS)
       works online and an unknown id does not. */
    const loc = LOCATIONS.find(l=>l.id===msg.locId)
      || (typeof OD !== 'undefined' && OD.Chaos && OD.Chaos.riftLoc ? OD.Chaos.riftLoc(state) : null);
    if(!loc || loc.id!==msg.locId) return;
    /* The two guards that were missing. Identical to humanPick's. */
    if(msg.tier==='advanced' && (!advancedUnlocked() || !canAffordExtra(loc, state.players[1]))) return;
    /* >>> D4: this used to be documented as "the guest's draft pick goes
     >>> through the same CONTESTED-SITE interceptor as humanPick(), so an
     >>> online game can never desync on a contested site". There is no
     >>> contested site any more - Siege was cut, and with it
     >>> OD.Wagers.beforePick (pinned absent by test/skirmish-odds.test.js D2),
     >>> so the call is a no-op guard against a hook that does not exist. It
     >>> is kept, because it costs one property read and is the correct seam
     >>> for any future feature that wants to veto a guest's pick; the comment
     >>> no longer claims a mechanic the player cannot see. */
    if(window.OD && OD.Wagers && OD.Wagers.beforePick && OD.Wagers.beforePick(1, msg.locId, msg.tier)) return;
    applyLocationEffect(1, msg.locId, msg.tier);
    advanceDraftOrSkirmish();
  } else if(msg.kind==='skirmishDecision'){
    /* AUDITED, no hole. Both fields are coerced to strict booleans here
       (msg.force===true), and msg.attack is only ever read as a truthiness
       test by decisionHandler, which can do exactly two things the guest was
       already offered the choice between - attack, or hold back.
       OD.Wagers.onForceDecision re-checks forceAvailable() before honouring
       it. Nothing derived from this message reaches innerHTML. */
    if(pendingGuestDecision){ const cb=pendingGuestDecision; pendingGuestDecision=null; cb(msg.attack===true, msg.force===true); }
    // >>> WAGERS (feature: Betrayal tokens) - force is the guest's answer to
    // >>> the Quiet-Round offer, which has no pendingGuestDecision slot.
    else if(window.OD && OD.Wagers && OD.Wagers.onForceDecision) OD.Wagers.onForceDecision(msg.force===true);
  } else if(msg.kind==='commit'){
    /* AUDITED, ONE REAL GAP - now closed. applyCommit() DID re-derive rather
       than trust: cardId is looked up in the live hand with indexOf() and
       dropped if absent, and troops runs through applyCommitDeclaration() ->
       pinTroops(), which clamps to [0, troopsMax] and forces All In / Ghost
       regardless of the claim. The gaps were at the boundary: msg.cardId,
       msg.wager and msg.betrayal were handed over RAW, and troops was the one
       field whose safety depended on js/feature-wagers.js being present -
       delete that file and pinTroops() does not exist, so the raw number was
       applied straight to player.troops. All four are now normalised here to
       the exact shapes the local UI sends, so the host never depends on a
       downstream check to save it. The wire format is unchanged: the same
       fields with the same names, only validated. */
    if(pendingGuestCommit){
      const cb=pendingGuestCommit; pendingGuestCommit=null;
      const wager = (msg.wager==='allin' || msg.wager==='ghost') ? msg.wager : null;
      const b = (msg.betrayal && typeof msg.betrayal==='object') ? msg.betrayal : null;
      const betrayal = b ? {plus:b.plus===true, reroll:b.reroll===true} : null;
      cb(numOr(msg.troops, 0), (typeof msg.cardId==='string' ? msg.cardId : null),
         {wager, betrayal});
    }
  } else if(msg.kind==='intrigue'){
    /* AUDITED, no hole. playIntrigueCard() looks the id up in the live
       intrigueHand with indexOf() and returns on a miss, and re-checks
       canPlayIntrigue() before charging - so a forged or unaffordable card is
       rejected by the same code the local click goes through. */
    const idx = currentPicker();
    if(idx===1 && state.phase==='draft' && typeof msg.cardId==='string'){ playIntrigueCard(1, msg.cardId); }
  /* >>> D4: `buySite` was Siege's own message kind - the host offering a
     >>> contested site for sale. It is a BRANCH THAT CANNOT RUN: the feature
     >>> that answered it (OD.Wagers.onBuySite) was cut, so nothing sends the
     >>> message and nothing handles it. Left in place deliberately rather than
     >>> deleted, because a wire branch is part of the protocol surface a peer
     /// runs, and removing it would change what an OLD guest's message does
     >>> (silently nothing, instead of a no-op hook call). No copy reaches the
     >>> player: there is no CONTESTED SITE to buy. */
  } else if(msg.kind==='buySite'){
    if(window.OD && OD.Wagers && OD.Wagers.onBuySite) OD.Wagers.onBuySite(msg.accept===true);
  }
}

function handleGuestSocketMessage(msg){
  if(msg.type==='joined'){
    online.enabled = true; online.isHost = false; online.myIndex = 1;
    stageBanner.lastRound = 0;
    delete handRenderCache[0]; delete handRenderCache[1];
    prevBoardSnapshot = null;
    document.getElementById('joinStatus').textContent = `Connected! Waiting for the host to start the game…`;
  } else if(msg.type==='error'){
    document.getElementById('joinStatus').textContent = msg.message;
  } else if(msg.type==='state'){
    state = msg.state;
    document.getElementById('setup').classList.add('hidden');
    if(state.round !== stageBanner.lastRound){
      showRoundBanner(`Round ${state.round}`);
      stageBanner.lastRound = state.round;
    }
    if(state.phase==='ended'){
      document.getElementById('game').classList.add('hidden');
      showEndScreen();
    } else {
      document.getElementById('endScreen').classList.add('hidden');
      document.getElementById('game').classList.remove('hidden');
      renderAll();
    }
  } else if(msg.type==='requestSkirmishDecision'){
    showSkirmishDecisionModal(msg.aggressorName, msg.defenderName, msg.defenderTroops, msg.defenderHandCount,
      // >>> WAGERS: `force` rides the EXISTING decision payload.
      (attack, force)=> wsSend({type:'action', kind:'skirmishDecision', attack, force:!!force}),
      // >>> WAGERS: the FORCE button only appears when a token is actually held.
      msg.forceHtml);
  } else if(msg.type==='requestCommit'){
    showCommitModal(msg.playerName, msg.maxTroops, msg.hand,
      // >>> WAGERS: the stance + token declaration rides the EXISTING commit
      // >>> payload as extra top-level fields (see collectCommit).
      (troops, cardId, extra)=> wsSend(Object.assign({type:'action', kind:'commit', troops, cardId}, extra||{})),
      msg.playerIdx);
  // >>> WAGERS (feature: Siege / Betrayal tokens) - the two host->guest offers.
  } else if(msg.type==='requestBuySite'){
    if(window.OD && OD.Wagers && OD.Wagers.showGuestBuyOffer) OD.Wagers.showGuestBuyOffer(msg);
  } else if(msg.type==='requestForceSkirmish'){
    if(window.OD && OD.Wagers && OD.Wagers.showGuestForceOffer) OD.Wagers.showGuestForceOffer(msg);
  } else if(msg.type==='peerLeft'){
    showNotice('The host disconnected — you are still connected to the room, but no more moves will arrive.', {id:'odNoticePeer', sticky:true});
  }
}

/* ============================ ODDS (G8) ===================================
   The defender commits SECOND and can see exactly what the aggressor
   committed - and the UI was throwing that away. Both sides roll one d6
   and everything else is already fixed at that point, so the defender's
   win probability is not an estimate, it is arithmetic. OD.Rules has
   always been able to compute it; nothing called it.

   The aggressor is genuinely blind (the defender has not committed yet), so
   the honest thing to show them is a RANGE - what happens against a passive
   defender, and what happens if the defender mirrors - not a single number
   that would be a lie told confidently. */

/* The live ladder, read from the feature that OWNS it, with OD.Rules as the
   fallback for a tree where js/feature-wagers.js was deleted. The two agree
   by construction (same three constants), and the feature wins because it
   is what resolveSkirmish actually applies to the totals. */
function furyRung(streak){
  if(typeof OD !== 'undefined' && OD.Wagers && typeof OD.Wagers.FURY === 'function'){
    try{ return OD.Wagers.FURY(streak); }catch(_){ /* fall through */ }
  }
  return (typeof OD !== 'undefined' && OD.Rules && OD.Rules.furyFor)
    ? OD.Rules.furyFor(streak) : {streak:Math.max(0,streak|0), bonus:0, cap:4};
}
function furyRungCap(streak, fever){
  if(typeof OD !== 'undefined' && OD.Wagers && typeof OD.Wagers.furyCap === 'function'){
    try{ return OD.Wagers.furyCap(streak, fever); }catch(_){ /* fall through */ }
  }
  return (typeof OD !== 'undefined' && OD.Rules && OD.Rules.furyCap)
    ? OD.Rules.furyCap(streak, fever) : (fever ? 6 : 4);
}
/* The declaration, restated in machine-readable form on BOTH seats' commit
   modals. `data-stake` is the contract: one attribute, the same three values
   the decision group uses, so a stylesheet, a test or a screen reader can key
   off the declaration without parsing a sentence. The sentence is there for
   everyone else, and it is written from the same constants the engine applies
   rather than from a second copy of the numbers.

   ORDINARY prints nothing at all. It is the default, it is what the panel
   already describes in full (the Fury rungs are two lines above it), and a
   readout that fires on every ordinary fight trains the eye to skip it. */
function stakeReadoutHtml(){
  const s = declaredStakes();
  const p = (state && s.aggressorIdx >= 0) ? state.players[s.aggressorIdx] : null;
  if(!p) return '';
  if(s.stance === STANCE_BLOOD){
    return `<p class="stake-readout" data-stake="blood" style="font-size:12px;margin:0 0 8px">`
      + `${esc(p.name)} declared <b>BLOOD</b> \u2014 cap ${BLOOD_CAP}, at least half their Troops, and the loser keeps their Troops.</p>`;
  }
  if(s.stance === STANCE_HOLD){
    return `<p class="stake-readout" data-stake="hold" style="font-size:12px;margin:0 0 8px">`
      + `${esc(p.name)} declared <b>HOLD BACK</b> \u2014 this round is a declaration, not a fight.</p>`;
  }
  return '';
}

function isFeverRound(){ return !!(state && state.currentEvent==='skirmish_fever'); }

/* ============================== THE STAKES ==============================
   The Influence cap used to be a clamp applied to a fight nobody had a say
   in: the aggressor pressed Attack, the margin came out at 5.03 on average,
   the cap took 4 and ~15% of the entire game's score was generated and thrown
   away (measured: the cap bound in 49.2% of 5.34 fights a game). The STAKES
   turn that clamp into a wager - the aggressor declares, in public, how hard
   they are willing to swing, and the cap becomes the thing they are bidding
   for rather than the thing that quietly caps them.

     HOLD BACK   no Skirmish; the aggressor banks +1 Influence and the round
                 is not "quiet" for Pressure purposes (see holdBackRound).
     ORDINARY    today's rules, unchanged: the winner's Fury rung ceiling.
     BLOOD       the ceiling is 6 whatever the ladder says, the aggressor must
                 commit at least half their Troop pool, and the LOSER of the
                 fight keeps the Troops they committed.

   EVERY READER GOES THROUGH declaredStakes(). `state.stakes` is reassigned
   wholesale by beginRound and by the decision itself, and it rides the JSON
   relay to the online guest, so any read has to survive three things: an
   older snapshot from the wire (`undefined`), a hand-edited payload
   (`'blood'` arriving from nowhere), and the round boundary. Hence `??`
   everywhere and a whitelist that folds anything unrecognised to ORDINARY -
   the inert choice is the one that cannot change a game's score.

   The three STANCE_* names and the two numbers (BLOOD_CAP,
   HOLD_BACK_INFLUENCE) are declared at the TOP of this file, beside
   OBJECTIVE_BONUS, because RULES_HTML interpolates them from a top-level
   template literal. Redeclaring them here would be a second `const` of the same
   name in the same scope, which is a SyntaxError the whole file cannot survive. */
function normaliseStance(v){
  return (v === STANCE_HOLD || v === STANCE_BLOOD) ? v : STANCE_ORDINARY;
}
/* `state.stakes` is a plain object on the JSON relay; `?? {}` covers a guest
   whose last snapshot predates the field entirely, and the integer coercion
   covers `null`/`""` arriving as a seat. */
function declaredStakes(){
  const s = (state && state.stakes) ?? {};
  return {aggressorIdx: (s.aggressorIdx | 0), stance: normaliseStance(s.stance)};
}
function declaredStance(){ return declaredStakes().stance; }
/* The floor BLOOD puts under the aggressor's commitment. `ceil(pool/2)`: half
   the pool, rounded UP, because "at least half" of 1 Troop has to be 1 or the
   declaration would be unpayable. A pool of 0 needs 0 - there is nothing to
   commit, and the rule must not invent a Troop. */
function bloodMinCommit(pool){
  const p = Math.max(0, pool|0);
  return (p <= 0) ? 0 : Math.ceil(p / 2);
}
/* The one place the Influence ceiling for a fight is decided. `feverCap` is
   the event's 6 (0 when it is not in play) and `bloodCap` is BLOOD_CAP under a
   BLOOD declaration (0 otherwise), so ORDINARY behaves exactly as it did and
   a tie is still worth nothing. */
function skirmishCap(winnerCap, feverCap, bloodCap){
  return Math.max(winnerCap|0, feverCap|0, bloodCap|0);
}
/* BLOOD's extra ceiling, for the screens that print the cap BEFORE the dice. */
function stanceCeiling(winnerCap, fever){
  return skirmishCap(winnerCap, fever ? BLOOD_CAP : 0, declaredStance() === STANCE_BLOOD ? BLOOD_CAP : 0);
}

/* >>> THE SINGLE CEILING, and the reason B2 could not be fixed by editing one
   >>> number. Four places print the Influence ceiling for the fight on screen -
   >>> the two odds panels, the "At stake" paragraph and (per seat) the stakes
   >>> panel - and each used to derive it its own way. Any two of them could
   >>> disagree, which is exactly what happened under BLOOD: cap 4 on the
   >>> projection, cap 6 in the apology printed under it.
   >>> So they all read THIS, fed the streaks that are in play. `winStreaks` is a
   >>> list rather than two arguments because the odds panel has two PROJECTION
   >>> specs and the "At stake" paragraph has two seats, and both mean the same
   >>> thing: the ceiling is the higher of the two rungs, lifted by Fever, lifted
   >>> again by a BLOOD declaration. */
function fightCeiling(winStreaks, fever){
  let top = 0;
  (winStreaks || []).forEach(s=>{ top = Math.max(top, furyRungCap(s, fever)); });
  return stanceCeiling(top, fever);
}

function gamblerLeader(p){ const l = getLeader(p); return !!(l && l.id==='gambler'); }

/* A projectSide() spec for one side, built from everything that is PUBLIC
   about them: their Troops (once committed), their streak, the Garrison
   bonus their HUD badge is already advertising, and a declared token. The
   card is passed only when the viewer is allowed to know it - which, in
   this game, is nobody until the dice are rolling. */
function projectionSpec(playerIdx, troops, cardId, isAggressor, extraBonus){
  const p = state.players[playerIdx];
  return {
    troops: Math.max(0, troops|0),
    cardId: cardId || null,
    winStreak: p.winStreak,
    isAggressor: !!isAggressor,
    credits: p.credits,
    ore: p.ore,
    isGambler: gamblerLeader(p),
    bonus: (extraBonus|0),
  };
}
function garrisonBonusOf(playerIdx){
  const p = state.players[playerIdx];
  return (p.isAggressor && p.aggressorBonus) ? 1 : 0;
}
function tokenBonusOf(commit){
  return (commit && commit.betrayal && commit.betrayal.plus) ? 1 : 0;
}

/* The one call into OD.Rules, and the place the DECLARED CAP has to enter.

   >>> B2. This used to be `projectSkirmish(mine, theirs, {fever})` and nothing
   >>> else, so every projection on the commit screen was priced at the Fury
   >>> ladder's cap and then corrected by a sentence printed NEXT to it. Under a
   >>> BLOOD declaration that produced one panel quoting four different numbers
   >>> for one ceiling - "Fury 2 (+1, cap 4)", "the ceiling is 6 for this fight",
   >>> "Influence cap this Skirmish: 4", "capped at 6" - and, worse, an
   >>> "Expected Influence" computed as if the declaration had not been made
   >>> (4.0 where the true capped EV was ~5.9). That number is the one that tells
   >>> a player whether their declaration paid.
   >>>
   >>> `projectSkirmish` has accepted `opts.cap` since it was written
   >>> (js/rules.js:516), and `stanceCeiling()` above has always known the
   >>> declaration. So the fix is to hand one to the other rather than to argue
   >>> with the answer: the cap is computed ONCE, from the same helper the
   >>> resolution pays under, and passed in.
   >>>
   >>> `myCap` / `theirCap` are re-stamped with it too. They are what the panel
   >>> prints in "Fury 2 (+1, cap N)", and leaving them on the raw ladder rung is
   >>> how "cap 4" survived on a fight that pays 6. For ORDINARY this is a
   >>> no-op by construction: `stanceCeiling(max(rungA, rungB))` with no BLOOD and
   >>> no Fever IS `max(furyCap(a), furyCap(b))`, which is the default
   >>> `projectSkirmish` already computed - so nothing about the ordinary game
   >>> moves, and no value anywhere is touched.

   `cap` is optional so a caller with no seat, no declaration or a tree without
   js/rules.js degrades to the previous behaviour rather than to a throw. */
function runOdds(mineSpec, theirsSpec, fever, cap){
  if(typeof OD === 'undefined' || !OD.Rules || typeof OD.Rules.projectSkirmish !== 'function') return null;
  try{
    const mine = mineSpec || {};
    const theirs = theirsSpec || {};
    const ceiling = (typeof cap === 'number' && isFinite(cap))
      ? Math.max(0, Math.round(cap))
      : fightCeiling([mine.winStreak, theirs.winStreak], fever);
    const p = OD.Rules.projectSkirmish(mine, theirs, {fever: !!fever, cap: ceiling});
    if(!p) return p;
    p.myCap = ceiling; p.theirCap = ceiling;
    return p;
  }
  catch(_){ return null; }
}

function pct(n){ return `${Math.round(n*10)/10}%`; }

/* A 0% outcome still gets a segment - the bar must always read as three
   outcomes, and its fill is a channel in its own right - but a ~1% flex
   segment has no room for "LOSE 0%". The label then spilled out of its own box
   and collided with the neighbour's ("IE 0%OSE 0"). Below ~7% the segment is
   marked `.is-tiny`, which the stylesheet renders as a bare colour chip: the
   outcome is still identified by position and fill, and the exact figures are
   already stated in the projection line beneath the bar. */
function oddsSeg(label, value, bg, extraClass){
  const tiny = value < 0.07 ? ' is-tiny' : '';
  return `<span class="odds-seg${tiny}${extraClass ? ' ' + extraClass : ''}"`
    + ` style="flex:${Math.max(value,0.01)};background:${bg};color:#fff;border-radius:3px;padding:2px 4px;text-align:center"`
    + ` aria-label="${label} ${pct(value)}"${tiny ? ' title="' + label + ' ' + pct(value) + '"' : ''}>`
    + (tiny ? '' : `${label} ${pct(value)}`)
    + `</span>`;
}

function oddsBar(p){
  return `<div class="odds-bar" style="display:flex;gap:6px;margin:6px 0;font-size:12px">`
    + oddsSeg('WIN', p.winPct, 'var(--accent-cool,#3d6b7a)')
    + oddsSeg('TIE', p.tiePct, 'var(--accent-mute,#7a7568)')
    + oddsSeg('LOSE', p.losePct, 'var(--accent-blood,#8c1d18)')
    + `</div>`;
}

function thresholdLine(p){
  if(typeof OD === 'undefined' || !OD.Rules || !OD.Rules.thresholdSentence) return '';
  const t = p.threshold;
  const good = (t > 0 && t < 7);
  return `<div style="font-size:13px;margin-top:2px">`
    + `<b style="color:${good?'var(--accent-cool-ink,#2c4d58)':'var(--muted)'}">${OD.Rules.thresholdSentence(t)}</b>`
    + (good ? ` <span style="color:var(--muted);font-size:12px">(${6 - t + 1} of 6 faces win outright)</span>` : '')
    + `</div>`;
}

function projectionLine(label, side, extra){
  return `<div style="font-size:12px;color:var(--muted)">${label}: `
    + `expected <b style="color:var(--ink)">${Math.round(side.mean*10)/10}</b>`
    + ` <span style="font-size:11px">(${side.min}&ndash;${side.max})</span>`
    + (extra || '') + `</div>`;
}

/* The Defender's readout. Their own commit and the aggressor's Troops are
   both known, so the only unknown is the aggressor's card - which is stated
   rather than guessed, and the bar is labelled as "card hidden" so nobody
   reads it as a guarantee. */
function defenderOddsHtml(defIdx, troops, cardId, fever){
  const ctx = skirmishCtx;
  if(!ctx || !ctx.aggCommit) return '<div style="font-size:12px;color:var(--muted)">Waiting on the aggressor&rsquo;s commit&hellip;</div>';
  const aggIdx = ctx.aggressorIdx;
  const theirs = projectionSpec(aggIdx, ctx.aggCommit.troops, null, true,
    garrisonBonusOf(aggIdx) + tokenBonusOf(ctx.aggCommit));
  const mine = projectionSpec(defIdx, troops, cardId, false, tokenBonusOf(ctx.defCommit));
  const p = runOdds(mine, theirs, fever);
  if(!p) return '';
  return oddsBar(p)
    + projectionLine('Your projection', p.mine, furyNote(p.mine.winStreak, p.myCap))
    + projectionLine(`${esc(state.players[aggIdx].name)} (committed ${ctx.aggCommit.troops})`, p.theirs,
        ` &mdash; their card is <b>hidden</b>, so this is their Troops alone`)
    + thresholdLine(p)
    + `<div style="font-size:12px;color:var(--muted);margin-top:4px">Expected Influence if you win: <b>${Math.round(p.ev*10)/10}</b> (capped at ${p.cap}).</div>`;
}

/* The Aggressor's honest range. Two named reference defenders, because "you
   will win 62% of the time" is not a number anyone can act on - "against a
   defender who holds everything back" and "against a defender who mirrors
   you" are both decisions. */
function aggressorOddsHtml(aggIdx, troops, cardId, fever){
  const defIdx = 1 - aggIdx;
  const mine = projectionSpec(aggIdx, troops, cardId, true, garrisonBonusOf(aggIdx));
  const passive = projectionSpec(defIdx, 0, null, false, 0);
  /* >>> B6. The second reference point used to be priced at `troops` - the
     >>> AGGRESSOR's own commitment - and labelled "if <them> mirrors you
     >>> (8 Troops)". So with 5 Troops in hand the panel described a fight the
     >>> defender cannot take part in: they cannot commit 8, and the bar was
     >>> drawn for a scenario outside the rules. It is now bounded by their real
     >>> pool, which the decision modal has already told this seat anyway
     >>> ("Defender has N Troops"), and the label says which of the two numbers
     >>> it used. When they can match, nothing changes. */
  const defPool = Math.max(0, state.players[defIdx].troops|0);
  const want = Math.max(0, troops|0);
  const mirrorTroops = Math.min(want, defPool);
  const mirror  = projectionSpec(defIdx, mirrorTroops, null, false, 0);
  const a = runOdds(mine, passive, fever);
  const b = runOdds(mine, mirror, fever);
  if(!a || !b) return '';
  const mirrorHow = (mirrorTroops === want)
    ? `matches your ${want} Troop${want === 1 ? '' : 's'}`
    : `matches you as far as they can &mdash; all <b>${mirrorTroops}</b> Troop${mirrorTroops === 1 ? '' : 's'} they hold, not your ${want}`;
  return `<div style="font-size:12px;color:var(--muted);margin-bottom:2px">`
      + `You commit first, so you cannot know this yet. Two honest reference points:`
    + `</div>`
    + `<div style="margin-top:6px"><b style="font-size:12px">vs a passive defender (they hold all ${defPool} Troops back)</b></div>`
    + oddsBar(a) + thresholdLine(a)
    + `<div style="margin-top:8px"><b style="font-size:12px">if ${esc(state.players[defIdx].name)} ${mirrorHow}, no card</b></div>`
    + oddsBar(b) + thresholdLine(b)
    + projectionLine('Your projection', a.mine, furyNote(a.mine.winStreak, a.myCap))
    + `<div style="font-size:12px;color:var(--muted);margin-top:4px">Influence cap this Skirmish: <b>${a.cap}</b>. Expected Influence vs a passive defender: <b>${Math.round(a.ev*10)/10}</b>.</div>`;
}

function furyNote(streak, cap){
  const f = furyRung(streak);
  return ` &mdash; Fury ${f.streak} (+${f.bonus}, cap ${cap})`;
}
/* >>> B4: catchingUpLine() IS GONE. It printed "CATCHING UP: you are on a
   >>> 3-win streak, so the other side adds +2" off `p.catchingUp`, a key
   >>> `projectSkirmish` stopped returning when the valve was deleted (two tests
   >>> pin that: `!('catchingUp' in p)`). So the guard below was what made it
   >>> safe - and unreachable code that names a mechanic the game does not have
   >>> is exactly the defect D6 was written to remove from the commit panel. The
   >>> same reasoning retires the matching block in resolveSkirmish(): it reads
   >>> `OD.Rules.catchingUp`, which no longer exists, so `CU` is always null and
   >>> the totals it would have adjusted are never touched. That one is left in
   >>> place rather than deleted, because it sits in the scoring path and an inert
   >>> branch there is worth less than a reviewer having to re-derive it. */

/* Card fizzle warnings. Both are discovered LATE in the live game - the
   player finds out at cardModifier() that their Overrun was worth +0
   because they had no Ore, after they have already committed everything
   else on the belief it was +3. This is the single most expensive piece of
   hidden information in the commit step, so it is stated up front. */
function fizzleWarning(playerIdx, cardId){
  if(!cardId || !CARD_DEFS[cardId]) return '';
  const p = state.players[playerIdx];
  let msg = '';
  if(cardId==='overrun' && p.ore < 1){
    msg = `You have ${p.ore} Ore &mdash; <b>Overrun will resolve as +0</b>, not +3.`;
  } else if(cardId==='onslaught' && p.credits < 2){
    msg = `You have ${p.credits} Credits &mdash; <b>Onslaught will resolve as +1</b>, not +4.`;
  }
  if(!msg) return '';
  return `<div class="odds-fizzle" style="margin-top:6px;padding:6px 8px;border:1px solid #b5502e;border-radius:6px;background:rgba(181,80,46,.10);font-size:12px">`
    + `<b style="color:#b5502e">FIZZLE WARNING.</b> ${msg}</div>`;
}

/* What a commit actually risks, in the two sentences a player actually
   wants. The token declaration is read back through the feature's OWN
   commitDeclaration() rather than re-derived here, so a rebalance of the token
   cannot leave this preview quoting a stale number.

   >>> D4: THIS USED TO CARRY A STANCE PARAGRAPH. `const stance = (decl &&
   >>> decl.wager) ? decl.wager : 'normal'` and two sentences behind it -
   >>> "ALL IN declared: you commit every Troop, and a win pays +3 Influence"
   >>> and the GHOST equivalent - were unreachable from the moment the wagers
   >>> were cut, because applyCommitDeclaration() no longer returns a `wager`
   >>> at all (test/skirmish-odds.test.js D2 pins that it is `undefined`). The
   >>> branch was not harmless: it named two mechanics that are not in the game
   >>> from the one panel whose whole purpose is to be trustworthy, and it
   >>> would have woken up silently the day anyone re-added a stance. The
   >>> numbers came from `typeof OD.Wagers.ALL_IN_WIN !== 'undefined' ? ... : 3`
   >>> fallbacks, so it would have quoted numbers this file had invented. */
function consequenceHtml(playerIdx, troops, cardId){
  const p = state.players[playerIdx];
  const fever = isFeverRound();
  const cap = fightCeiling([p.winStreak, state.players[1-playerIdx].winStreak], fever);
  const decl = (typeof OD !== 'undefined' && OD.Wagers && typeof OD.Wagers.commitDeclaration === 'function')
    ? OD.Wagers.commitDeclaration() : null;
  const token = (decl && decl.betrayal && decl.betrayal.plus) ? ' A <b>+1 token</b> is declared and is already in the projection above.' : '';
  const reroll = (decl && decl.betrayal && decl.betrayal.reroll) ? ' A <b>RE-ROLL</b> is declared: your die is cast twice, second cast stands.' : '';
  /* >>> BLOOD CHANGES BOTH HALVES OF THIS SENTENCE, so it is written from the
     >>> declaration rather than left to the paragraph above it: the ceiling is
     >>> already `cap` (stanceCeiling), and the loser now KEEPS their committed
     >>> Troops - which is the only rule in the game that turns a lost fight
     >>> into a better round than an ordinary one, and it has to be on this
     >>> panel or the defender is being asked to price a fight whose downside
     >>> the panel does not mention. */
  const blood = declaredStance() === STANCE_BLOOD;
  const loseClause = blood
    ? `Lose: you keep the <b>${troops}</b> Troop${troops===1?'':'s'} you commit \u2014 under BLOOD the loser keeps them \u2014 and no Influence moves. `
    : `Lose: you lose the <b>${troops}</b> Troop${troops===1?'':'s'} you commit${troops===0?' (none)':''} and no Influence moves. `;
  const tieClause = blood
    ? `Tie: no Influence either way, and \u2014 again, under BLOOD \u2014 both sides keep what they committed.`
    : `Tie: no Influence either way, but both sides still lose their committed Troops.`;
  return `<div class="odds-consequence" style="margin-top:8px;font-size:12px;line-height:1.5">`
    + `<b>At stake.</b> Win: +the margin in Influence, capped at <b>${cap}</b>${isFeverRound()?' (Skirmish Fever)':''}${blood?' (BLOOD)':''}, and they ${blood?'keep':'lose'} their committed Troops. `
    + loseClause
    + tieClause
    + token + reroll
    + `</div>`;
}

function commitOddsHtml(playerIdx, troops, cardId){
  if(!state || playerIdx < 0 || !state.players[playerIdx]) return '';
  const fever = isFeverRound();
  const isDefender = !!(skirmishCtx && playerIdx===skirmishCtx.defenderIdx);
  return `<div class="odds-panel" id="oddsPanel" data-role="${isDefender?'defender':'aggressor'}">`
    + `<div class="odds-head" style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);font-weight:700">`
    + (isDefender ? 'Your odds &mdash; you commit second' : 'Your odds &mdash; you commit first')
    + `</div>`
    + (isDefender ? defenderOddsHtml(playerIdx, troops, cardId, fever)
                  : aggressorOddsHtml(playerIdx, troops, cardId, fever))
    + fizzleWarning(playerIdx, cardId)
    + consequenceHtml(playerIdx, troops, cardId)
    + `</div>`;
}

/* `aggressorName` / `defenderName` / the counts arrive over the WebSocket
   on the guest (handleGuestSocketMessage reads them straight off
   `requestSkirmishDecision`), so this modal body IS a trust boundary and both
   names are escaped here. The counts are coerced to finite integers rather
   than escaped: they are numbers, and escaping a number that is not one yet
   would print the attacker's string instead of rejecting it.

   `aggressorTroops` is the DECLARING seat's own pool, and it is the seventh
   argument rather than a read of `state` because on the guest this modal is
   opened from a socket message: the host is the only side that knows the
   aggressor's Troops at that moment, so the guest has to be told. Without it
   the guest would render BLOOD for a pool it cannot see and the host would
   then refuse the declaration - a button that lies across the wire. It is
   coerced, and a payload that omits it degrades to 0, which hides BLOOD. */
function showSkirmishDecisionModal(aggressorName, defenderName, defenderTroops, defenderHandCount, onDecision, forceHtml, aggressorTroops){
  const troops = numOr(defenderTroops, 0);
  const handCount = numOr(defenderHandCount, 0);
  /* A fresh declaration screen has no declaration yet, so #srLive must not
     open on last round's. Same rule as srWagerSeen's reset in the commit modal,
     for the same reason: the first announcement of a round has to be a CHANGE
     or there is nothing to hear. */
  srStanceSeen = '';
  showModal("Skirmish Decision", `
    <p>${esc(aggressorName)}, you hold the Garrison. Declare how you fight ${esc(defenderName)}?</p>
    <p style="color:var(--muted);font-size:13px">Defender has ${troops} Troops, ${handCount} cards in hand.</p>
    ${skirmishStakesHtml(aggressorTroops)}
    ${forceHtml || ''}
    <div class="stake-choices" role="radiogroup" aria-label="Your declaration" id="stakeChoices">
      <button type="button" class="stake-btn stake-hold" id="skipAttack" role="radio" aria-checked="false" tabindex="-1" data-stake="hold">Hold Back</button>
      <button type="button" class="stake-btn stake-ordinary" id="doAttack" role="radio" aria-checked="true" tabindex="0" data-stake="ordinary">Attack</button>
      <button type="button" class="stake-btn stake-blood" id="doBlood" role="radio" aria-checked="false" tabindex="-1" data-stake="blood">Blood</button>
    </div>
    <div id="meltdownHoldNote" class="hidden" style="margin-top:10px;padding:8px 10px;border:1px solid #8c1d18;border-radius:6px;background:rgba(140,29,24,.10);font-size:12px;color:#8c1d18">
      <b>MELTDOWN &mdash; no holding back.</b> In the last round the Garrison is an obligation, not an option. Hold Back is off; declare <b>Attack</b> or <b>Blood</b> to fight.
    </div>
  `);
  /* >>> STAKES: the three declarations, as ONE radiogroup with a roving
     tabindex (the same pattern the Rules tabs and the mode cards already use in
     this file). Selection follows focus, so focus and `aria-checked` can never
     disagree: there is no state in which the keyboard is parked on BLOOD while
     the group still reports ORDINARY.

     >>> The `id`s are load-bearing and are NOT decoration. #skipAttack and
     >>> #doAttack are the names the balance harness drives a scripted human
     >>> through (test/balance.sim.js serviceHumanDecision), and #doBlood is the
     >>> third member of that same set: HOLD BACK keeps the old id so "hold" and
     >>> ORDINARY keep working for anything that already knows them, and BLOOD
     >>> is reachable by the same lookup rather than by a query the harness
     >>> would have to learn. Removing the pair would silently turn every
     >>> human-led balance run into a game where nobody ever fights.
     >>> #doBlood is deliberately a plain id with no old counterpart to keep. */
  const stakeBtns = ()=> Array.prototype.slice.call(
    document.querySelectorAll('#stakeChoices .stake-btn')).filter(b=>!b.disabled);
  const selectStance = (btn)=>{
    if(!btn || btn.disabled) return;
    stakeBtns().concat([btn]).forEach(b=>{
      const on = (b === btn);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
  };
  /* >>> B3. The keyboard half of a radiogroup: Enter and Space CONFIRM, they do
     >>> not merely re-select. This handler used to `preventDefault()` and then
     >>> call `selectStance(btn)` on the button that was already selected - which
     >>> is the standard "arrow to choose, Space to confirm" pattern - and because
     >>> it swallowed the default it also killed the click the browser would have
     >>> synthesised for Space on a <button>. So a keyboard-only player could Tab
     >>> to the group, walk it with the arrows, watch `aria-checked` follow
     >>> correctly, and then be STUCK: nothing else in the dialog is focusable,
     >>> and no key did anything. The only escape was the mouse.
     >>>
     >>> So activation goes through `decideOnce` - the SAME latched path the click
     >>> uses, with the same three-way stance it derives from `data-stake`. The
     >>> latch is not weakened by this: `decideOnce` still refuses a second
     >>> declaration for the round (`decided`, `state.roundRec.decision` and the
     >>> `state.stakes` aggressor seat), so a key repeat, an Enter that lands
     >>> while the dialog is closing, or a click arriving after the key all
     >>> resolve to one declaration. That is the property the previous pass fixed
     >>> the double-click for, and it is the reason this routes through the
     >>> function rather than calling `onDecision` directly.
     >>>
     >>> MELTDOWN gets the same refusal the click gets: a disabled HOLD BACK is
     >>> not in `stakeBtns()` and so cannot be reached by an arrow either, but
     >>> the guard is repeated here because `activateStance` is also reachable by
     >>> a stale focus that survived the disable. */
  const activateStance = (btn)=>{
    if(!btn || btn.disabled) return false;
    const s = btn.dataset ? btn.dataset.stake : '';
    if(s === STANCE_HOLD){
      if(state && state.meltdown) return false;
      decideOnce(STANCE_HOLD, false);
      return true;
    }
    if(s === STANCE_BLOOD){ decideOnce(STANCE_BLOOD, false); return true; }
    decideOnce(STANCE_ORDINARY, false);
    return true;
  };
  const stakeGroup = document.getElementById('stakeChoices');
  if(stakeGroup){
    stakeGroup.addEventListener('keydown', (e)=>{
      if(e.ctrlKey || e.metaKey || e.altKey) return;
      const btn = (e.target && e.target.closest) ? e.target.closest('.stake-btn') : null;
      if(!btn) return;
      const list = stakeBtns();
      const i = list.indexOf(btn);
      if(i < 0) return;
      let next = -1;
      let confirming = false;
      const key = e.key;
      if(key==='ArrowRight' || key==='ArrowDown') next = (i + 1) % list.length;
      else if(key==='ArrowLeft'  || key==='ArrowUp')   next = (i - 1 + list.length) % list.length;
      else if(key==='Home') next = 0;
      else if(key==='End')  next = list.length - 1;
      else if(key==='Enter' || key===' ' || key==='Spacebar'){ next = i; confirming = true; }
      else return;
      if(next < 0 || !list[next]) return;
      /* Space would scroll the dialog; Enter would submit the nearest form. */
      e.preventDefault();
      e.stopPropagation();
      selectStance(list[next]);
      if(typeof list[next].focus === 'function') list[next].focus();
      /* And now the declaration actually happens. AFTER the selection and the
         focus move, so what the panel reads back is the stance that was chosen. */
      if(confirming) activateStance(list[next]);
    });
  }
  /* >>> CHAOS (feature-chaos.js) - MELTDOWN makes holding the Garrison an
     OBLIGATION. promptAggressorDecision() already ignores a hold-back
     (`noRetreat`), which means the button used to render, look clickable,
     accept the click, and then do nothing but log a complaint. A control
     that silently refuses is worse than no control: this disables it and
     says why, in the same words the log will use.

     >>> AND IT STILL DOES, in a group. Disabling one member is not enough on
     >>> its own: the roving tabindex and the arrow keys both walk the list, so
     >>> a disabled HOLD BACK left in the list would still be selectable with
     >>> the keyboard and would still be announced as an option. `stakeBtns()`
     >>> filters disabled members out of the movement, and the selection is
     >>> forced onto ORDINARY below so `aria-checked` never names a stance the
     >>> rules will refuse. */
  if(state && state.meltdown){
    const hold = document.getElementById('skipAttack');
    if(hold){
      hold.disabled = true;
      hold.setAttribute('aria-disabled', 'true');
      hold.setAttribute('title', 'Meltdown: holding the Garrison obliges you to attack.');
      /* The button's own text stays "Hold Back": the reason it is off is printed
         once, in #meltdownHoldNote, rather than baked into a label that would
         then have to be un-baked - and the three labels are part of the
         stylesheet's contract, so they do not vary with board state. */
      const atk = document.getElementById('doAttack');
      if(atk) selectStance(atk);
    }
    const note = document.getElementById('meltdownHoldNote');
    if(note) note.classList.remove('hidden');
  }
  /* >>> D4: same double-fire class as the Commit button, on the decision that
     >>> STARTS the Skirmish. `onDecision(true)` runs startSkirmishCommit,
     >>> which re-seeds `skirmishCtx` and starts a commit chain; a second
     >>> invocation re-seeds it again underneath the first, so the aggressor's
     >>> commit is discarded and the defender's modal is asked for a commit
     >>> into a context that no longer matches.

     >>> TWO LATCHES, because `decided` alone has exactly the weakness the
     >>> Commit button's `commitFired` had: it dies with the dialog, and the
     >>> second click of a double-click lands on whatever the first one put in
     >>> its place. `state.roundRec.decision` is the round's own record - one
     >>> Skirmish per round, no exceptions - so it survives the re-render, is a
     >>> plain boolean, and rides the JSON relay to the online guest for free.
     >>> (It is NOT on the round's public contract for anything else: nothing
     >>> reads it but this guard.) `decided` is kept because it is what makes
     >>> the buttons go visibly dead on the first click.

     >>> THIRD LATCH, `state.stakes`. The stakes block below writes the
     >>> declaration the moment the choice is made, and `stakes.stance` is a
     >>> plain string on the JSON relay - so "has a declaration already been
     >>> recorded for this round?" is answerable after the dialog is gone, which
     >>> is precisely the window a double-click lands in. It answers the
     >>> question `decision` cannot: `decision` is a boolean with one value, and
     >>> three buttons now share it, so the guard has to be able to tell WHICH
     >>> declaration won the race. Reading it costs one property and cannot
     >>> reject a legitimate first click, because the dialog opens with the
     >>> round's default (`stance:'ordinary'`, `aggressorIdx:-1`) - a seat index
     >>> of -1 is what says "nobody has declared yet". */
  let decided = false;
  const alreadyDeclared = ()=>{
    const s = declaredStakes();
    return s.aggressorIdx >= 0;
  };
  const decideOnce = (stance, force)=>{
    if(decided) return;
    if(state && state.roundRec && state.roundRec.decision){
      log('The Skirmish decision was already made this round - ignored.');
      return;
    }
    if(alreadyDeclared()){
      log('The Skirmish declaration was already made this round - ignored.');
      return;
    }
    decided = true;
    if(state && state.roundRec) state.roundRec.decision = true;
    /* Every member of the group dies together, not just the one clicked: a
       radiogroup with two live members is a group whose second click can still
       change the answer. */
    ['skipAttack','doAttack','doBlood'].forEach(id=>{
      const b = document.getElementById(id);
      if(b) b.disabled = true;
    });
    if(forceBtn) forceBtn.disabled = true;
    hideModal(); onDecision(stance, force);
  };
  const holdBtn = document.getElementById('skipAttack');
  const atkBtn  = document.getElementById('doAttack');
  const bloodBtn = document.getElementById('doBlood');
  if(holdBtn) holdBtn.onclick = ()=>{
    if(state && state.meltdown){ return; }
    decideOnce(STANCE_HOLD, false);
  };
  if(atkBtn) atkBtn.onclick = ()=> decideOnce(STANCE_ORDINARY, false);
  /* BLOOD is only offered when it can be paid. The rule is "at least half your
     Troop pool", so a player holding zero Troops cannot declare it - and a
     declaration that silently did nothing would be the same lying control the
     MELTDOWN note exists to prevent. The button is removed rather than
     disabled so the group is still two options wide. */
  if(bloodBtn){
    if((aggressorTroops|0) >= 1){
      bloodBtn.onclick = ()=> decideOnce(STANCE_BLOOD, false);
    } else {
      if(bloodBtn.parentNode && typeof bloodBtn.parentNode.removeChild === 'function'){
        bloodBtn.parentNode.removeChild(bloodBtn);
      }
      bloodBtn.disabled = true;
    }
  }
  // >>> WAGERS (feature: Betrayal tokens) - the FORCE button is injected by the
  // >>> feature and reports a token spend through the SAME decision handler.
  const forceBtn = document.getElementById('wagersForceAttack');
  if(forceBtn && forceBtn.dataset.token==='1'){
    forceBtn.onclick = ()=> decideOnce(STANCE_ORDINARY, true);
  }
}

/* "What is at stake" for the decision, before any Troops are committed. The
   Influence cap is the piece that was completely invisible and is
   decision-changing: a player on a 3-win streak is capped at 5 and a player on
   4+ at 6, and Skirmish Fever lifts every rung to 6.

   >>> IT NOW DESCRIBES THE THREE DECLARATIONS, because the cap stopped being
   >>> a fact about the winner and became the thing the aggressor is bidding
   >>> for. The panel is the only place the player can read all three side by
   >>> side before choosing, and a choice between three options that are only
   >>> described one at a time is a guess. The numbers here are read from the
   >>> same helpers the resolution uses (stanceCeiling / bloodMinCommit), never
   >>> retyped, so the panel cannot quote a cap the engine would not honour. */
function skirmishStakesHtml(ownTroops){
  if(!state) return '';
  const fever = isFeverRound();
  const [a, b] = state.players;
  const rows = [a, b].map(p=>{
    const f = furyRung(p.winStreak);
    const cap = stanceCeiling(furyRungCap(f.streak, fever), fever);
    return `<div style="font-size:12px">${esc(p.name)}: <b>Fury ${f.streak}</b> `
      + `<span style="color:var(--muted)">(+${f.bonus} to their total, Influence cap ${cap})</span></div>`;
  }).join('');
  const dread = (state.dread|0);
  const pool = Math.max(0, numOr(ownTroops, 0));
  const half = bloodMinCommit(pool);
  return `<div class="odds-panel" id="stakesPanel" style="margin:10px 0;padding:8px 10px;border:1px solid rgba(140,120,90,.4);border-radius:6px">`
    + `<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);font-weight:700">What is at stake</div>`
    + rows
    + `<div style="font-size:12px;margin-top:4px">${fever
        ? '<b style="color:var(--accent-gold-ink,#8a5a10)">SKIRMISH FEVER is in play</b> &mdash; every Influence ceiling is lifted to <b>6</b> this round.'
        : 'Influence is capped at the <b>winner&rsquo;s</b> Fury rung ceiling.'}</div>`
    + `<div style="font-size:12px;margin-top:6px"><b>Ordinary</b> &mdash; the rules above, nothing declared.</div>`
    + `<div style="font-size:12px"><b>Blood</b> &mdash; the ceiling is <b>${BLOOD_CAP}</b> whatever the ladder says${half>0?`, you must commit at least <b>${half}</b> of your ${pool} Troops`:''}, and <b>the loser keeps the Troops they committed</b>. Worth it only if the margin reaches ${BLOOD_CAP-1}.${half>0?'':' <b>Locked</b> &mdash; it needs at least one Troop to divide, and you have none.'}</div>`
    + `<div style="font-size:12px"><b>Hold Back</b> &mdash; no Skirmish, you bank <b>+${HOLD_BACK_INFLUENCE}</b> Influence, and the round costs <b>1</b> Pressure instead of 2. Every Troop stays yours.</div>`
    + (dread>0 ? `<div style="font-size:12px;margin-top:4px;color:var(--muted)">Pressure is at ${dread} &mdash; attacking keeps it at +1.</div>` : '')
    + `</div>`;
}

/* `playerName` is safe to interpolate into the TITLE because showModal assigns
   it with textContent, never innerHTML - the modal title was never a sink.
   `maxTroops` is NOT: it is interpolated into an attribute (`max=`) and into the
   body text, and on the guest it arrives straight off the socket in
   `requestCommit`, so it is coerced to a non-negative integer here. `hand`
   arrives over the wire too, but groupHand() drops any id CARD_DEFS does not
   know, so every surviving `c` and every `def` below it is engine-authored. */
function showCommitModal(playerName, maxTroops, hand, onSubmit, playerIdx=-1){
  let selectedCardId = null;
  /* A fresh modal starts from no pledge: without this the previous Skirmish's
     declaration would be the baseline the delta is measured against and the
     first chip click would announce nothing at all. */
  srWagerSeen.wager = 'normal'; srWagerSeen.plus = false; srWagerSeen.reroll = false;
  maxTroops = Math.max(0, numOr(maxTroops, 0));
  /* >>> STAKES ON THE COMMIT SCREEN. The declaration is PUBLIC (that is the
     >>> whole point of it), so the seat that did not make it has to be able to
     >>> read it - and the commit modal is where they find out what they are
     >>> committing AGAINST. `commitFloor` is the same bloodMinCommit() the
     >>> engine enforces in bloodFloorCommit(), and it is applied to the
     >>> slider's OWN `min`: a control that offers a value the engine will
     >>> override is a control that lies, and a range input whose floor is
     >>> raised is the honest way to say "this is the least you may commit".
     >>> It is zero for every other stance, so ORDINARY's slider is byte-for-
     >>> byte what it always was. */
  const stake = declaredStakes();
  const bloodHere = (stake.stance === STANCE_BLOOD && playerIdx >= 0 && playerIdx === stake.aggressorIdx);
  const commitFloor = bloodHere ? Math.min(bloodMinCommit(maxTroops), maxTroops) : 0;
  const commitStart = Math.max(commitFloor, Math.min(1, maxTroops));
  const groups = groupHand(hand);
  const cardOptsHtml = groups.map(g=>`
    <div class="hand-group-label">${g.category}</div>
    <div class="hand-group-cards">
      ${g.cards.map(c=>{
        const def = CARD_DEFS[c];
        const powerLabel = def.mod===null ? '?' : `+${def.mod}`;
        /* Keyboard operability (G11). A commit-modal card option is a TOGGLE,
           so it carries aria-pressed (not aria-disabled) and is reachable with
           Tab. Enter and Space both activate, and Space must be
           preventDefault()ed or the page scrolls behind the modal. */
        return `<div class="opt" data-card="${c}" role="button" tabindex="0" aria-pressed="false">
          <div class="tcard-top"><span class="tcard-power">${powerLabel}</span><b>${def.name}</b></div>
          <div class="tcard-desc">${def.desc}</div>
        </div>`;
      }).join('')}
    </div>
  `).join('') || '<span style="color:var(--muted)">No cards in hand.</span>';

  /* >>> ODDS ABOVE THE CARDS. The panel used to sit BELOW #cardSelect - i.e.
     >>> under a 434px card grid inside a 751px dialog - so the one piece of
     >>> decision support this screen exists to give was under the fold on every
     >>> viewport the game ships for. It was also the WRONG ORDER even when it
     >>> happened to be visible: choosing the card is what moves the numbers, so
     >>> a player has to have the numbers in view while they read the cards.
     >>> Document order is now slider -> odds -> cards -> sticky footer, which is
     >>> the order the player needs to act in. `.odds-panel` already carries its
     >>> own margin, so the slot needs no wrapper and no stylesheet change
     >>> (css/style.css is not this file's to edit). A CSS engineer could later
     >>> promote it out of the scrolling region into a fixed band above
     >>> #skirmishBody's sticky `.footer-actions`; DOM order alone already puts
     >>> it above the fold. The rationale lives here rather than in an HTML
     >>> comment because a backtick inside the template literal ends it - which
     >>> is exactly the bug this file had for ten minutes. */
  showModal(`${playerName} — Commit Troops`, `
    <p>You have ${maxTroops} Troops available.</p>
    ${stakeReadoutHtml()}
    <div class="troop-picker">
      <span>${commitFloor}</span>
      <input type="range" id="troopSlider" min="${commitFloor}" max="${maxTroops}" value="${commitStart}">
      <span>${maxTroops}</span>
    </div>
    <p>Committing: <b id="troopVal">${commitStart}</b> <span id="troopWord">Troops</span></p>
    <div id="oddsSlot"></div>
    <p style="margin-top:10px">Optionally play one hidden Tactic card as a modifier:</p>
    <div class="card-select" id="cardSelect">${cardOptsHtml}</div>
    <div class="footer-actions">
      <button id="commitBtn">Commit</button>
    </div>
  `, {wide:true});

  const slider = document.getElementById('troopSlider');
   const troopVal = document.getElementById('troopVal');
   const troopWord = document.getElementById('troopWord');
   const syncTroopWord = ()=>{ if(troopWord) troopWord.textContent = (parseInt(slider.value,10) === 1) ? 'Troop' : 'Troops'; };
   slider.oninput = ()=>{ troopVal.textContent = slider.value; syncTroopWord(); refreshOdds(); };
   syncTroopWord();

  /* The odds panel (G8) is a LIVE function of the slider and the selected
     card, not a one-shot snapshot at open time: the whole point of the
     defender's readout is "move the slider and watch your number move", and
     a fizzle warning that only appeared if the card happened to be selected
     before the panel rendered would be worse than none. `playerIdx` is -1 for
     a caller with no seat (never in the live game, but the guard keeps
     commitOddsHtml total).

     >>> WHY THIS FUNCTION LOOKED BROKEN AND WAS NOT. The slot is written here,
     >>> and an empty #oddsSlot with a missing #oddsPanel is EXACTLY what this
     >>> guard produces when `playerIdx` is -1 - a caller that left the fifth
     >>> argument off. Measured in a real browser, a probe doing
     >>> `showCommitModal(name, max, hand, cb)` with no seat produced
     >>> `oddsSlot.innerHTML.length === 0` and `oddsPanel === null` while every
     >>> real path (aggressor, defender, and the online guest over a live
     >>> WebSocket) rendered a full panel with a connected, in-body slot. The
     >>> slot is never stale: showModal writes the body once, mountCommit only
     >>> appends, and the footer move re-parents the footer. So the failure was
     >>> "no seat", not "detached node", and hunting a re-render for it wastes a
     >>> day. Warned once per session so the next reader is told outright. */
  function refreshOdds(){
    /* The feature re-renders its own blocks when a token changes, so the cap
       parity pass has to ride along with every repaint rather than run once. */
    alignWagerFuryCaps();
    const slot = document.getElementById('oddsSlot');
    if(!slot) return;
    if(!(playerIdx >= 0)){
      if(!showCommitModal._warnedSeat){
        showCommitModal._warnedSeat = true;
        if(typeof console !== 'undefined' && console.warn){
          console.warn('[odds] showCommitModal() was called without a seat (playerIdx < 0), so the odds panel is empty by design. Pass the seat index as the 5th argument.');
        }
      }
      slot.innerHTML = '';
      return;
    }
    slot.innerHTML = commitOddsHtml(playerIdx, Number(slider.value), selectedCardId);
  }

  /* The selected-card state is owned in ONE place so the DOM class, the
     aria-pressed attribute, the odds panel and the commit payload can never
     disagree - a card that looks chosen but is not in the projection is a
     lie of exactly the kind this whole panel exists to remove. */
  function setCard(cardId){
    selectedCardId = cardId || null;
    document.querySelectorAll('#cardSelect .opt').forEach(o=>{
      const on = (o.dataset.card === selectedCardId);
      o.classList.toggle('selected', on);
      o.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  refreshOdds();
  }

  document.querySelectorAll('#cardSelect .opt').forEach(el=>{
    /* >>> B5. The second half of a double-click is not a second DECISION. This
     >>> is a toggle, so two activations of one card netted to zero: a
     >>> double-click left `aria-pressed="false"` on every option, `setCard(null)`
     >>> behind it, and the player committed with no card and nothing on screen
     >>> to say why. `e.detail` is the browser's own click count - 1 for a single
     >>> click, 2 for the second click of a double-click, 0 for a key-activation
     >>> - so ignoring `detail >= 2` makes a double activation idempotent with no
     >>> clock, no timer and no latch to get stuck. A deliberate second click
     >>> (detail 1) still deselects, which is how you take the card back off, and
     >>> `e.repeat` stops a HELD key from toggling the card on and off while it is
     >>> held down. */
    const toggle = (e)=>{
      if(e){
        if(e.detail >= 2) return;   /* the tail of a double-click: one decision, already made */
        if(e.repeat) return;        /* key auto-repeat is one activation, not a stream of them */
        e.preventDefault(); e.stopPropagation();
      }
      const cardId = el.dataset.card;
      sfx.click();
      setCard(selectedCardId===cardId ? null : cardId);
    };
    el.onclick = toggle;
    el.onkeydown = (e)=>{
      if(e.key==='Enter' || e.key===' ' || e.key==='Spacebar'){ toggle(e); }
    };
  });

  /* >>> BUG (BLOCKER 3) refreshOdds() used to run HERE, ABOVE the mountCommit
     >>> call below. consequenceHtml() reads the live stance/token declaration
     >>> through OD.Wagers.commitDeclaration(), which returns the feature's
     >>> module-level `activeCommitUI` — a singleton the feature never clears.
     >>> So the FIRST paint of every commit modal read LAST Skirmish's
     >>> controller: Skirmish 1, defender declares ALL IN, and Skirmish 2's
     >>> aggressor is told "ALL IN declared: you commit every Troop, and a
     >>> win pays +3 Influence". They declared nothing. The same staleness
     >>> reported a token or a RE-ROLL from the previous Skirmish. The
     >>> underlying payload was always right (the Commit button re-reads
     >>> commitDeclaration() at click time), which is what made this a display
     >>> lie rather than a scoring bug — in the one panel whose entire purpose
     >>> is to be trustworthy.
     >>> The fix is ordering, and it has to be ordering: the controller is
     >>> module-private to js/feature-wagers.js, so the engine cannot null it.
     >>> So: mount FIRST (below), paint SECOND — the first read of the
     >>> declaration now belongs to THIS modal and never to a previous one. */
  /* >>> WAGERS HOOK (feature: Betrayal tokens + All In / Ghost + the Fury
     >>> readout). This is the SINGLE call site the feature makes into this
     >>> function: it appends its controls to the modal body and binds them.
     >>> No-op when js/feature-wagers.js did not load. */
  if(window.OD && OD.Wagers && OD.Wagers.mountCommit){
    OD.Wagers.mountCommit({
      playerIdx,
      playerName,
      maxTroops,
      setTroops: (n)=>{
   slider.value = String(clamp(n, 0, maxTroops));
   document.getElementById('troopVal').textContent = slider.value;
   const tw = document.getElementById('troopWord');
   if (tw) tw.textContent = (parseInt(slider.value, 10) === 1) ? 'Troop' : 'Troops';
      },
      /* >>> Ask the feature to call back when the declaration changes, so the
         >>> "At stake" line tracks a stance declared inside this modal instead
         >>> of freezing at open time. The panel is truthful at open and static
         >>> after; it can never be WRONG, which is the half that mattered.
         >>> The same callback announces the new stance to #srLive: a stance
         >>> pins the slider (All In to the top, Ghost to zero), so a player who
         >>> cannot see the chip flip has to be told their commitment moved. */
      onChange: (decl)=>{ refreshOdds(); srWagerSentence(decl); },
    });
    alignWagerFuryCaps();
    srWrite([srWagerLockSentence()]);
    /* >>> D2: upgrade the five chips the feature just appended, from here,
       because js/feature-wagers.js is not this file's to edit. One delegated
       listener on the same mount root as the srWager one below; installed
       once, re-stamped on every Skirmish. */
    installWagerChipA11y(document.getElementById('skirmishBody'));
    /* Scoped delegated listener on the chips the feature just appended. It
       runs in the bubble phase on the BODY, i.e. AFTER the feature's own
       onclick has already repainted `.selected`, which is what makes reading
       the chip here correct. Scoped to the wager chips so a card click or a
       Commit click does not go through it at all, and every message it can
       produce is deduplicated, so a click that changes nothing writes nothing. */
    const mountHost = document.getElementById('skirmishBody');
    if(mountHost && !mountHost.__odSrWager){
      mountHost.__odSrWager = true;
      mountHost.addEventListener('click', (ev)=>{
        const chip = (ev.target && ev.target.closest)
          ? ev.target.closest('#wagersStance .wagers-stance, #wagersTokens .wagers-token')
          : null;
        if(!chip) return;
        srWrite([srWagerLockSentence()]);
        srWagerSentence(null);
      });
    }
  }

  /* >>> THE COMMIT BUTTON WAS OFF SCREEN. showModal() wrote `.footer-actions`
      >>> into the body and then mountCommit() (above) APPENDED the feature's
      >>> wagers controls after it, so the primary action of the most
      >>> decision-critical screen in the game sat ~390px down a 1438px scroll
      >>> area inside a 720px dialog - nowhere near visible, behind content a
      >>> player had no reason to think they had to scroll past. The footer is
      >>> moved back to the end of the body, which is both the correct document
      >>> order and the precondition for the sticky action bar the stylesheet
      >>> now gives it. */
  const body = document.getElementById('skirmishBody');
  const footer = body ? body.querySelector('.footer-actions') : null;
  if(body && footer) body.appendChild(footer);

  refreshOdds();

/* >>> D4: DOUBLE-CLICKING COMMIT SUBMITTED THE OPPONENT'S WHOLE COMMIT.
     Both Commit buttons - the aggressor's and the defender's - are laid out at
     the SAME PIXEL (measured dx=0, dy=1), because showModal reuses one dialog
     and only the title changes. A real double-click therefore lands twice on
     the same spot, and the second click arrived AFTER the first had closed the
     aggressor's modal and opened the defender's:

         before: "Player 1 - Commit Troops"   troops [4,1]
         after : "Rolling the Dice"            troops [3,0]
         *** the defender's commit was submitted: 1 troop, no card, no wager ***

     The defender never saw their own commit screen at all. Nothing about the
     click handler noticed, because `onSubmit` is the ordinary submit path -
     the second invocation was a perfectly valid commit for the seat that
     happened to be asking now.

     THREE guards, because no single one of them covers the whole hole and the
     first version shipped exactly one of them, which is the bug:

       1. `commitFired` below - a one-shot latch on THIS handler. It stops a
          second click on the same button (so it holds for the keyboard path
          too), and it is what makes the button read "Committed" rather than
          looking live. It cannot stop the bug on its own: a re-render builds
          a new closure with a new `false`.
       2. `commitIsReplayed(playerIdx)`, which asks `skirmishCtx` - the object
          that survives the re-render - whether this seat has already committed.
          This is the guard that outlives the modal.
       3. the click shield hideModal() raises, which stops the replaying click
          BEFORE it reaches ANY handler. This is the one that closes the
          CROSS-SEAT case - the second click arriving on the defender's
          freshly rendered button - because a value on the context cannot tell
          that apart from a deliberate click, and a click that never arrives is
          the only answer that does not involve a clock.

     The button also goes `disabled` on the first fire, which is what makes the
     fix visible to the player instead of merely silent. */
  const commitBtn = document.getElementById('commitBtn');
  let commitFired = false;
  const fireCommit = ()=>{
    if(commitFired) return;
    /* Guard 2. Checked BEFORE the button is touched, so a refused replay leaves
       the button exactly as it was: live, and saying "Commit". */
    if(commitIsReplayed(playerIdx)){
      log(`${esc((state.players[playerIdx] || {}).name || 'A player')}'s commit arrives after one was already accepted this Skirmish - ignored.`);
      return;
    }
    commitFired = true;
    if(commitBtn){
      commitBtn.disabled = true;
      commitBtn.setAttribute('aria-disabled', 'true');
      commitBtn.textContent = 'Committed';
    }
    const troops = Number(slider.value);
    const cardId = selectedCardId;
    // >>> WAGERS (feature: Wagers + Betrayal tokens) - reads the stance +
    // >>> token declaration out of the mounted commit UI. Returns null when
    // >>> the player declared nothing, so the payload is unchanged. Read HERE,
    // >>> at click time, off the controller mounted above - which is this
    // >>> modal's, never a previous Skirmish's.
    const wagersExtra = (window.OD && OD.Wagers && OD.Wagers.commitDeclaration) ? OD.Wagers.commitDeclaration() : null;
    hideModal();
    onSubmit(troops, cardId, wagersExtra);
    /* Latch here too, for the one caller whose onSubmit is NOT applyCommit -
       the online guest's, which sends a socket message instead of touching the
       engine. Writing it after the call is deliberate: onSubmit is what opens
       the NEXT modal, and the next modal's guard reads this at ITS click
       time, so ordering cannot matter either way. */
    latchCommit(playerIdx);
  };
  if(commitBtn) commitBtn.onclick = fireCommit;
}

/* ------------------------- Setup / round flow ------------------------- */

function startGame(){
  const mode = document.getElementById('gameMode').value;
  /* Any countdown left over from the previous game's end screen would fire
     into this one and restart it out from under the player. */
  if(demoLoopTimer){ clearInterval(demoLoopTimer); demoLoopTimer = null; }
  /* D4: the pending BOT tick belongs to the game that armed it. startGame()
     cleared only demoLoopTimer, so a tick from the outgoing game survived into
     the new one. Cleared HERE, next to the other timer, and re-validated on
     fire as well - clearTimeout alone still races a callback already queued. */
  if(botTickTimer){ clearTimeout(botTickTimer); botTickTimer = null; }
  online.enabled = (mode==='host');
  online.isHost = (mode==='host');
  online.myIndex = 0;
  delete handRenderCache[0]; delete handRenderCache[1];
  prevBoardSnapshot = null;
  stageBanner.lastRound = 0;
  endConfettiFired = false;

  BOT_TICK_MS = {normal:500, fast:150, instant:20}[document.getElementById('botSpeed').value] ?? 500;
  const demoLoop = mode==='demo' && document.getElementById('demoLoop').checked;

  const p1name = document.getElementById('p1name').value.trim() || "Player 1";
  const p2name = document.getElementById('p2name').value.trim() || "Player 2";
  const p1type = mode==='demo' ? 'bot' : document.getElementById('p1type').value;
  const p2type = (online.enabled || mode==='demo') ? (mode==='demo'?'bot':'human') : document.getElementById('p2type').value;
  const difficulty = document.getElementById('botDifficulty').value;

  state = {
    round: 1,
    difficulty,
    mode,
    demoLoop,
    players: [makePlayer(p1name,p1type), makePlayer(p2name,p2type)],
    board: null,
    pickQueue: [],
    logEntries: [],
    firstPlayerIdx: 0,
    phase: 'draw',
    intrigueDeck: shuffle(INTRIGUE_DECK_TEMPLATE.slice()),
    intrigueDiscard: [],

    /* Feature-owned round/game state. Every one of these is assigned a plain
       JSON default HERE, in the literal, because `currentEvent` used to be
       written later in beginRound() and read by getEvent() in between - a
       crash in that window left the round event undefined. Same class of
       bug applies to anything a feature reads before it writes. */
    currentEvent: null,      // id of this round's shared Event, or null
    meltdown: false,         // escalating board state (feature-owned)
    surgeRolls: null,        // pending surge dice, or null when idle
    dread: 0,                // rising pressure counter
    collapses: 0,            // how many times the board has collapsed
    /* >>> CHAOS (feature-chaos.js) — the rest of the feature-owned state.
       Declared here for the same reason as the fields above: every key a
       feature reads is written first, in this literal, so a broadcast can
       never carry an undefined the receiver would have to guess about.
       `bounty` is {id, round} (the definition lives in the feature's
       frozen table, never on state), and the Rift trio is reassigned every
       round from Round 3. All plain JSON — this is the online relay. */
    bountyIds: null,         // ids of every Bounty published so far, or null
    riftTarget: null,        // which real site the Rift mutates this round
    riftMut: null,           // which mutation the Rift wears this round
    riftContested: false,    // this round's Rift is permanently Contested
    collapseSpent: false,    // has the 2-collapse cap already been announced
    bounty: null,            // {id, round} standing bounty, or null
    roundRec: {              // per-round scratch pad, reset in beginRound()
      round: 1,
      picks: [],
      intrigue: null,
      skirmish: false,
      heldBack: false,        // a DECLARED hold-back round: no fight, +1 Influence
      capped: {credits:0, ore:0, troops:0},
    },
    history: [],             // per-round summaries, appended in endRound
    betrayed: {plus:false, reroll:false},  // this round's betrayal flags
    lastActiveIdx: 0,        // whose hand to show outside the draft
    /* >>> STAKES: this round's PUBLIC declaration by the aggressor. Two plain
       fields, no functions and no class instances, because renderAll()
       JSON.stringify's the whole state to the online guest on every action and
       a value that cannot survive a round trip is a value the second seat
       cannot see. Defaulted here (rather than written at decision time) for the
       same reason every other feature-owned key above is: a broadcast in the
       window before anybody declares must carry ORDINARY, not undefined.
       `aggressorIdx` is the SEAT that declared, so a stale or absent
       declaration can never be applied to the wrong player. */
    stakes: {aggressorIdx:-1, stance:'ordinary'},
  };

  state.players.forEach(p => drawCard(p, HAND_CAP));

  /* Features are told the game exists before the first round is built, so
     they can adjust setup (or bail out) without racing beginRound. */
  if(canRunExtensions()) OD.Ext.hooks.run('gameStart', extCtx(null, -1));

  document.getElementById('setup').classList.add('hidden');
  document.getElementById('game').classList.remove('hidden');
  document.getElementById('endScreen').classList.add('hidden');
  document.getElementById('demoBanner').classList.toggle('hidden', mode!=='demo');

  beginRound();
}

function beginRound(){
  const s = state;
  s.board = {};
  LOCATIONS.forEach(l => s.board[l.id] = null);
  s.players.forEach(p => {
    p.isAggressor=false; p.aggressorBonus=0;
    if(intrigueUnlocked()) drawIntrigue(p,1);
  });

  /* Fresh per-round scratch pad, so a feature reading roundRec never sees
     last round's picks or cap overflow. `prevInfluence` is the Influence
     tally as it stood at the TOP of this round, so the round debrief can
     report "+3 this round" as a real delta instead of a running total.
     `decision` is the D4 latch that outlives the decision dialog: one
     Skirmish per round, so one decision, and the flag is re-created here. */
  s.roundRec = {round: s.round, picks: [], intrigue: null, skirmish: false, decision: false,
                heldBack: false,
                capped: {credits:0, ore:0, troops:0},
                prevInfluence: s.players.map(p=>p.influence)};
  s.betrayed = {plus:false, reroll:false};
  /* >>> STAKES ARE PER ROUND. A declaration is a claim about THIS round's
     Skirmish ("cap 6, at least half my Troops"), so carrying it into the next
     round would silently re-price a fight nobody declared. Re-created here for
     the same reason `decision` is: the round's own latch has to start false. */
  s.stakes = {aggressorIdx:-1, stance:'ordinary'};

  if(canRunExtensions()) OD.Ext.hooks.run('roundBegin', extCtx('draft', -1));

  if(eventsUnlocked()){
    s.currentEvent = EVENTS[Math.floor(Math.random()*EVENTS.length)].id;
    const eventDef = getEvent();
    if(s.currentEvent==='windfall_round') s.players.forEach(p=>{ p.credits+=2; reportCaps(p, applyCaps(p)); });
    if(s.currentEvent==='trade_winds') s.players.forEach(p=>{ p.ore+=1; reportCaps(p, applyCaps(p)); });
    if(s.currentEvent==='recruitment_drive') s.players.forEach(p=>{ p.troops+=1; reportCaps(p, applyCaps(p)); });
    if(s.currentEvent==='council_session') s.players.forEach(p=> log(`${esc(p.name)} studies Council Session -> ${drawLog(p, 1, drawCard(p,1), 'hand already at the limit')}`));
    if(canRunExtensions()){
      OD.Ext.hooks.run('roundEventApplied', extCtx('draft', -1, {eventId: s.currentEvent}));
      OD.Ext.effects.run('roundEventApplied', extCtx('draft', -1, {eventId: s.currentEvent}));
    }
  } else {
    s.currentEvent = null;
  }

  s.firstPlayerIdx = (s.round % 2 === 1) ? 0 : 1;
  const F = s.firstPlayerIdx, S = 1-F;
  s.pickQueue = [F,S,S,F,F,S]; // 3 picks each, snake order
  s.phase = 'draft';

  /* >>> INTEGRATION (G5) - the escalation ramp. Written HERE, after every
     roundBegin hook has run, because that is where `state.meltdown` is
     decided for Round 6: setting it before the hooks would paint a hot but
     not-yet-Meltdown board for one frame, and not setting it at all left
     --heat pinned at its .12 default for the whole game. */
  setHeat(s.round);

  log(`<b>— Round ${s.round} begins —</b> ${esc(s.players[s.firstPlayerIdx].name)} drafts first.`);
  const eventDef = getEvent();
  if(eventDef) log(`Round Event: <b>${eventDef.name}</b> - ${eventDef.desc}`);
  else if(!advancedUnlocked()) log(`Basic tier only this round - Advanced tier unlocks Round 2.`);
  if(s.currentEvent==='quiet_round') OD.Sound.play('quiet.round');
  /* Matchpoint - the round before the last - is worth flagging, and the
     final round gets the heaviest cue of the game. */
  OD.Sound.play(s.round >= TOTAL_ROUNDS ? 'stinger.final'
              : (s.round === TOTAL_ROUNDS-1 ? 'stinger.matchpoint' : 'stinger.round'));
  showRoundBanner(`Round ${s.round}`);
  stageBanner.lastRound = s.round;
  renderAll();
  maybeAutoPick();
}

/* Caps clamp the instant a resource is gained, so a +2 event while already
   at the cap is a real loss, not a rounding error. Say so out loud. */
function reportCaps(player, lost){
  const trimmed = capLossNote(lost);
  if(trimmed){
    log(`${esc(player.name)} is at the resource cap${trimmed} - discarded, not banked.`);
    OD.Sound.play('cap.hit');
    if(state && state.roundRec) state.roundRec.capped.credits += lost.credits + lost.ore + lost.troops;
  }
  return trimmed;
}

function currentPicker(){
  return state.pickQueue.length ? state.pickQueue[0] : null;
}

function openLocations(){
  const out = LOCATIONS.filter(l => state.board[l.id] === null);
  /* >>> CHAOS (feature-chaos.js) — the Rift is the ninth site from Round 3.
     It is NOT pushed into LOCATIONS: that array is the board's template and
     it is read by the rules copy and the renderer, both of which are not
     this feature's to change. riftLoc() returns null before Round 3 and
     again once the Rift has been taken, so the 8/9/8 shape (6 picks, 2 or
     3 sites left cold) falls out of the same filter as everything else.
     boardLocations() is the SAME list the renderer draws, which is what
     guarantees a tile the bot can pick is a tile the human can see. */
  const rift = riftLocIfLive();
  if(rift) out.push(rift);
  return out;
}

function canAffordExtra(loc, player){
  /* >>> CHAOS (feature-chaos.js) — Meltdown waives EVERY Advanced cost for
     every site, so the affordability check is skipped outright rather than
     special-cased per resource. The Rift's own Advanced price is not
     special-cased at all: riftLoc() hands back a loc object whose
     `advanced.cost` is already the mutated one (Toll doubled, Open Hands
     free), so it goes through the identical check below. */
  if(loc && typeof OD !== 'undefined' && OD.Chaos && OD.Chaos.advancedWaived && OD.Chaos.advancedWaived(state)) return true;
  /* >>> A tier flagged `consolation` is always takeable (see tierIsAlways-
     Takeable): the rules owe the player the consolation, not a dead tile. */
  if(loc && tierIsAlwaysTakeable(loc.id, 'advanced')) return true;
  const cost = (loc && loc.advanced && loc.advanced.cost) || {};
  return (player.credits>=(cost.credits||0)) && (player.ore>=(cost.ore||0)) && (player.troops>=(cost.troops||0));
}

/* Progressive complexity: Round 1 is Basic-tier only (learn the board),
   Intrigue cards start flowing Round 2, and Round Events kick in Round 3 -
   the game gets more complex as it goes instead of dumping everything on
   round one. */
function advancedUnlocked(){ return state.round >= 2; }
function intrigueUnlocked(){ return state.round >= 2; }
function eventsUnlocked(){ return state.round >= 3; }

/* The bot's read of the board. It values the same two clauses the tiles print
   (povertyInfluence / surplusInfluence, above) rather than a hand-tuned guess,
   so the bot's draft order cannot drift away from the thing a human reads on
   the tile. Note what is NOT here any more: a term for "this pool is full",
   which is what used to make the Easy bot out-draft the Hard one. */
function baseLocationValue(loc, player){
  const broke = (n)=> povertyInfluence(n) * 0.7;
  switch(loc.id){
    /* >>> CHAOS (feature-chaos.js) — the Rift is worth a FLAT 1.15 on
       purpose. The mutation is public, but the bot does not read the
       reveal, so any value tuned per mutation would be a guess dressed up
       as knowledge. Flat is honest: the bot is genuinely uncertain, and a
       human who reads the announcement systematically out-drafts it. */
    case 'rift': return 1.3;
    case 'market': return 1.5 + broke(player.credits);
    case 'quarry': return 1.5 + broke(player.troops);
    case 'garrison': {
      const afterTroops = player.troops + 2;
      const opp = state.players[1-state.players.indexOf(player)];
      /* The Garrison is worth an army, and an army is worth standing while you
         still have it - so the ARMY clause, plus the Aggressor option. This is
         what makes HOLD BACK worth taking. */
      return 1.3 + surplusInfluence(player.troops, 1, 2) * 0.7 + (afterTroops > opp.troops ? 0.6 : 0.2);
    }
    case 'outpost': return (player.credits>=5 && player.ore>=3) ? 1.85 : ((player.credits>=3 && player.ore>=2) ? 1.4 : 0.5);
    case 'archive': return 1.15;
    case 'foundry': return 1.5 + broke(player.ore);
    case 'bazaar': return player.ore>=2 ? 1.5 : 1.6;
    case 'shrine': return 1.0;
  }
  return 1;
}

function botChoosePick(playerIdx){
  const player = state.players[playerIdx];
  const opts = openLocations();
  const jitter = {easy:1.1, normal:0.45, hard:0.12}[state.difficulty] ?? 0.45;
  let best = null, bestScore = -Infinity;
  opts.forEach(loc=>{
    ['basic','advanced'].forEach(tier=>{
      if(tier==='advanced' && (!advancedUnlocked() || !canAffordExtra(loc, player))) return;
      const base = baseLocationValue(loc, player);
      const val = tier==='advanced' ? base*1.6 : base;
      const noise = (Math.random()*2-1) * jitter * val;
      /* >>> CHAOS (feature-chaos.js) — the live Bounty is a public contract,
         so the bot should care about it: a `blood_price` Bounty must push
         it off the troop-granting sites, `deep_cut` must make Advanced the
         tempting pick. The feature returns 0 for Easy (so Easy stays Easy),
         0.7x at normal and 1.0x at hard, and is handed `val` so a
         multiplier composes with the 1.6 above instead of restating it. */
      const chaosMod = (typeof OD !== 'undefined' && OD.Chaos && OD.Chaos.bountyMod)
        ? OD.Chaos.bountyMod(loc.id, tier, val, state.difficulty, state) : 0;
      const score = val + noise + (isFinite(chaosMod) ? chaosMod : 0);
      if(score > bestScore){ bestScore = score; best = {locId:loc.id, tier}; }
    });
  });
  return best;
}

function applyLocationEffect(playerIdx, locId, tier){
  const player = state.players[playerIdx];
  state.board[locId] = {owner:playerIdx, tier};
  state.pickQueue.shift();
  if(tier==='advanced') player.advancedPicks++;
  state.lastActiveIdx = playerIdx;   // whose hand to show outside the draft
  if(state.roundRec) state.roundRec.picks.push({playerIdx, locId, tier});
  const leader = getLeader(player);
  /* The HUD badge is deferred so it can quote the NET after the caps clamp
     rather than the gross the site nominally pays. */
  let popupText = null;
  /* What this pick ACTUALLY debited, per resource — zero for a free tier and
     zero for a consolation the player could not afford. The switch below is
     the only writer. Handed to the Rift's mutations so Open Hands refunds
     exactly what was charged and Toll charges exactly that much again. */
  let charged = {credits:0, ore:0, troops:0};

  /* >>> CHAOS (feature-chaos.js) — THE RIFT resolves as a mutated copy of a
     real site. This sits AFTER the board/pick bookkeeping on purpose: the
     Rift's own slot must stay consumed, so only the EFFECT (and this
     round's copy) come from the target. The switch below is not forked and
     not duplicated - the Rift rides the exact same code path as the site it
     imitates, which is the only way its Toll / Open Hands costs and its
     Shrine/Outpost Influence stay honest. Cursed forces the Basic tier here,
     before the switch reads `tier`. */
  const riftMut = (locId==='rift') ? state.riftMut : null;
  if(riftMut){
    locId = state.riftTarget;
    if(riftMut==='cursed' && tier==='advanced') tier='basic';
  }

  switch(locId){
    case 'market': {
      const bonus = leader.id==='merchant' ? 1 : 0;
      const gain = (tier==='advanced' ? 4 : 2) + bonus;
      if(tier==='advanced') charged = takeCost(player, tierCost('market','advanced'));
      /* POVERTY: read BEFORE the yield, so it is the empty treasury the Market
         pays standing for, not the one it has just filled. */
      const surplus = povertyInfluence(player.credits);
      player.credits += gain;
      if(surplus > 0) player.influence += surplus;
      log(`${esc(player.name)} works the <b>Market</b> (${tier}) -> +${gain} Credits${tier==='advanced'?paidNote(charged):''}${bonus?' (+1 Merchant)':''}${surplus>0?`, +${surplus} Influence`:''}.`);
      popupText = {text: `+${gain} Credits` + (surplus>0 ? `, +${surplus} Influence` : ''), good: true};
      break;
    }
    case 'quarry': {
      const bonus = leader.id==='engineer' ? 1 : 0;
      const oreGain = (tier==='advanced'?3:2) + bonus, troopGain = (tier==='advanced'?2:1);
      if(tier==='advanced') charged = takeCost(player, tierCost('quarry','advanced'));
      const surplus = povertyInfluence(player.troops);
      player.ore += oreGain; player.troops += troopGain;
      if(surplus > 0) player.influence += surplus;
      log(`${esc(player.name)} works the <b>Quarry</b> (${tier}) -> +${oreGain} Ore, +${troopGain} Troop${tier==='advanced'?paidNote(charged):''}${bonus?' (+1 Engineer)':''}${surplus>0?`, +${surplus} Influence`:''}.`);
      popupText = {text: `+${oreGain} Ore, +${troopGain} Troop` + (surplus>0 ? `, +${surplus} Influence` : ''), good: true};
      break;
    }
    case 'garrison': {
      const bonus = leader.id==='warmonger' ? 1 : 0;
      const troopGain = (tier==='advanced'?4:2) + bonus;
      if(tier==='advanced'){ charged = takeCost(player, tierCost('garrison','advanced')); player.aggressorBonus=1; } else { player.aggressorBonus=0; }
/* ARMY: the one clause that pays for what the holder ALREADY has. This
         is the tile that makes HOLDING BACK worth something - the army you
         did not spend keeps paying you standing, so spending it in a Skirmish
         is a choice with a price rather than a free action. */
      const surplus = surplusInfluence(player.troops, 1, tier==='advanced' ? 2 : 1);
      player.troops += troopGain; player.isAggressor = true;
      if(surplus > 0) player.influence += surplus;
      log(`${esc(player.name)} rallies the <b>Garrison</b> (${tier}) -> +${troopGain} Troops${bonus?' (+1 Warmonger)':''}${surplus>0?`, +${surplus} Influence`:''}. Aggressor this round${tier==='advanced'?' with +1 Skirmish bonus':''}.`);
      popupText = {text: `+${troopGain} Troops - Aggressor!` + (surplus>0 ? `, +${surplus} Influence` : ''), good: true};
      break;
    }
    case 'outpost': {
      const bonus = leader.id==='diplomat' ? 1 : 0;
      /* The price and the consolation both come from the one table now, so
         the printed sentence and the number debited are the same object. */
      const need = tierCost('outpost', tier);
      const reward = (tier==='advanced' ? 3 : 1) + bonus;
      const consolation = 1 + bonus;
      if(canPayCost(player, need)){
        charged = takeCost(player, need); player.influence+=reward;
        log(`${esc(player.name)} invests in the <b>Outpost</b> (${tier}) -> pays ${need.credits} Credits + ${need.ore} Ore for +${reward} Influence${bonus?' (+1 Diplomat)':''}.`);
        popupText = {text: `+${reward} Influence`, good: true};
      } else {
        player.influence += consolation;
        log(`${esc(player.name)} eyes the <b>Outpost</b> (${tier}) but can't afford it -> consolation +${consolation} Influence${bonus?' (+1 Diplomat)':''}.`);
        popupText = {text: `+${consolation} Influence`, good: true};
      }
      break;
    }
    case 'archive': {
      const bonus = leader.id==='scholar' ? 1 : 0;
      const draws = (tier==='advanced' ? 3 : 1) + bonus;
      if(tier==='advanced') charged = takeCost(player, tierCost('archive','advanced'));
      /* A FULL HAND IS A DEAD PICK, and it used to be one: the hand starts at
         HAND_CAP and only ever empties in a Skirmish, so the Archive drew
         nothing 2.4 times a game and the pick was wasted. When there is
         nowhere to put the card, the Archive pays standing instead - the one
         clause that fires on something other than a resource. */
      if(player.hand.length >= HAND_CAP){
        const standing = 1;
        player.influence += standing;
        log(`${esc(player.name)} studies the <b>Archive</b> (${tier}) -> their hand is full, so there is nothing to draw: +${standing} Influence.`);
        popupText = {text: `+${standing} Influence`, good: true};
        break;
      }
      const drew = drawCard(player, draws);
      const reason = player.hand.length >= HAND_CAP ? 'hand already at the limit' : 'deck and discard are empty';
      log(`${esc(player.name)} studies the <b>Archive</b> (${tier}) -> ${drawLog(player, draws, drew, reason)}${tier==='advanced'?paidNote(charged):''}${bonus?' (+1 Scholar)':''}.`);
      popupText = {text: drew>0 ? `+${drew} Card${drew!==1?'s':''}` : 'Hand full, 0 Cards', good: drew>0};
      break;
    }
    case 'foundry': {
      const bonus = leader.id==='engineer' ? 1 : 0;
      const crGain = tier==='advanced'?3:1, oreGain = (tier==='advanced'?2:1) + bonus;
      if(tier==='advanced') charged = takeCost(player, tierCost('foundry','advanced'));
      const surplus = povertyInfluence(player.ore);
      player.credits += crGain; player.ore += oreGain;
      if(surplus > 0) player.influence += surplus;
      log(`${esc(player.name)} runs the <b>Foundry</b> (${tier}) -> +${crGain} Credits, +${oreGain} Ore${tier==='advanced'?paidNote(charged):''}${bonus?' (+1 Engineer)':''}${surplus>0?`, +${surplus} Influence`:''}.`);
      popupText = {text: `+${crGain} Credits, +${oreGain} Ore` + (surplus>0 ? `, +${surplus} Influence` : ''), good: true};
      break;
    }
    case 'bazaar': {
      const bonus = leader.id==='merchant' ? 1 : 0;
      const crGain = (tier==='advanced'?4:2) + bonus;
      /* A trade, but priced from the same table as every other cost - so the
         Rift's Toll doubles the 2 Ore instead of being unable to see it. */
      const trade = tierCost('bazaar', tier);
      if(canPayCost(player, trade)){
        charged = takeCost(player, trade); player.credits+=crGain;
        log(`${esc(player.name)} trades at the <b>Bazaar</b> (${tier}) -> trades ${trade.ore} Ore for +${crGain} Credits${bonus?' (+1 Merchant)':''}.`);
        popupText = {text: `+${crGain} Credits`, good: true};
      } else {
        /* The fallback IS the conditional: a player with no Ore to trade has
           nothing else the Bazaar could give them, so it pays standing for the
           trade it could not make. */
        const consolation = (tier==='advanced'?2:1) + bonus;
        const standing = 1;
        player.credits += consolation; player.influence += standing;
        log(`${esc(player.name)} visits the <b>Bazaar</b> (${tier}) without enough Ore -> consolation +${consolation} Credit${consolation!==1?'s':''} and +${standing} Influence${bonus?' (+1 Merchant)':''}.`);
        popupText = {text: `+${consolation} Credits, +${standing} Influence`, good: true};
      }
      break;
    }
    case 'shrine': {
      const bonus = leader.id==='diplomat' ? 1 : 0;
      const reward = (tier==='advanced' ? 3 : 1) + bonus;
      if(tier==='advanced'){
        const rite = tierCost('shrine','advanced');
        if(canPayCost(player, rite)){
          charged = takeCost(player, rite); player.influence+=reward;
          log(`${esc(player.name)} prays at the <b>Shrine</b> (advanced) -> pays ${rite.credits} Credits + ${rite.ore} Ore for +${reward} Influence${bonus?' (+1 Diplomat)':''}.`);
          popupText = {text: `+${reward} Influence`, good: true};
        } else {
          player.influence += 1 + bonus;
          log(`${esc(player.name)} can't afford the deep Shrine rite -> +${1+bonus} Influence instead${bonus?' (+1 Diplomat)':''}.`);
          popupText = {text: `+${1+bonus} Influence`, good: true};
        }
      } else {
        player.influence += reward;
        log(`${esc(player.name)} prays at the <b>Shrine</b> (basic) -> +${reward} Influence${bonus?' (+1 Diplomat)':''}.`);
        popupText = {text: `+${reward} Influence`, good: true};
      }
      break;
    }
  }

  /* >>> CHAOS (feature-chaos.js) — the mutation delta, applied on top of the
     target site's own effect (the switch above has already charged the
     ordinary Advanced cost and paid the ordinary yield, so Toll charges its
     second half here and Open Hands refunds its first). Runs BEFORE the
     caps clamp like every other hook, so a Rift payout can hit the Meltdown
     ceiling and lose the excess exactly like any other gain.
     `paidCost` is what the switch REALLY debited, which is why it is passed:
     a consolation (an Outpost the player could not afford) charged nothing, so
     Open Hands has nothing to return and Toll has nothing to double. */
  if(riftMut && typeof OD !== 'undefined' && OD.Chaos && OD.Chaos.applyRift){
    OD.Chaos.applyRift({state, api: OD.Ext.makeApi(state), playerIdx, targetId: locId, tier, mutation: riftMut, paidCost: charged});
  }

  /* Features get their say BEFORE the caps clamp, so a feature can push a
     player over a cap deliberately and still be credited for it. */
  if(canRunExtensions()) OD.Ext.hooks.run('locationResolved', extCtx('draft', playerIdx, {locId, tier, popup: popupText}));
  if(canRunExtensions()) OD.Ext.effects.run('locationResolved', extCtx('draft', playerIdx, {locId, tier}));

  const lost = applyCaps(player);
  const trimmed = reportCaps(player, lost);
  if(trimmed && popupText && popupText.good) popupText.good = false;
  if(popupText) popupGain(playerIdx, popupText.text + trimmed, popupText.good);
}

/* Caps clamp IMMEDIATELY, not at end of round - applyCaps() is called right
   after every gain. Returns what was discarded (all zeros when nothing was
   over) so the caller can report the true net instead of the gross. */
function applyCaps(player){
  const lost = {credits:0, ore:0, troops:0};
  /* >>> CHAOS (feature-chaos.js) — the Round 6 Meltdown lifts the caps to
     10/8/8. This is the one place that knows the ceiling, so instead of
     forking it (7 call sites) the numbers live in the feature and are read
     through here: capOverrides() returns {} normally and the Meltdown caps
     during the last round. Non-mutating, so a stale value can never leak
     into the next game. */
  const overrides = (typeof OD !== 'undefined' && OD.Chaos && OD.Chaos.capOverrides) ? OD.Chaos.capOverrides(state) : null;
  for(const res of ['credits','ore','troops']){
    const cap = (overrides && overrides[res] !== undefined) ? overrides[res] : CAPS[res];
    const over = player[res] - cap;
    if(over > 0){ player[res] = cap; lost[res] = over; }
    else if(player[res] < 0){ player[res] = 0; lost[res] = 0; }
  }
  return lost;
}

/* Compact "3 Credits, 1 Troop lost to cap" suffix, or '' when nothing was
   trimmed. `lost` is the object applyCaps() returns. */
function capLossNote(lost){
  if(!lost) return '';
  const parts = [];
  const NAMES = {credits:'Credit', ore:'Ore', troops:'Troop'};
  for(const res of ['credits','ore','troops']){
    if(lost[res] > 0) parts.push(`${lost[res]} ${NAMES[res]}${lost[res]!==1?'s':''}`);
  }
  if(!parts.length) return '';
  return ` (${parts.join(', ')} lost to cap)`;
}

/* Apply caps and report the net loss, so the popup and the caller both know
   what actually stuck. */
function applyCapsReport(player, playerIdx, text, good){
  const lost = applyCaps(player);
  const note = capLossNote(lost);
  popupGain(playerIdx, note ? text + note : text, good && !note);
  return lost;
}

function humanPick(locId, tier){
  const idx = currentPicker();
  if(idx===null || state.phase!=='draft') return;
  if(state.board[locId]!==null) return;

  if(online.enabled){
    if(online.isHost){
      if(idx!==0) return;
    } else {
      wsSend({type:'action', kind:'pick', locId, tier});
      return;
    }
  } else if(state.players[idx].type!=='human'){
    return;
  }

  /* >>> CHAOS (feature-chaos.js) — the Rift is not in LOCATIONS, so a click
     on it resolves through the feature, which hands back a loc object whose
     Advanced cost is this round's mutated one. Everything below (the
     affordability check, the pick itself) is then the ordinary path. */
  const loc = LOCATIONS.find(l=>l.id===locId)
    || (typeof OD !== 'undefined' && OD.Chaos && OD.Chaos.riftLoc ? OD.Chaos.riftLoc(state) : null);
  if(!loc || loc.id!==locId) return;
  if(tier==='advanced' && (!advancedUnlocked() || !canAffordExtra(loc, state.players[idx]))) return;

  /* >>> D4: this used to read "a CONTESTED SITE pauses the draft and offers the
     >>> opponent one chance to buy it" - Siege, whose hook
     >>> (OD.Wagers.beforePick) no longer exists, so the call is a no-op. Kept
     >>> as the seam: one property read, and it is the right place for any
     >>> future feature that needs to veto a pick. The comment no longer
     >>> advertises a mechanic that is not in the game. The online guest's pick
     >>> is routed through the very same call in handleHostIncomingAction. */
  if(window.OD && OD.Wagers && OD.Wagers.beforePick && OD.Wagers.beforePick(idx, locId, tier)) return;

  applyLocationEffect(idx, locId, tier);
  advanceDraftOrSkirmish();
}

function maybeAutoPick(){
  if(state.phase!=='draft') return;
  const idx = currentPicker();
  if(idx===null) { advanceDraftOrSkirmish(); return; }
  if(state.players[idx].type==='bot'){
    /* One tick at a time: re-arming replaces the handle instead of leaving a
       second live timer for the same seat. */
    if(botTickTimer){ clearTimeout(botTickTimer); botTickTimer = null; }
    botTickTimer = setTimeout(()=>{
      botTickTimer = null;
      /* >>> RE-VALIDATE ON FIRE (D4). This callback captures an `idx` from the
         >>> game that armed it and fires BOT_TICK_MS later, by which time that
         >>> game can be gone (Play Again, the demo loop, re-arming a room). It
         >>> used to run botChoosePick() and applyLocationEffect() against
         >>> whatever `state` pointed at THEN: measured 65 uncaught
         >>> `TypeError: Cannot read properties of null (reading 'locId')` in 12
         >>> trials, and in the trials that did not throw it silently consumed a
         >>> pick from the NEW game's queue with a pick belonging to a game that
         >>> no longer existed. startGame() clears the handle; this guard is the
         >>> half that covers the case startGame() cannot reach. */
      if(!state || state.phase!=='draft' || currentPicker()!==idx) return;
      const player = state.players[idx];
      if(!player) return;
      if(player.intrigueHand.length>0 && canPlayIntrigue(player) && Math.random()<0.8){
        const cardId = player.intrigueHand[Math.floor(Math.random()*player.intrigueHand.length)];
        playIntrigueCard(idx, cardId);
      }
      /* botChoosePick returns null when openLocations() is empty (every site
         taken with picks still in the queue). `pick.locId` used to dereference
         that null directly, which is the second half of the same crash. */
      const pick = botChoosePick(idx);
      if(!pick) return;
      /* >>> D4: bot picks go through the SAME (now no-op) beforePick seam as human
         >>> picks, so a future feature cannot be dodged by letting the bot pick
         >>> first. It is not there to stop a contested site any more - Siege was
         >>> cut - and the asymmetry that seam used to protect is gone with it. */
      if(!(window.OD && OD.Wagers && OD.Wagers.beforePick && OD.Wagers.beforePick(idx, pick.locId, pick.tier))){
        applyLocationEffect(idx, pick.locId, pick.tier);
        advanceDraftOrSkirmish();
      }
    }, BOT_TICK_MS);
  }
}

function advanceDraftOrSkirmish(){
  if(state.pickQueue.length>0){
    renderAll();
    maybeAutoPick();
    return;
  }
  const aggressorIdx = state.players.findIndex(p=>p.isAggressor);
  if(aggressorIdx===-1 || state.currentEvent==='quiet_round'){
    if(aggressorIdx!==-1 && state.currentEvent==='quiet_round'){
      // >>> WAGERS (feature: Betrayal tokens) - Spend B: 1 token forces a
      // >>> Skirmish THROUGH a Quiet Round. Returns true when the feature took
      // >>> over (it then starts the Skirmish, or ends the round itself once
      // >>> the offer lapses), so this branch must not end the round twice.
      if(window.OD && OD.Wagers && OD.Wagers.onQuietRound && OD.Wagers.onQuietRound(aggressorIdx)) return;
      log(`<b>Quiet Round</b> silences the Skirmish this round - no combat, no matter who holds the Garrison.`);
    }
    endRound();
  } else {
    state.phase = 'skirmish-decide';
    renderAll();
    promptAggressorDecision(aggressorIdx);
  }
}

/* ------------------------------ Skirmish ------------------------------ */

function promptAggressorDecision(aggressorIdx){
  const aggressor = state.players[aggressorIdx];
  const defenderIdx = 1-aggressorIdx;
  const defender = state.players[defenderIdx];

  /* >>> CHAOS (feature-chaos.js) — MELTDOWN: no holding back. Holding the
     Garrison in the last round obliges you to attack, so both the bot's
     decision and the human's Hold Back button are overridden here rather
     than in the modal (which is render territory another owner controls).
     The log line is the rule: the player is told exactly why the button
     they just pressed did nothing.

     >>> AND IT NOW OVERRIDES THE WHOLE STAKES BLOCK, not just the boolean.
     >>> MELTDOWN's rule is "the Garrison is an obligation", and HOLD BACK is
     >>> the only non-fighting stance - so MELTDOWN forbids exactly one of the
     >>> three, and ORDINARY and BLOOD are both legal answers to it. A round-6
     >>> BLOOD is a bigger swing than a round-6 Ordinary, which is coherent:
     >>> Meltdown raises the caps and makes Advanced free, and a round with
     >>> everything on the table is the round to swing on. */
  const noRetreat = !!(state && state.meltdown);

  if(aggressor.type==='bot'){
    /* One decision, three answers. `botWantsToAttack` still answers the
       attack-or-not question underneath it (and keeps its own history and its
       own tuning), so this is a policy layered on a policy rather than a
       rewrite of one. */
    const stance = noRetreat ? STANCE_ORDINARY : botChoosesStance(aggressor, defender);
    setTimeout(()=>{
      if(stance === STANCE_HOLD){ holdBackRound(aggressorIdx); return; }
      declareStance(aggressorIdx, stance);
      startSkirmishCommit(aggressorIdx, defenderIdx);
    }, BOT_TICK_MS);
    return;
  }

  const decisionHandler = (stance, force)=>{
    // >>> WAGERS (feature: Betrayal tokens) - a declared FORCE spends the token
    // and guarantees the attack. FORCE is an ORDINARY attack: the token buys
    // the fight, not a declaration, so it cannot smuggle in BLOOD's ceiling
    // and floor without the player having chosen them.
    if(force && typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.spendForce) OD.Wagers.spendForce(aggressorIdx);
    const asked = normaliseStance(stance);
    if(asked === STANCE_HOLD){
      if(noRetreat){ log(`<b>MELTDOWN — no holding back.</b> ${esc(aggressor.name)} holds the Garrison, and in Meltdown that means you fight.`); return; }
      holdBackRound(aggressorIdx);
      return;
    }
    /* MELTDOWN also refuses a BLOOD nobody can pay: the declaration needs half
       a pool, and a pool of zero cannot fund it. ORDINARY is the fallback and
       it is announced, because silently downgrading a declaration is the one
       thing this panel must never do. */
    if(asked === STANCE_BLOOD && aggressor.troops < 1){
      log(`<b>NO BLOOD.</b> ${esc(aggressor.name)} has no Troops to stake, so the declaration is refused — ${esc(defender.name)} is attacked ordinarily.`);
    }
    declareStance(aggressorIdx, asked);
    startSkirmishCommit(aggressorIdx, defenderIdx);
  };

  if(online.enabled && aggressorIdx!==online.myIndex){
    pendingGuestDecision = decisionHandler;
    // >>> WAGERS: `forceHtml` lets the guest render the FORCE button, and it is
    // >>> omitted entirely when the aggressor holds no Betrayal token.
    // >>> `aggressorTroops` rides the SAME message: the guest is about to be
    // >>> offered BLOOD and has to know whether the declaration is payable
    // >>> before it renders the button, and it cannot see the host's pool.
    wsSend({type:'requestSkirmishDecision', aggressorName:aggressor.name, defenderName:defender.name, defenderTroops:defender.troops, defenderHandCount:defender.hand.length,
      aggressorTroops:aggressor.troops,
      forceHtml: (typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.forceAttackHtml) ? OD.Wagers.forceAttackHtml(aggressorIdx) : ''});
    return;
  }

  /* The horn: the one sound in the game that means "this is about to go
     badly for someone". Fired the moment the aggressor commits to a fight,
     so the two commit modals that follow are already framed by it. */
  OD.Sound.play('skirmish.horn');
  // >>> WAGERS: injects the "break the Quiet Round / buy the attack" button.
  showSkirmishDecisionModal(aggressor.name, defender.name, defender.troops, defender.hand.length, decisionHandler,
    (typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.forceAttackHtml) ? OD.Wagers.forceAttackHtml(aggressorIdx) : '',
    aggressor.troops);
}

/* Record the declaration, and paint it. Both halves matter:
   - the write is what the defender's commit modal and the online guest read
     (it is on `state`, so renderAll's broadcast carries it);
   - renderAll() is what puts it on the wire BEFORE the next message goes out,
     because wsSend preserves order on a real socket and the host sends
     `requestCommit` to the other seat in the same breath. Without the paint the
     guest's commit modal would open against a snapshot that still says
     ORDINARY, and it would price a BLOOD fight as an ordinary one. */
function declareStance(aggressorIdx, stance, opts){
  const s = normaliseStance(stance);
  const announce = !(opts && opts.announce === false);
  if(state) state.stakes = {aggressorIdx:(aggressorIdx|0), stance:s};
  const who = state && state.players[aggressorIdx] ? state.players[aggressorIdx].name : 'The aggressor';
  if(s === STANCE_BLOOD){
    log(`<b>BLOOD declared</b> by ${esc(who)} \u2014 the Influence ceiling is <b>${BLOOD_CAP}</b> whatever the Fury ladder says, they must commit at least half their Troops, and <b>the loser keeps their committed Troops</b>.`);
  } else if(s === STANCE_HOLD){
    log(`<b>HOLD BACK declared</b> by ${esc(who)} \u2014 no Skirmish this round.`);
  }
  /* >>> ONLY WHEN ONLINE, and that is not an optimisation. renderAll() repaints
     >>> animated counters that read Math.random(), so calling it where the
     >>> declaration needs no painting shifts the random stream of every local
     >>> game - which is exactly what the balance harness warns about when it
     >>> says a re-ordering of Math.random() reshuffles which game each seed
     >>> becomes, and it would make every before/after comparison of this change
     >>> unreadable. A bot declares only in local play and demo, where the commit
     >>> modal reads `state` directly; an online declaration is always a human's,
     >>> and that is the only case that needs the broadcast. */
  if(online.enabled) renderAll();
  if(announce) srStanceSentence(s);
}

/* The declared round with no Skirmish in it: +HOLD_BACK_INFLUENCE to the
   aggressor and Pressure at +1 instead of +2.

   >>> THE PRESSURE LEVER, AND WHAT IT COSTS TO BE HONEST ABOUT IT. The tick
   >>> lives in js/feature-chaos.js (`const quiet = !rec.skirmish`), which this
   >>> engineer does not own, and the ONLY state it reads is
   >>> `state.roundRec.skirmish`. So the reduced tick is bought by writing that
   >>> flag - and that flag is also what the round debrief and the end-screen
   >>> trajectory read to decide whether to say "a Skirmish was fought". A flag
   >>> that lies there would be worse than no rule at all: the one screen whose
   >>> job is to tell the truth about the round would claim a fight that never
   >>> happened, and no amount of correct Pressure would pay for that.

   >>> So `roundRec.heldBack` is written at the same moment and BOTH readers
   >>> are taught about it: the debrief and the trajectory ask `heldBack` first
   >>> and print the truth ("held back \u2014 +1 Influence, Pressure +1"), and
   >>> `skirmish` keeps its one remaining job, which is the honest one for this
   >>> field: "this round was not quiet, the sky was not punished for silence".
   >>> A round nobody drafted a Garrison into, or a Quiet Round EVENT, still
   >>> costs the full +2 - being SKIPPED is a decision somebody made and was
   >>> paid for; being unable to fight is not. */
function holdBackRound(aggressorIdx){
  const who = state.players[aggressorIdx];
  /* >>> B7. THE ANNOUNCEMENT WAS BORN AND BURIED IN THE SAME TASK.
     `declareStance` ends in `srStanceSentence`, and this function then calls
     `endRound()` synchronously - whose `renderAll()` ends in `srWrite(srDeltas())`.
     Both are `textContent =` writes to the same `aria-live` region in the same
     task, so the live region only ever holds the SECOND one: a MutationObserver
     on addedNodes/removedNodes measured the HOLD BACK text going in and coming
     out at the same +118ms, and no screen reader announced either. A player who
     holds back was never told they had declared it - the one irreversible,
     public, in-round decision in the game.
     BLOOD was never affected, because it does not end the round here: it is
     announced when the DEFENDER's commit modal opens, a task later.
     So the announcement moves to AFTER the round closes. `endRound()` is the
     last thing that writes #srLive on this path (the debrief it opens is a
     showModal, which does not render), so the sentence is still there for the
     next paint - which is exactly what a polite live region needs. The write
     contract is untouched: still `srWrite`, still textContent assignment, still
     one delta, still deduped against the last thing said. */
  declareStance(aggressorIdx, STANCE_HOLD, {announce:false});
  who.influence += HOLD_BACK_INFLUENCE;
  popupGain(aggressorIdx, `+${HOLD_BACK_INFLUENCE} Influence`, true);
  if(state.roundRec){
    state.roundRec.skirmish = true;   // the Pressure lever; see the note above
    state.roundRec.heldBack = true;   // the truth both READERS ask first
  }
  log(`${esc(who.name)} <b>declares HOLD BACK</b> \u2014 no Skirmish, <b>+${HOLD_BACK_INFLUENCE} Influence</b> banked, every Troop kept, and Pressure rises by 1 rather than 2.`);
  OD.Sound.play('turn.pass');
  endRound();
  srStanceSentence(STANCE_HOLD);
}

function botWantsToAttack(aggressor, defender){
  const aggression = {easy:0.55, normal:0.65, hard:0.85}[state.difficulty] ?? 0.65;
  const advantage = aggressor.troops - defender.troops;
  /* >>> THE 0.05 WAS THE DEAD OPTION. A committed Troop IS a point of the
     Skirmish total, so Troop headroom is worth far more than 0.05 of appetite
     per Troop implied - and the measured consequence was that the bot attacked
     from behind as readily as from in front. It now reads the gap at 0.11 per
     Troop, so three Troops of deficit is a real reason to hold and the Hold
     Back button stops being dead. The floor drops to 0.05 because a player
     with nothing to lose should still be allowed to swing. */
  // >>> WAGERS (feature: Fury) - every rung of the ladder adds +0.18
  // >>> aggression. This is the CATCHING UP valve working FORWARD as well as
  // >>> back: the valve can only fire when somebody walks into a Skirmish on a
  // >>> 3+ win streak, so a policy that abandons a hot streak throws the only
  // >>> anti-snowball rule in the game away. At the old +0.10 the bot coasted
  // >>> at Fury 2 and Catching Up fired 0.33 times a game.
  const furyDrive = Math.min(4, Math.max(0, aggressor.winStreak|0)) * 0.25;
  const chance = clamp(aggression + advantage*0.11 + furyDrive, 0.05, 0.95);
  /* >>> CHAOS (feature-chaos.js) — Dread makes aggression a moving target.
     A LEADING bot presses harder, because every round it stalls feeds the
     Collapse it is about to cash in; a trailing bot six Influence down stops
     feeding a tax it cannot convert. Returns 0 whenever the clock says
     nothing, and the base clamp above is untouched in that case. */
  const dread = (typeof OD !== 'undefined' && OD.Chaos && OD.Chaos.dreadMod) ? OD.Chaos.dreadMod(aggressor, defender, state) : 0;
  if(isFinite(dread) && dread !== 0) return Math.random() < clamp(chance + dread, 0.05, 0.99);
  return Math.random() < chance;
}

/* THE STAKES DECISION, which is a decision ABOUT a decision.

   botWantsToAttack() answers "do I fight at all" and keeps its own tuning, its
   Dread term and its Fury drive; this sits on top of it and splits the YES
   branch into ORDINARY and BLOOD. The question it actually asks is the one the
   rules pose:

     BLOOD pays at most BLOOD_CAP where ORDINARY pays at most the winner's Fury
     rung (4 on a cold streak, which is where most fights happen). So BLOOD is
     worth +2 over ORDINARY only if the margin actually REACHES 6 - and against
     the measured mean margin of 5.03 with the cap already binding in half of
     all fights, roughly half of all fights are one margin point from banking
     it. That is the whole tension, and it is why this cannot be "always BLOOD
     when the pool is big": the extra 2 is only worth the Troops it risks on the
     fights that come up one point short.

   Two terms, both measured rather than felt:
     - the CEILING GAP, in margin points, between what this stance can pay and
       what the ladder would have paid. Positive gap = BLOOD buys something.
     - the FLOOR the declaration puts under the commitment, which is a real
       cost: half the pool stops being Troops you hold for the next round.

   The appetite is difficulty-weighted, and the measurement is what set the
   direction. The first attempt ran it the obvious way - the easy bot
   over-declares, the hard bot under-declares - and it cost 1.5 points of
   ladder: over 60 games a game the EASY bot gained +1.55 pts/seat from the whole
   stakes block and the HARD one gained +0.01, dropping separation from 5.44 to
   3.90. BLOOD pays +2 to a bot whose ceiling the ladder left at 4 and only +1
   to one already on Fury 3, so the cold bot buys more from it - and the easy bot
   is the cold one. A hard bot has hoarded enough Troops to reach a margin of 5
   on its own, so it needs the ceiling least. The ladder's job here is therefore
   "how big a swing can this bot actually pay for", which is the honest reading
   of a Stakes-aware bot rather than a difficulty multiplier pointed the
   convenient way. */

function botChoosesStance(aggressor, defender){
  if(!botWantsToAttack(aggressor, defender)) return STANCE_HOLD;
  /* An empty pool cannot fund the floor. Refusing here is the same rule the
     modal hides the button for, and it has to be the same rule: a bot that
     could declare BLOOD with nothing to stake would be a bot the UI forbids. */
  if((aggressor.troops|0) < 1) return STANCE_ORDINARY;
  const fever = isFeverRound();
  /* What the ladder would pay this winner. The bot does not know who will win,
     so it prices the rung it is most likely to meet: a bot on a streak expects
     to keep it, and a cold bot expects the cold number. */
  const ownRung = furyRungCap(aggressor.winStreak|0, fever);
  const worstRung = furyRungCap(0, fever);
  const feverCap = fever ? BLOOD_CAP : 0;
  const ladderCap = Math.max(ownRung, worstRung, feverCap);
  /* What the margin has to reach for BLOOD to pay one more point than the
     ladder would have. Zero or negative means BLOOD changes nothing here. */
  const headroom = BLOOD_CAP - ladderCap;
  /* How far the bot's own margin expectation sits from the BLOOD ceiling.
     botChooseTroops commits most of the pool it is asked to commit, and the
     aggressor's edge over a ~35% defender is roughly one Troop of headroom plus
     the +1 Garrison bonus, so the expected margin is expressed in points
     rather than re-derived: it only has to be monotone. */
  const edge = (aggressor.troops - defender.troops) + 1;
  const expected = 3.5 + Math.max(0, Math.min(edge, 4));
  const reach = BLOOD_CAP - expected;          /* margin points still needed */
  const appetite = {easy:0.12, normal:0.30, hard:0.42}[state.difficulty] ?? 0.30;
  /* BLOOD is worth declaring when the ceiling it buys is closer than the margin
     it is likely to reach - and never worth it when it buys nothing. */
  const worthIt = (headroom > 0) && (reach <= headroom + 1.5);
  const p = clamp(appetite * (worthIt ? 1 : 0.35), 0, 0.9);
  return (Math.random() < p) ? STANCE_BLOOD : STANCE_ORDINARY;
}

let skirmishCtx = null;

/* >>> D4: THE COMMIT GUARD, ON THE CONTEXT.

   `commitIsReplayed()` is asked by every commit before it is allowed to change
   anything, and it asks `skirmishCtx` - the object created once per Skirmish
   and NOT recreated by a re-render - rather than a closure that dies with the
   dialog. It refuses exactly one thing: a commit for a seat that has already
   committed this Skirmish. That is the online guest's replayed socket message,
   and a stale modal re-fired after the board moved on, and both of them would
   otherwise overwrite the first payload on `skirmishCtx[role]` and spend the
   Troops twice. The next Skirmish builds a new context, so the second fight of
   a game commits normally.

   >>> WHAT THIS GUARD DELIBERATELY DOES NOT DO, and why it cost a rewrite.
   >>> The first attempt also refused any commit arriving within 400ms of the
   >>> last one, which reads like it covers the double-click: the second click
   >>> does land on the OTHER seat's modal. It does cover it - and it cost
   >>> test/balance.sim.js a deadlock on the first run, because that harness
   >>> plays a scripted human through a SYNCHRONOUS timer queue, so a whole
   >>> six-round game commits two seats within a few milliseconds of wall
   >>> clock and every commit after the first was refused as a "replay". A
   >>> guard that can be defeated by a clock is not a guard: the same refusal
   >>> fires on a real machine whose clock steps backwards (NTP, a laptop
   >>> waking from sleep), and it fires with no way for the player to recover
   >>> except clicking again. So the cross-seat case is closed where it can be
   >>> closed without a clock - by the click shield hideModal() raises, which
   >>> stops the replaying click BEFORE it reaches any handler at all - and this
   >>> guard is left doing the one job a value on the context can do honestly.
   >>> js/game.js's own D4 tests say which half each one covers; the cross-seat
   >>> half is verified in a real browser, where hit-testing actually exists. */
function commitIsReplayed(playerIdx){
  const ctx = skirmishCtx;
  if(!ctx || playerIdx < 0) return false;
  return !!(Array.isArray(ctx.commitLatched) && ctx.commitLatched[playerIdx]);
}
/* The single writer. applyCommit() is the only place a human commit becomes
   real - the button's onSubmit AND the online guest's socket message both land
   here - so writing the guard in one place is what makes "at most one commit
   per seat per Skirmish" a fact rather than a convention. */
function latchCommit(playerIdx){
  if(!skirmishCtx) return;
  if(!Array.isArray(skirmishCtx.commitLatched)) skirmishCtx.commitLatched = [false, false];
  if(playerIdx >= 0) skirmishCtx.commitLatched[playerIdx] = true;
}

function startSkirmishCommit(aggressorIdx, defenderIdx){
  state.phase = 'skirmish-commit';
  skirmishCtx = {aggressorIdx, defenderIdx, aggCommit:null, defCommit:null};
  // >>> WAGERS (feature: Betrayal tokens) - at most one RE-ROLL per player per
  // >>> Skirmish; the record lives on the existing skirmishCtx object.
  skirmishCtx.wagersReroll = [false, false];
  /* >>> D4: THE COMMIT GUARD, ON THE CONTEXT AND NOT THE CLOSURE.
     The old latch was `let commitFired = false` INSIDE showCommitModal, and
     that is not a guard against a double-click at all - it is a guard against
     one button being clicked twice. The button is destroyed between the two
     clicks of a double-click (showModal rewrites #skirmishBody), the next
     modal builds a fresh closure with a fresh `false`, and the second click
     therefore fires a perfectly valid commit for whichever seat is asking
     NOW. Measured: the defender was committed at the slider default - 1 Troop,
     no card - at every gap from 40ms to 320ms, and never saw their own modal.

     So the guard lives on `skirmishCtx` (commitIsReplayed / latchCommit, both
     declared beside it), which is created once per Skirmish and cannot be
     recreated by a re-render. It is per SEAT, so the defender's own first
     commit is still allowed, and it is re-created by every
     startSkirmishCommit, so the second Skirmish of a game commits normally. */
  skirmishCtx.commitLatched = [false, false];
  if(state.roundRec) state.roundRec.skirmish = true;
  if(canRunExtensions()){
    OD.Ext.hooks.run('skirmishBegin', extCtx('aggressor', aggressorIdx, {defenderIdx}));
    OD.Ext.effects.run('tacticCommitted', extCtx('aggressor', aggressorIdx, {defenderIdx, stage:'begin'}));
  }
  collectCommit(aggressorIdx, ()=> collectCommit(defenderIdx, ()=> resolveSkirmish()));
}

/* >>> WAGERS BRIDGE (js/feature-wagers.js). One frozen object, one marked
   >>> block, and nothing is ever replaced, wrapped or removed here: it only
   >>> READS engine internals and hands the feature the five calls it cannot
   >>> fake. Deleting js/feature-wagers.js and this block returns the engine
   >>> to byte-identical behaviour. Anything privileged belongs in this list
   >>> and nowhere else. */
/* >>> BOARD TABLE (the engine's own, published). A feature that has to price
   >>> a site - js/feature-chaos.js prices the Rift's Toll and Open Hands
   >>> mutations - reads the real number from HERE instead of keeping its own
   >>> copy of the board. That mirror is exactly what broke: Outpost, Bazaar
   >>> and Shrine had an empty `cost` in the copy, so a Rift-of-Outpost charged
   >>> 5 Credits + 3 Ore and then announced the Advanced was free. Read-only,
   >>> frozen, and identical to the numbers applyLocationEffect debits. */
if(typeof OD !== 'undefined'){
  OD.Board = Object.freeze({
    siteIds: ()=> LOCATIONS.map(l => l.id),
    tierCost: (id, tier)=> tierCost(id, tier),
    costPhrase: (cost)=> costPhrase(cost),
  });
}

if(typeof window !== 'undefined'){
  window.OD = window.OD || {};
  window.OD.WagersBridge = Object.freeze({
    getState: ()=> state,
    log: (html)=> log(html),
    popup: (i, text, good)=> popupGain(i, text, good),
    renderAll: ()=> renderAll(),
    showModal: (title, html, opts)=> showModal(title, html, opts),
    hideModal: ()=> hideModal(),
    applyLocationEffect: (i, locId, tier)=> applyLocationEffect(i, locId, tier),
    advanceDraftOrSkirmish: ()=> advanceDraftOrSkirmish(),
    startSkirmishCommit: (a, d)=> startSkirmishCommit(a, d),
    endRound: ()=> endRound(),
    rollD6: ()=> rollD6(),
    botTickMs: ()=> BOT_TICK_MS,
    advancedUnlocked: ()=> advancedUnlocked(),
    locationIds: ()=> LOCATIONS.map(l=>l.id),
    locationName: (id)=> ((LOCATIONS.find(l=>l.id===id) || {}).name || id),
    isOnline: ()=> online.enabled,
    isHost: ()=> online.isHost,
    myIndex: ()=> online.myIndex,
    send: (msg)=> wsSend(msg),
  });
}

/* Every Tactic card that leaves a hand for a Skirmish is a card PLAYED, and
   that count is what Archivist is gated on. One function for both callers (the
   bot path and the human path) so the two cannot drift, so the counter cannot
   be bumped for a card that was never taken, and so the field stays a plain
   integer that JSON.stringify can carry to the online guest. */
function takeCommitCard(player, cardIdx){
  if(!player || !Array.isArray(player.hand)) return null;
  const i = (typeof cardIdx === 'number') ? cardIdx : -1;
  if(i < 0 || i >= player.hand.length) return null;
  const card = player.hand.splice(i, 1)[0];
  player.cardsPlayed = ((player.cardsPlayed | 0) + 1);
  return card || null;
}

/* BLOOD's commitment floor, applied ONCE, at the single point where a
   commitment becomes real - after the Wagers pin (All In / Ghost) and after
   the [0, pool] clamp, so it can neither be talked under by a declaration nor
   invented out of nothing.

   It is deliberately a function of the SEAT and the declaration rather than of
   the modal: a human who drags the slider to zero under BLOOD has their
   commitment raised to half their pool exactly as a bot's would, because a rule
   the bot has to follow and the player does not is not a rule, it is a handicap.
   (The commit modal RAISES THE SLIDER'S OWN FLOOR as well, so the control never
   offers a value the engine would override - the enforcement here is the
   backstop, not the surprise.) */
function bloodFloorCommit(playerIdx, pool, troops){
  const s = declaredStakes();
  if(s.stance !== STANCE_BLOOD) return troops;
  if(playerIdx !== s.aggressorIdx) return troops;
  const floor = bloodMinCommit(pool);
  if(floor <= 0) return troops;
  return clamp(Math.max(troops|0, floor), 0, Math.max(0, pool|0));
}

function collectCommit(playerIdx, onDone){
  const player = state.players[playerIdx];
  /* resolveSkirmish() nulls skirmishCtx the moment a fight is settled, and a
     commit chain that is still in flight (a bot's setTimeout, a late guest
     snapshot) can land after that. It used to dereference null and throw out
     of a timer, which is how one stray commit could take the game down with
     no message. A commit arriving for a fight that no longer exists is simply
     late; say so and stop. */
  if(!skirmishCtx){ log(`A late commit from ${esc(player.name)} arrives after the Skirmish was settled - ignored.`); return; }
  /* D1: keep `lastActiveIdx` pointing at the seat being asked. commitSeatIdx()
     in renderHand() is the authority for the rail and reads live state, so
     this is belt-and-braces for anything else that consults the index - and it
     lives HERE, not in startSkirmishCommit, because collectCommit runs once per
     seat: setting it in startSkirmishCommit would fix the aggressor's modal and
     still show the aggressor's cards behind the defender's. A plain integer, so
     `state` stays JSON-serialisable for the online guest. */
  state.lastActiveIdx = playerIdx;
  const role = (playerIdx===skirmishCtx.aggressorIdx) ? 'aggCommit' : 'defCommit';

  if(player.type==='bot'){
    // >>> WAGERS (feature: Wagers + Betrayal tokens) - the card is chosen FIRST
    // >>> so the stance decision (All In when your floor beats their expected
    // >>> total, Ghost when your card alone does) can see what was played.
    // >>> `troops` is then PINNED by botChooseTroops BEFORE the subtraction
    // >>> below runs, which is what makes All In / Ghost real.
    const cardIdx = botChooseCard(player);
    const card = takeCommitCard(player, cardIdx);
    const wagerStance = (typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.botStance) ? OD.Wagers.botStance(playerIdx, card, player.troops) : null;
    const troops = bloodFloorCommit(playerIdx, player.troops, botChooseTroops(player, playerIdx, wagerStance));
    if(typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.payBotBetrayal) OD.Wagers.payBotBetrayal(playerIdx, wagerStance && wagerStance.betrayal);
    skirmishCtx[role] = {
      troops, card,
      troopsMax: player.troops,
      wager: (wagerStance && wagerStance.wager) || null,
      betrayal: (wagerStance && wagerStance.betrayal) || null,
    };
    player.troops -= troops;
    if(canRunExtensions()) OD.Ext.hooks.run('skirmishCommitted', extCtx(role==='aggCommit'?'aggressor':'defender', playerIdx, {troops, cardId: card, role, commit: skirmishCtx[role]}));
    setTimeout(onDone, Math.max(60, BOT_TICK_MS*0.8));
    return;
  }

  const applyCommit = (troops, cardId, extra)=>{
    /* >>> D4: the same guard, at the door. Two commits for one seat in one
       Skirmish is never legitimate: the second would overwrite the first on
       `skirmishCtx[role]` and the troops would be deducted twice. Same shape
       as the null-skirmishCtx guard above: late, so say so and stop. */
    if(commitIsReplayed(playerIdx)){
      log(`${esc(player.name)}'s commit arrives after one was already accepted this Skirmish - ignored.`);
      return;
    }
    latchCommit(playerIdx);
    const idx = cardId ? player.hand.indexOf(cardId) : -1;
    const card = takeCommitCard(player, idx);
    // >>> WAGERS (feature: Wagers + Betrayal tokens) - the public declaration
    // >>> (stance + tokens paid) is charged HERE, at commit time, so a charge
    // >>> can never be spent twice for one commitment, and it is re-derived
    // >>> from the live `state` so an online guest cannot forge it.
    const wagerDecl = (typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.applyCommitDeclaration)
      ? OD.Wagers.applyCommitDeclaration(playerIdx, extra, skirmishCtx, troops) : null;
    // >>> WAGERS - the stance PINS the committed troop count BEFORE the
    // >>> deduction, so a GHOST really keeps its Troops and an ALL IN really
    // >>> risks all of them. resolveSkirmish re-pins from `troopsMax`, so this
    // >>> is belt and braces rather than the only line of defence.
    // >>>
    // >>> The `: troops` arm (D2). wagerDecl is null whenever
    // >>> js/feature-wagers.js is absent - and then the raw number reached
    // >>> `player.troops -= commitTroops`, so a guest claiming 9999 Troops
    // >>> drove its own pool deeply negative and won the fight on the way.
    // >>> clamp() here is the engine's own invariant ("you cannot commit more
    // >>> Troops than you hold") and it holds with or without the feature.
    const commitTroops = bloodFloorCommit(playerIdx, player.troops,
      (wagerDecl && typeof wagerDecl.troops === 'number')
        ? clamp(wagerDecl.troops, 0, player.troops) : clamp(numOr(troops, 0), 0, player.troops));
    skirmishCtx[role] = {
      troops: commitTroops, card,
      troopsMax: player.troops,
      wager: (wagerDecl && wagerDecl.wager) || null,
      betrayal: (wagerDecl && wagerDecl.betrayal) || null,
    };
    player.troops -= commitTroops;
    if(canRunExtensions()) OD.Ext.hooks.run('skirmishCommitted', extCtx(role==='aggCommit'?'aggressor':'defender', playerIdx, {troops: commitTroops, cardId: card, role, commit: skirmishCtx[role]}));
    onDone();
  };

  if(online.enabled && playerIdx!==online.myIndex){
    pendingGuestCommit = applyCommit;
    // >>> WAGERS: playerIdx lets the guest render its OWN tokens and the same
    // >>> three stances the host uses, instead of guessing.
    wsSend({type:'requestCommit', role, playerName:player.name, maxTroops:player.troops, hand:player.hand, playerIdx});
    return;
  }

  showCommitModal(player.name, player.troops, player.hand, applyCommit, playerIdx);
}

function botChooseTroops(player, playerIdx, stance){
  // >>> WAGERS (feature: Wagers) - All In commits every Troop, Ghost commits
  // >>> none, and both are resolved BEFORE collectCommit subtracts them.
  if(typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.botTroopShare){
    const n = OD.Wagers.botTroopShare(playerIdx, player, stance);
    if(typeof n === 'number') return clamp(n, 0, player.troops);
  }
  /* >>> COMMITTING IS THE GAMBLE (T4). The pool is what the two Troop sites
     and the Intrigue deck leave you; committing a bigger slice of it is the
     only way a Skirmish total ever reaches the Fury cap, and it is also the
     only way to spend the army the surplus clauses keep paying you standing
     for. The fractions are raised so the average bot commits most of what it
     has - which raises the margin, and with it the share of the score the
     Skirmish owns, at the cost of leaving nothing behind. */
  const frac = {easy:[0.25,0.60], normal:[0.50,0.95], hard:[0.70,1.0]}[state.difficulty] ?? [0.50,0.95];
  const [lo,hi] = frac;
  /* >>> THE DEFENDER COMMITS WHAT THE ROUND DEMANDS; THE AGGRESSOR COMMITS
     WHAT THEY BROUGHT. This is the single change that turned the Skirmish from
     a side-show into the main game.

     Measured, before it: the Skirmish owned 21.6% of the score and zeroing it
     flipped the winner in 25.1% of decided games. The reason is that both
     seats committed the SAME slice of the SAME small pool, so the committed
     Troops cancelled out of the margin and every fight was one die plus a card
     that also cancelled - which is why a blowout could never happen and a
     featherweight could never lose either.

     The Garrison's owner always enters the fight holding the Garrison's fresh
     Troops on top of whatever it hoarded. Committing that whole stack against a
     defender that commits half of its own is what finally lets the margin reach
     the Fury cap, and the cap is what makes a big win worth exactly as much as
     a small one - the brake is doing its job BECAUSE the margin now gets big
     enough to be caught by it.

     The DEFENDER'S SHARE IS A CONSTANT, not a difficulty-scaled one, and that
     is load-bearing for the difficulty slider: scaling it by difficulty meant
     Easy defended best and Hard defended worst, which inverted the whole ladder
     (measured: hard - easy = -2.01 Influence per seat, z = -4.19, i.e. Easy
     beat Hard by two points and it was not noise). With the defender fixed at
     50%, the ladder's only job is how hard the aggressor swings and how well it
     drafts, which is the right way round.

     >>> AND 20% WAS ARITHMETICALLY DEAD, WHICH NOBODY MEASURED. The defender
     >>> committed `round(pool * 0.20)`, and the defender's pool is small -
     >>> measured, 26% of the time it is 1 Troop and 37% of the time it is 2 - so
     >>> the share rounded to ZERO in 76.3% of all defensive commitments and
     >>> never exceeded a third of the pool in 98.8% of them. Half the table's
     >>> climax control moved nothing, and it moved nothing *arithmetically*:
     >>> 0.2 x 1 rounds to 0, 0.2 x 2 rounds to 0. Raising the fraction would
     >>> have hidden that behind a different constant with the same shape.

     >>> WHAT REPLACES IT IS A REASON, and the reason is the cap. A committed
     >>> Troop is a point of your total, so it raises your chance of winning -
     >>> and it raises the margin by exactly the same point, which is the number
     >>> the ceiling truncates. So a defender's marginal Troop is worth something
     >>> up to the ceiling and NOTHING above it: commit too little and the fight
     >>> is already lost before the dice matter; commit too much and the extra
     >>> margin is paid at 4 whether it is 5 or 9. The window between those two
     >>> failures is the entire value of this slider, and it is what
     >>> botDefenderCommit() computes - from the PUBLIC aggressor commit (the
     >>> defender really does see it), the live ceiling, and nothing else. */
  if(player.isAggressor){
    const share = ({easy:[0.45,0.75], normal:[0.70,1.0], hard:[0.85,1.0]}[state.difficulty] ?? [0.70,1.0]);
    const [slo,shi] = share;
    const pct = slo + Math.random()*(shi-slo);
    return Math.max(0, Math.min(player.troops, Math.round(player.troops * pct)));
  }
  return botDefenderCommit(player);
}

/* THE DEFENDER'S COMMITMENT: what the ceiling can still pay for.

   Three bounds, all of them failures rather than tastes:

     FLOOR   - enough Troops to be IN the fight. The aggressor's committed total
               is public (skirmishCtx.aggCommit, and the whole odds panel is
               built on it), so the defender knows the number it has to
               approach: the aggressor's Troops plus the +1 the Garrison bonus
               pays, less what the defender's own die and Fury rung are going to
               contribute. One Troop past parity is "able to win it", not
               "certain to win it" - the die is still a die.

     CEILING - how many Troops can still move the number that pays. Past the
               ceiling, an extra Troop of margin buys exactly nothing, so the
               defender stops there and keeps that Troop for the next round.
               BLOOD's ceiling is 6 whatever the ladder says, which is the same
               argument with a bigger window - not a special case.

     RANGE   - half the pool stays home. This is the term that keeps the control
               a control. A Troop held back is a Troop next round's draft can
               spend on a full point of margin, and a Troop committed above the
               fight's demand is a Troop spent moving a number the ceiling will
               not pay for; the same Troop is worth more in the draft than in a
               capped fight. It is also what stops the policy collapsing to
               "commit everything", which is what the first attempt did: with
               the pool at 1-2 Troops almost half the time, any rule phrased as
               a bare floor produces a slider that only ever reads 100%.

   NOT DIFFICULTY-SCALED, deliberately, for the reason the block above sets out:
   the ladder's job is how hard the aggressor swings, not how a defensive slider
   is set. */
function botDefenderCommit(player){
  const pool = Math.max(0, player.troops|0);
  if(pool <= 0) return 0;
  const fever = isFeverRound();
  const ceiling = stanceCeiling(furyRungCap(player.winStreak|0, fever), fever);
  const ctx = skirmishCtx;
  const aggTroops = (ctx && ctx.aggCommit) ? Math.max(0, ctx.aggCommit.troops|0) : 0;
  /* What the defender brings without committing a single Troop: a d6 (mean
     3.5) and the Fury rung they are walking in on. A card is deliberately NOT
     counted - the defender has not chosen it yet, and guessing at it would put
     a hidden card into a public calculation. */
  const ownFloor = 3.5 + furyRung(player.winStreak|0).bonus;
  /* The Garrison bonus is +1 to the AGGRESSOR's total and it is on the board for
     everyone, so it is named here rather than discovered as an off-by-one. */
  const toContest = Math.max(1, Math.ceil((aggTroops + 1) - ownFloor) + 1);
  const affordable = Math.max(1, Math.ceil(pool * 0.5));
  const want = clamp(Math.min(toContest, affordable), 1, ceiling);
  return Math.max(0, Math.min(pool, want));
}

function botChooseCard(player){
  if(player.hand.length===0) return -1;
  const playChance = {easy:0.5, normal:0.7, hard:0.85}[state.difficulty] ?? 0.7;
  if(Math.random() > playChance) return -1;
  let best=0, bestVal=-1;
  player.hand.forEach((c,i)=>{
    const val = CARD_DEFS[c].avg;
    if(val>bestVal){bestVal=val; best=i;}
  });
  return best;
}

function resolveSkirmish(){
  const {aggressorIdx, defenderIdx, aggCommit, defCommit} = skirmishCtx;
  const aggressor = state.players[aggressorIdx];
  const defender = state.players[defenderIdx];

  function cardModifier(commit, player, isAggressorSide){
    if(!commit.card) return {mod:0, note:''};
    const def = CARD_DEFS[commit.card];
    let mod = def.mod;
    let note = '';
    if(commit.card==='wild'){ mod = rollD6(); note = ` (Wildcard rolled ${mod})`; }
    if(commit.card==='gambit'){ const r1=rollD6(), r2=rollD6(); mod = Math.max(r1,r2); note = ` (Desperate Gambit rolled ${r1} and ${r2}, kept ${mod})`; }
    if((commit.card==='wild'||commit.card==='gambit') && getLeader(player).id==='gambler'){ mod += 1; note += ` (+1 Gambler)`; }
    if(commit.card==='blitz'){ mod = isAggressorSide ? 2 : 0; }
    if(commit.card==='overrun'){
      if(player.ore>=1){ player.ore-=1; } else { mod = 0; note = ' (no Ore, fizzled)'; }
    }
    if(commit.card==='onslaught'){
      if(player.credits>=2){ player.credits-=2; } else { mod = 1; note = ' (short on Credits, reduced)'; }
    }
    return {mod, note, card:def.name};
  }

  // >>> WAGERS (feature: All In / Ghost) - the stance PINS the committed troop
  // >>> count, resolved from `troopsMax` (captured at commit time) rather than
  // >>> trusted from the client payload, so an online guest cannot lie about
  // >>> what it committed. Runs before the dice are counted.
  if(typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.lockStance){
    OD.Wagers.lockStance(aggCommit, aggressorIdx);
    OD.Wagers.lockStance(defCommit, defenderIdx);
  }

  const aggMod = cardModifier(aggCommit, aggressor, true);
  const defMod = cardModifier(defCommit, defender, false);

  const aggRoll0 = rollD6();
  const defRoll0 = rollD6();
  // >>> WAGERS (feature: Betrayal tokens) - a declared RE-ROLL rolls a second
  // >>> time and OVERWRITES in place. Deliberately NOT a second
  // >>> animateDiceRoll(): one dice animation, one final number, and the log
  // >>> line carries the drama ("declared a RE-ROLL: 1 -> 5").
  let aggRoll = aggRoll0, defRoll = defRoll0;
  let rerollNote = '';
  if(typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.applyRerolls){
    if(typeof OD.Wagers.noteFirstCast === 'function'){
      OD.Wagers.noteFirstCast(skirmishCtx, aggressorIdx, aggRoll0);
      OD.Wagers.noteFirstCast(skirmishCtx, defenderIdx, defRoll0);
    }
    const rrs = OD.Wagers.applyRerolls(skirmishCtx, rollD6) || [];
    rrs.forEach(r=>{
      if(r.idx===aggressorIdx) aggRoll = r.to; else defRoll = r.to;
      rerollNote += ` ${esc(r.name)} declared a <b>RE-ROLL</b>: ${r.from!==null && r.from!==undefined ? r.from : '?'} &rarr; ${r.to}.`;
    });
  }
  // >>> WAGERS (feature: Fury) - the flat "Momentum +1 at two wins" rule is
  // >>> replaced by the four-rung Fury ladder, which also supplies the
  // >>> Influence cap for this Skirmish. `betrayal.plus` is the token-bought
  // >>> +1 to the committed total.
  // >>> Read through furyRung(), the one accessor the HUD, the stakes panel
  // >>> and this resolution already share. It used to inline its own
  // >>> `OD.Wagers.FURY(...) : {bonus: winStreak>=2 ? 1 : 0, cap: 4}` fallback
  // >>> here - which is a THIRD copy of the ladder, and a copy of the
  // >>> RETIRED rule: delete js/feature-wagers.js and the engine silently
  // >>> went back to playing flat Momentum (+1 from a 2-streak) while every
  // >>> rules panel, the odds preview and the tests described the ladder.
  // >>> A game that silently reverts to a rule its own rulebook deleted is
  // >>> worse than a crash, and OD.Rules is load-order-guaranteed to exist
  // >>> (tools/check-scripts.js), so there is nothing to fall back TO.
  const AGGF = furyRung(aggressor.winStreak);
  const DEFF = furyRung(defender.winStreak);
  const aggBetrayal = (aggCommit.betrayal && aggCommit.betrayal.plus) ? 1 : 0;
  const defBetrayal = (defCommit.betrayal && defCommit.betrayal.plus) ? 1 : 0;
  let aggTotal = aggRoll + aggCommit.troops + aggMod.mod + (aggressor.aggressorBonus||0) + AGGF.bonus + aggBetrayal;
  let defTotal = defRoll + defCommit.troops + defMod.mod + DEFF.bonus + defBetrayal;

  // Undermine subtracts from the OPPONENT's total - applied before the
  // reveal so the totals shown in the dice-roll animation are already final.
  let undermineNote = '';
  if(aggCommit.card==='undermine'){ defTotal -= 2; undermineNote += ` ${esc(aggressor.name)}'s Undermine saps ${esc(defender.name)} for -2.`; }
  if(defCommit.card==='undermine'){ aggTotal -= 2; undermineNote += ` ${esc(defender.name)}'s Undermine saps ${esc(aggressor.name)} for -2.`; }

  // >>> WAGERS (feature: Fury - CATCHING UP) - the anti-snowball valve. If the
  // >>> player who WINS walked into the Skirmish on a 3+ win streak, the LOSER
  // >>> adds +2 to their committed total. It lands on the TOTALS, before
  // >>> isTie/aggWins are computed, so it can flip a loss into a win or tie
  // >>> it - which is the whole point of the rule.
  // >>> The rule itself is NOT written here. It is OD.Rules.catchingUp, the
  // >>> same function projectSkirmish() previews with on the commit screen,
  // >>> and this used to be a fourth hand-typed copy of it (`streak >= 3`,
  // >>> `+= 2`) sitting in the engine while the odds panel answered from
  // >>> Rules. Two copies of a rule that decides a Skirmish is one rebalance
  // >>> away from the commit screen describing a game the game does not
  // >>> play, so the engine asks the same question the UI does and reads the
  // >>> adjusted totals back out of the answer.
  let catchingUp = '';
  const CU = (typeof OD !== 'undefined' && OD.Rules && OD.Rules.catchingUp)
    ? OD.Rules.catchingUp(aggTotal, defTotal, aggressor.winStreak|0, defender.winStreak|0)
    : null;
  if(CU && CU.applied > 0){
    aggTotal = CU.aggTotal; defTotal = CU.defTotal;
    const wName = CU.leaderIdx===0 ? esc(aggressor.name) : esc(defender.name);
    const lName = CU.leaderIdx===0 ? esc(defender.name) : esc(aggressor.name);
    catchingUp = ` <b>CATCHING UP:</b> ${lName} adds +${CU.applied} against ${wName}'s ${CU.streak}-win Fury.`;
  }

  // Pre-compute the outcome so the result modal can spell it out clearly
  // (who won, by how much, and the Influence split) instead of only a log line.
  const isTie = aggTotal === defTotal;
  const aggWins = aggTotal > defTotal;
  const winnerName = isTie ? '' : (aggWins ? aggressor.name : defender.name);
  const loserName  = isTie ? '' : (aggWins ? defender.name : aggressor.name);
  let rawMargin = Math.abs(aggTotal - defTotal);
  const loserCard  = isTie ? null : (aggWins ? defCommit.card : aggCommit.card);
  if(loserCard === 'guard') rawMargin = Math.max(0, rawMargin - 1);
  // >>> WAGERS (feature: Fury) - the cap is now the winner's ladder rung, and
  // >>> Skirmish Fever raises the ceiling to 6.
  // >>> >>> STAKES: the BLOOD ceiling rides the SAME max(). Two rules that both
  // >>> mean "this fight may pay six" cannot be allowed to argue about which is
  // >>> larger, so `skirmishCap()` takes the largest of the three contributors
  // >>> rather than letting the declaration and the event override each other
  // >>> in sequence. Concretely: BLOOD + Fever = 6, Fever alone = 6, BLOOD
  // >>> alone = 6, and neither can pull the ceiling DOWN - a declaration is a
  // >>> claim about what the fight is worth, and it may not reduce what a
  // >>> player's own win streak already earned.
  const FEVER = state.currentEvent === 'skirmish_fever' ? 6 : 0;
  const bloodCeil = declaredStance() === STANCE_BLOOD ? BLOOD_CAP : 0;
  const winnerCap = (aggWins ? AGGF.cap : DEFF.cap);
  const inflCap = isTie ? 4 : skirmishCap(winnerCap, FEVER, bloodCeil);
  const influenceGained = isTie ? 0 : Math.min(rawMargin, inflCap);
  const winnerCard = isTie ? null : (aggWins ? aggCommit.card : defCommit.card);
  const rallyBonus = winnerCard === 'rally';
  const skirmishResult = {
    tie: isTie, winnerName, loserName, margin: rawMargin,
    influence: influenceGained, rally: rallyBonus,
    /* True when the loser's Guard trimmed the margin, so the modal can
       explain the same number the log reports instead of leaving the player
       to wonder where it came from. */
    guarded: !isTie && loserCard === 'guard' && rawMargin < Math.abs(aggTotal-defTotal),
    guardCut: (!isTie && loserCard === 'guard') ? Math.abs(aggTotal-defTotal) - rawMargin : 0,
    /* The declaration, so the result modal can name the fight that was fought
       instead of leaving the player to remember what they pressed. Plain JSON,
       like everything else on this object. */
    blood: !!bloodCeil,
    aggTotal, defTotal, aggName: aggressor.name, defName: defender.name
  };

  // The numbers are already locked in - the dice-roll animation is a
  // suspense/legibility beat, not a source of new information.
  animateDiceRoll(aggressor.name, defender.name, aggRoll, defRoll, aggTotal, defTotal,
    aggCommit.card ? CARD_DEFS[aggCommit.card].name : null,
    defCommit.card ? CARD_DEFS[defCommit.card].name : null,
    skirmishResult, ()=>{
    log(`<b>Skirmish!</b> ${esc(aggressor.name)} rolls ${aggRoll} + ${aggCommit.troops} troops${aggressor.aggressorBonus?` + 1 (Garrison bonus)`:''}${AGGF.bonus?` + ${AGGF.bonus} (Fury ${aggressor.winStreak})`:''}${aggBetrayal?' + 1 (Betrayal token)':''}${aggMod.card?` + ${aggMod.card}(${aggMod.mod})${aggMod.note}`:''} = <b>${aggTotal}</b>. ` +
        `${esc(defender.name)} rolls ${defRoll} + ${defCommit.troops} troops${DEFF.bonus?` + ${DEFF.bonus} (Fury ${defender.winStreak})`:''}${defBetrayal?' + 1 (Betrayal token)':''}${defMod.card?` + ${defMod.card}(${defMod.mod})${defMod.note}`:''} = <b>${defTotal}</b>.${undermineNote}${rerollNote}${catchingUp}`);

    if(aggCommit.card) aggressor.discard.push(aggCommit.card);
    if(defCommit.card) defender.discard.push(defCommit.card);

    if(aggTotal===defTotal){
      /* >>> BLOOD ON A TIE: both sides KEEP their committed Troops. The rule is
         >>> "the loser keeps their committed Troops" and a tie has no loser, so
         >>> the honest reading is that nobody pays - not that both do. It is
         >>> also the only reading that keeps BLOOD from being a trap: under the
         >>> other one, a BLOOD declaration would make a tie the single worst
         >>> outcome available (no Influence, and your half-pool gone), which
         >>> would make ties the thing a BLOOD declarer most fears rather than
         >>> the free roll it is worth reading "the loser's Troops are safe". */
      if(bloodCeil){
        aggressor.troops += aggCommit.troops;
        defender.troops += defCommit.troops;
        log(`It's a tie \u2014 no Influence either way, and under <b>BLOOD</b> both sides keep the Troops they committed.`);
      } else {
        log(`It's a tie — both sides lose their committed Troops, no Influence changes.`);
      }
      aggressor.winStreak = 0; defender.winStreak = 0;
      // >>> WAGERS (feature: All In / Ghost) - a tie pays NOTHING to either
      // >>> stance. An All In that ties is simply dead.
      // >>> `aggressorIdx` is threaded in because settleWagers walks the two
      // >>> COMMITS (side order: 0 = aggressor, 1 = defender) while it pays
      // >>> SEATS. Deriving the seat from the side index silently mis-paid
      // >>> every Skirmish where Player 2 held the Garrison.
      if(typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.settleWagers){
        OD.Wagers.settleWagers(-1, aggressorIdx, aggCommit, defCommit);
      }
    } else {
      const aggWins = aggTotal > defTotal;
      const winner = aggWins ? aggressor : defender;
      const loser = aggWins ? defender : aggressor;
      const loserCommit = aggWins ? defCommit : aggCommit;
      const winnerCommit = aggWins ? aggCommit : defCommit;
      winner.skirmishWins++; loser.skirmishLosses++;
      winner.winStreak++; loser.winStreak = 0;
      // >>> WAGERS (feature: Fury) - the old flat Momentum callout becomes the
      // >>> ladder's next rung, quoted with the cap it unlocks.
      if(winner.winStreak===2) log(`${esc(winner.name)} reaches <b>Fury 2</b> - +1 to their next Skirmish total, Influence cap 4.`);
      if(winner.winStreak===3) log(`${esc(winner.name)} reaches <b>Fury 3</b> - +2 to their next Skirmish total, and the Influence cap rises to 5.`);
      if(winner.winStreak>=4) log(`${esc(winner.name)} is <b>Fury ${winner.winStreak}</b> - +3 to their next Skirmish total, Influence cap 6.`);
      let margin = Math.abs(aggTotal-defTotal);
      const rawMargin = margin;

      if(loserCommit.card==='guard') margin = Math.max(0, margin-1);
      const guardNote = (margin !== rawMargin) ? ` (Guard cut ${rawMargin - margin} off the margin)` : '';

      const gained = Math.min(margin, inflCap);
      winner.influence += gained;
      /* A margin of 3 or more is a decisive result, not a coin flip - that
         deserves its own sting rather than the ordinary stat chime. */
      const decisive = margin >= 3;
      if(decisive){ OD.Sound.play('influence.gain'); OD.Sound.play('stinger.kill'); }
      popupGain(state.players.indexOf(winner), `+${gained} Influence`, true);

      if(winner===aggressor && aggCommit.card==='rally') winner.influence += 1;
      if(winner===defender && defCommit.card==='rally') winner.influence += 1;

      if(loser===defender && loserCommit.card==='feint'){
        defender.troops += defCommit.troops;
        log(`${esc(loser.name)} loses the Skirmish but Feint returns their committed Troops.`);
      } else if(loser===aggressor && loserCommit.card==='feint'){
        aggressor.troops += aggCommit.troops;
        log(`${esc(loser.name)} loses the Skirmish but Feint returns their committed Troops.`);
      } else if(bloodCeil && (loserCommit.troops|0) > 0){
        /* >>> BLOOD: THE LOSER KEEPS THE TROOPS. The one rule in the game that
           >>> makes a lost fight cheaper than a won one, and the reason BLOOD
           >>> is worth declaring at all: the aggressor is bidding a ceiling
           >>> they might not reach, and this is what the bid costs them when
           >>> the dice do not cooperate. It is checked AFTER Feint on purpose -
           >>> Feint's own return is a card effect and prints its own line, and
           >>> paying both would pay twice. Ambush still bites underneath it:
           >>> a card that costs Troops outright is not a refund of committed
           >>> Troops. */
        loser.troops += (loserCommit.troops|0);
        log(`<b>BLOOD:</b> ${esc(loser.name)} lost, so they keep the <b>${loserCommit.troops}</b> Troop${loserCommit.troops===1?'':'s'} they committed.`);
      } else if(loserCommit.card==='ambush'){
        loser.troops = Math.max(0, loser.troops-1);
        log(`${esc(loser.name)}'s own Ambush backfires — 1 extra Troop lost.`);
      }

      if(winnerCommit.card==='ambuscade'){
        loser.troops = Math.max(0, loser.troops-1);
        log(`${esc(winner.name)}'s Ambuscade costs ${esc(loser.name)} 1 extra Troop.`);
      }

      /* Report the SAME number the result modal shows: `margin` is the
         post-Guard figure, which is also what produced `gained` and
         skirmishResult.margin. Printing the raw difference here used to
         contradict the modal whenever Guard was in play. */
      log(`<b>${esc(winner.name)} wins the Skirmish</b> by ${margin} -> +${gained} Influence.${guardNote}`);

      // >>> WAGERS (feature: All In / Ghost) - the wagers settle INSIDE the
      // >>> existing win/lose branch: no new resolution pipeline, and the same
      // >>> totals that produced `margin` are the ones being paid on.
      // >>> `aggWins ? 0 : 1` is the winning SIDE; `aggressorIdx` is the seat
      // >>> the side order hangs off. Passing the seat explicitly is the whole
      // >>> point - see settleWagers in js/feature-wagers.js.
      if(typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.settleWagers){
        OD.Wagers.settleWagers(aggWins ? 0 : 1, aggressorIdx, aggCommit, defCommit);
      }
    }

    // Effects that always apply, win/lose/tie alike.
    [{commit:aggCommit, self:aggressor, opp:defender},{commit:defCommit, self:defender, opp:aggressor}].forEach(({commit,self,opp})=>{
      if(!commit.card) return;
      if(commit.card==='fortify'){
        self.troops += commit.troops;
        log(`${esc(self.name)}'s Fortify returns their committed Troops.`);
      }
      if(commit.card==='berserker'){
        self.troops = Math.max(0, self.troops-2);
        log(`${esc(self.name)}'s Berserker costs them 2 additional Troops.`);
      }
      if(commit.card==='scout'){
        const drew = drawCard(self,1);
        log(`${esc(self.name)}'s Scout -> ${drawLog(self, 1, drew, 'hand already at the limit')}`);
      }
      if(commit.card==='sabotage' && opp.hand.length>0){
        const idx = Math.floor(Math.random()*opp.hand.length);
        const discarded = opp.hand.splice(idx,1)[0];
        opp.discard.push(discarded);
        log(`${esc(self.name)}'s Sabotage forces ${esc(opp.name)} to discard ${CARD_DEFS[discarded].name}.`);
      }
      if(commit.card==='insight'){
        const drew = drawCard(self,1);
        log(`${esc(self.name)}'s Insight -> ${drawLog(self, 1, drew, 'hand already at the limit')}`);
      }
    });

    /* Everything is settled and post-Guard now, so this is the point where
       a feature gets to see the final score. */
    if(canRunExtensions()) OD.Ext.hooks.run('skirmishResolved', extCtx('aggressor', aggressorIdx, {
      defenderIdx, result: skirmishResult, aggTotal, defTotal,
    }));

    applyCaps(aggressor); applyCaps(defender);
    if(canRunExtensions()) OD.Ext.effects.run('tacticResolved', extCtx('aggressor', aggressorIdx, {result: skirmishResult}));
    skirmishCtx = null;
    endRound();
  });
}

function animateDiceRoll(aggName, defName, aggRoll, defRoll, aggTotal, defTotal, aggCardName, defCardName, result, onDone){
  const rollMs = clamp(BOT_TICK_MS*3, 150, 900);
  const holdMs = clamp(BOT_TICK_MS*4, 250, 1300);
  let finished = false;
  const finish = ()=>{ if(finished) return; finished = true; hideModal(); onDone(); };

  showModal('Skirmish - Rolling the Dice', `
    <div class="dice-row">
      <div class="dice-col"><div class="who">${esc(aggName)} (Aggressor)</div><div class="die rolling" id="dieAgg">?</div>
        <div class="dice-card">${aggCardName ? `Card: <b>${aggCardName}</b>` : 'No card played'}</div></div>
      <div class="dice-col"><div class="who">${esc(defName)} (Defender)</div><div class="die rolling" id="dieDef">?</div>
        <div class="dice-card">${defCardName ? `Card: <b>${defCardName}</b>` : 'No card played'}</div></div>
    </div>
    <div id="diceResultArea" style="text-align:center;color:var(--muted);font-size:13px;margin-top:10px">Rolling...</div>
    <div id="diceContinueWrap" class="hidden" style="text-align:center;margin-top:16px">
      <button id="diceContinueBtn">Continue</button>
    </div>
  `);

  const dieAgg = document.getElementById('dieAgg');
  const dieDef = document.getElementById('dieDef');
  const continueBtn = document.getElementById('diceContinueBtn');
  if(continueBtn) continueBtn.onclick = finish;

  const tickMs = Math.max(40, Math.round(rollMs/12));
  const interval = setInterval(()=>{
    dieAgg.textContent = String(1+Math.floor(Math.random()*6));
    dieDef.textContent = String(1+Math.floor(Math.random()*6));
    sfx.diceTick();
  }, tickMs);

  setTimeout(()=>{
    clearInterval(interval);
    if(!dieAgg.isConnected) return;
    dieAgg.textContent = String(aggRoll);
    dieDef.textContent = String(defRoll);
    dieAgg.classList.remove('rolling'); dieAgg.classList.add('settled');
    dieDef.classList.remove('rolling'); dieDef.classList.add('settled');
    sfx.diceSettle();
    const resultEl = document.getElementById('diceResultArea');
    if(resultEl){
      let verdict, detail;
      if(result && !result.tie){
        verdict = `${esc(result.winnerName)} wins the Skirmish!`;
        detail =
          `<div class="skirmish-totals">Totals (dice + troops + cards): <b>${result.aggTotal}</b> (${esc(result.aggName)}) vs <b>${result.defTotal}</b> (${esc(result.defName)})</div>` +
          `<div class="skirmish-result win">${verdict}</div>` +
          `<div class="skirmish-detail">Won by a margin of <b>${result.margin}</b> &rarr; <b>+${result.influence} Influence</b>${result.rally ? ` <span class="skirmish-bonus">Rally +1</span>` : ''}${result.guarded ? ` <span class="skirmish-bonus">Guard cut ${result.guardCut}</span>` : ''}.</div>` +
          `<div class="skirmish-detail skirmish-split">${esc(result.winnerName)} takes the contested Troops; ${esc(result.loserName)} ${result.blood ? 'keeps theirs, under BLOOD' : 'loses theirs'}${result.influence ? ` &mdash; the Influence split is <b>${esc(result.winnerName)} +${result.influence}</b>` : ''}.</div>`;
      } else if(result && result.tie){
        verdict = "It's a tie!";
        detail =
          `<div class="skirmish-totals">Totals (dice + troops + cards): <b>${result.aggTotal}</b> vs <b>${result.defTotal}</b></div>` +
          `<div class="skirmish-result">${verdict}</div>` +
          `<div class="skirmish-detail">Both sides ${result.blood ? 'keep their committed Troops, under BLOOD' : 'lose their committed Troops'} &mdash; no Influence changes hands.</div>`;
      } else {
        if(aggTotal===defTotal) verdict = "It's a tie!";
        else if(aggTotal>defTotal) verdict = `${esc(aggName)} wins the Skirmish!`;
        else verdict = `${esc(defName)} wins the Skirmish!`;
        detail = `<div>Totals (dice + troops + cards): <b>${aggTotal}</b> vs <b>${defTotal}</b></div>` +
          `<div class="skirmish-result ${aggTotal===defTotal?'':'win'}">${verdict}</div>`;
      }
      resultEl.innerHTML = detail;
      const wrap = document.getElementById('diceContinueWrap');
      if(wrap) wrap.classList.remove('hidden');
    }
  }, rollMs);

  // Fallback: if the player never clicks Continue, still advance so the
  // round can't get stuck. Longer than holdMs so reading isn't cut short.
  /* >>> L3, the other half. Same rule as the debrief failsafe below: in a DEMO
     >>> nobody is there to press Continue, so this floor - not the dice
     >>> animation - is what a spectator actually watches, and a 2.6s hold on
     >>> every roll is most of a demo round. A human keeps the full
     >>> `rollMs + max(holdMs, 2600)` and the Continue button, unchanged.
     >>> `state.mode` is the existing field startGame() already puts on the state
     >>> literal, so this adds no key and nothing new to serialise. `finished`
     >>> still gates both the button and this timer, so they cannot both fire. */
  const demoDice = !!(state && state.mode === 'demo');
  setTimeout(finish, demoDice
    ? rollMs + Math.min(900, Math.max(320, holdMs))
    : rollMs + Math.max(holdMs, 2600));
}

/* ------------------------------ Round end ------------------------------ */

/* ROUND DEBRIEF (G9). endRound used to hand off to beginRound with nothing in
   between, so the player never saw what a round was worth: the Influence they
   actually banked, what the resource caps silently ate, or that Round 6 is
   Meltdown and holding the Garrison is no longer an option. Three facts the
   player cannot reconstruct from the log without doing arithmetic, presented
   once, at the only moment they can change anything about it (before the
   next draft).

   Deliberately a MODAL rather than an inline panel: it must not compete with
   showRoundBanner() for the same pixels, and a banner that races a dialog is
   a dialog nobody reads. The round number is folded into the TITLE so the
   banner's big "Round N" stays the only place it is announced.

   >>> IT NO LONGER SILENTLY NO-OPS (G4). The first line used to be
   >>> `if(!rec) return;`, so showRoundDebrief() with no arguments drew
   >>> NOTHING and returned undefined - which is exactly how the debrief went
   >>> missing from a capture: a caller (or a harness) invoked it bare and got
   >>> silence, indistinguishable from "the debrief is broken". Everything it
   >>> needs is already in `state.roundRec`, so a bare call now rebuilds the
   >>> record itself and the round's own heartbeat cannot be skipped by a
   >>> missing argument. `nextRound` defaults the same way. */
function debriefRecordFromState(){
  const s = state;
  if(!s || !Array.isArray(s.players) || !s.players.length) return null;
  const rec = s.roundRec || {};
  const prev = Array.isArray(rec.prevInfluence) && rec.prevInfluence.length === 2
    ? rec.prevInfluence.slice()
    : s.players.map(p=>p.influence);
  return {
    round: (typeof rec.round === 'number' && rec.round > 0) ? rec.round : s.round,
    picks: Array.isArray(rec.picks) ? rec.picks : [],
    skirmish: !!rec.skirmish,
    /* The TRUTH about a round nobody fought. `skirmish` is true for a declared
       HOLD BACK (that is the Pressure lever - see holdBackRound), so it cannot
       be the field the debrief asks to print "a Skirmish was fought". */
    heldBack: !!rec.heldBack,
    capped: rec.capped || {credits:0, ore:0, troops:0},
    prevInfluence: prev,
  };
}

/* >>> THE ROUND A DEBRIEF IS SUMMARISING, or 0 when no debrief is on screen.
   >>> Read by renderTurnBanner() for the phase label and written by
   >>> showRoundDebrief()'s open/close pair. Module-level, never on `state`:
   >>> it describes the DIALOG, not the game, and must not ride the JSON relay
   >>> to the online guest. */
let debriefOpenRound = 0;

function showRoundDebrief(rec, nextRound){
  if(!state) return;
  const r = rec || debriefRecordFromState();
  if(!r) return;
  /* `prevInfluence` is the round's STARTING Influence, and it is the only
     thing that makes "+3 this round" a delta rather than a running total. A
     record that lost it (a bare call mid-round, a feature that rebuilt
     roundRec) falls back to "same as now", which reports +0 instead of
     printing a lie. */
  const prev0 = Array.isArray(r.prevInfluence) && r.prevInfluence.length === 2
    ? r.prevInfluence : state.players.map(p=>p.influence);
  const nxt = (typeof nextRound === 'number' && nextRound > 0) ? nextRound : state.round + 1;
  const [a, b] = state.players;
  const capped = r.capped || {credits:0, ore:0, troops:0};
  const cappedTotal = (capped.credits|0) + (capped.ore|0) + (capped.troops|0);

  /* What the Skirmish actually paid, read off the round record rather than
     re-derived: the log line and the history entry are the same numbers the
     resolution actually moved, so the debrief cannot quote a different
     figure from the one that was banked. */
  const skirmishRows = state.players.map((p,i)=>{
    const gained = Math.max(0, p.influence - prev0[i]);
    return `<div style="font-size:12px">${esc(p.name)}: <b style="color:${gained>0?'var(--accent-cool-ink,#2c4d58)':'var(--muted)'}">`
      + `${p.influence} Influence</b> <span style="color:var(--muted)">(${gained>=0?'+':''}${gained} this round)</span></div>`;
  }).join('');

  const capLine = cappedTotal > 0
    ? `<div style="font-size:12px;margin-top:4px;color:#b5502e"><b>Caps ate ${cappedTotal} resource${cappedTotal!==1?'s':''}</b>`
      + ` this round &mdash; gained and immediately discarded, never banked. A site that pays more than you can hold is worth less than it reads.</div>`
    : '';

  const picks = (r.picks||[]).map(p=>{
    const t = (p.tier==='advanced') ? 'Adv' : 'Basic';
    return `<span class="debrief-pick">${locationName(p.locId)} <span style="color:var(--muted)">${t}</span></span>`;
  }).join('');

  /* OBJECTIVE PROGRESS. The debrief is the only moment between rounds, and an
     Objective that is one win from completion is a plan - it is not visible
     anywhere else except a HUD line the player has to remember. */
  const objLines = state.players.map(p=>{
    const obj = getObjective(p);
    if(!obj) return '';
    const met = obj.check(p);
    let progress = '';
    if(typeof obj.progress === 'function'){
      try{
        const pr = obj.progress(p) || {};
        if(pr.need > 1) progress = ` <span class="obj-progress">${pr.have} of ${pr.need} ${pr.unit||''}` +
          `${pr.note ? ` · ${pr.note}` : ''}</span>`;
      }catch(_){ /* a broken progress fn must not blank the debrief */ }
    }
    return `<div style="font-size:12px">${esc(p.name)} &mdash; ${obj.name}: `
      + `<span class="obj-status ${met?'met':''}">${met?`met (+${obj.bonus})`:'not yet'}</span>${progress} `
      + `<span style="color:var(--muted)">&mdash; ${obj.desc}</span></div>`;
  }).join('');

  /* What changes NEXT round is the actionable half. Three unlocks happen on
     fixed rounds and one of them (Meltdown) takes an option away rather than
     adding one - both are invisible until the player is already in the round
     they land in. A round with nothing new gets the generic line rather than
     an EMPTY "Coming up" box, which read as a broken panel.

     >>> D4: THESE THREE LINES ARE THE LAST WORD ON WHEN A MECHANIC BECOMES
     >>> LEGAL, and they used to advertise two that no longer exist - the All In
     >>> / Ghost wagers (cut: measured worth -1.5 and -2.1 Influence per seat,
     >>> and a bot that used them scored 11% worse than one that ignored them)
     >>> and Siege (cut with them). Each line is derived from the predicates
     >>> the engine actually tests - advancedUnlocked(), intrigueUnlocked(),
     >>> eventsUnlocked() and the Betrayal token's own rule in
     >>> js/feature-wagers.js - rather than from a list of what used to be
     >>> true, so a mechanic that is cut cannot leave a sentence behind. */
  const lookahead = [];
  if(nxt === 2) lookahead.push('<b>Round 2:</b> the <b>Advanced</b> tier and <b>Intrigue</b> cards unlock.');
  if(nxt === 3) lookahead.push('<b>Round 3:</b> <b>Round Events</b> start, <b>Betrayal tokens</b> pay +1, the <b>Rift</b> opens as a ninth site, and the first <b>Bounty</b> is published.');
  if(nxt === 5) lookahead.push('<b>Round 5:</b> a second <b>Betrayal token</b> and a second <b>Bounty</b>.');
  if(nxt === 6) lookahead.push('<b style="color:#8c1d18">MELTDOWN.</b> Caps rise, <b>every Advanced cost is free</b>, a <b>Surge</b> of 1&ndash;6 Influence is rolled at the top of the round &mdash; and if you take the Garrison you <b>must attack</b>. Holding back is not on the table.');
  if(!lookahead.length){
    lookahead.push(`<b>Round ${nxt}:</b> ${PHASE_LABEL_TEXT[phaseKey()] || 'no new mechanics'} &mdash; the Pressure clock keeps running and every site that pays more than you can hold is still worth less than it reads.`);
  }

  const dread = state.dread|0;
  const dreadLine = (nxt >= 4 && dread > 0)
    ? `<div style="font-size:12px;margin-top:4px;color:var(--muted)">Pressure stands at <b>${dread}</b>. A round with no Skirmish adds 2 &mdash; a <i>declared</i> Hold Back adds only 1.</div>` : '';

  showModal(`Round ${r.round} debrief`, `
    <div class="debrief-panel" id="roundDebrief" data-round="${r.round}">
      <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);font-weight:700">Where the round left you</div>
      ${skirmishRows}
      <div style="font-size:12px;margin-top:6px">${r.heldBack
        ? 'A Skirmish was <b>declared off</b> &mdash; the Garrison holder held back and banked +1 Influence instead. Pressure rose by 1, not 2.'
        : (r.skirmish
          ? 'A Skirmish was fought &mdash; the margin is in the log above.'
          : 'No Skirmish this round &mdash; whoever held the Garrison held back.')}</div>
      ${capLine}
      ${picks ? `<div style="font-size:12px;margin-top:6px;color:var(--muted)">Picks: ${picks}</div>` : ''}
      ${objLines ? `<div style="margin-top:8px">
        <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);font-weight:700">Objectives</div>
        ${objLines}</div>` : ''}
      ${dreadLine}
      <div class="debrief-lookahead" style="margin-top:10px;padding:8px 10px;border:1px solid var(--gold,#c98a2b);border-radius:6px;font-size:12px;line-height:1.55">
        <b>Coming up.</b><br>${lookahead.join('<br>')}</div>
      <div class="footer-actions" style="justify-content:flex-end;margin-top:12px">
        <button id="debriefNext">Continue</button>
      </div>
    </div>
  `, {dismissible:true});

  /* A failsafe, exactly as animateDiceRoll has one: the round must never be
     able to deadlock on a dialog the player did not open. Long enough to
     read, short enough that a distracted player is not stuck.

     Three things it must do, and the first two are what animateDiceRoll
     already does at its head (`let finished = false;` + a stored handle):

       1. LATCH. Without one, the armed timer fires a SECOND beginRound() for
          the round the player is already in the middle of. That is not a
          cosmetic double-advance: beginRound() wipes the board, rebuilds the
          pick queue and re-fires roundBegin, which re-draws the contested
          site, re-rolls the Rift target + mutation and the Round Event, and
          re-runs grantIncome - so by Round 3 or 5 the player is handed a
          second Betrayal token for a round they are already playing.
       2. clearTimeout the handle inside next(), so the button and the timer
          can never both get through.
       3. Check the round it belongs to. "Some modal is open" is not the
          question - "is the round I am the failsafe FOR still the round the
          game is in" is. A stale timer must never advance the game. */
  const debriefRound = state.round;
  /* >>> THE DECLARATION THIS FLAG WAS MISSING. renderTurnBanner() reads
     >>> `debriefOpenRound` to label the phase line "Round N debrief" while the
     >>> summary is on screen, but the name had never been declared anywhere in
     >>> the file: `node --check` passed (it is a runtime ReferenceError, not a
     >>> syntax error) and EVERY renderAll() threw
     >>> `ReferenceError: debriefOpenRound is not defined` - so the whole board
     >>> failed to paint on the opening beginRound() and nothing else in the
     >>> file could be exercised. It is a module-level flag, NOT state: it never
     >>> crosses the JSON relay, it only names the dialog currently on screen.
     >>> Set when the debrief opens, cleared the moment it closes. */
  debriefOpenRound = r.round;
  let advanced = false;
  let failsafe = null;
  const next = ()=>{
    if(advanced) return;
    advanced = true;
    if(failsafe !== null){ clearTimeout(failsafe); failsafe = null; }
    debriefOpenRound = 0;
    hideModal();
    /* A debrief shown for a game that has ALREADY ended (a bare call from the
       end screen, or a late snapshot) must not start a seventh round: the
       failsafe would otherwise hand the player a board nobody can finish. */
    if(state && state.phase === 'ended'){ renderAll(); return; }
    beginRound();
  };
  const btn = document.getElementById('debriefNext');
  if(btn) btn.onclick = next;
  /* >>> L3. THE DEBRIEF ATE ~84 SECONDS OF EVERY 90-SECOND DEMO.
     >>> Measured unattended, at every bot speed: 13.8s of no screen change per
     >>> round, and Instant vs Fast differing by ~3s across a whole game - because
     >>> this single modal dominated both. In a demo there is nobody to click
     >>> Continue, so the failsafe is the ONLY thing that ever advances the round,
     >>> and it was set for a human reading speed.
     >>>
     >>> So the timer is now chosen by WHO IS WATCHING:
     >>>   human / host / online : 14,000ms - UNCHANGED, Continue button unchanged
     >>>   demo                 : 2,600ms
     >>>
     >>> NOTHING about the latch or the round guard changes: `advanced` still gates
     >>> the button AND the timer, the handle is still cleared inside next(), and
     >>> the stale-round guard in the callback below is untouched. The demo just
     >>> reaches that same guarded path sooner. The Continue button also stays in
     >>> a demo on purpose - a spectator SHOULD be able to hold the round open,
     >>> and a human watching can always click it instead of waiting. */
  const demoDebriefMs = (state.mode === 'demo') ? 2600 : 14000;
  failsafe = setTimeout(()=>{
    failsafe = null;
    if(advanced) return;
    /* Not this round's debrief any more - whatever is on screen belongs to
       somebody else and must not be advanced by a leftover timer. */
    if(!state || state.round !== debriefRound) return;
    const modal = document.getElementById('skirmishModal');
    if(!modal || modal.classList.contains('hidden')) return;
    next();
  }, demoDebriefMs);
  OD.Sound.play('turn.pass');
}

function endRound(){
  state.players.forEach(p=>{ reportCaps(p, applyCaps(p)); });

  /* Snapshot the Influence the round STARTED from, before anything below can
     move it. The debrief's "+3 this round" has to be the round's own delta,
     not a running total re-labelled as one. */
  const prevInfluence = (state.roundRec && Array.isArray(state.roundRec.prevInfluence))
    ? state.roundRec.prevInfluence.slice()
    : state.players.map(p=>p.influence);

  /* Record the round before anything can end the game, so a feature reading
     `state.history` in gameEnd sees every round including this one.

     The entry is kept as a LIVE OBJECT, not a literal pushed and forgotten,
     because the final round's objective payout happens further down and used
     to land AFTER the history snapshot: the trajectory's last row showed the
     pre-bonus score, so a game won 18-14 with a +4 objective read as "16-14"
     on the round-by-round table - the one screen whose entire job is to tell
     the truth about where the margin came from. `objectiveBonus` records what
     the payout actually was, per player, so the end screen can attribute the
     swing instead of guessing. All plain JSON: this is the online relay. */
  const historyEntry = {
    round: state.round,
    influence: state.players.map(p=>p.influence),
    gained: state.players.map((p,i)=> p.influence - prevInfluence[i]),
    resources: state.players.map(p=>({credits:p.credits, ore:p.ore, troops:p.troops})),
    event: state.currentEvent,
    picks: (state.roundRec && state.roundRec.picks) ? state.roundRec.picks.slice() : [],
    skirmish: !!(state.roundRec && state.roundRec.skirmish),
    /* Whether that `skirmish: true` was a fight or a DECLARED hold-back. Both
       readers of this entry (the debrief and the end-screen trajectory) print
       a sentence from it, and a trajectory that says "yes" for a round nobody
       fought is the same lie the debrief just learned to avoid. */
    heldBack: !!(state.roundRec && state.roundRec.heldBack),
    capped: (state.roundRec && state.roundRec.capped)
      ? {credits:(state.roundRec.capped.credits|0), ore:(state.roundRec.capped.ore|0), troops:(state.roundRec.capped.troops|0)}
      : {credits:0, ore:0, troops:0},
    objectiveBonus: [0, 0],
  };
  state.history.push(historyEntry);

  /* Re-read the live score into the entry just pushed. Called after the
     roundEnd hooks and after the objective payout, because BOTH can move
     Influence: a Round-5 Bounty pays +2 and a Collapse takes 2 off the leader
     from inside a hook, so the snapshot taken at push time understated the
     round by exactly the amount the feature paid. `gained` is therefore
     derived here rather than at push time - it is the round's real delta, and
     the trajectory's "(+7)" column is the difference between the two rounds'
     snapshots either way. */
  const syncHistoryEntry = ()=>{
    historyEntry.influence = state.players.map(p=>p.influence);
    historyEntry.gained = historyEntry.influence.map((v,i)=> v - prevInfluence[i]);
    historyEntry.resources = state.players.map(p=>({credits:p.credits, ore:p.ore, troops:p.troops}));
  };

  /* Features get the round-end hook BEFORE the objective payout and before
     the game can end, so a feature can still act on a live board.

     This is also what makes a Round-5 Bounty pay: the Bounty is resolved by a
     roundEnd hook (feature-chaos.js, priority 10 so it outranks the Pressure
     tick at -5), and it runs HERE - inside the round, before the
     `state.round >= TOTAL_ROUNDS` branch below. A Round 5 Bounty is
     therefore always paid, and is paid before a Round-5 Collapse can swallow
     the Influence it was worth. */
  if(canRunExtensions()){
    OD.Ext.hooks.run('roundEnd', extCtx('draft', -1));
    OD.Ext.effects.run('roundEnd', extCtx('draft', -1));
  }
  syncHistoryEntry();

  if(state.round >= TOTAL_ROUNDS){
    state.players.forEach((p,i)=>{
      const obj = getObjective(p);
      if(obj && obj.check(p)){
        p.influence += obj.bonus;
        historyEntry.objectiveBonus[i] = obj.bonus;
        log(`${esc(p.name)} completes their objective <b>${obj.name}</b> -> +${obj.bonus} Influence.`);
        OD.Sound.play('objective.met');
      }
    });
    /* Re-sync the round-6 entry with the score the game actually ended on, so
       the trajectory's last row IS the final tally rather than the tally minus
       the objective bonus. */
    syncHistoryEntry();
    state.phase = 'ended';
    if(canRunExtensions()) OD.Ext.hooks.run('gameEnd', extCtx(null, -1));
    renderAll();
    showEndScreen();
  } else {
    state.round += 1;
    state.phase = 'draw';
    renderAll();
    /* DEBRIEF, then the next round. beginRound() is called from the dialog's
       Continue button rather than inline, so the summary is actually read
       instead of being painted over by the Round banner one frame later.
       `prevInfluence` rides on roundRec so the next round's own snapshot does
       not inherit it. */
    showRoundDebrief({
      round: state.round - 1,
      picks: (state.roundRec && state.roundRec.picks) ? state.roundRec.picks : [],
      skirmish: !!(state.roundRec && state.roundRec.skirmish),
      capped: (state.roundRec && state.roundRec.capped) ? state.roundRec.capped : null,
      prevInfluence,
    }, state.round);
  }
}

/* -------------------------------- Modal -------------------------------- */

/* dismissible:true adds a close (X) button plus backdrop-click / Escape
   support - used for informational modals like Rules. Decision modals
   (Skirmish attack/hold, troop commit) are NOT dismissible: they represent a
   choice the game needs to continue, so they're only closed by picking one
   of their own action buttons, same as before.

   FOCUS TRAP + FOCUS RESTORE (G6). index.html already ships
   role="dialog" aria-modal="true" aria-labelledby aria-describedby on
   #skirmishModal and `tabindex="-1"` on its .box, so the semantics are
   declared and the BEHAVIOUR has to be owned here - it cannot be done in
   CSS, and without it a keyboard player tabs straight out of an open modal
   into the board behind it and silently changes the game. Two halves:
     * RESTORE - on open remember document.activeElement; on close put focus
       back on it. Without this, dismissing the Rules modal drops focus to
       <body> and the player's place in the tab order is gone.
     * TRAP  - Tab / Shift+Tab cycle within the .box, so the modal is a
       closed world until it is answered or dismissed.
   Focus is moved into the .box itself (not the first control) because
   showModal is called with freshly-built innerHTML and the first control is
   not always a real target; .box carries tabindex="-1" for exactly this.
   OD.Fx.reduceMotion() skips the rAF deferral, which is an animation-timing
   affordance, not an accessibility one - focus must land synchronously
   for a screen reader that reads on the same tick. */
const MODAL_FOCUSABLE = [
  'a[href]', 'button', 'input', 'select', 'textarea',
  '[tabindex]:not([tabindex="-1"])',
].join(',');
/* The element focus returns to when the modal closes. Set on every OPEN
   (not on the first open) so a modal opened from inside another modal - the
   Rules modal from a commit modal is the real case - restores to the control
   that opened it rather than to a detached node. */
let modalReturnFocus = null;
/* >>> TABBABLE, NOT JUST FOCUSABLE. This predicate is the whole D3 fix.
   modalFocusables() used to answer "is this element focusable?", and for a
   group of <button>s that is the wrong question. The Rules tabs are a roving
   tabindex: all seven are <button role="tab">, so every one of them passed
   `button` in the selector and the -1 ones were handed to the wrap logic as if
   they were stops. Consequences, measured:
       Tab 1: #modalCloseBtn        IN-MODAL=true
       Tab 2: #rules-tab-objective  IN-MODAL=true
       Tab 3: BODY                  IN-MODAL=false   <<< ESCAPED
   items[last] was a tab that can never hold focus, so the forward-wrap branch
   (`inside===items.length-1`) never fired; the handler returned without
   preventDefault, and Chrome's own Tab walked past the six tabindex="-1" tabs
   and out of an aria-modal="true" dialog. A player could then start drafting
   behind an open Rules dialog.

   So the cycle is normalised to real stops: an element qualifies only if it is
   focusable AND still in the tab order. An explicit tabindex="-1" takes a
   button back OUT of the cycle, which is the entire point of a roving group.
   `.disabled` stays excluded (a disabled form control is focusable-flagged but
   untabbable), and `aria-disabled` does NOT - an aria-disabled control is
   deliberately still a stop, because it is the only way its "why not" can be
   read. The commit modal has no roving group, so its cycle is unchanged. */
function modalTabbable(el){
  if(!el || el.disabled) return false;
  const ti = el.getAttribute('tabindex');
  if(ti !== null && parseInt(ti, 10) < 0) return false;
  if(el.getAttribute('aria-hidden') === 'true') return false;
  /* offsetParent is null for a display:none subtree. */
  return el.offsetParent !== null;
}
function modalFocusables(){
  const box = document.getElementById('skirmishModal').querySelector('.box');
  if(!box) return [];
  return Array.prototype.filter.call(box.querySelectorAll(MODAL_FOCUSABLE), modalTabbable);
}
/* ---- MODAL TITLES ARE PLAIN TEXT -------------------------------------------
   CONTRACT: the `title` argument to showModal() is PLAIN TEXT. It is assigned
   with .textContent, so `<`, `&`, `>` and friends are inert and can never
   become markup - the title has never been a sink.

   That safety is exactly why an HTML entity in a title is displayed literally:
   a caller who wrote showModal('Contested &mdash; Buy the site?') rendered the
   characters "&mdash;" in the title bar, because textContent does not decode
   entities (it is innerHTML that decodes them, and innerHTML is not used here).
   The caller is not always this file - js/feature-wagers.js passes titles of
   its own - so showModal decodes the entities it understands on the way in,
   and leaves everything else untouched.

   New callers should pass the CHARACTER (an em dash, not "&mdash;"), not an
   entity. Decoding here is a compatibility shim for existing call sites, not
   an invitation.

   The whitelist is deliberately small and named-only: `&amp; &lt; &gt;` are
   included because they are the ones that make a literal-looking string
   actually correct ("Bob &amp; Co" is "Bob & Co"), and numeric references are
   accepted because they decode to a single character, which .textContent then
   renders as that character rather than as markup. Anything unrecognised is
   passed through unchanged, so an unknown entity can never be silently eaten. */
const TITLE_ENTITY_CHARS = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', minus: '\u2212',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  laquo: '\u00ab', raquo: '\u00bb', bull: '\u2022', middot: '\u00b7',
  times: '\u00d7', deg: '\u00b0', copy: '\u00a9', reg: '\u00ae',
  trade: '\u2122', rarr: '\u2192', larr: '\u2190', ne: '\u2260',
});
function decodeTitleEntities(title){
  if(typeof title !== 'string' || title.indexOf('&') === -1) return (typeof title === 'string') ? title : '';
  return title.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, name)=>{
    if(name.charAt(0) === '#'){
      const hex = (name.charAt(1) === 'x' || name.charAt(1) === 'X');
      const code = hex ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if(!isFinite(code) || code <= 0 || code > 0x10FFFF) return match;
      try{ return String.fromCodePoint(code); }
      catch(_){ return match; }
    }
    const key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(TITLE_ENTITY_CHARS, key) ? TITLE_ENTITY_CHARS[key] : match;
  });
}
function showModal(title, bodyHtml, opts={}){
  const dismissible = !!opts.dismissible;
  const modal = document.getElementById('skirmishModal');
  const box = modal.querySelector('.box');
  const wasHidden = modal.classList.contains('hidden');
  if(wasHidden) modalReturnFocus = document.activeElement;
  document.getElementById('skirmishTitle').textContent = decodeTitleEntities(title);
  document.getElementById('skirmishBody').innerHTML = bodyHtml;
  document.getElementById('modalCloseBtn').classList.toggle('hidden', !dismissible);
  modal.dataset.dismissible = dismissible ? '1' : '0';
  box.classList.toggle('rules-box', !!opts.rules);
  modal.classList.toggle('is-rules', !!opts.rules);
  /* A WIDE box, for the one screen that has to show a troop slider, an odds
     preview, a wager stance and a whole hand of cards at once. */
  modal.classList.toggle('is-wide', !!opts.wide);
  modal.classList.remove('hidden');
  document.getElementById('skirmishBody').scrollTop = 0;
  /* Focus lands in the dialog on every open, not only the dismissible ones:
     a Skirmish Decision modal is the ONE place where a keyboard player must
     not be able to wander into the board underneath.

     >>> AND IT LANDS SOMEWHERE VISIBLE (D3). Measured: focus went to `.box`,
     whose tabindex="-1" matches the stylesheet's bare `:focus{outline:none}`
     and NOT `:focus-visible` (it was moved by script, not by Tab), so the
     computed outline was `none` - the first thing a keyboard player saw on
     every dialog was no indicator at all, and on the Rules dialog the very
     next Tab moved them somewhere else entirely. A real control carries the
     existing `:focus-visible` ring, so the first stop in the dialog is now the
     first TABBABLE thing in it (the Rules close button, the commit slider),
     with `.box` kept only as the fallback for a dialog that has no controls.
     The ring still obeys :focus-visible, so a player who opened the dialog
     with a mouse does not get one. */
  const enter = ()=>{
    const first = modalFocusables()[0];
    if(first && typeof first.focus === 'function'){
      try{ first.focus(); return; }catch(_){ /* fall through to the .box pad */ }
    }
    if(box && typeof box.focus === 'function') box.focus();
  };
  /* Defer focus so the click that opened the modal doesn't immediately
     re-trigger, and so a caller that binds handlers AFTER showModal() (the
     commit modal does) is finished by the time focus resolves. Skipped
     under prefers-reduced-motion: the deferral exists for event ordering,
     not for animation. */
  if(typeof OD !== 'undefined' && OD.Fx && typeof OD.Fx.reduceMotion === 'function' && OD.Fx.reduceMotion()) enter();
  else if(typeof requestAnimationFrame === 'function') requestAnimationFrame(enter);
  else enter();
}
/* >>> D4: THE CLICK SHIELD — the third layer under the commit guard, and the
   only one that stops the second click BEFORE it reaches a handler.

   The defect was never really "the handler ran twice". It was "the DOM under
   the player's finger changed, and the new DOM had a live button in the same
   place". Every dialog in this game is ONE reused #skirmishModal whose body is
   rewritten in place, so a double-click's second click is aimed at a control
   that did not exist when the first click landed: the other seat's Commit, the
   next round's board tile, the next dialog's Continue. A latch inside the
   handler that was destroyed cannot see that, which is why the fix that
   shipped first did not work.

   So the shield is raised by hideModal() - the single choke point EVERY
   phase-advancing dialog in the game closes through, including the two this
   file does not own (js/feature-wagers.js's Quiet Round answer goes through
   the OD.WagersBridge, and the dice reveal's own finish()). It is a
   transparent, unfocusable, text-free layer over the whole dialog for
   MODAL_SHIELD_MS, so the replaying click hits nothing at all.

   #skirmishModal is `position:fixed; inset:0`, so an absolutely positioned
   child covers the dialog AND the scrim around it; z-index 60 puts it above
   .box in the paint order, which is what actually wins the hit test. It is
   `aria-hidden` and carries no tabindex, so it adds nothing to the tab order
   or to the accessibility tree - the keyboard path is covered by the
   per-handler latch instead.

   THE WINDOW. 400ms, chosen from a measurement rather than a feel: the
   playtest drove double-clicks at gaps of 40, 80, 120, 200 and 320ms and the
   defender was committed at EVERY one, so the shield has to outlast the widest
   gap a real double-click produces with room to spare. It is deliberately not
   enforced anywhere else - see commitIsReplayed() for why a guard that also
   refused commits on a clock had to be taken back out.

   `{shield:false}` opts out, and is used only where closing the dialog is a
   pure UI action that advances nothing: the close button, the scrim and
   Escape. Those are reachable from the Rules modal, where a 400ms dead zone on
   the board behind it would be felt as a dropped click. */
const MODAL_SHIELD_MS = 400;
function shieldModalClicks(ms){
  const modal = document.getElementById('skirmishModal');
  if(!modal || typeof modal.appendChild !== 'function') return null;
  if(typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  let sh = null;
  try{
    sh = document.createElement('div');
    sh.id = 'odClickShield';
    sh.setAttribute('aria-hidden', 'true');
    sh.style.cssText = 'position:absolute;inset:0;z-index:60;background:transparent;';
    modal.appendChild(sh);
  }catch(_){ return null; }
  const drop = ()=>{
    try{
      if(sh.parentNode && typeof sh.parentNode.removeChild === 'function') sh.parentNode.removeChild(sh);
      else if(typeof sh.remove === 'function') sh.remove();
    }catch(_){ /* the dialog went away first; nothing to clean up */ }
  };
  setTimeout(drop, (typeof ms === 'number' && ms > 0) ? ms : MODAL_SHIELD_MS);
  return drop;
}

function hideModal(opts={}){
  const modal = document.getElementById('skirmishModal');
  if(!opts || opts.shield !== false) shieldModalClicks(opts && opts.ms);
  modal.classList.add('hidden');
  modal.classList.remove('is-rules');
  modal.classList.remove('is-wide');
  const box = modal.querySelector('.box');
  if(box) box.classList.remove('rules-box');
  /* RESTORE. The element may have been re-rendered away in the meantime
     (a board tile the click destroyed, a card that was played), so
     isConnected is checked and a detach degrades to focus on the game
     container rather than silently dropping focus to <body>. */
  const back = modalReturnFocus;
  modalReturnFocus = null;
  if(back && back.isConnected && typeof back.focus === 'function'){
    try{ back.focus(); return; }catch(_){ /* fall through */ }
  }
  const frame = document.getElementById('boardFrame');
  if(frame && typeof frame.focus === 'function'){ try{ frame.focus(); }catch(_){} }
}
/* >>> PAGE WIRING MARKER. Everything from here to the end of the file is
   >>> page wiring — element lookups and event binding — plus the pure
   >>> function definitions interleaved with it. Each block of wiring is
   >>> wrapped in onDom() so this file can also be LOADED UNDER NODE, with no
   >>> DOM of any kind, by test/sites.test.js. That test exists to assert this
   >>> file's LOCATIONS against js/feature-chaos.js's SITES table, and a
   >>> structural guarantee that cannot be loaded cannot be asserted. onDom()
   >>> is true in every browser, so page behaviour is unchanged. */
function onDom(fn){ if(typeof document !== 'undefined' && typeof window !== 'undefined') fn(); }

onDom(()=>{
/* The three ways out that ADVANCE NOTHING opt out of the click shield: the
   close button, a click on the scrim, and Escape. All three are reachable from
   the Rules dialog, where a 400ms dead zone over the board would be felt as a
   dropped click rather than as protection. Every other close is a move in the
   game, and keeps the shield. */
document.getElementById('modalCloseBtn').addEventListener('click', ()=> hideModal({shield:false}));
document.getElementById('skirmishModal').addEventListener('click', (e)=>{
  if(e.target.id==='skirmishModal' && e.currentTarget.dataset.dismissible==='1') hideModal({shield:false});
});
/* The trap itself. A keydown listener on the modal (not on document) so it
   only runs while the modal is open, and so the game's other document-level
   keydown handlers are unaffected. Wrapped in try/catch: a focus failure
   must not be able to block a Tab, because a stuck Tab is worse than no
   trap at all. */
document.getElementById('skirmishModal').addEventListener('keydown', (e)=>{
  if(e.key!=='Tab') return;
  if(e.currentTarget.classList.contains('hidden')) return;
  const items = modalFocusables();
  if(items.length===0){
    /* Nothing tabbable inside (a pure-message modal). Keep focus on the
       dialog itself rather than letting Tab escape to the page. */
    e.preventDefault();
    const box = e.currentTarget.querySelector('.box');
    if(box && typeof box.focus === 'function') box.focus();
    return;
  }
  const first = items[0], last = items[items.length-1];
  const active = document.activeElement;
  const inside = items.indexOf(active);
  /* >>> FOCUS CAN LAND ON SOMETHING THAT IS NOT A STOP, AND STILL BE INSIDE.
     Two ways: `.box` itself (tabindex="-1", the landing pad) and any element of
     a roving group that has been arrowed away from (tabindex="-1"). In both
     cases the browser's own "next tabbable" is computed from a node that is
     NOT in the cycle, so it leaves the dialog. So when focus is not on a stop
     we stop delegating and pick the stop ourselves: the first one AFTER the
     active node in document order, or wrap to the head; backwards, the last
     one before it, or wrap to the tail. */
  const afterActive = (node)=>{
    if(!node || typeof node.compareDocumentPosition !== 'function') return null;
    for(let i=0;i<items.length;i++){
      if(items[i].compareDocumentPosition(node) & 4 /* DOCUMENT_POSITION_FOLLOWING */) return items[i];
    }
    return null;
  };
  const beforeActive = (node)=>{
    if(!node || typeof node.compareDocumentPosition !== 'function') return null;
    for(let i=items.length-1;i>=0;i--){
      if(items[i].compareDocumentPosition(node) & 2 /* DOCUMENT_POSITION_PRECEDING */) return items[i];
    }
    return null;
  };
  let next = null;
  if(inside === -1){
    /* Not a stop: forward takes the next stop after it, backward the one
       before it, and either end of the dialog wraps. This is what keeps a
       roving tabindex group from being an exit. */
    if(e.shiftKey) next = beforeActive(active) || last;
    else next = afterActive(active) || first;
  } else if(e.shiftKey){
    /* Shift+Tab off the head wraps to the tail. */
    if(inside<=0) next = last;
  } else if(inside===items.length-1){
    next = first;
  }
  /* In the middle of the cycle we return without preventDefault and let the
     browser move: re-implementing ordinary forward motion is how a trap ends
     up skipping controls or looping on one. */
  if(!next) return;
  e.preventDefault();
  try{ next.focus(); }catch(_){ /* never swallow the Tab entirely */ }
});
document.addEventListener('keydown', (e)=>{
  const modal = document.getElementById('skirmishModal');
  if(e.key==='Escape' && !modal.classList.contains('hidden') && modal.dataset.dismissible==='1') hideModal({shield:false});
});
});

/* Floating "+3 Credits"-style badge near a player's HUD card. Appended to
   body (not inside a container that gets innerHTML-replaced) so its CSS
   animation can finish and remove it without being interrupted by a
   re-render, then it removes itself once the animation ends. */
const activePopupCount = {}; // playerIdx -> concurrently visible popups, so they stack instead of overlapping illegibly
function popupGain(playerIdx, text, good){
  if(good) sfx.gain();
  const cardEl = document.querySelector(`#playerCards .player-card.p${playerIdx+1}`);
  if(!cardEl) return;
  const rect = cardEl.getBoundingClientRect();
  const stack = activePopupCount[playerIdx] || 0;
  activePopupCount[playerIdx] = stack + 1;
  const el = document.createElement('div');
  /* `is-stacked` on every popup after the first: css/style.css already carried a
     rule for it that nothing had ever set, because a stack that looks exactly
     like a lone popup is not a stack. */
  el.className = `gain-popup ${good?'good':'bad'}${stack ? ' is-stacked' : ''}`;
  el.textContent = text;
  /* >>> L2. THREE POPUPS AT ONCE PRINTED ON TOP OF EACH OTHER AND ON TOP OF THE
     >>> STAT CHIPS. Two separate faults, both in the three lines this replaces:
     >>>
     >>> 1. `rect.top - stack*22` walks UP from the card's top edge, and the
     >>>    Credits/Ore/Troops/Cards chips are the SECOND row INSIDE that same
     >>>    card (renderPlayerCards: `.player-card > .name` then `.stats`). So the
     >>>    first popup printed across its own chip row, and the second popup for
     >>>    a seat printed across the chips of the card ABOVE it.
     >>> 2. 22px of pitch is smaller than a popup's own line box, so even two
     >>>    popups on one seat overprinted each other by construction.
     >>>
     >>> The stack now starts BELOW the chip row and grows DOWNWARD, with the
     >>> pitch taken from the popup's own measured height rather than a magic
     >>> number - so two popups cannot share a pixel at any font size. It only
     >>> grows upward when a downward run would leave the viewport, and `left` is
     >>> clamped so a long line ("Intrigue: Sabotage (-2)") cannot hang off the
     >>> side of the screen.
     >>>
     >>> Minimal and additive: `activePopupCount`, `cleanup`, the animationend
     >>> listener and the 1500ms fallback are all untouched. */
  const chipRow = cardEl.querySelector('.stats');
  const chipRect = chipRow ? chipRow.getBoundingClientRect() : null;
  const chipTop = chipRect ? chipRect.top : rect.top;
  const baseTop = (chipRect ? chipRect.bottom : rect.top) + 4;
  document.body.appendChild(el);   /* appended before measuring: a popup's own
                                      height is what sets the next one's row. */
  const vw = window.innerWidth  || document.documentElement.clientWidth  || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const GAP = 4;
  const popH = el.offsetHeight || 24;
  const popW = el.offsetWidth  || 60;
  /* >>> The on-screen clamp, and why the base must NOT depend on `stack`.
     >>> Every earlier attempt here was wrong in the same instructive way: the
     >>> base was re-derived per row (as `vh-4-span-popH`, then as
     >>> `baseTop-overflow` where overflow itself contained `stack*row`), so the
     >>> `stack*row` term cancelled and every popup in a deep stack landed on the
     >>> SAME y. Measured at 1280x720: "+2 Ore" and "Skirmish: Fortify" both
     >>> printed at top=693. The base is now computed from `baseTop` and `popH`
     >>> only - nothing that varies with the row - so it is identical for every
     >>> popup of the same seat, and `row` genuinely separates them. Seat 1,
     >>> which had room below its chips, stacked correctly at 30px pitch
     >>> throughout.
     >>>
     >>> `maxRack` is how many rows the rack reserves space for. Past that, a
     >>> row can run past the bottom edge rather than overprint its neighbour -
     >>> the lesser of the two failures, and self-clearing in 1.5s.
     >>>
     >>> AND THE FLIP. A lower seat's card can sit low enough that its chip row
     >>> straddles the fold - measured at 1280x720, seat 2's chips run y=599 to
     >>> y=749 on a 720px viewport - and then "below the chips" and "on screen"
     >>> are the same requirement, not two. Measured before this: seat 2's two
     >>> popups were clear of each other and inside the viewport, and both
     >>> landed ON the chip row. So when there is no room for the rack below the
     >>> chips, the rack goes ABOVE them instead, growing upward from the chip
     >>> row's top edge - over the seat's own name row, which is the player's own
     >>> card and not the numbers the popup is annotating. */
  const row = popH + GAP;
  const maxRack = 3;
  const rackRoom = popH + maxRack * row;
  const roomBelow = !vh || (baseTop + rackRoom <= vh - 4);
  const base = roomBelow
    ? Math.max(4, Math.min(baseTop, vh - 4 - rackRoom))
    : chipTop - GAP - popH;          /* flipped: rows climb from here */
  const top = roomBelow ? base + stack * row : base - stack * row;
  const centre = rect.left + rect.width/2;
  const half = popW/2;
  el.style.left = `${(!vw) ? centre : Math.min(Math.max(centre, half + 4), vw - half - 4)}px`;
  el.style.top = `${Math.max(4, top)}px`;
  const cleanup = ()=>{ activePopupCount[playerIdx] = Math.max(0, (activePopupCount[playerIdx]||1)-1); el.remove(); };
  el.addEventListener('animationend', cleanup);
  setTimeout(()=>{ if(el.isConnected) cleanup(); }, 1500); // fallback if animationend never fires
}

/* Styled inline notice, anchored top-centre of the viewport. Replaces the
   blocking alert() the online relay used for a peer disconnect: a dropped
   socket is information, not a modal emergency, and freezing the page for
   it loses the game state the player can still see. `sticky` notices (a
   missing action button) stay until replaced; everything else self-clears
   on a timer, matching the popup pattern above. */
function showNotice(message, opts){
  const o = opts || {};
  if(typeof document === 'undefined' || !document.body) return;
  const id = o.id || 'odNotice';
  const old = document.getElementById(id);
  if(old) old.remove();

  const el = document.createElement('div');
  el.id = id;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.textContent = message;
  el.style.cssText = [
    'position:fixed', 'top:16px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:10000', 'max-width:min(560px,92vw)', 'padding:12px 20px',
    'border-radius:10px', 'border:1px solid var(--gold,#c98a2b)',
    'background:var(--panel,#fff)', 'color:var(--ink,#222)',
    'box-shadow:0 6px 24px rgba(0,0,0,.18)', 'font-size:14px', 'font-weight:600',
    'text-align:center', 'pointer-events:none',
  ].join(';');
  document.body.appendChild(el);
  OD.Fx.shake(el, {amp: 6, ms: 320});

  if(!o.sticky){
    setTimeout(()=>{ if(el.isConnected) el.remove(); }, o.ms || 4200);
  }
  return el;
}

/* Big dramatic "Round N begins" banner - shown once per round, purely
   cosmetic, removes itself after its CSS animation finishes. */
function showRoundBanner(text){
  const old = document.getElementById('roundBanner');
  if(old) old.remove();
  const el = document.createElement('div');
  el.id = 'roundBanner';
  el.textContent = text;
  document.body.appendChild(el);
  el.addEventListener('animationend', ()=> el.remove());
  setTimeout(()=>{ if(el.isConnected) el.remove(); }, 2200);
}

const ICONS = {
  /* The Credits glyph is a "C", not a "$": the resource is called Credits
     everywhere in prose (board labels, rules, log lines) and a dollar sign
     implied a second, different notation. */
  credits: '<svg width="14" height="14" viewBox="0 0 16 16" style="vertical-align:-2px;margin-right:4px"><circle cx="8" cy="8" r="6" fill="none" stroke="#c98a2b" stroke-width="2"/><text x="8" y="11" text-anchor="middle" fill="#c98a2b" font-size="8" font-weight="bold">C</text></svg>',
  ore: '<svg width="14" height="14" viewBox="0 0 16 16" style="vertical-align:-2px;margin-right:4px"><path d="M8 1 L14 5 L11.5 14 H4.5 L2 5 Z" fill="none" stroke="#6b7a4a" stroke-width="1.6"/></svg>',
  troops: '<svg width="14" height="14" viewBox="0 0 16 16" style="vertical-align:-2px;margin-right:4px"><path d="M8 1 L13 3.5 V8 C13 11.5 8 15 8 15 C8 15 3 11.5 3 8 V3.5 Z" fill="#b5502e"/></svg>',
  cards: '<svg width="14" height="14" viewBox="0 0 16 16" style="vertical-align:-2px;margin-right:4px"><rect x="3" y="2" width="10" height="12" rx="1.5" fill="none" stroke="#8a5aa8" stroke-width="1.6"/><line x1="6" y1="6" x2="10" y2="6" stroke="#8a5aa8" stroke-width="1.2"/><line x1="6" y1="9" x2="10" y2="9" stroke="#8a5aa8" stroke-width="1.2"/></svg>',
  influence: '<svg width="14" height="14" viewBox="0 0 16 16" style="vertical-align:-2px;margin-right:4px"><path d="M8 1 L9.5 6 H15 L10.5 9.2 L12 14.5 L8 11 L4 14.5 L5.5 9.2 L1 6 H6.5 Z" fill="#5a7a3a"/></svg>',
};
function icon(name){ return ICONS[name] || ''; }

/* Display name for a site id, including the Rift - which is deliberately NOT
   in LOCATIONS, so a bare `LOCATIONS.find` would print "rift". Used by the
   round debrief and the end-screen trajectory, both of which report picks by
   id. */
function locationName(locId){
  const real = LOCATIONS.find(l=>l.id===locId);
  if(real) return real.name;
  if(locId==='rift') return 'The Rift';
  return locId;
}

const LOC_ICONS = {
  market:   {icon:'credits',   bg:'#f0ddc0'},
  bazaar:   {icon:'credits',   bg:'#f0ddc0'},
  quarry:   {icon:'ore',       bg:'#e4e6d4'},
  foundry:  {icon:'ore',       bg:'#e4e6d4'},
  garrison: {icon:'troops',    bg:'#f5d8c8'},
  outpost:  {icon:'influence', bg:'#f5dea0'},
  shrine:   {icon:'influence', bg:'#f5dea0'},
  archive:  {icon:'cards',     bg:'#ece0f5'},
  /* >>> CHAOS (feature-chaos.js) - the ninth site. It is NOT in LOCATIONS
     (that array is the board template and is also quoted by the rules copy),
     so the renderer used to never draw it - while botChoosePick COULD pick
     it. That is a bot drafting a tile no human can see: an unfair, broken
     board. Every tile id the renderer can emit now resolves here, which is
     the invariant the integration harness asserts. Purple + a "cards"
     glyph reads as "not one of the eight" without needing a new stylesheet. */
  rift:     {icon:'cards',     bg:'#d8c8ea'},
};

/* Every tile id the renderer can emit, resolved from LOC_ICONS. Used as a
   hard guard in renderBoard (a missing entry used to throw on `bg` of
   undefined) and by the integration harness. */
function locIconFor(locId){
  return LOC_ICONS[locId] || {icon:'influence', bg:'#e8e2d4'};
}

/* -------------------------------- Render -------------------------------- */

/* Feature-contributed HUD widgets. The container is created lazily and only
   when a feature has actually registered a panel, so with no features
   enabled this costs one `has()` check and touches the DOM not at all.

   >>> WHAT IS WORTH SHOWING IS THE RENDER LAYER'S CALL. OD.Ext.panels is a
   >>> SEAM, not a contract on the page: a feature answers "nothing to report"
   >>> with a placeholder rather than with nothing - feature-chaos.js returns
   >>> '' for an inactive Meltdown, the muted words "quiet", "none standing"
   >>> and "closed" for an unstarted Pressure clock, a bounty that is not
   >>> standing and a Rift that has not opened. js/game.js used to print those
   >>> placeholders verbatim, so a Round 1 board carried a stack of
   >>> PRESSURE / BOUNTY / MELTDOWN / RIFT chips that said nothing at all, plus
   >>> a "Wagers" line that dumped both seats' engine internals under the mats.
   >>> A chip that is present-and-zero is noise, so a panel with no live fact
   >>> behind it is not rendered at all.

   >>> IT LIVES WITH THE ROUND, NOT UNDER THE MATS. It used to be appended to
   >>> #playerCardsPanel, a 184px column, where a tag pill left the body 112px
   >>> and the Pressure meter wrapped one word per line - 310px of left rail in
   >>> a busy round, which made the left column the tallest thing on the page
   >>> and pushed the whole game a screen and a half down. The same facts sit
   >>> beside the Influence scoreboard in a 776px strip, where each one is a
   >>> line, and the mats go back to being mats. */

/* A body that is ONE short, digitless, muted span is a feature saying it has
   nothing to report ("quiet", "none standing", "closed"). Anything carrying a
   figure - the Pressure meter's "0/4", a bounty's payout, a Rift sentence -
   survives this test, so a live fact is never mistaken for a placeholder. */
function statusBodyIsPlaceholder(root){
  const kids = root.children;
  if(kids.length !== 1) return false;
  const kid = kids[0];
  if(!/^(SPAN|EM|I|B)$/.test(kid.tagName)) return false;
  if(!/color:\s*var\(--muted\)/.test(kid.getAttribute('style') || '')) return false;
  const txt = (kid.textContent || '').replace(/\s+/g, ' ').trim();
  return txt.length > 0 && txt.length <= 24 && !/\d/.test(txt);
}

/* Drop the parts of a feature panel that only repeat something the player can
   already see. Returns nothing; it edits `root` in place. */
function prunePanelBody(root, panelId){
  /* The wagers panel opens with one line per seat -
     "Player 1: Fury 0 (+0, cap 4)  <pips> 2". Both halves of that line are
     ALREADY on that player's mat, one screen up: the Fury rung as a
     `.pill.fury` (hudPill only emits it from a streak of 1, so a "Fury 0"
     row can only ever be a present-and-zero duplicate) and the Betrayal
     tokens as public pips. The remainder - "(+0, cap 4)" - is engine
     notation, not player language. The feature owns this markup and its
     `declarations` map is module-private, so the engine cannot ask it for a
     narrower version; the render layer drops the duplicate lines and keeps
     everything else the panel reports (contested site, open siege, a declared
     ALL IN / GHOST / token), which is the part that is genuinely new.
     See the handover note: js/feature-wagers.js should stop emitting the
     per-seat Fury row in the first place. */
  if(panelId === 'wagers'){
    root.querySelectorAll('.wagers-line').forEach(line=>{
      if(/\bFury\b/.test(line.textContent || '')) line.remove();
    });
  }
  /* A panel's lines are joined with <br>, so removing one leaves a <br> where
     it was - and a hard line break is not a space: the surviving fact was
     pushed onto a second line of its own, under an empty first line. The
     facts that remain are separate chips that wrap on their own, so the
     separators come out. */
  root.querySelectorAll('br').forEach(br=>{ br.remove(); });
}

/* The card that holds the Influence scoreboard, which is also where the board
   state belongs. Resolved from the track rather than hard-coded, so index.html
   stays the only thing that knows the page's structure. */
function statusHost(){
  const track = document.getElementById('influenceTrack');
  const panel = track && track.closest ? track.closest('.card-panel') : null;
  return panel || document.getElementById('playerCardsPanel');
}

function renderExtPanels(){
  if(!OD.Ext.panels.has()) return;
  const host = statusHost();
  if(!host) return;
  let el = document.getElementById('odExtPanels');
  if(!el){
    el = document.createElement('div');
    el.id = 'odExtPanels';
    el.className = 'status-strip';
    host.appendChild(el);
  }
  const scratch = document.createElement('div');
  const rows = [];
  OD.Ext.panels.list(extCtx('draft', -1)).forEach(p=>{
    scratch.innerHTML = p.html || '';
    prunePanelBody(scratch, p.id);
    const text = (scratch.textContent || '').replace(/\s+/g, ' ').trim();
    if(!text || statusBodyIsPlaceholder(scratch)) return;
    rows.push({id:p.id, label:p.label, body:scratch.innerHTML});
  });
  if(!rows.length){ el.innerHTML = ''; return; }
  el.innerHTML = `<div class="status-cap">Board state</div>`
    + `<div class="status-grid">` + rows.map(r =>
      `<div class="status-row" data-panel="${r.id}">`
      + `<span class="status-tag">${r.label}</span>`
      + `<span class="status-body">${r.body}</span>`
      + `</div>`
    ).join('') + `</div>`;
}

/* ----------------------------- heat / drama ramp -----------------------------
   css/style.css consumes a `--heat` custom property on :root (default .12) and
   mixes it into the board frame, the vignette, the round stepper and the
   tile shadows. NOTHING ever set it, so the entire escalation ramp was dead
   code and the board looked identical on Round 1 and Round 6. These are the
   authored values from the stylesheet's own contract; `setHeat` writes them
   once per round, which is the only cadence the property is designed for. */
const HEAT_BY_ROUND = Object.freeze({1:0.12, 2:0.20, 3:0.28, 4:0.48, 5:0.72, 6:1.0});
/* RULE 2 in the stylesheet: no state is ever signalled by colour alone, so
   every heat value also has a literal name. The tier attribute picks the
   chip's colour; the text is what a greyscale player reads. */
const HEAT_TIER = Object.freeze({1:1, 2:2, 3:3, 4:4, 5:5, 6:5});
const HEAT_LABEL = Object.freeze({
  1:'Opening', 2:'Mobilising', 3:'Closing In', 4:'Tense', 5:'Critical', 6:'Meltdown',
});

/* ---- G5: THE SECOND HALF OF THE RAMP -------------------------------------
   --heat says how LATE the game is. The stylesheet also authors a separate
   .phase-label with a [data-phase] attribute for what KIND of round it is
   (contact / probe / escalation / events-live / pressure / critical /
   final-round), and nothing in this file ever emitted one: renderBoardHeader
   wrote only the heat chip and the Rift line, so the stylesheet's whole phase
   block was live-but-unbound exactly like the log's .is-* block was.

   The two are deliberately kept apart. `critical` and `pressure` are BOTH
   Round 5 - the difference between them is Dread, not the round number - so
   the phase key is computed from the round AND the Pressure clock, which is
   the only thing that knows both. */
const PHASE_BY_ROUND = Object.freeze({
  1:'contact', 2:'probe', 3:'escalation', 4:'events-live', 5:'pressure', 6:'final-round',
});
const PHASE_LABEL_TEXT = Object.freeze({
  'contact':     'Board cold &mdash; nothing contested',
  'probe':       'Advanced + Intrigue live',
  'escalation':  'Events + Rift open',
  'events-live': 'Full kit running',
  'pressure':    'Pressure rising',
  'critical':    'Collapse imminent',
  'final-round': 'Final round',
});
/* Dread at or over the Collapse threshold is 'critical', whatever the round.
   `roundOverride` lets a caller ask about a round OTHER than the one the game is
   currently in. The round debrief needs exactly that: while the summary for
   round N is on screen the game is (deliberately) still ON round N, but the
   "Coming up" line is about round N+1 - and reading phaseKey() there would
   label the next round with the round that just finished. */
function phaseKey(roundOverride){
  const s = state;
  const r = (typeof roundOverride === 'number' && roundOverride > 0)
    ? clamp(roundOverride|0, 1, TOTAL_ROUNDS)
    : clamp((s && s.round) | 0, 1, TOTAL_ROUNDS);
  const dread = s ? (s.dread | 0) : 0;
  const atCollapse = (typeof OD !== 'undefined' && OD.Chaos && typeof OD.Chaos.COLLAPSE_AT === 'number')
    ? OD.Chaos.COLLAPSE_AT : 4;
  if(r === TOTAL_ROUNDS) return 'final-round';
  if(dread >= atCollapse) return 'critical';
  return PHASE_BY_ROUND[r] || 'contact';
}

function setHeat(round){
  const r = clamp(round|0, 1, TOTAL_ROUNDS);
  const v = (HEAT_BY_ROUND[r] !== undefined) ? HEAT_BY_ROUND[r] : HEAT_BY_ROUND[1];
  const meltdown = !!(state && state.meltdown);
  if(typeof document === 'undefined' || !document.documentElement) return v;
  document.documentElement.style.setProperty('--heat', String(v));
  /* .is-meltdown is a STATE layer on top of --heat, so a round can be hot
     without being the last one. The stylesheet accepts it on #boardFrame or
     on body; both are set so either selector in the sheet matches. */
  const frame = document.getElementById('boardFrame');
  if(frame) frame.classList.toggle('is-meltdown', meltdown);
  if(document.body) document.body.classList.toggle('is-meltdown', meltdown);
  return v;
}

/* Lazily-created board-header extras. index.html is not the render layer's
   to edit, so the Rift reveal and the heat chip are appended into the
   existing #boardRulesRow on first render and then updated in place. */
function boardHeaderExtras(){
  const host = document.getElementById('boardRulesRow');
  if(!host) return null;
  let el = document.getElementById('odBoardHeader');
  if(!el){
    el = document.createElement('div');
    el.id = 'odBoardHeader';
    el.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px';
    host.appendChild(el);
  }
  return el;
}

/* The Rift is announced in the log and in a HUD panel, but the log is
   bottom-of-rail and scrolled to the newest entry - which is exactly where a
   player is NOT looking when they are reading the board they are about to
   draft from. The reveal is also printed on the board header, next to the
   phase, so the mutation is on screen at the moment it can be acted on. */
function renderBoardHeader(){
  const el = boardHeaderExtras();
  if(!el) return;
  const r = clamp(state.round|0, 1, TOTAL_ROUNDS);
  /* >>> ONE MELTDOWN BADGE, NOT TWO. Round 6's heat label is already the word
      >>> "Meltdown", so the extra MELTDOWN chip printed next to it repeated the
      >>> same state twice in the same row, in two different shapes. The chip
      >>> that carries information ("ADVANCED FREE") wins and the plain tier
      >>> label stands down for that one round; every other round keeps its
      >>> heat name. */
  const meltdown = !!(state && state.meltdown);
  const parts = [];
  if(meltdown){
    parts.push(`<span class="heat-label" data-heat-tier="5" style="background:#8c1d18;color:#ffe9e2;border-color:#ffe9e2">MELTDOWN &mdash; ADVANCED FREE</span>`);
  } else {
    parts.push(`<span class="heat-label" data-heat-tier="${HEAT_TIER[r]}" title="Escalation ${r} of ${TOTAL_ROUNDS}">${HEAT_LABEL[r]}</span>`);
  }
  /* The PHASE chip: the stylesheet's second escalation reading, and the one
     that keeps moving inside a single round (Round 5 flips to 'critical' the
     moment the Pressure clock reaches the Collapse threshold). It sits beside
     the heat chip rather than in #phaseLabel because #phaseLabel carries the
     round STEP ("Drafting the board"), which is a different fact entirely. */
  const pk = phaseKey();
  parts.push(`<span class="phase-label" data-phase="${pk}" title="Round ${r} of ${TOTAL_ROUNDS}">${PHASE_LABEL_TEXT[pk] || ''}</span>`);

  const rift = riftLocIfLive();
  if(rift){
    const contested = state.riftContested ? ' <b>CONTESTED</b>' : '';
    const name = state.riftTarget ? rift.name : rift.name;
    /* No inline colour: `.rift-reveal` is authored open-first and the closed
       reading is `.rift-reveal.is-closed`, so the inline `color:var(--gold)` /
       `color:var(--muted)` this used to carry was overriding the very rule the
       stylesheet wrote for it. */
    parts.unshift(`<span class="rift-reveal">RIFT OPEN &mdash; ${name}${contested}</span>`);
  } else if(r >= 3 && !meltdown){
    parts.unshift(`<span class="rift-reveal is-closed">Rift closed &mdash; taken or not this round.</span>`);
  }
  el.innerHTML = parts.join('');
}

/* ============================ #srLive (SCREEN READER) =====================
   index.html declares `#srLive` - an aria-live=polite, aria-atomic=true,
   visually-hidden region - and styled it as the mirror of the colour-coded
   board state. Nothing ever wrote to it. On a board whose whole visual rule
   is "no state is signalled by colour alone", that was the single largest gap
   between what a sighted player is told and what a screen-reader player is
   told: the heat ramp, the Rift reveal, the contested tile, the Advanced lock
   and the objective flip were all drawn and none of it was announced.

   THREE RULES, AND THEY ARE NOT NEGOTIABLE:

   1. WRITE, NEVER APPEND. aria-atomic="true" means every write re-announces
      the WHOLE region, so this is `textContent = msg` and never `+=` or
      insertAdjacentText. An append here would re-read every previous message
      on every change.

   2. STATE, NOT NARRATION. Each entry below is a fact with a value, phrased so
      a change is obvious when it is heard. Nothing here describes an
      animation, a transition or a player's action.

   3. WRITE ON CHANGE ONLY. renderAll() runs on every single action in the
      game - a pick, a card, a log line - so an unconditional write would
      re-announce the whole board state on every keystroke. Each fact is
      diffed against the value it held at the last render and only CHANGED
      facts are composed into the message; a render where nothing moved writes
      nothing at all.

   Every entry is guarded: a missing #srLive, a missing feature, a missing
   state key or a broken objective check degrades to "say nothing", never to a
   throw inside renderAll(). */
const SR_MAX = 120;
let srLast = '';
/* >>> TRUNCATION CUT MID-WORD (D4). This used to be
   `msg.slice(0, SR_MAX - 1).trim() + '\u2026'`, a hard character cut at 119, and
   a live region with aria-atomic="true" announces the string it is given - so a
   message that ran over was not merely short, it was MALFORMED: a player heard
   "...they unlock in Round 2. Sea" and could not tell whether "Sea" was a new
   fact, half a word, or the start of the tail the ceiling had just eaten. The
   ellipsis was decoration on a lie.
   >>> Now the cut is made at the last SPACE inside the budget, so a truncated
   message ends on a whole word and the tail is honestly declared missing
   rather than half-spoken. The raw character cut survives ONLY as the fallback
   for a prefix with no space in it at all (a single unbroken token), where
   there is no word boundary to cut on. */
function srTruncate(msg){
  if(msg.length <= SR_MAX) return msg;
  const budget = msg.slice(0, SR_MAX - 1);
  const sp = budget.lastIndexOf(' ');
  const cut = (sp > 0) ? budget.slice(0, sp) : budget;
  /* Never end on dangling punctuation - "…, and" reads as a truncated clause
     even though it is a whole word. */
  return cut.replace(/[\s,;:.!?\u2014\u2013-]+$/, '') + '\u2026';
}
function srWrite(parts){
  const msg = (parts || []).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if(!msg || msg === srLast) return;
  const el = document.getElementById('srLive');
  if(!el) return;
  srLast = msg;
  el.textContent = srTruncate(msg);
}
/* One delta per fact, compared against the value that fact held last time.
   `value` may be anything JSON-comparable as a string; the map is keyed by
   fact name so two facts cannot collide. */
const srSeen = Object.create(null);
function srFact(key, value, msg){
  const v = String(value);
  if(srSeen[key] === v) return null;
  srSeen[key] = v;
  return msg || null;
}
/* The Rift's mutation, read as a NAME out of the feature's frozen table rather
   than restated here, so the announcement cannot name a mutation differently
   from the board tile does. Only the name, not the clause: the tile beside it
   prints the full effect, and a whole composed message has to stay inside
   120 characters or the facts at the end of it are never heard at all. */
function srRiftSentence(){
  const rift = riftLocIfLive();
  if(!rift || !state.riftMut) return '';
  const muts = (typeof OD !== 'undefined' && OD.Chaos && Array.isArray(OD.Chaos.MUTATIONS)) ? OD.Chaos.MUTATIONS : null;
  const mut = muts ? muts.find(m=>m && m.id===state.riftMut) : null;
  const siteName = ((state.riftTarget && LOCATIONS.find(l=>l.id===state.riftTarget)) || {}).name || 'a site';
  const name = (mut && mut.name) ? mut.name : state.riftMut;
  return `Rift open on ${siteName}, wearing ${name}${state.riftContested ? ', and it is Contested' : ''}.`;
}
/* Caps are read through the same numbers the clamp uses, so the announcement
   can never say a player is capped when the engine would have let them past
   it. Names the resources that are ACTUALLY full, not the whole table. */
function srCapsSentence(){
  if(!state || !state.players) return '';
  const p = state.players[0];
  if(!p) return '';
  const full = [];
  if(p.credits >= CAPS.credits) full.push(`Credits ${CAPS.credits}`);
  if(p.ore >= CAPS.ore) full.push(`Ore ${CAPS.ore}`);
  if(p.troops >= CAPS.troops) full.push(`Troops ${CAPS.troops}`);
  return full.length ? `Seat 1 at cap: ${full.join(', ')}. Gains are discarded.` : '';
}
/* Objective MET / NOT YET, one fact per seat. check() is the engine's own
   predicate - the same one that pays the bonus at endRound - so the
   announcement cannot disagree with the payout. */
function srObjectiveSentence(i){
  const p = (state && state.players && state.players[i]) || null;
  if(!p) return '';
  const obj = getObjective(p);
  if(!obj || typeof obj.check !== 'function') return '';
  let met = false;
  try{ met = !!obj.check(p); }
  catch(_){ return ''; }
  let prog = '';
  if(typeof obj.progress === 'function'){
    try{
      const pr = obj.progress(p) || {};
      if(pr && pr.need > 1) prog = `, ${pr.have} of ${pr.need} ${pr.unit||''}${pr.note ? ` and ${pr.note}` : ''}`;
    }catch(_){ /* a broken progress fn must not silence the fact it qualifies */ }
  }
  return met
    ? `Seat ${i+1} objective met: ${obj.name}, +${obj.bonus} Influence.`
    : `Seat ${i+1} objective not yet: ${obj.name}${prog}.`;
}
/* >>> WHY THIS READS THE DOM AS WELL AS THE CALLBACK. `mountCommit` builds its
     >>> controller with `wireCommit(host, null)` - the `onChange` we hand it is
     >>> NOT registered - so a declared stance never reaches this file through
     >>> the API it was offered. Observed directly: the chips moved, `srLive`
     >>> stayed empty. So the declaration is read off the MOUNTED CHIPS as
     >>> well: those are in the body this function built, they are already
     >>> focusable, already carry `.selected` for the visible state, and reading
     >>> them cannot drift from what the player is looking at. When the feature
     >>> does honour `onChange`, the callback argument wins and this is inert. */
function srWagerDeclaration(){
  const body = document.getElementById('skirmishBody');
  if(!body) return null;
  const stance = body.querySelector('#wagersStance .wagers-stance.selected');
  const plus   = body.querySelector('#wagersTokens .wagers-token[data-token="plus"].selected');
  const reroll = body.querySelector('#wagersTokens .wagers-token[data-token="reroll"].selected');
  if(!stance && !plus && !reroll) return null;
  return {
    wager: (stance && stance.dataset.wager) || 'normal',
    betrayal: { plus: !!plus, reroll: !!reroll },
  };
}
/* >>> STAKES, ANNOUNCED. One fact, one delta, one write - the same contract
   >>> every other #srLive entry obeys: `srWrite` assigns textContent (never
   >>> appends), skips an identical message, and truncates at a word boundary
   >>> under 120 characters. A declaration is public and irreversible, so both
   >>> seats have to hear it: the aggressor hears what they just committed the
   >>> game to, and the defender hears the ceiling they are about to play under
   >>> - which is the one number that decides whether their commitment is worth
   >>> anything. */
let srStanceSeen = '';
function srStanceSentence(stance){
  const s = normaliseStance(stance);
  if(s === srStanceSeen) return;
  srStanceSeen = s;
  if(s === STANCE_ORDINARY) return;   /* the default needs no announcement */
  if(s === STANCE_HOLD){
    srWrite(['HOLD BACK declared. No Skirmish; +1 Influence, Pressure +1.']);
    return;
  }
  srWrite([`BLOOD declared. Cap ${BLOOD_CAP}, half your Troops at least, and the loser keeps their Troops.`]);
}

/* Every wager stance, and every token declared alongside it. State, not
   narration: what is committed, not what the player did. NORMAL is the absence
   of a pledge and says nothing; ALL IN and GHOST each pin the slider, so a
   screen-reader player has to be told their own commitment was moved for
   them.

   Announced as a DELTA, on the same rule as every board fact: a stance that
   has not moved is not restated. Otherwise clicking a token three declarations
   deep re-announces the stance and both tokens too, and the message walks past
   the 120-character ceiling carrying the old news. */
const srWagerSeen = { wager: 'normal', plus: false, reroll: false };
/* The BITS, not the write. >>> D4: these used to be announced through
   srWagerSentence() -> srWrite() on their own, which meant that a wager click
   and a Troop-count click - two things a player does together, and which the
   engine composes into ONE message whenever they happen in the same render -
   produced TWO writes. #srLive is aria-atomic, so the second write replaces the
   first: the stance announcement and the "your commitment moved" announcement
   could never both be heard, and which one survived was an accident of call
   order. Returning the facts and letting the CALLER compose them means one
   write, one message, both facts, still under the 120-character ceiling.
   The sentences are also shorter than the originals ("ALL IN declared: every
   Troop committed." vs "Wager declared: ALL IN. Every Troop is on the line."),
   because the old wording spent 53 of 120 characters restating a word the
   player had just been handed by the chip's own label. */
function srWagerBits(decl){
  const d = (decl && (decl.wager || (decl.betrayal && (decl.betrayal.plus || decl.betrayal.reroll))))
    ? decl : srWagerDeclaration();
  if(!d) return [];
  const w = d.wager || 'normal';
  /* >>> D4: THE STANCE BITS BELOW CANNOT FIRE, and that is worth saying rather
   >>> than leaving to be discovered. `d.wager` is 'normal' or undefined,
   >>> because #wagersStance is no longer rendered by js/feature-wagers.js (the
   >>> All In / Ghost wagers were cut), and srWagerSeen.wager is reset to
   >>> 'normal' every time a commit modal opens - so `w !== srWagerSeen.wager`
   >>> is never true and none of the three stance sentences is ever pushed.
   >>> Verified in a real browser with tokens in hand: #srLive never carried
   >>> one. The TOKEN bits below are live and are the half that matters. */
  const bet = d.betrayal || {};
  const bits = [];
  if(w !== srWagerSeen.wager){
    srWagerSeen.wager = w;
    if(w === 'allin') bits.push('ALL IN declared: every Troop committed.');
    else if(w === 'ghost') bits.push('GHOST declared: no Troop committed.');
    else bits.push('Wager cleared: NORMAL, no pledge.');
  }
  if(!!bet.plus !== srWagerSeen.plus){
    srWagerSeen.plus = !!bet.plus;
    bits.push(srWagerSeen.plus ? '+1 total declared.' : '+1 total withdrawn.');
  }
  if(!!bet.reroll !== srWagerSeen.reroll){
    srWagerSeen.reroll = !!bet.reroll;
    bits.push(srWagerSeen.reroll ? 'Re-roll declared; second cast stands.' : 'Re-roll withdrawn.');
  }
  return bits;
}
function srWagerSentence(decl){ srWrite(srWagerBits(decl)); }
/* The stance block's LOCKED state. The stance chips used to be painted
   `disabled` before Round 2, and a disabled chip is not focusable and is
   skipped by the tab order - so this existed to tell a screen-reader player
   "All In and Ghost are not available".

   >>> D4: THE STANCES ARE GONE, so the sentence never fires: the query below
   >>> looks for `#wagersStance .wagers-stance[data-wager="allin"].disabled`,
   >>> and js/feature-wagers.js renders no stance chips at all any more, so
   >>> `locked` is false and srFact() returns null. Called on every commit modal
   >>> mount (showCommitModal, and installWagerChipA11y), so it is a live call
   >>> site - it simply cannot speak. Kept, and kept honest by this note: a
   >>> player is never told about a mechanic that does not exist, and the next
   >>> engineer is told why the string is still here rather than finding it. */
function srWagerLockSentence(){
  const locked = !!document.querySelector('#wagersStance .wagers-stance[data-wager="allin"].disabled');
  return srFact('wagerLock', String(locked), locked ? 'Wager locked: All In and Ghost unlock in Round 2.' : null);
}

/* ---- THE WAGER AND TOKEN CHIPS (D2) ------------------------------------
   /* >>> D4: THIS BLOCK WAS WRITTEN WHEN THERE WERE FIVE CHIPS. js/feature-wagers.js
   >>> used to render NORMAL / ALL IN / GHOST / +1 TOTAL / RE-ROLL as bare
   >>> <div>s - measured role null and tabindex null on all five - and this
   >>> upgrade is what made the two decisions that carried a real cost
   >>> (risk every Troop for +3 Influence, or risk none for +2) reachable by
   >>> keyboard at all. The All In / Ghost wagers were then MEASURED and CUT
   >>> (worth -1.5 and -2.1 Influence per seat; a bot that used them scored 11%
   >>> worse than one that ignored them), so today the feature renders TWO chips
   >>> - the +1 TOTAL and the RE-ROLL tokens - and both are labelled, focusable
   >>> and announced, as this block intended. The stance arms of
   >>> wagerChipLabel() below are the residue of the other three: unreachable,
   >>> because paintWagerChips() only ever sees the chips that exist. Verified
   >>> in a real browser with tokens in hand - both token chips carry an
   >>> aria-label, and nothing in the commit modal mentions a stance.

   feature-wagers.js is not this file's to edit, so the upgrade is applied from
   here, at MOUNT time, through a delegated listener on the commit modal's
   mount root. #skirmishBody is the right host: it survives showModal()
   replacing the body's innerHTML, so the listener is installed once and the
   attributes are re-stamped on every Skirmish.

   The attributes:
     role="button"    a div with a click handler announces nothing at all;
     tabindex="0"     so Tab reaches it. Kept at 0 even when LOCKED: the
                       `.disabled` class is the feature's own visual lock and
                       removing the chip from the tab order would hide the only
                       thing that says WHY (see srWagerLockSentence);
     aria-pressed     these are toggles, not actions, and a chip that looks
                       selected must not be silent about it;
     aria-disabled    present-but-unavailable rather than gone;
     aria-label       the cost and the effect as ONE sentence, which is the
                       part the chip's two-line visual layout makes hard to read
                       aloud. The numbers come from the feature's own
                       constants through wagerPayouts(), never re-typed. */
const WAGER_CHIP_SELECTOR = '#wagersStance .wagers-stance, #wagersTokens .wagers-token';

function wagerChipLabel(chip){
  const p = wagerPayouts();
  const wager = chip.dataset.wager;
  let label;
  if(wager === 'allin')       label = `All In: commit every Troop. A win pays +${p.allInWin} Influence, a loss costs ${p.allInLoss}.`;
  else if(wager === 'ghost')  label = `Ghost: commit no Troops. A win pays +${p.ghostWin} Influence, a loss or a tie costs nothing.`;
  else if(wager === 'normal') label = 'Normal: no pledge, commit any number of Troops.';
  else if(chip.dataset.token === 'plus')   label = 'Add 1 Total: spend 1 Betrayal token to add 1 to your committed total, in public before the dice fall.';
  else if(chip.dataset.token === 'reroll') label = 'Re-roll: spend 1 Betrayal token; your die is cast twice and the second cast stands. Once per Skirmish.';
  else return '';
  if(chip.classList.contains('disabled')){
    label += chip.dataset.wager
      ? ' Locked: All In and Ghost unlock in Round 2.'
      : ' Locked: you are holding no Betrayal tokens.';
  }
  return label;
}

function paintWagerChips(root){
  if(!root || typeof root.querySelectorAll !== 'function') return;
  const stance = root.querySelector('#wagersStance');
  const tokens = root.querySelector('#wagersTokens');
  if(stance){ stance.setAttribute('role','group'); stance.setAttribute('aria-label','Wager'); }
  if(tokens){ tokens.setAttribute('role','group'); tokens.setAttribute('aria-label','Betrayal tokens'); }
  root.querySelectorAll(WAGER_CHIP_SELECTOR).forEach(chip=>{
    chip.setAttribute('role', 'button');
    chip.setAttribute('tabindex', '0');
    chip.setAttribute('aria-pressed', chip.classList.contains('selected') ? 'true' : 'false');
    chip.setAttribute('aria-disabled', chip.classList.contains('disabled') ? 'true' : 'false');
    const label = wagerChipLabel(chip);
    if(label) chip.setAttribute('aria-label', label);
  });
}

/* >>> B2, THE FOURTH CAP FIGURE - AND THE ONE THIS FILE DOES NOT OWN.
   `OD.Wagers.mountCommit` appends a "Fury ladder" block to the commit modal with
   one row per seat: "Player 1 - Fury 2 (+1 to total, Influence cap 4)". The cap
   there is `furyCap(winStreak, fever)` computed inside js/feature-wagers.js,
   which knows the ladder and the event and has never heard of a stance. Under a
   BLOOD declaration that block therefore printed "Influence cap 4" in the middle
   of a fight that pays 6 - the fourth disagreeing figure, and the one B2's
   acceptance test ("every cap figure on the panel must be the same number")
   fails on while js/feature-wagers.js is out of this engineer's hands.

   So the integrator corrects it, the same way it already re-labels the feature's
   chips for assistive tech (installWagerChipA11y, two functions up): from here,
   after the mount, on the mounted DOM. Three properties make it safe rather than
   clever:
     - it only ever RAISES a printed cap to `fightCeiling(...)`, and only when
       that ceiling is above the rung, so it can never make the panel contradict
       the engine in the other direction;
     - it is a no-op under ORDINARY and under Skirmish Fever, where the feature's
       `furyCap(streak, fever)` is already the ceiling - which is the case the
       overwhelming majority of Skirmishes are, so the common path touches
       nothing;
     - it matches the feature's own wording ("Influence cap <digits>") and gives
       up silently if that wording ever changes, so a reworded feature degrades
       to the old text rather than to a broken panel.
   The source-level fix belongs in the feature: a `capFor(winStreak)` hook it
   asks the engine for. This is the integrator's half of that, and it is marked
   as such so the next reader does not mistake it for the rule. */
function alignWagerFuryCaps(){
  const block = document.getElementById('wagersFuryBlock');
  if(!block) return;
  const fever = isFeverRound();
  const ceiling = fightCeiling(state.players.map(p=>p.winStreak), fever);
  if(!(ceiling > 0)) return;
  block.querySelectorAll('.wagers-dim').forEach(span=>{
    const m = /Influence cap (\d+)/.exec(span.textContent || '');
    if(!m) return;
    const printed = parseInt(m[1], 10);
    if(!isFinite(printed) || printed >= ceiling) return;
    /* A real em dash, not the entity: this is a textContent assignment, so
       "&mdash;" would print as the six characters. And the qualifier goes
       INSIDE the feature's own parentheses, so the row still reads as one
       clause: "(+1 to total, Influence cap 6 - BLOOD)". */
    span.textContent = span.textContent.replace(m[0], `Influence cap ${ceiling} \u2014 BLOOD`);
  });
}

function installWagerChipA11y(host){
  if(!host) return;
  /* >>> RE-PAINT ON EVERY MOUNT, LISTEN ONCE. showModal() REPLACES
     #skirmishBody's innerHTML, so every Skirmish brings five BRAND-NEW chips
     with none of these attributes on them. Guarding the paint behind the
     "listeners already installed" flag stamped the first Skirmish's chips and
     left every Skirmish after it exactly as unlabelled as before - measured:
     round 1's modal had role="button" on all five and round 3's had role null
     on all five. The listeners live on the host and survive the innerHTML
     swap; the attributes live on the chips and do not. */
  paintWagerChips(host);
  if(host.__odWagerChips) return;
  host.__odWagerChips = true;
  /* Bubble phase on the host, so it runs AFTER the feature's own onclick has
     repainted `.selected` - which is what makes aria-pressed read the state the
     player is looking at rather than the one they were in. */
  host.addEventListener('click', (ev)=>{
    const chip = (ev.target && ev.target.closest) ? ev.target.closest(WAGER_CHIP_SELECTOR) : null;
    if(!chip) return;
    paintWagerChips(host);
  });
  host.addEventListener('keydown', (ev)=>{
    if(ev.key!=='Enter' && ev.key!==' ' && ev.key!=='Spacebar') return;
    const chip = (ev.target && ev.target.closest) ? ev.target.closest(WAGER_CHIP_SELECTOR) : null;
    if(!chip) return;
    /* Space would scroll the commit body; Enter would otherwise activate
       whatever the browser thinks the form control is. Neither is wanted. */
    ev.preventDefault();
    ev.stopPropagation();
    /* >>> ONE code path. The feature owns the click, so a keyboard press is
       delivered as a click on the chip rather than as a second, parallel
       implementation of setWager/setToken. Anything that changes about the
       chips from here on is picked up by the keyboard for free. */
    chip.click();
  });
}

/* ------------------------- the Surge (D6) -------------------------
   THE SURGE IS THE LARGEST UNCAPPED SWING IN THE GAME and it used to be
   announced NOWHERE. Measured: both players roll 1d6 straight to Influence at
   the top of Round 6; the only trace was a clause in a status chip ("Surge: 5
   and 5 straight to Influence") and a log line third-from-top in a rail the
   player is not looking at - worth 10.7% of the final score on average, and
   pointing the WRONG way in 49% of games (both seats roll the same d6, so the
   larger roll wins the round and the smaller one never even catches up).
   A player who cannot see that number cannot plan the last round around it.

   The rolls themselves are feature-owned (js/feature-chaos.js writes
   state.surgeRolls and draws its own dice overlay). What the engine owns is
   the two things a feature cannot do: the live region, and a presentation hook
   that fires on a VALUE CHANGE so a re-render never re-announces it. Both read
   state.surgeRolls and nothing else, so they work identically on the host and
   on the online guest - the guest never runs hooks, and its render loop is the
   only change feed it has. */

/* The identity of the Surge currently on the table. Null until one has rolled.
   NOT on `state`: this is a presentation flag, and state is JSON.stringify'd to
   the online guest on every render. */
let surgeSeen = null;
/* The wagers feature's own payout constants, read (never re-typed) so a chip's
   aria-label cannot quote a different number from the rules copy or from
   settleWagers(). Each falls back to the value the feature ships today, so the
   label is still correct if the feature is deleted. */
function wagerPayouts(){
  const w = (typeof OD !== 'undefined' && OD.Wagers) ? OD.Wagers : null;
  return {
    allInWin:  (w && typeof w.ALL_IN_WIN  === 'number') ? w.ALL_IN_WIN  : 3,
    allInLoss: (w && typeof w.ALL_IN_LOSS === 'number') ? w.ALL_IN_LOSS : 2,
    ghostWin:  (w && typeof w.GHOST_WIN   === 'number') ? w.GHOST_WIN   : 2,
  };
}
function surgeKey(){
  const sr = (state && state.surgeRolls) || null;
  return (sr && Array.isArray(sr.values)) ? `r${sr.round|0}:${sr.values.join(',')}` : '';
}
/* "Player 1 +5, Player 2 +3" - the raw result, from the SAME array the engine
   banked, so the announcement cannot disagree with the score. */
function surgeTally(){
  const sr = (state && state.surgeRolls) || null;
  if(!sr || !Array.isArray(sr.values) || !sr.values.length || !state.players) return '';
  return sr.values.map((v,i)=>{
    const p = state.players[i];
    return `${p ? p.name : `Seat ${i+1}`} +${v|0}`;
  }).join(', ');
}
function srSurgeSentence(){
  const tally = surgeTally();
  return tally ? `THE SURGE: ${tally} straight to Influence. Uncapped, no take-backs.` : null;
}
/* The visible half. showNotice is the engine's existing inline banner: an
   aria-live status region, pointer-events:none, self-clearing, and built from a
   cssText the function owns - so the presentation needs no stylesheet, which
   matters because css/style.css is not this file's to edit. OD.Fx.shake, which
   showNotice calls, is itself a no-op under prefers-reduced-motion, so the
   banner appears without movement when the player has asked for that.
   Idempotent on the same key, so the six renders that happen while the feature
   replays its dice animation produce exactly one banner. */
function presentSurge(){
  const key = surgeKey();
  if(!key || key === surgeSeen) return;
  surgeSeen = key;
  const tally = surgeTally();
  if(!tally) return;
  OD.Sound.play('stat.gain');
  showNotice(`THE SURGE \u2014 ${tally} straight to Influence`, {id:'odSurgeNotice', ms:5200});
}

/* --------------------- the commit modal (D4) ---------------------
   >>> SELECTING A TACTIC CARD ANNOUNCED NOTHING. Measured: aria-pressed
   >>> toggled, the odds panel repainted live, and #srLive still read
   >>> "Wager locked: All In and Ghost unlock in Round 2." - the previous
   >>> message, verbatim - because nothing in the commit modal ever wrote to
   >>> the live region on a card select or on a Troop change. A player who
   >>> cannot see the panel was told, on every single interaction, about a
   >>> rule that had not changed.
   >>> The three facts below are the ones the panel exists to deliver, and they
   >>> are read out of the panel's own state (the selected card id, the slider
   >>> value, and the same runOdds() call the bars are drawn from) so the
   >>> announcement cannot report a different number from the one on screen.
   >>> Composed as BITS and written by the caller, for the same reason as
   >>> srWagerBits(): one write per interaction, all of its facts, no ordering
   >>> accident. */
const srCommitSeen = { troops: null, card: null };
/* The card's effect in the fewest words that still mean something. The full
   `desc` runs to 70 characters ("+2 combat. You draw 1 Tactic card after the
   Skirmish, win or lose."), and a card line plus a Troop line plus an odds
   line has to fit inside 120 - so the announced card is the NAME and the one
   number the player is actually deciding on, which is the combat modifier. */
function srCardBits(cardId){
  const id = cardId || '';
  if(srCommitSeen.card === id) return [];
  srCommitSeen.card = id;
  const def = id ? CARD_DEFS[id] : null;
  if(!def) return ['Card cleared. No modifier.'];
  const mod = (def.mod === null || def.mod === undefined)
    ? 'modifier is a fresh d6 roll'
    : `+${def.mod} combat`;
  return [`Card ${def.name}: ${mod}.`];
}
/* The live win percentage, computed through the SAME two calls the odds panel
   makes (defenderOddsHtml / aggressorOddsHtml) with the same specs, so the
   spoken number is the drawn number. Returns null when a projection is not
   available yet - the aggressor cannot know the defender's stance, and the
   defender cannot know the aggressor's Troops until they commit - which is the
   correct answer, not a missing one. */
function commitWinPct(playerIdx, troops, cardId){
  if(!(playerIdx >= 0) || !state || !state.players || !skirmishCtx) return null;
  const fever = isFeverRound();
  const t = Math.max(0, troops|0);
  let p = null;
  try{
    if(playerIdx === skirmishCtx.defenderIdx){
      if(!skirmishCtx.aggCommit) return null;
      const aggIdx = skirmishCtx.aggressorIdx;
      const theirs = projectionSpec(aggIdx, skirmishCtx.aggCommit.troops, null, true,
        garrisonBonusOf(aggIdx) + tokenBonusOf(skirmishCtx.aggCommit));
      const mine = projectionSpec(playerIdx, t, cardId, false, tokenBonusOf(skirmishCtx.defCommit));
      p = runOdds(mine, theirs, fever);
    } else {
      p = runOdds(
        projectionSpec(playerIdx, t, cardId, true, garrisonBonusOf(playerIdx)),
        projectionSpec(1 - playerIdx, 0, null, false, 0), fever);
    }
  }catch(_){ return null; }
  return (p && typeof p.winPct === 'number') ? Math.round(p.winPct*10)/10 : null;
}
function srCommitBits(playerIdx, troops, cardId){
  const out = [];
  const t = Math.max(0, troops|0);
  /* Reset on a fresh modal, in showCommitModal, so the first interaction of a
     new Skirmish speaks instead of being deduped against the last one's. */
  if(srCommitSeen.troops !== t){
    srCommitSeen.troops = t;
    out.push(`Committing ${t} ${t === 1 ? 'Troop' : 'Troops'}.`);
  }
  out.push.apply(out, srCardBits(cardId));
  const pct = commitWinPct(playerIdx, t, cardId);
  if(pct !== null) out.push(`Win chance ${pct}%.`);
  return out;
}
/* Everything the board currently says, as a list of DELTAS. Called once per
   renderAll(); the order is the order a player would want them read, and it
   is also the order truncation preserves. */
function srDeltas(){
  if(!state) return [];
  const r = clamp(state.round|0, 1, TOTAL_ROUNDS);
  const out = [];
  const heat = HEAT_LABEL[r] || '';
  const phase = (PHASE_LABEL_TEXT[phaseKey()] || '').replace(/&[a-z]+;/gi, '');
  const md = !!state.meltdown;
  /* >>> THE SURGE IS FIRST (D6), deliberately. It is the biggest uncapped
     >>> swing in the game and it happens exactly once, in the last round, at the
     >>> top of it. Every other fact below it is context; a message that runs
     >>> past the 120-character ceiling is truncated from the END, so anything
     >>> listed after a long Surge line is the thing that gets eaten. Order is
     >>> therefore also priority. */
  const surgeKeyNow = surgeKey();
  out.push(srFact('surge', surgeKeyNow, surgeKeyNow ? srSurgeSentence() : null));
  out.push(srFact('meltdown', md, md
    ? 'Meltdown: Advanced is free everywhere and holding the Garrison is compulsory.'
    : (srSeen.meltdown === 'true' ? 'Meltdown has passed.' : null)));
  out.push(srFact('round', `${r}|${heat}|${phaseKey()}`, `Round ${r} of ${TOTAL_ROUNDS}. ${heat}. ${phase}.`));
  out.push(srFact('rift', `${state.riftTarget}|${state.riftMut}|${state.riftContested}`, srRiftSentence()));
  out.push(srFact('lock', String(r), (r < 2) ? 'Advanced tiers are locked this round - they unlock in Round 2.' : null));
  /* >>> D4: THE CONTESTED FACT IS THE RIFT'S NOW. This used to read
     >>> `state.contestedLocId` and announce "X is Contested - it can be bought
     >>> this round", which is Siege's paid-for contested site. The key was
     >>> seeded only by js/feature-wagers.js and has had no writer since the
     >>> cut, so the sentence could never fire - but the Rift's permanent
     >>> contested state, which IS real and IS announced, was reading the
     >>> wrong key for it: `srRiftSentence()` above already covers
     >>> `state.riftContested`, so nothing is lost. The Rift's tile styling
     >>> (`.loc.contested`) is deliberately still in css/style.css and is still
     >>> used; only this dead reader goes. */
  const caps = srCapsSentence();
  out.push(srFact('caps', caps, caps));
  for(let i=0;i<2;i++){
    const line = srObjectiveSentence(i);
    out.push(srFact(`objective${i}`, line, line));
  }
  const [p1,p2] = state.players;
  if(p1 && p2){
    const gap = (p1.influence|0) - (p2.influence|0);
    out.push(srFact('influence', String(gap),
      gap === 0 ? `Influence level at ${p1.influence|0}.`
                : `Seat ${gap > 0 ? 1 : 2} leads Influence ${Math.max(p1.influence|0, p2.influence|0)} to ${Math.min(p1.influence|0, p2.influence|0)}.`));
  }
  return out.filter(Boolean);
}

function renderAll(){
  renderHud();
  renderExtPanels();
  setHeat(state.round);
  renderBoardHeader();
  renderBoard();
  renderHand();
  renderIntrigueHand();
  renderInfluenceTrack();
  renderRoundStepper();
  renderTurnBanner();
  /* The online guest never calls log() - it receives whole snapshots and its
     `state.logEntries` is replaced wholesale - so nothing was ever painting the
     log on that seat. renderAll() is the guest's paint, so the log rides
     along. Host-side this is one extra identical render per pick. */
  renderLog();
  document.getElementById('roundLabel').textContent = `${state.round} / ${TOTAL_ROUNDS}`;
  const phaseNames = {draw:'Drawing cards…', draft:'Drafting the board', 'skirmish-decide':'Skirmish decision', 'skirmish-commit':'Skirmish in progress', ended:'Game over'};
  /* >>> WHILE A ROUND DEBRIEF IS OPEN (D5), the phase line names the round the
     >>> dialog is summarising rather than the phase the round happened to be in
     >>> when it ended. It used to read "— Drawing cards..." - the NEXT round's
     >>> phase - because endRound had already incremented state.round before
     >>> showing the summary, so the HUD behind the dialog described a round
     >>> that had not started. Now the round is NOT advanced until the player
     >>> answers the debrief (see endRound / showRoundDebrief), so `state.round`
     >>> is already correct here; this flag only supplies the one label that
     >>> state.phase cannot express without inventing a new phase value, which
     >>> is out of bounds. */
  const phaseText = debriefOpenRound
    ? `Round ${debriefOpenRound} debrief`
    : (phaseNames[state.phase] ? phaseNames[state.phase] : '');
  document.getElementById('phaseLabel').textContent = phaseText ? `— ${phaseText}` : '';
  const ev = getEvent();
  document.getElementById('eventLine').innerHTML = ev ? `Round Event: <b style="color:var(--gold)">${ev.name}</b> - ${ev.desc}` : '';
  /* The board's colour-coded state, in words, only where it actually moved.
     Last in renderAll so every fact it reads has just been re-rendered. */
  presentSurge();
  srWrite(srDeltas());
  if(online.enabled && online.isHost) wsSend({type:'state', state});
}

/* >>> THE `WIN` MARKER IS GONE. The stylesheet drew a dashed "WIN" flag at a
   >>> fixed 62% of both bars. There is no win threshold in this game - six
   >>> rounds, most Influence, and a draw is a draw - so the flag pointed at a
   >>> number that does not exist, and at 0-0 it sat in the middle of two empty
   >>> troughs promising something neither player could reach. The bar now
   >>> carries the one fact that IS on it: whose meter is in front. The flag is
   >>> absent at a tie, so a level start reads as level, and it is a WORD, not
   >>> a colour, for the same reason the rest of the file is. */
function renderInfluenceTrack(){
  const el = document.getElementById('influenceTrack');
  if(!el) return;
  const [p1,p2] = state.players;
  const maxScale = Math.max(20, p1.influence, p2.influence, 1) + 4;
  const lead = (p1.influence === p2.influence) ? -1 : (p1.influence > p2.influence ? 0 : 1);
  el.innerHTML = [p1,p2].map((p,i)=>`
    <div class="track-row${lead===i?' is-lead':''}">
      <div class="track-label">${esc(p.name)}</div>
      <div class="track-bar"><div class="track-fill p${i+1}" style="width:${Math.min(100, p.influence/maxScale*100)}%"></div></div>
      <div class="track-value">${p.influence}</div>
    </div>`).join('');
}

function renderRoundStepper(){
  const el = document.getElementById('roundStepper');
  if(!el) return;
  const parts = [];
  for(let n=1; n<=TOTAL_ROUNDS; n++){
    const cls = n<state.round || state.phase==='ended' ? 'done' : n===state.round ? 'active' : '';
    if(n>1) parts.push(`<div class="connector ${n-1<state.round?'done':''}"></div>`);
    parts.push(`<div class="step ${cls}">${n}</div>`);
  }
  el.innerHTML = parts.join('');
}

function renderTurnBanner(){
  const el = document.getElementById('turnBanner');
  if(!el) return;
  const activeIdx = currentPicker();
  if(state.phase==='draft' && activeIdx!==null){
    const player = state.players[activeIdx];
    const isMe = online.enabled ? activeIdx===online.myIndex : player.type==='human';
    el.innerHTML = isMe ? `<b>Your turn</b> to draft a site.` : `Waiting on <b>${esc(player.name)}</b> to draft...`;
  } else if(state.phase==='skirmish-decide' || state.phase==='skirmish-commit'){
    el.innerHTML = `<b>Skirmish</b> in progress...`;
  } else {
    el.innerHTML = '';
  }
}

function renderHud(){
  const el = document.getElementById('playerCards');
  el.innerHTML = state.players.map((p,i)=>{
    const activeIdx = currentPicker();
    const isActive = state.phase==='draft' && activeIdx===i;
    const obj = getObjective(p);
    const leader = getLeader(p);
    return `
    <div class="player-card p${i+1} ${isActive?'active':''}">
      <div class="name"><span>${esc(p.name)} ${p.type==='bot'?'(Bot)':''}</span><span class="influence-badge">${p.influence} Influence</span></div>
      <div class="stats">
        <span>${icon('credits')}Credits: ${p.credits}</span>
        <span>${icon('ore')}Ore: ${p.ore}</span>
        <span>${icon('troops')}Troops: ${p.troops}</span>
        <span>${icon('cards')}Cards: ${p.hand.length}</span>
        ${p.isAggressor?`<span class="pill aggr">Aggressor${p.aggressorBonus?' +1':''}</span>`:''}
        ${(()=>{
          // >>> WAGERS (feature: Fury + Betrayal tokens) - the flat
          // >>> "Momentum +1" pill becomes the Fury ladder rung, and both
          // >>> players' Betrayal tokens get PUBLIC pips here.
          if(typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.hudPill) return OD.Wagers.hudPill(p);
          return p.winStreak>=2?`<span class="pill momentum">Momentum +1</span>`:'';
        })()}
      </div>
      ${leader?`<div class="objective-line">Leader: <b>${leader.name}</b> - ${leader.desc}</div>`:''}
      ${obj?objectiveHudLine(p, obj):''}
    </div>`;
  }).join('');
}

/* Objective line with live progress. The `check` is still the source of
   truth for "met" - progress is only there so a 3-round-old goal reads as
   "1 of 3 wins" rather than a dead "not yet". */
function objectiveHudLine(p, obj){
  const met = obj.check(p);
  let progress = '';
  if(typeof obj.progress === 'function'){
    try{
      const pr = obj.progress(p) || {};
      if(pr.need > 1) progress = ` <span class="obj-progress">${pr.have} of ${pr.need} ${pr.unit||''}` +
        `${pr.note ? ` · ${pr.note}` : ''}</span>`;
    }catch(_){ /* a broken progress fn must not blank the whole HUD */ }
  }
  return `<div class="objective-line">Objective: <b>${obj.name}</b> - ${obj.desc} ` +
    `<span class="obj-status ${met?'met':''}">${met?`met (+${obj.bonus})`:'not yet'}</span>${progress}</div>`;
}

/* Every tile the board shows this round: the eight real sites, PLUS the Rift
   while it is live. openLocations() - the list the bot picks from and
   humanPick() validates against - already includes the Rift, so the
   renderer asking the same question is what makes the board honest: a tile
   a bot can draft is a tile a human can see and click. Returns null when
   there is no live Rift (before Round 3, or once it has been taken). */
function riftLocIfLive(){
  if(typeof OD === 'undefined' || !OD.Chaos || typeof OD.Chaos.riftLoc !== 'function') return null;
  try{ return OD.Chaos.riftLoc(state) || null; }
  catch(_){ return null; }
}
function boardLocations(){
  const rift = riftLocIfLive();
  return rift ? LOCATIONS.concat([rift]) : LOCATIONS;
}

/* What the Advanced tier's note actually says. `advAfford` is a TRI-STATE and
   has to be one:
     true  - this player was evaluated against this price and can pay it;
     false - this player was evaluated against this price and cannot;
     null  - nobody was evaluated, because it is NOT THIS PLAYER'S PICK.

   The old signature took a boolean that the caller built as
   `actor ? canAffordExtra(loc, actor) : false`, so "not your turn" arrived
   indistinguishable from "you cannot pay this", and every Advanced tier on the
   board printed "cannot afford" for roughly half the wall-clock of a
   human-vs-bot game - including Outpost and Shrine Advanced, which are
   `consolation`-tiered and therefore ALWAYS takeable at a reduced payout, and
   which under MELTDOWN the board strip itself describes as free. The renderer
   was making a claim about a player it had not looked at.

   So a note that is about AFFORDABILITY is now only ever printed from an
   evaluation. `null` says nothing about the price at all - the row is still
   visually inert (see `advDisabled`), it is inert because it is not your pick,
   and the tile head's own title already says exactly that.

   The gate ('unlocks Round 2') is a fact about the ROUND, not about a player,
   so it is still printed when it is not your pick. */
function advancedNote(loc, advUnlocked, advAfford){
  if(!advUnlocked) return 'unlocks Round 2';
  /* The two ROUND facts come first and are printed whoever is picking: a waived
     cost is waived for the whole board, exactly as the gate is a fact about the
     round rather than about a player. This is also the only order in which the
     waiver and the price cannot disagree - `loc.advanced.note` is the real
     price, and the Rift's is this round's MUTATED one, so under Meltdown (which
     overrides even the Rift) it must never be printed. */
  if(state && state.meltdown) return 'FREE — MELTDOWN';
  if(advAfford === false) return 'cannot afford';
  /* Not your pick: no affordability was evaluated, so none is claimed. */
  if(advAfford !== true) return '';
  return loc.advanced.note || '';
}

/* Which of the four `.tier-note` states a note is, for the stylesheet's
   .is-free / .is-short / .is-locked / .is-cost block. A WAIVED cost and a
   BLOCKED cost are two near-identical amber tints, so the sheet splits them on
   border + glyph + words; until this returned a class, an Advanced tile whose
   cost had been waived under Meltdown and one the player could not pay both
   rendered as the same neutral note. `is-cost` is the default look and is only
   emitted when there is genuinely a price to show. */
function tierNoteClass(note){
  const s = String(note || '');
  if(/meltdown/i.test(s)) return 'is-free';
  if(/cannot afford/i.test(s)) return 'is-short';
  if(/unlocks Round 2/i.test(s)) return 'is-locked';
  return s ? 'is-cost' : '';
}

function renderBoard(){
  const el = document.getElementById('board');
  const activeIdx = currentPicker();
  const humanCanPick = online.enabled
    ? (state.phase==='draft' && activeIdx===online.myIndex)
    : (state.phase==='draft' && activeIdx!==null && state.players[activeIdx].type==='human');
  const actor = humanCanPick ? state.players[online.enabled?online.myIndex:activeIdx] : null;

  const newSnapshot = {};
  /* The ninth cell. An eight-site game in a 3x3 grid leaves one square of bare
     felt, and bare felt in the middle of a board reads as a missing tile rather
     than as a square nobody has claimed. It is a real slot with a real job: the
     Rift opens here from Round 3, so the empty square is marked as the place
     the ninth site will appear - and the MARKING changes with the round, so it
     never contradicts the board header, which says "Rift closed" from Round 3
     once the window has passed. The whole marker is switched off the moment the
     Rift is real, which is tracked here because this function is what knows. */
  const riftLive = !!riftLocIfLive();
  el.classList.toggle('has-rift', riftLive);
  el.style.setProperty('--rift-note', riftLive ? ''
    : (state.round >= 3 ? 'Rift closed this round' : 'Rift opens Round 3'));
  el.innerHTML = boardLocations().map(loc=>{
    const taken = state.board ? state.board[loc.id] : null;
    newSnapshot[loc.id] = taken ? taken.owner : null;
    const justTaken = !!taken && prevBoardSnapshot && prevBoardSnapshot[loc.id]===null;
    const pickable = humanCanPick && !taken;
    /* >>> D4: THE TRI-STATE. `actor` is null whenever it is not this player's
       pick, and the old `actor ? canAffordExtra(loc, actor) : false` turned
       that into a claim about a player who was never evaluated. null now means
       exactly "nobody was evaluated" and advancedNote() reads it as silence
       rather than as a verdict. */
    const advAfford = actor ? !!canAffordExtra(loc, actor) : null;

    const advUnlocked = advancedUnlocked();
    const takenBasic = taken && taken.tier==='basic';
    const takenAdvanced = taken && taken.tier==='advanced';

    const basicDisabled = !pickable;
    /* Inert when it is not your pick (that is `!pickable`, and it is the
       honest reason), when Advanced has not unlocked, or when the price was
       evaluated and could not be met. `advAfford === null` adds nothing here:
       `!pickable` is already true whenever there is no actor, so a not-your-turn
       row is greyed for being not your turn and not for a price nobody looked
       at. */
    const advDisabled = !pickable || !advUnlocked || advAfford === false;

    function row(tier, label, note, isTaken, disabled, takenOwner){
      const tag = tier==='advanced' ? 'ADV' : 'BASIC';
      const cls = ['tier-row', tier, isTaken?'is-taken':'', (disabled && !isTaken)?'disabled':''].join(' ');
      const actionable = pickable && !isTaken && !disabled;
      const data = actionable ? `data-loc="${loc.id}" data-tier="${tier}"` : '';
      const takenTag = isTaken ? `<span class="taken-tag p${(takenOwner+1)}">${esc(state.players[takenOwner].name)}</span>` : '';
      const noteEl = (!isTaken && note) ? `<span class="tier-note ${tierNoteClass(note)}">${note}</span>` : '';
      /* Keyboard operability: a tier row is a BUTTON, so it is one. A
         keyboard player used to be locked out of the entire game because
         every pickable thing was a bare <div> with a click handler and no
         tabindex. `.focus-visible` rings already exist in the stylesheet.
         `aria-pressed` is not right here (it is not a toggle) and
         `aria-disabled` is, so a disabled row still announces itself as
         present-but-unavailable instead of vanishing from the tab order. */
      const a11y = actionable
        ? ' role="button" tabindex="0" aria-disabled="false"'
        : ' role="button" tabindex="-1" aria-disabled="true"';
      return `<div class="${cls}" ${data}${a11y}>`
        + `<span class="tier-tag">${tag}</span>`
        + `<span class="tier-label">${label}</span>`
        + noteEl + takenTag
        + `</div>`;
    }

    const tierRows = row('basic', loc.basic.label, loc.basic.note || '', takenBasic, basicDisabled, taken ? taken.owner : null)
      + row('advanced', loc.advanced.label, advancedNote(loc, advUnlocked, advAfford), takenAdvanced, advDisabled, taken ? taken.owner : null);

    const locIcon = locIconFor(loc.id);
    /* The Rift gets its own class so the mutation reads at a glance, and it takes
       the `contested` class for its permanently contested state. >>> D4: that
       class used to be described here as "REUSED from the ordinary
       contested-site styling (feature-wagers.js)", which stopped being true when
       Siege was cut - js/feature-wagers.js renders no contested-site styling
       any more. The RULE in css/style.css is still there and still bound to
       this class; it is the Rift's alone now. Both are state names in the
       markup, not colours. */
    const riftCls = (loc.id==='rift') ? ' loc-rift' : '';
    const contestedCls = (loc.id==='rift' && state.riftContested) ? ' contested' : '';
    const riftTag = (loc.id==='rift') ? '<span class="taken-tag rift-tag">RIFT</span>' : '';

    /* >>> THE TILE'S OWN BODY WAS A DEAD ZONE (D4). Measured: clicking the
       name/icon block produced 0 DOM changes - no log, no state, no hint. It
       is the largest target on the tile and it is the first thing every player
       tries, so the honest-looking dead click was a silent refusal in the
       middle of the board.

       It is not made into a control here, because "which tier?" is a real
       question the tile cannot answer for the player, and guessing Basic would
       silently spend their pick. It is made HONEST instead: a `title` on the
       head states either what to do (choose a tier below) or why nothing will
       happen (already taken / not your turn), and `aria-hidden` is deliberately
       NOT used - the site's name is the tile's heading and hiding it would cost
       a screen-reader user the only thing the head has to say. The pointer
       affordance itself is a stylesheet question, reported in the handover:
       `.loc-head{ cursor:default }` and, ideally, no `:hover` lift on a head
       that cannot be pressed. */
    const headTitle = taken
      ? `${state.players[taken.owner].name} already took this site (${taken.tier==='advanced' ? 'Advanced' : 'Basic'}) — nothing left to pick here.`
      : (pickable
          ? 'Choose a tier below: Basic is free, Advanced costs more and pays more.'
          : (state.phase==='draft'
              ? 'Not your turn to pick — this tile opens when the picker reaches you.'
              : 'The draft is not open right now — tiles open again on your pick turn.'));

    return `
      <div class="loc${riftCls}${contestedCls}${pickable?' pickable':''}${taken?' loc-taken':''}${justTaken?' just-taken':''}" data-loc="${loc.id}">
        <div class="loc-head" data-inert="1" title="${esc(headTitle)}">
          <div class="loc-icon" style="background:${locIcon.bg}">${icon(locIcon.icon)}</div>
          <h3>${riftTag}${loc.name}</h3>
        </div>
        <div class="loc-tiers">${tierRows}</div>
      </div>`;
  }).join('');
  prevBoardSnapshot = newSnapshot;

  if(humanCanPick){
    el.querySelectorAll('.tier-row[data-loc]').forEach(r=>{
      const go = (e)=>{ if(e){ e.stopPropagation(); e.preventDefault(); } sfx.click(); humanPick(r.dataset.loc, r.dataset.tier); };
      r.onclick = go;
      r.onkeydown = (e)=>{
        if(e.key==='Enter' || e.key===' ' || e.key==='Spacebar') go(e);
      };
    });
  }
}

function renderIntrigueHand(){
  const panel = document.getElementById('intriguePanel');
  const el = document.getElementById('intrigueHand');
  const activeIdx = currentPicker();
  const canAct = online.enabled
    ? (state.phase==='draft' && activeIdx===online.myIndex)
    : (state.phase==='draft' && activeIdx!==null && state.players[activeIdx].type==='human');
  if(!canAct){ panel.classList.add('hidden'); el.innerHTML=''; return; }
  const idx = online.enabled ? online.myIndex : activeIdx;
  const player = state.players[idx];
  if(player.intrigueHand.length===0){ panel.classList.add('hidden'); el.innerHTML=''; return; }
  panel.classList.remove('hidden');
  el.innerHTML = player.intrigueHand.map(c=>{
    const def = INTRIGUE_DEFS[c];
    const affordable = canPlayIntrigue(player);
    /* >>> D4: AN UNAFFORDABLE PLAY WAS `disabled`, WHICH MADE THE ENGINE'S OWN
       REFUSAL UNREACHABLE. `disabled` on a button removes it from the tab
       order, suppresses the click, and cancels the key activation - so the
       handler below could never fire, and the one sentence that explains the
       rule ("can't afford that Intrigue card - it costs 2 Credits") was dead
       code reachable only from a console. The control is now aria-disabled:
       still a tab stop, still focusable, still announces why, and still says
       no. aria-disabled over disabled is the whole point - a control that
       cannot be explained cannot be focused, and cannot be focused means the
       reason is never read. */
    const why = `You cannot afford this Intrigue card \u2014 it costs ${INTRIGUE_PLAY_COST} Credits and you have ${player.credits}.`;
    return `<div class="intrigue-card" data-card="${c}">
      <b>${def.name}</b>
      <div class="intrigue-desc">${def.desc}</div>
      <button type="button" class="secondary intrigue-play-btn" data-card="${c}"
        ${affordable ? 'aria-disabled="false"' : `aria-disabled="true" title="${esc(why)}"`}>Play (${INTRIGUE_PLAY_COST} Credits)</button>
    </div>`;
  }).join('');
  /* Bound for EVERY card, affordable or not: an unaffordable press has to reach
     humanPlayIntrigue to be refused out loud (see D4 above). It is a no-op
     there beyond the refusal, and the latch in it means a double-press still
     only produces one message. */
  el.querySelectorAll('.intrigue-play-btn').forEach(btn=>{
    /* The event is passed through so the D5 latch can tell a reflexive
       second click at the same pixel from a deliberate click on another card. */
    btn.onclick = (ev)=> humanPlayIntrigue(btn.dataset.card, ev);
  });
}

/* ONE heading for the hand rack, not two.
   index.html's panel heading is the static string "Your Hand", which is wrong
   for a hotseat - the panel shows whichever seat is acting - and it sat
   directly above a second caption saying much the same thing. The lower caption
   is the one that carries information (whose hand this is), so the render layer
   takes the heading over: the panel keeps exactly one <h3>, and it names the
   seat. The duplicate caption is gone. */
function setHandHeading(title, note){
  const el = document.getElementById('hand');
  const panel = el && el.closest ? el.closest('.card-panel') : null;
  const h = panel ? panel.querySelector('h3') : null;
  if(!h) return;
  h.innerHTML = `${title} <span class="hand-cap">${note}</span>`;
}

/* >>> WHICH SEAT IS BEING ASKED TO COMMIT (D1).
   >>> During a Skirmish there is no `currentPicker()` - the draft is over - so
   >>> renderHand() used to fall through to `state.lastActiveIdx`, which is
   >>> written ONLY by applyLocationEffect() and therefore still pointed at the
   >>> AGGRESSOR. In a two-human hotseat the rail behind the defender's commit
   >>> modal was headed "<Aggressor>'s hand" and showed the aggressor's five
   >>> cards: player 2 decided their fight with player 1's hand in full view,
   >>> in the one mode built for two people at one keyboard.
   >>>
   >>> This is the authority for that question, derived from live state rather
   >>> than from a cached index, so it cannot go stale the way lastActiveIdx
   >>> did. Two moments, both covered:
   >>>   - `skirmish-decide`: `skirmishCtx` does not exist yet (it is created in
   >>>     startSkirmishCommit), and the seat being asked is whoever holds the
   >>>     Garrison - the same player advanceDraftOrSkirmish() calls the
   >>>     aggressor.
   >>>   - `skirmish-commit`: the aggressor commits first, so the seat asked is
   >>>     the aggressor while `aggCommit` is still null and the defender once
   >>>     it is set. Both halves are read live, which is what makes it correct
   >>>     at the defender's modal - the moment the old fallback got it wrong.
   >>> Returns null outside a Skirmish, and also when the fight is already fully
   >>> committed (nothing left to ask), so the caller's own fallback still owns
   >>> every other phase. */
function commitSeatIdx(){
  if(!state) return null;
  if(state.phase==='skirmish-decide'){
    const agg = state.players.findIndex(p=>p.isAggressor);
    return agg>=0 ? agg : null;
  }
  if(state.phase==='skirmish-commit' && skirmishCtx){
    if(skirmishCtx.aggCommit===null || skirmishCtx.aggCommit===undefined) return skirmishCtx.aggressorIdx;
    if(skirmishCtx.defCommit===null || skirmishCtx.defCommit===undefined) return skirmishCtx.defenderIdx;
    return null;
  }
  return null;
}

function renderHand(){
  const el = document.getElementById('hand');
  let showIdx;
  if(online.enabled){
    /* The guest's rail is visible to them alone, so their own seat is the only
       answer that is both correct and safe - and if the HOST is the one being
       asked, the guest is not asked at all and their own hand is what they
       should keep seeing. The D1 leak was a hotseat leak; online each side has
       its own screen, so this branch is correct as it stands. */
    showIdx = online.myIndex;
  } else {
    const activeIdx = currentPicker();
    /* In the draft, show whoever is picking right now. Outside the draft there
       is no active picker, so the rail must be told whose hand it is by the
       phase: during a Skirmish that is the seat being asked to commit (D1,
       commitSeatIdx above), and outside one it is the player who most recently
       acted (`lastActiveIdx`, set in applyLocationEffect). The old fallback for
       the latter was findIndex(p => p.type === 'human'), which is always 0 in
       a two-human hotseat - so after Player 2's Skirmish the panel silently
       flipped back to showing Player 1's hand. */
    const commitSeat = commitSeatIdx();
    if(state.phase==='draft' && activeIdx!==null && state.players[activeIdx].type==='human'){
      showIdx = activeIdx;
    } else if(commitSeat!==null && state.players[commitSeat] && state.players[commitSeat].type==='human'){
      showIdx = commitSeat;
    } else if(typeof state.lastActiveIdx === 'number' && state.players[state.lastActiveIdx]
              && state.players[state.lastActiveIdx].type==='human'){
      showIdx = state.lastActiveIdx;
    } else {
      const humanIdx = state.players.findIndex(p=>p.type==='human');
      showIdx = humanIdx>=0 ? humanIdx : 0;
    }
  }
  const player = state.players[showIdx];
  if(!player || (!online.enabled && player.type!=='human')){
    el.innerHTML = '<span style="color:var(--muted-text)">No human player — sit back and watch the bots duel.</span>';
    setHandHeading('Hand', 'no human seat this game');
    return;
  }
  setHandHeading(online.enabled ? 'Your hand' : `${esc(player.name)}'s hand`, 'used only in a Skirmish');

  const prevSeen = handRenderCache[showIdx] || new Set();
  const groups = groupHand(player.hand);
  handRenderCache[showIdx] = new Set(player.hand);

  /* Belt and braces on the G3 invariant: a group whose card list is empty is
     dropped HERE as well as inside groupHand, so no caller can ever paint a
     category header over nothing. */
  const shown = groups.filter(g=>g.cards && g.cards.length);

  el.innerHTML = (shown.length ? shown.map(g=>`
      <div class="hand-group">
        <div class="hand-group-label">${g.category}</div>
        <div class="hand-group-cards">
          ${g.cards.map(c=>{
            const def = CARD_DEFS[c];
            const isNew = !prevSeen.has(c);
            const powerLabel = def.mod===null ? '?' : `+${def.mod}`;
            return `<div class="tcard${isNew?' card-new':''}">
              <div class="tcard-top"><span class="tcard-power">${powerLabel}</span><b>${def.name}</b></div>
              <div class="tcard-desc">${def.desc}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`).join('') : '<span style="color:var(--muted)">Empty hand.</span>');
}

/* The log's own header. index.html ships a static `<h3>Log</h3>` and no
   `#logPanel` cannot be edited, so the meta row is created lazily INSIDE the
   panel and immediately BEFORE #log - not inside #log. That placement is load
   bearing: css/style.css animates `#log .entry:first-child`, and a header
   element as #log's first child would steal :first-child from the newest line
   and the whole panel would stop sliding in new entries.

   NEW CLASSES (for the stylesheet owner): .log-head, .log-head-n. */
function renderLogHead(el){
  const panel = el.parentNode;
  if(!panel) return null;
  let head = document.getElementById('logHead');
  if(!head){
    head = document.createElement('div');
    head.id = 'logHead';
    head.className = 'log-head';
    panel.insertBefore(head, el);
  }
  const n = state.logEntries.length;
  head.innerHTML = `<span class="log-head-n">${n} ${n===1?'entry':'entries'} &middot; newest first</span>`;
  return head;
}

function renderLog(){
  const el = document.getElementById('log');
  if(!el) return;
  trimLog();
  renderLogHead(el);
  el.innerHTML = state.logEntries.slice().reverse().map(e=>
    `<div class="entry ${logEntryType(e)}">${e}</div>`).join('');
  /* Newest is FIRST in the array, so the scroll position belongs at the top.
     Without this the panel keeps whatever offset it had and, on a re-render
     that shrinks the content, parks the player somewhere in the middle of
     history instead of on the line that just happened. */
  if(el.scrollTop !== 0) el.scrollTop = 0;
}

/* Confetti fires ONCE per finished game. showEndScreen() is reachable more than
   once for one game (the online guest re-renders it on every snapshot that
   arrives with phase 'ended', and a reconnect re-runs it), so an unguarded
   call rains particles on every duplicate render. Reset in startGame(). */
let endConfettiFired = false;

function showEndScreen(){
  document.getElementById('game').classList.add('hidden');
  const end = document.getElementById('endScreen');
  end.classList.remove('hidden');
  const [p1,p2] = state.players;
  const obj1 = getObjective(p1), obj2 = getObjective(p2);
  let headline, winnerIdx;
  if(p1.influence===p2.influence){ headline = "It's a draw!"; winnerIdx = -1; }
  else if(p1.influence>p2.influence){ headline = `${esc(p1.name)} wins!`; winnerIdx = 0; }
  else { headline = `${esc(p2.name)} wins!`; winnerIdx = 1; }

  /* ---- G1.3 WEIGHT THE OUTCOME ----------------------------------------
     Victory and defeat used to be the SAME markup with two different words in
     the <h1>: the harness diffed both screens and the class sets were
     byte-identical apart from that string, so nothing on the page said "you
     won" except a sentence. Three new signals, all class names so the
     stylesheet owns the pixels and a greyscale reader still gets them:

       #endScreen.is-victory  / .is-defeat / .is-draw   (whole panel)
       .player-card.is-winner / .is-loser              (the two chips)
       h1[data-outcome="victory|defeat|draw"]           (the headline)

     A tie carries NONE of the winner/loser classes: neither seat won, and
     painting one of them as "the winner" on a draw is the kind of small lie a
     results screen should not tell. */
  const outcome = winnerIdx===-1 ? 'draw' : (winnerIdx===0 ? 'victory' : 'defeat');
  const panelState = winnerIdx===-1 ? 'is-draw' : (winnerIdx===0 ? 'is-victory' : 'is-defeat');
  ['is-victory','is-defeat','is-draw'].forEach(c=> end.classList.toggle(c, c===panelState));
  const cardState = (i)=> winnerIdx===-1 ? '' : (i===winnerIdx ? ' is-winner' : ' is-loser');

  if(winnerIdx!==-1){
    if(!online.enabled || winnerIdx===online.myIndex){ sfx.win(); OD.Sound.play('victory.fanfare'); }
    else { sfx.lose(); OD.Sound.play('defeat'); }
  } else {
    /* A draw used to be completely silent - it now gets its own cue. */
    OD.Sound.play('tie');
  }

  /* ---- G1.1 THE SCORE-GAP BAR -----------------------------------------
     css/style.css has authored .end-gap, .end-gap-label, .end-gap-bar,
     .end-gap-fill, .end-gap-value and an #endScreenGap confetti anchor, and
     NOTHING ever emitted them - the number that decided a six-round game was
     a table cell.

     The two fills are ABSOLUTELY positioned inside .end-gap-bar (which the
     stylesheet already gives position:relative and overflow:hidden) rather
     than left to flow. The sheet carries `.end-gap-fill.p2{margin-left:auto}`,
     which only means anything in a flex row, and .end-gap-bar is not flex -
     as flowing children the two fills would stack vertically and the second
     would be clipped away entirely. Absolute insets read correctly with the
     sheet as authored AND with `display:flex` added to .end-gap-bar later. */
  const total = p1.influence + p2.influence;
  const margin = Math.abs(p1.influence - p2.influence);
  const share1 = total > 0 ? Math.round((p1.influence / total) * 1000) / 10 : 50;
  const share2 = Math.round((100 - share1) * 10) / 10;   // exact complement, so the fills sum to 100
  const gapLead = margin === 0 ? 'Level' : `${esc(p1.influence > p2.influence ? p1.name : p2.name)} leads`;
  const gapValue = margin === 0
    ? `Level finish &mdash; both outposts on <span class="is-margin">${p1.influence}</span> Influence`
    : `${esc(p1.influence > p2.influence ? p1.name : p2.name)} wins by <span class="is-margin">${margin}</span> Influence`;
  const gapHtml = `
    <div class="end-gap" id="endScreenGap">
      <div class="end-gap-label">
        <span class="end-gap-name p1">${esc(p1.name)} <b>${p1.influence}</b></span>
        <span class="end-gap-lead">${gapLead}</span>
        <span class="end-gap-name p2"><b>${p2.influence}</b> ${esc(p2.name)}</span>
      </div>
      <div class="end-gap-bar">
        <div class="end-gap-fill p1" style="position:absolute;top:0;bottom:0;left:0;width:${share1}%"></div>
        <div class="end-gap-fill p2" style="position:absolute;top:0;bottom:0;right:0;width:${share2}%"></div>
      </div>
      <div class="end-gap-value">${gapValue}</div>
    </div>`;

  function statRow(label, key, fmt){
    const v1 = fmt ? fmt(p1[key]) : p1[key];
    const v2 = fmt ? fmt(p2[key]) : p2[key];
    return `<tr><td>${label}</td><td>${v1}</td><td>${v2}</td></tr>`;
  }

/* END-SCREEN TRAJECTORY (G1.2). The final tally is a static number; the game
     that produced it is not. The player scored all of this across six rounds
     of drafts, caps and Skirmishes, and the end screen used to present only
     the sum - so a 22-4 win and a 22-4 lead built the same way read
     identically. `state.history` is appended in endRound BEFORE anything can
     end the game, so all six rounds are present even on the final one; the
     round-6 entry is re-synced after the objective payout so its Influence is
     the number the game actually ended on.

     The PIVOT is the single round where the lead changed hands by the largest
     margin. It is the round the loser would point at and the winner would
     rather forget, which is exactly why it earns a line of its own. */
  const history = (state.history || []).filter(h => h && Array.isArray(h.influence) && h.influence.length===2);
  let trajectoryHtml = '';
  let pivot = null;
  if(history.length){
    const lead = (h)=> h.influence[0] - h.influence[1];
    const prev = (h)=> {
      const i = history.indexOf(h);
      return i > 0 ? history[i-1] : null;
    };
    /* Largest single-round CHANGE in the gap. Using the change rather than
       the absolute gap matters: a player who was already 10 up and wins
       again by 10 has not had a pivotal round, they have had six quiet
       ones. A first-round lead has no previous to change from, so it is
       measured from 0-0. Ties keep the EARLIER round, which is the round that
       actually set the tone rather than the one that failed to move it. */
    history.forEach(h=>{
      const now = lead(h);
      const before = prev(h);
      const was = before ? lead(before) : 0;
      const swing = Math.abs(now - was);
      if(!pivot || swing > pivot.swing) pivot = {h, swing, was, now};
    });

    /* `gained` is recorded per round in endRound; recomputing it from the
       running totals is the same arithmetic and is what keeps this correct for
       a history written by an older snapshot. */
    const gainOf = (h, before, k)=> Array.isArray(h.gained) && h.gained.length===2
      ? h.gained[k]
      : (h.influence[k] - (before ? before.influence[k] : 0));

    const rows = history.map((h)=>{
      const before = prev(h);
      const d0 = gainOf(h, before, 0), d1 = gainOf(h, before, 1);
      const gap = lead(h);
      const leader = gap === 0 ? '-' : (gap > 0 ? esc(p1.name) : esc(p2.name));
      const cls = gap === 0 ? '' : (gap > 0 ? 'p1' : 'p2');
      const ob = Array.isArray(h.objectiveBonus) ? h.objectiveBonus : [0,0];
      /* The round an objective bonus was banked on is flagged in the row: the
         +4 is frequently the single biggest number in the column and it used
         to be invisible in the trajectory. */
      const bonusTag = (ob[0] > 0 || ob[1] > 0)
        ? ` <span class="trajectory-bonus">obj +${(ob[0]||0) + (ob[1]||0)}</span>` : '';
      return `<tr${pivot && pivot.h===h ? ' class="pivot-round"' : ''}>`
        + `<td>${h.round}</td>`
        + `<td>${h.influence[0]} <span style="color:var(--muted);font-size:11px">(${d0>=0?'+':''}${d0})</span></td>`
        + `<td>${h.influence[1]} <span style="color:var(--muted);font-size:11px">(${d1>=0?'+':''}${d1})</span></td>`
        + `<td class="${cls}">${leader}</td>`
        + `<td>${h.heldBack
            ? '<span style="color:var(--muted)">held back (+1)</span>'
            : (h.skirmish ? 'yes' : '<span style="color:var(--muted)">no fight</span>')}${bonusTag}</td>`
        + `</tr>`;
    }).join('');

    /* >>> D4: "THE PIVOT WAS ROUND 6. ANA TOOK IT FROM ANA". The sentence was built
     >>> from `pivot.now` (who leads AFTER the round) and `pivot.was` (who led
     >>> BEFORE it) with no check that these are DIFFERENT people. Whenever one
     >>> player led throughout - which is most games, and every game where the
     >>> leader never gave the lead up - both names resolved to the same player
     >>> and the screen said so, on the end screen, in the one line whose job is
     >>> to explain the game. A pivot is a change of hands; where the hands did
     >>> not change, the honest sentence is that the leader simply widened a
     >>> lead they already had. */
    const pivotLine = (pivot && pivot.swing > 0)
      ? `<div class="pivot-note"><b>The pivot was Round ${pivot.h.round}.</b> `
        + `${(()=>{
            if(pivot.now === 0) return 'The lead tied out';
            const taker = esc((pivot.now > 0 ? p1.name : p2.name));
            /* Signed by the same convention as `lead()`: positive is seat 1. */
            const changedHands = (pivot.was !== 0 && Math.sign(pivot.was) !== Math.sign(pivot.now));
            if(pivot.was === 0)     return `${taker} took the lead`;
            if(!changedHands)        return `${taker} extended a lead they already had`;
            return `${taker} took it from ${esc((pivot.was > 0 ? p1.name : p2.name))}`;
          })()}`
        + ` &mdash; a swing of <b>${pivot.swing} Influence</b> in a single round.`
        + `${(pivot && pivot.h && Array.isArray(pivot.h.objectiveBonus) && (pivot.h.objectiveBonus[0] > 0 || pivot.h.objectiveBonus[1] > 0))
            ? ' Part of that was an objective bonus.' : ''}</div>`
      : '';

    trajectoryHtml = `
      <div class="trajectory">
        <h3>How it went</h3>
        <table class="stats-table">
          <thead><tr><th>Round</th><th>${esc(p1.name)}</th><th>${esc(p2.name)}</th><th>Led by</th><th>Skirmish</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${pivotLine}
      </div>`;
  }

  /* G1.4 THE OBJECTIVE BONUS IS THE LARGEST SWING IN THE GAME. +4 in one
     line, against a Skirmish that pays 4-6 but only for holding a Garrison,
     and it is settled after the last round so it never shows up as a Skirmish
     you could have played for. It used to render as one more table cell.

     The callout is SCORED rather than merely stated: it prints what each
     player would have finished on WITHOUT the bonus and then says the one
     thing that matters - whether the bonus decided the game, did not decide
     it, or turned a win into a level finish. The old copy asserted "the bonus
     did not change the winner" whenever exactly one player met their goal,
     which is false in precisely the case a player most wants to know about. */
  const lastEntry = history.length ? history[history.length-1] : null;
  const objMet = (p, obj)=> !!(obj && obj.check(p));
  const met1 = objMet(p1, obj1), met2 = objMet(p2, obj2);
  /* What was ACTUALLY paid, from the recorded round. Falls back to the
     objective's own declared bonus, so a screen rendered from a snapshot with
     no history behind it still scores the callout correctly instead of
     claiming a met objective was worth nothing. */
  const bonusOf = (i, met, obj)=> {
    const rec = (lastEntry && Array.isArray(lastEntry.objectiveBonus) && lastEntry.objectiveBonus[i] > 0)
      ? lastEntry.objectiveBonus[i] : 0;
    if(rec > 0) return rec;
    return met && obj ? (obj.bonus || 0) : 0;
  };
  const b1 = bonusOf(0, met1, obj1), b2 = bonusOf(1, met2, obj2);
  const bare1 = p1.influence - b1, bare2 = p2.influence - b2;
  const bareMargin = Math.abs(bare1 - bare2);
  const bareWinner = bare1 === bare2 ? -1 : (bare1 > bare2 ? 0 : 1);
  let flipLine = '';
  if(met1 !== met2){
    if(bareWinner !== winnerIdx){
      if(winnerIdx === -1){
        /* The bonus pulled a game that was heading one way back to level. That
           is the most interesting thing the +4 ever does, so it gets said
           plainly rather than left to arithmetic. */
        flipLine = `<div class="objective-callout-flip">The bonus <b>levelled the game</b> &mdash; without it `
          + `${esc(bare1 > bare2 ? p1.name : p2.name)} would have won by ${bareMargin} Influence.</div>`;
      } else if(bareWinner === -1){
        flipLine = `<div class="objective-callout-flip">The bonus <b>decided the game</b> &mdash; without it the Influence track would have finished level.</div>`;
      } else {
        flipLine = `<div class="objective-callout-flip">The bonus <b>decided the game</b> &mdash; `
          + `${esc(state.players[winnerIdx].name)} finished on the Skirmishes and Sites alone only `
          + `${esc(state.players[1-winnerIdx].name)} led by ${bareMargin} Influence.</div>`;
      }
    } else if(margin > 0){
      flipLine = `<div class="objective-callout-flip">The bonus did not change the winner &mdash; `
        + `${esc(state.players[winnerIdx].name)} would still have taken it by ${bareMargin} Influence.</div>`;
    }
  }
  const objectiveCallout = (met1 || met2)
    ? `<div class="objective-callout">
        <div class="objective-callout-h">Objective bonus &mdash; +${OBJECTIVE_BONUS} each, settled after the last round</div>
        <div class="objective-callout-row">
          <b>${esc(p1.name)}</b> &mdash; ${obj1.name}: ${met1
            ? `<b class="met">MET, +${b1}</b>. Without it: <b>${bare1}</b>.`
            : `not met. On the Influence they actually scored: <b>${p1.influence}</b>.`}
        </div>
        <div class="objective-callout-row">
          <b>${esc(p2.name)}</b> &mdash; ${obj2.name}: ${met2
            ? `<b class="met">MET, +${b2}</b>. Without it: <b>${bare2}</b>.`
            : `not met. On the Influence they actually scored: <b>${p2.influence}</b>.`}
        </div>
        ${flipLine}
      </div>`
    : '';

  /* One sentence of verdict, in the `.end-sub` pill the stylesheet already
     defines and never received. It names the outcome AND the size of it, so
     the first thing a player reads is the answer, not the word "wins". */
  const verdict = margin === 0
    ? `Level after ${TOTAL_ROUNDS} rounds. Nobody's objective broke the tie.`
    : `${esc((winnerIdx===0 ? p1.name : p2.name))} takes it by ${margin} Influence across ${TOTAL_ROUNDS} rounds.`;

  end.innerHTML = `
    <h1 class="end-headline" data-outcome="${outcome}">${headline}</h1>
    <p class="end-sub">${verdict}</p>
    ${gapHtml}
    <div class="row" style="justify-content:center">
      <div class="player-card p1${cardState(0)}"><div class="name">${esc(p1.name)}<span class="influence-badge">${p1.influence} Influence</span></div></div>
      <div class="player-card p2${cardState(1)}"><div class="name">${esc(p2.name)}<span class="influence-badge">${p2.influence} Influence</span></div></div>
    </div>
    ${objectiveCallout}
    ${trajectoryHtml}
    <table class="stats-table">
      <thead><tr><th>Final tally</th><th>${esc(p1.name)}</th><th>${esc(p2.name)}</th></tr></thead>
      <tbody>
        ${statRow('Influence','influence')}
        ${statRow('Credits','credits')}
        ${statRow('Ore','ore')}
        ${statRow('Troops','troops')}
        ${statRow('Cards in hand','hand',h=>h.length)}
        <tr><td>Objective</td><td>${obj1.name}${met1?' (met, +'+b1+')':''}</td><td>${obj2.name}${met2?' (met, +'+b2+')':''}</td></tr>
      </tbody>
    </table>
    <div class="footer-actions" style="justify-content:center;margin-top:20px">
      <button id="playAgain">Play Again</button>
    </div>
    <div id="demoLoopBar" class="hidden" style="justify-content:center;margin-top:14px"></div>
  `;

  /* The stylesheet's own comment on #endScreenGap says this is where
     OD.Fx.confetti() is meant to land (it overrides the host's overflow to
     visible so the rain crosses the whole screen). Fired on a win only, once
     per game, and OD.Fx no-ops under prefers-reduced-motion. */
  if(winnerIdx!==-1 && !endConfettiFired && typeof OD !== 'undefined' && OD.Fx && typeof OD.Fx.confetti === 'function'){
    endConfettiFired = true;
    try{
      const palette = winnerIdx===0
        ? ['#c98a2b','#e0c56a','#b5502e','#8a5a2b','#ffe9e2']
        : ['#2f6f7a','#7fa3c0','#c98a2b','#cfd8dc','#e6eef0'];
      OD.Fx.confetti('#endScreenGap', {count: 110, colors: palette});
    }catch(_){ /* confetti is decoration; never let it break the end screen */ }
  }
  document.getElementById('playAgain').onclick = ()=>{
    cancelDemoLoop();
    end.classList.add('hidden');
    if(online.ws){ online.ws.close(); online.ws = null; }
    online.enabled=false; online.isHost=false; online.guestReady=false; online.roomCode=null;
    document.getElementById('gameMode').value = 'local';
    updateModeUI();
    document.getElementById('setup').classList.remove('hidden');
  };

  /* Demo loop used to restart silently after 3s, yanking the end screen out
     from under anyone still reading the final tally. Now there is a visible
     countdown and a cancel button, and either one stops the loop for good
     (state.demoLoop is cleared so the next game starts as a one-shot).

     GUARD (G10): a second countdown is the one way this can double-start a
     game. showEndScreen() is reachable more than once for one finished game
     (the online guest re-renders the end screen on every snapshot that
     arrives with phase 'ended', and a reconnect re-runs it), and each call
     would otherwise start its own interval - two countdowns, two startGame()
     calls, two games racing each other out of one button press. The timer
     handle is checked before arming, and the interval clears itself before
     it fires. */
  if(state.demoLoop && !online.enabled && !demoLoopTimer){
    const bar = document.getElementById('demoLoopBar');
    if(!bar) return;
    bar.classList.remove('hidden');
    let remaining = DEMO_LOOP_SECONDS;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.id = 'demoLoopCancel';
    cancel.textContent = `Stop looping (${remaining}s)`;
    cancel.onclick = ()=>{
      cancelDemoLoop();
      bar.innerHTML = '<span style="color:var(--muted);font-size:13px">Looping stopped. Use Play Again for another game.</span>';
    };
    const label = document.createElement('span');
    label.style.cssText = 'color:var(--muted);font-size:13px;margin-right:12px';
    label.textContent = `Next demo game in ${remaining}s…`;
    bar.appendChild(label);
    bar.appendChild(cancel);

    demoLoopTimer = setInterval(()=>{
      remaining -= 1;
      /* Release the handle FIRST. If startGame() is re-entered (or throws)
         the handle is already null, so no second interval can be armed from
         inside the callback. */
      const t = demoLoopTimer;
      demoLoopTimer = null;
      clearInterval(t);
      if(remaining > 0){
        demoLoopTimer = t;   // still counting: re-arm the same handle
        if(cancel.textContent) cancel.textContent = `Stop looping (${remaining}s)`;
        label.textContent = `Next demo game in ${remaining}s…`;
        return;
      }
      /* Play Again also calls cancelDemoLoop(); a click that lands in the
         same tick as the countdown must not also start a game. */
      end.classList.add('hidden');
      startGame();
    }, 1000);
  }
}

/* Clears any running demo-loop countdown and switches the mode to one-shot
   so a later game doesn't silently auto-restart either. */
function cancelDemoLoop(){
  if(demoLoopTimer){ clearInterval(demoLoopTimer); demoLoopTimer = null; }
  if(state && state.demoLoop){
    state.demoLoop = false;
    const box = document.getElementById('demoLoop');
    if(box) box.checked = false;
  }
}

onDom(()=>{
document.getElementById('startBtn').addEventListener('click', ()=>{ ensureAudioCtx(); sfx.click(); startGame(); });
document.getElementById('gameMode').addEventListener('change', updateModeUI);

/* ONE way to choose a mode, so the click path and the keyboard path cannot
   drift. It writes #gameMode and re-runs updateModeUI, which is what paints
   the Selected flag, reveals the Host/Join/Demo panels and - via
   syncModeCardsA11y - sets aria-checked and the roving tabindex. */
function selectMode(card){
  if(!card || !card.dataset.mode) return;
  ensureAudioCtx();
  document.getElementById('gameMode').value = card.dataset.mode;
  document.querySelectorAll('.mode-card').forEach(c=>c.classList.remove('selected'));
  card.classList.add('selected');
  updateModeUI();
}
document.querySelectorAll('.mode-card').forEach(card=>{
  card.addEventListener('click', ()=> selectMode(card));
});

/* >>> KEYBOARD, for the group that had none. One delegated keydown on the
   container rather than four on the cards: the cards' tabindex values are
   rewritten by the roving logic on every selection, and a listener that
   survives that is one less thing that can be silently unbound.

   ArrowRight/ArrowDown and ArrowLeft/ArrowUp both move, because a radiogroup
   is expected to work with either axis and the cards are laid out as a grid -
   ArrowUp/Down are the natural keys for the row, ArrowLeft/Right for the
   column, and a player will use both. Home/End go to the ends. */
const modeGroup = document.getElementById('modeCards');
if(modeGroup){
  /* Selection follows focus, which is the standard: the roving tabindex moves
     to the new card AND selectMode() makes it the answer, so the two can never
     disagree - no state where focus is on Demo but Local is still checked. */
  const cards = ()=> Array.prototype.slice.call(modeGroup.querySelectorAll('.mode-card'));
  const focusCard = (card)=>{
    if(!card) return;
    selectMode(card);
    if(typeof card.focus === 'function') card.focus();
  };
  const step = (from, delta)=>{
    const list = cards();
    if(!list.length) return;
    const i = list.indexOf(from);
    focusCard(list[(((i < 0 ? 0 : i) + delta) % list.length + list.length) % list.length]);
  };
  modeGroup.addEventListener('keydown', (e)=>{
    if(e.ctrlKey || e.metaKey || e.altKey) return;
    const card = (e.target && e.target.closest) ? e.target.closest('.mode-card') : null;
    if(!card) return;
    const key = e.key;
    const list = cards();
    let handled = true;
    if(key==='Enter' || key===' ' || key==='Spacebar') selectMode(card);
    else if(key==='ArrowRight' || key==='ArrowDown') step(card, 1);
    else if(key==='ArrowLeft'  || key==='ArrowUp')   step(card, -1);
    else if(key==='Home')  focusCard(list[0]);
    else if(key==='End')   focusCard(list[list.length-1]);
    else handled = false;
    if(handled){
      /* Space would otherwise scroll the setup screen; Enter would otherwise
         submit the nearest form. */
      e.preventDefault();
      e.stopPropagation();
    }
  });
  /* Do the upgrade now rather than relying on a later updateModeUI() call, so
     the group is announced correctly even if a future edit drops that call. */
  syncModeCardsA11y();
}

/* >>> THE SOUND SWITCH. role="switch" + tabindex come from setSoundUI(); all
   that is left is to make Enter and Space do what a click does. A switch is
   not a <button>, so the browser synthesises nothing for these keys - without
   this the control is focusable, announced, and completely inert. */
[document.getElementById('soundToggle'), document.getElementById('soundToggleGame')].forEach(el=>{
  if(!el) return;
  el.addEventListener('click', toggleSound);
  el.addEventListener('keydown', (e)=>{
    if(e.key!=='Enter' && e.key!==' ' && e.key!=='Spacebar') return;
    e.preventDefault();
    toggleSound();
  });
});
setSoundUI();

window.addEventListener('beforeunload', (e)=>{
  const gameVisible = !document.getElementById('game').classList.contains('hidden');
  if(state && state.phase!=='ended' && gameVisible){
    e.preventDefault();
    e.returnValue = '';
  }
});

document.getElementById('createRoomBtn').addEventListener('click', ()=>{
  document.getElementById('hostStatus').textContent = 'Connecting…';
  online.ws = new WebSocket(wsUrl());
  online.isHost = true;
  online.ws.onopen = ()=> wsSend({type:'host'});
  online.ws.onmessage = (ev)=> handleHostSocketMessage(JSON.parse(ev.data));
  online.ws.onclose = ()=>{ document.getElementById('hostStatus').textContent = 'Disconnected from server.'; };
  online.ws.onerror = ()=>{ document.getElementById('hostStatus').textContent = 'Connection error.'; };
});

document.getElementById('joinRoomBtn').addEventListener('click', ()=>{
  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  if(!code){ document.getElementById('joinStatus').textContent = 'Enter a room code first.'; return; }
  document.getElementById('joinStatus').textContent = 'Connecting…';
  online.ws = new WebSocket(wsUrl());
  online.isHost = false;
  online.ws.onopen = ()=> wsSend({type:'join', code});
  online.ws.onmessage = (ev)=> handleGuestSocketMessage(JSON.parse(ev.data));
  online.ws.onclose = ()=>{ document.getElementById('joinStatus').textContent = 'Disconnected from server.'; };
  online.ws.onerror = ()=>{ document.getElementById('joinStatus').textContent = 'Connection error.'; };
});
});   // /onDom (setup + online wiring)

/* ------------------------- feature-owned rules copy -------------------------
   The rules modal used to describe a game that no longer existed: it taught
   a flat "two wins in a row = +1" streak bonus that was replaced by the Fury
   ladder, and it documented none of Betrayal tokens, All In / Ghost, Siege,
   Meltdown, Pressure / Collapse, Bounties or the Rift. A rule the player
   cannot find is a rule that does not exist.

   The two feature modules own the prose for their own mechanics and export
   it as ready-made HTML (OD.Wagers.RULES_HTML, OD.Chaos.RULES_HTML). Those
   strings are REFERENCE here, never transcribed: hand-copying them is how
   the copy silently drifts the first time a feature is rebalanced, which is
   exactly the bug this replaced. If a feature file is deleted, its tab
   disappears with it and the rest of the modal is untouched.

   `rulesTabs()` and `rulesPanelsHtml()` are both computed at OPEN time, not
   at module load, so a feature that registers late still gets a tab and the
   tab list can never disagree with the panel list. */

/* The retired flat streak bonus. The engine no longer has a rule by this
   name, and the only remaining mentions live in the feature's own rules
   prose, where they appear as historical asides ("replaces the old flat X
   bonus"). A player who searched the rules for the old term should not be
   pointed at a mechanic that is not in the game, so the name is retired
   here - the SENTENCE still says a rule was replaced, and the sentence is
   not re-typed, so this cannot go stale. */
const RETIRED_RULE_NAMES = [
  [/flat Momentum bonus/gi, 'flat streak bonus'],
  [/\bMomentum\b/g, 'the old flat streak bonus'],
];
function scrubRetiredRuleNames(html){
  let out = String(html == null ? '' : html);
  RETIRED_RULE_NAMES.forEach(([re, to]) => { out = out.replace(re, to); });
  return out;
}

/* The features that contribute rules, in tab order. `id` must match the
   panel id: selectRulesTab() pairs a tab's data-target with a panel's id,
   and openRulesModal() derives the tab's own id from it for aria-labelledby.
   `key` is the EXPORT NAME each feature publishes its prose under, and every
   feature publishes it as RULES_HTML - the whole point of the contract is
   that game.js never transcribes the copy, so it must name the export, not
   invent a second key that no feature sets. */
const RULES_FEATURES = [
  {id:'rules-wagers', label:'Fury & Tokens', short:'Fury', feature:'Wagers', key:'RULES_HTML'},
  {id:'rules-chaos',  label:'Meltdown', short:'Chaos',  feature:'Chaos',  key:'RULES_HTML'},
];

function availableRulesFeatures(){
  if(typeof OD === 'undefined') return [];
  return RULES_FEATURES.filter(f => {
    const mod = OD[f.feature];
    return !!(mod && typeof mod[f.key] === 'string' && mod[f.key].length > 0);
  });
}

function rulesTabs(){
  const base = [
    {id:'rules-objective', label:'Overview',   short:'Overview'},
    {id:'rules-board',     label:'Board Sites', short:'Sites'},
    {id:'rules-cards',     label:'Tactic Cards', short:'Cards'},
    {id:'rules-skirmish',  label:'Skirmish',    short:'Skirmish'},
    {id:'rules-extras',    label:'Extras',      short:'Extras'},
  ];
  /* Wagers and Meltdown sit either side of Modes: the two combat systems,
     then the two board systems, then how you are playing. */
  return base.slice(0, 4)
    .concat(availableRulesFeatures())
    .concat([base[4], {id:'rules-modes', label:'Play Modes', short:'Modes'}]);
}

function rulesPanelsHtml(){
  const panels = availableRulesFeatures().map(f =>
    `<section class="rules-panel" id="${f.id}" role="tabpanel" aria-labelledby="rules-tab-${f.id.replace('rules-','')}" hidden>`
    + scrubRetiredRuleNames(OD[f.feature][f.key])
    + `</section>`
  ).join('');
  /* Injected immediately before the closing .rules-panels div, i.e. after
     rules-modes, so the hand-written sections keep their authored order and
     the spliced ones never disturb it. */
  return panels;
}

function selectRulesTab(targetId){
  const tabs = document.querySelectorAll('.rules-tab');
  const panels = document.querySelectorAll('.rules-panel');
  tabs.forEach(btn=>{
    const on = btn.dataset.target === targetId;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
  });
  panels.forEach(panel=>{
    const on = panel.id === targetId;
    panel.classList.toggle('active', on);
    panel.hidden = !on;
  });
  const body = document.getElementById('skirmishBody');
  if(body) body.scrollTop = 0;
}

function openRulesModal(){
  const tabs = rulesTabs();
  const tabsHtml = `<div class="rules-tabs" role="tablist" aria-label="Rules sections">${tabs.map((t,i)=>
    `<button type="button" class="rules-tab${i===0?' active':''}" role="tab" id="rules-tab-${t.id.replace('rules-','')}"
      data-target="${t.id}" aria-selected="${i===0?'true':'false'}" tabindex="${i===0?0:-1}">
      <span class="rules-tab-full">${t.label}</span><span class="rules-tab-short">${t.short}</span>
    </button>`).join('')}</div>`;
  showModal('How to Play', tabsHtml + RULES_HTML + rulesPanelsHtml(), {dismissible:true, rules:true});

  const tabList = document.querySelector('.rules-tabs');
  if(!tabList) return;

  tabList.addEventListener('click', (e)=>{
    const btn = e.target.closest('.rules-tab');
    if(!btn) return;
    selectRulesTab(btn.dataset.target);
    btn.focus();
  });

  // Arrow-key tab navigation (standard tablist pattern)
  tabList.addEventListener('keydown', (e)=>{
    const tabs = [...tabList.querySelectorAll('.rules-tab')];
    const i = tabs.indexOf(document.activeElement);
    if(i < 0) return;
    let next = -1;
    if(e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % tabs.length;
    else if(e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + tabs.length) % tabs.length;
    else if(e.key === 'Home') next = 0;
    else if(e.key === 'End') next = tabs.length - 1;
    if(next < 0) return;
    e.preventDefault();
    selectRulesTab(tabs[next].dataset.target);
    tabs[next].focus();
  });
}
onDom(()=>{
document.getElementById('rulesBtn').addEventListener('click', openRulesModal);
document.getElementById('rulesBtnSetup').addEventListener('click', openRulesModal);

updateModeUI();
});   // /onDom

/* DOM-free surface for test/sites.test.js, and for anything else that needs
   the engine's own board table without a browser. The board is data, and the
   table a feature has to agree with it lives here and nowhere else.

   The OBJECTIVES block plus `startGame` / `getState` are the SIMULATION
   surface: a harness installs a fake `document` and a synchronous timer queue
   AFTER this file has loaded (onDom() has already declined to wire the page),
   calls startGame() in demo mode - which deals two bots - drains the queue,
   and reads the final state. That is how the objective met-rates were
   MEASURED rather than guessed, and it is why the thresholds in OBJECTIVES
   are numbers with a distribution behind them. */
if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    LOCATIONS, COST_RESOURCES, TOTAL_ROUNDS, CAPS,
    tierCost, tierIsAlwaysTakeable, canPayCost, takeCost, costPhrase,
    OBJECTIVES, OBJECTIVE_BONUS, HAND_CAP, ARCHIVIST_PLAYED, ARCHIVIST_HAND, INDUSTRIALIST_NEED,
    startGame, getState: ()=> state,
    /* >>> D4: THE SEAMS test/skirmish-odds.test.js NEEDS TO TEST THE REAL
       >>> THING. Its D4 block used to assert against a hand-rolled stand-in for
       >>> the commit handler, which is why a suite of 140 green tests sat on
       >>> top of a live double-click hole: a stand-in cannot be the defect.
       >>> These five are the minimum surface that lets a headless test drive
       >>> the ACTUAL commit chain - startSkirmishCommit builds the context,
       >>> showCommitModal renders the real dialog, renderBoard is the real
       >>> board renderer, logEntryType is the real log classifier, and
       >>> readSkirmishCtx is a getter because `skirmishCtx` is a module-level
       >>> `let` that an object literal would freeze at null. Nothing here is a
       >>> re-implementation of the behaviour under test. */
    showCommitModal, startSkirmishCommit, renderBoard,
    logEntryType, advancedNote, commitIsReplayed, MODAL_SHIELD_MS,
    readSkirmishCtx: ()=> skirmishCtx,
  };
}
