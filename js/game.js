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
const CATEGORY_ORDER = ['Aggressive','Defensive','Utility','Chaos'];

/* Cards are grouped by category for display (hand and the Skirmish commit
   picker), highest-impact first within each group. Since each player's deck
   has exactly one of each card id, cards can always be identified and
   removed by id - display order never has to match array index, so grouping
   is purely cosmetic and never risks selecting or discarding the wrong
   card. */
function groupHand(hand){
  return CATEGORY_ORDER
    .map(category=>({
      category,
      cards: hand.filter(c=>CARD_DEFS[c].category===category)
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
const LOCATIONS = [
  {id:'market',   name:'Market',
    basic:{label:'+3 Credits', cost:{}},
    advanced:{label:'+6 Credits', cost:{ore:1}, note:'pay 1 Ore'}},
  {id:'quarry',   name:'Quarry',
    basic:{label:'+2 Ore, +1 Troop', cost:{}},
    advanced:{label:'+4 Ore, +2 Troops', cost:{credits:1}, note:'pay 1 Credit'}},
  {id:'garrison', name:'Garrison',
    basic:{label:'+2 Troops, become Aggressor', cost:{}},
    advanced:{label:'+4 Troops, Aggressor gets +1 combat', cost:{ore:1}, note:'pay 1 Ore'}},
  {id:'outpost',  name:'Outpost',
    basic:{label:'Pay 3 Credits + 2 Ore → +4 Influence', cost:{credits:3, ore:2}, note:'can’t pay? +1', consolation:true},
    advanced:{label:'Pay 5 Credits + 3 Ore → +7 Influence', cost:{credits:5, ore:3}, note:'can’t pay? +2', consolation:true}},
  {id:'archive',  name:'Archive',
    basic:{label:'Draw 1 Tactic card', cost:{}, note:'hand must have room'},
    advanced:{label:'Draw 3 Tactic cards', cost:{credits:1}, note:'pay 1 Credit'}},
  {id:'foundry',  name:'Foundry',
    basic:{label:'+2 Credits, +1 Ore', cost:{}},
    advanced:{label:'+4 Credits, +3 Ore', cost:{troops:1}, note:'pay 1 Troop'}},
  {id:'bazaar',   name:'Bazaar',
    basic:{label:'Trade 2 Ore for 3 Credits', cost:{ore:2}, note:'no 2 Ore? +1 Credit', consolation:true},
    advanced:{label:'Trade 2 Ore for 6 Credits', cost:{ore:2}, note:'no 2 Ore? +2 Credits', consolation:true}},
  {id:'shrine',   name:'Shrine',
    basic:{label:'+1 Influence', cost:{}},
    advanced:{label:'Pay 2 Credits + 1 Ore → +3 Influence', cost:{credits:2, ore:1}, note:'can’t pay? +1', consolation:true}},
];

/* `consolation:true` on a tier means "always takeable" - the printed rule
   reads "Pay 5 Credits + 3 Ore → +7 Influence (else +2)", so a player who
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
const OBJECTIVE_BONUS = 4;
/* How long the end screen waits before looping into the next demo game. Long
   enough to actually read the final tally, and now visible + cancellable. */
const DEMO_LOOP_SECONDS = 8;
let demoLoopTimer = null;
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

function setSoundUI(){
  [document.getElementById('soundToggle'), document.getElementById('soundToggleGame')].forEach(el=>{
    if(!el) return;
    el.textContent = `Sound: ${soundOn?'On':'Off'}`;
    el.classList.toggle('on', soundOn);
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
        <p>Each player starts with <b>2 Credits</b>, <b>1 Ore</b>, <b>1 Troop</b>, <b>0 Influence</b>, and a personal deck of 14 Tactic cards. Caps are <b>Credits ${CAPS.credits} · Ore ${CAPS.ore} · Troops ${CAPS.troops}</b>, and they are <b>hard ceilings that clamp the moment you gain</b> — not an end-of-round trim. Anything over the cap is discarded immediately and never reaches your pool.</p>
      </div>
      <h3 class="rules-h">Each round (5 steps)</h3>
      <ol class="rules-steps">
        <li><span class="rules-step-title">Event</span> From Round 3, both players draw one shared Round Event that applies to you equally.</li>
        <li><span class="rules-step-title">Intrigue</span> From Round 2, both players draw 1 Intrigue card from the shared pool.</li>
        <li><span class="rules-step-title">Draft</span> 8 sites, 3 picks each (6 total) in snake order. Two sites go unused. First-picker alternates each round. Taking a site resolves Basic (free) or Advanced (costs more, pays more) immediately. You may also play one Intrigue card on your turn — free, it does not cost a pick.</li>
        <li><span class="rules-step-title">Skirmish</span> If someone took Garrison, they may attack. Otherwise skip this step.</li>
        <li><span class="rules-step-title">Upkeep</span> Anything over a cap is trimmed (it was already trimmed on the way in), then the next round begins.</li>
      </ol>
      <div class="rules-callout">
        <strong>Complexity ramp.</strong> Round 1 is Basic-only — no Intrigue or Events. Advanced + Intrigue unlock Round 2; Round Events from Round 3.
      </div>
    </section>

    <section class="rules-panel" id="rules-board" role="tabpanel" aria-labelledby="rules-tab-board" hidden>
      <p class="rules-intro">Eight sites. Each has a free <b>Basic</b> tier and a pricier <b>Advanced</b> tier. Two sites sit unused every round.</p>
      <div class="rules-sites">
        <article class="rules-site">
          <h4>Market</h4>
          <div class="rules-tier basic"><span class="rules-tier-tag">Basic</span><span>+3 Credits</span></div>
          <div class="rules-tier advanced"><span class="rules-tier-tag">Adv</span><span>Pay 1 Ore → +6 Credits</span></div>
        </article>
        <article class="rules-site">
          <h4>Quarry</h4>
          <div class="rules-tier basic"><span class="rules-tier-tag">Basic</span><span>+2 Ore, +1 Troop</span></div>
          <div class="rules-tier advanced"><span class="rules-tier-tag">Adv</span><span>Pay 1 Credit → +4 Ore, +2 Troops</span></div>
        </article>
        <article class="rules-site">
          <h4>Garrison</h4>
          <div class="rules-tier basic"><span class="rules-tier-tag">Basic</span><span>+2 Troops, become Aggressor</span></div>
          <div class="rules-tier advanced"><span class="rules-tier-tag">Adv</span><span>Pay 1 Ore → +4 Troops, Aggressor +1 Skirmish</span></div>
        </article>
        <article class="rules-site">
          <h4>Outpost</h4>
          <div class="rules-tier basic"><span class="rules-tier-tag">Basic</span><span>Pay 3 Credits + 2 Ore → +4 Influence (else +1)</span></div>
          <div class="rules-tier advanced"><span class="rules-tier-tag">Adv</span><span>Pay 5 Credits + 3 Ore → +7 Influence (else +2)</span></div>
        </article>
        <article class="rules-site">
          <h4>Archive</h4>
          <div class="rules-tier basic"><span class="rules-tier-tag">Basic</span><span>Draw 1 Tactic card</span></div>
          <div class="rules-tier advanced"><span class="rules-tier-tag">Adv</span><span>Pay 1 Credit → draw 3</span></div>
        </article>
        <article class="rules-site">
          <h4>Foundry</h4>
          <div class="rules-tier basic"><span class="rules-tier-tag">Basic</span><span>+2 Credits, +1 Ore</span></div>
          <div class="rules-tier advanced"><span class="rules-tier-tag">Adv</span><span>Pay 1 Troop → +4 Credits, +3 Ore</span></div>
        </article>
        <article class="rules-site">
          <h4>Bazaar</h4>
          <div class="rules-tier basic"><span class="rules-tier-tag">Basic</span><span>2 Ore → 3 Credits (else +1 Credit)</span></div>
          <div class="rules-tier advanced"><span class="rules-tier-tag">Adv</span><span>2 Ore → 6 Credits (else +2 Credits)</span></div>
        </article>
        <article class="rules-site">
          <h4>Shrine</h4>
          <div class="rules-tier basic"><span class="rules-tier-tag">Basic</span><span>+1 Influence, free</span></div>
          <div class="rules-tier advanced"><span class="rules-tier-tag">Adv</span><span>Pay 2 Credits + 1 Ore → +3 Influence (else +1)</span></div>
        </article>
      </div>
    </section>

    <section class="rules-panel" id="rules-cards" role="tabpanel" aria-labelledby="rules-tab-cards" hidden>
      <p class="rules-intro">14-card personal deck (one of each). Played <b>face-down only in a Skirmish</b>. Your hand starts <b>full</b> at ${HAND_CAP} and can never hold more than ${HAND_CAP}.</p>
      <div class="rules-callout">
        <strong>Your hand starts full.</strong> Archive, Foresight, Scout and Insight all draw Tactic cards — and all of them draw <b>zero</b> while your hand is at ${HAND_CAP}. Cards only ever leave your hand when you play one in a Skirmish, so drawing is a <b>rewards-for-spending</b> bonus, not a build-up. If the log says a card “drew 0”, you were at the cap.
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
        <li><span class="rules-step-title">Decide</span> Aggressor chooses attack or hold. Hold = no Skirmish.</li>
        <li><span class="rules-step-title">Commit</span> Aggressor picks troops (0–all) and may play one Tactic face-down.</li>
        <li><span class="rules-step-title">Respond</span> Defender does the same — and commits <b>second</b>, so they see what the aggressor committed. The commit window shows you the exact odds before you commit; the aggressor's window does not, because they do not know yet either.</li>
        <li><span class="rules-step-title">Spend</span> Committed troops are spent by both sides unless a card returns them (e.g. Feint, Fortify).</li>
        <li><span class="rules-step-title">Resolve</span> Each side: d6 + troops + card mod (+1 if Advanced Garrison Aggressor). Undermine subtracts 2 from the other total.</li>
        <li><span class="rules-step-title">Score</span> Higher total wins Influence equal to the margin, capped at your <b>Fury</b> rung's ceiling (or 6 on Skirmish Fever). Tie = no Influence; troops still spent. Some cards fire regardless of winner.</li>
      </ol>
      <div class="rules-callout">
        <strong>The streak bonus is the Fury ladder, not a flat one.</strong> Two wins in a row is no longer worth the same as four. The full ladder, the Catching Up valve, Betrayal tokens, the All In / Ghost wagers and Siege are all on the <b>Wagers</b> tab — that tab is owned by the feature that implements them, so it cannot drift out of date with the game.
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
  coup:            {name:'Coup',             desc:'Gain 3 Influence immediately.'},
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
      log(`${player.name} plays <b>Raid</b> -> steals ${stolen} Credits from ${opp.name}.`);
      break;
    }
    case 'requisition':
      player.ore += 2; player.credits += 1;
      log(`${player.name} plays <b>Requisition</b> -> +2 Ore, +1 Credit.`);
      break;
    case 'coup':
      player.influence += 3;
      log(`${player.name} plays <b>Coup</b> -> +3 Influence.`);
      break;
    case 'sabotage_supply': {
      const lost = Math.min(1, opp.troops);
      opp.troops -= lost;
      log(`${player.name} plays <b>Sabotage Supply</b> -> ${opp.name} loses ${lost} Troop${lost!==1?'s':''}.`);
      break;
    }
    case 'foresight':
      {
        const drew = drawCard(player, 2);
        log(`${player.name} plays <b>Foresight</b> -> ${drawLog(player, 2, drew, 'hand already at the limit')}`);
      }
      break;
    case 'windfall':
      player.credits += 3;
      log(`${player.name} plays <b>Windfall</b> -> +3 Credits.`);
      break;
    case 'reinforce':
      player.troops += 2;
      log(`${player.name} plays <b>Reinforce</b> -> +2 Troops.`);
      break;
    case 'marketplace':
      if(player.ore>=2){
        player.ore-=2; player.credits+=4;
        log(`${player.name} plays <b>Marketplace</b> -> trades 2 Ore for +4 Credits.`);
      } else {
        player.credits+=1;
        log(`${player.name} plays <b>Marketplace</b> without enough Ore -> consolation +1 Credit.`);
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
    log(`${player.name} can't afford to play <b>${INTRIGUE_DEFS[cardId].name}</b> (needs ${INTRIGUE_PLAY_COST} Credits).`);
    return;
  }
  player.credits -= INTRIGUE_PLAY_COST;
  player.intrigueHand.splice(idx,1);
  state.intrigueDiscard.push(cardId);
  applyIntrigueEffect(playerIdx, cardId);
  renderAll();
}

function humanPlayIntrigue(cardId){
  const idx = currentPicker();
  if(idx===null || state.phase!=='draft') return;
  if(online.enabled){
    if(online.isHost){ if(idx!==0) return; }
    else { wsSend({type:'action', kind:'intrigue', cardId}); return; }
  } else if(state.players[idx].type!=='human'){
    return;
  }
  if(!canPlayIntrigue(state.players[idx])){
    log(`<b>${state.players[idx].name}</b> can't afford that Intrigue card - it costs ${INTRIGUE_PLAY_COST} Credits.`);
    return;
  }
  playIntrigueCard(idx, cardId);
}

/* Public race-condition objectives - both players can see both targets, which
   adds tension (deny the site your opponent needs) without requiring any
   hidden-information plumbing over the network relay.

   `progress(p)` reports live {have, need} for the HUD so a goal reads as
   "2 of 4" instead of a bare met / not-yet. It is a FUNCTION, which is why
   state only ever stores `objectiveId` (see makePlayer) - the whole object
   can't survive JSON.stringify over the online-play relay. */
const OBJECTIVES = [
  {id:'warlord',       name:'Warlord',       desc:'Win 3 or more Skirmishes.',                         bonus:OBJECTIVE_BONUS, check:p=> p.skirmishWins>=3,
   progress:p=> ({have: Math.min(p.skirmishWins, 3), need: 3, unit: 'wins'})},
  {id:'unscathed',     name:'Unscathed',     desc:'Fight at least one Skirmish and never lose one.',    bonus:OBJECTIVE_BONUS, check:p=> (p.skirmishWins+p.skirmishLosses)>0 && p.skirmishLosses===0,
   progress:p=> ({have: ((p.skirmishWins+p.skirmishLosses)>0 && p.skirmishLosses===0) ? 1 : 0, need: 1, unit: 'unbroken'})},
  {id:'industrialist', name:'Industrialist', desc:'Take the Advanced tier 4 or more times.',            bonus:OBJECTIVE_BONUS, check:p=> p.advancedPicks>=4,
   progress:p=> ({have: Math.min(p.advancedPicks, 4), need: 4, unit: 'advanced picks'})},
  {id:'financier',     name:'Financier',     desc:'End the game with 7 or more Credits.',               bonus:OBJECTIVE_BONUS, check:p=> p.credits>=7,
   progress:p=> ({have: Math.min(p.credits, 7), need: 7, unit: 'Credits'})},
  {id:'prospector',    name:'Prospector',    desc:'End the game with 6 or more Ore.',                   bonus:OBJECTIVE_BONUS, check:p=> p.ore>=6,
   progress:p=> ({have: Math.min(p.ore, 6), need: 6, unit: 'Ore'})},
  {id:'archivist',     name:'Archivist',     desc:'End the game with 5 or more cards in hand.',         bonus:OBJECTIVE_BONUS, check:p=> p.hand.length>=5,
   progress:p=> ({have: Math.min(p.hand.length, 5), need: 5, unit: 'cards in hand'})},
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

function log(msg){
  state.logEntries.push(msg);
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
    return `${player.name} draws ${drew} Tactic card${drew!==1?'s':''}${extra}.`;
  }
  return `${player.name} draws nothing - ${reason}.`;
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

function updateModeUI(){
  const mode = document.getElementById('gameMode').value;
  document.querySelectorAll('.mode-card').forEach(c=> c.classList.toggle('selected', c.dataset.mode===mode));
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

function handleHostIncomingAction(msg){
  if(msg.kind==='pick'){
    const idx = currentPicker();
    if(idx===1 && state.phase==='draft' && state.board[msg.locId]===null){
      // >>> WAGERS (feature: Siege) - the guest's draft pick goes through the
      // >>> SAME contested-site interceptor as humanPick(), so an online game
      // >>> can never desync on a contested site.
      if(window.OD && OD.Wagers && OD.Wagers.beforePick && OD.Wagers.beforePick(1, msg.locId, msg.tier)) return;
      applyLocationEffect(1, msg.locId, msg.tier);
      advanceDraftOrSkirmish();
    }
  } else if(msg.kind==='skirmishDecision'){
    if(pendingGuestDecision){ const cb=pendingGuestDecision; pendingGuestDecision=null; cb(msg.attack, msg.force===true); }
    // >>> WAGERS (feature: Betrayal tokens) - `force` is the guest's answer to
    // >>> the Quiet-Round offer, which has no pendingGuestDecision slot.
    else if(window.OD && OD.Wagers && OD.Wagers.onForceDecision) OD.Wagers.onForceDecision(msg.force===true);
  } else if(msg.kind==='commit'){
    // >>> WAGERS (feature: Wagers + Betrayal tokens) - the public stance and
    // >>> the tokens paid ride the EXISTING commit payload.
    if(pendingGuestCommit){ const cb=pendingGuestCommit; pendingGuestCommit=null; cb(msg.troops, (msg.cardId===undefined?null:msg.cardId), {wager:msg.wager||null, betrayal:msg.betrayal||null}); }
  } else if(msg.kind==='intrigue'){
    const idx = currentPicker();
    if(idx===1 && state.phase==='draft'){ playIntrigueCard(1, msg.cardId); }
  // >>> WAGERS (feature: Siege) - the only NEW message kind in this feature.
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
function isFeverRound(){ return !!(state && state.currentEvent==='skirmish_fever'); }

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

function runOdds(mineSpec, theirsSpec, fever){
  if(typeof OD === 'undefined' || !OD.Rules || typeof OD.Rules.projectSkirmish !== 'function') return null;
  try{ return OD.Rules.projectSkirmish(mineSpec, theirsSpec, {fever: !!fever}); }
  catch(_){ return null; }
}

function pct(n){ return `${Math.round(n*10)/10}%`; }

function oddsBar(p){
  return `<div class="odds-bar" style="display:flex;gap:6px;margin:6px 0;font-size:12px">`
    + `<span style="flex:${Math.max(p.winPct,0.01)};background:var(--accent-cool,#3d6b7a);color:#fff;border-radius:3px;padding:2px 4px;text-align:center">WIN ${pct(p.winPct)}</span>`
    + `<span style="flex:${Math.max(p.tiePct,0.01)};background:var(--accent-mute,#7a7568);color:#fff;border-radius:3px;padding:2px 4px;text-align:center">TIE ${pct(p.tiePct)}</span>`
    + `<span style="flex:${Math.max(p.losePct,0.01)};background:var(--accent-blood,#8c1d18);color:#fff;border-radius:3px;padding:2px 4px;text-align:center">LOSE ${pct(p.losePct)}</span>`
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
    + projectionLine(`${state.players[aggIdx].name} (committed ${ctx.aggCommit.troops})`, p.theirs,
        ` &mdash; their card is <b>hidden</b>, so this is their Troops alone`)
    + thresholdLine(p)
    + catchingUpLine(p)
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
  const mirror  = projectionSpec(defIdx, troops, null, false, 0);
  const a = runOdds(mine, passive, fever);
  const b = runOdds(mine, mirror, fever);
  if(!a || !b) return '';
  return `<div style="font-size:12px;color:var(--muted);margin-bottom:2px">`
      + `You commit first, so you cannot know this yet. Two honest reference points:`
    + `</div>`
    + `<div style="margin-top:6px"><b style="font-size:12px">vs a passive defender (they hold all ${state.players[defIdx].troops} Troops back)</b></div>`
    + oddsBar(a) + thresholdLine(a)
    + `<div style="margin-top:8px"><b style="font-size:12px">if ${state.players[defIdx].name} mirrors you (${troops} Troops, no card)</b></div>`
    + oddsBar(b) + thresholdLine(b)
    + projectionLine('Your projection', a.mine, furyNote(a.mine.winStreak, a.myCap))
    + `<div style="font-size:12px;color:var(--muted);margin-top:4px">Influence cap this Skirmish: <b>${a.cap}</b>. Expected Influence vs a passive defender: <b>${Math.round(a.ev*10)/10}</b>.</div>`;
}

function furyNote(streak, cap){
  const f = furyRung(streak);
  return ` &mdash; Fury ${f.streak} (+${f.bonus}, cap ${cap})`;
}
function catchingUpLine(p){
  const cu = p.catchingUp;
  if(!cu || !cu.applied) return '';
  const who = (cu.leaderIdx===0) ? 'the aggressor' : 'you';
  return `<div style="font-size:12px;margin-top:2px"><b style="color:var(--accent-gold-ink,#8a5a10)">`
    + `CATCHING UP:</b> ${who === 'you' ? 'you are' : 'they are'} on a ${cu.streak}-win streak, so the other side adds +${cu.applied}.`
    + `</div>`;
}

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
   wants. Stance payouts are read back through the feature's OWN
   commitDeclaration() rather than re-derived here, so a rebalance of
   ALL_IN_WIN cannot leave this preview quoting a stale number. */
function consequenceHtml(playerIdx, troops, cardId){
  const p = state.players[playerIdx];
  const fever = isFeverRound();
  const cap = Math.max(furyRungCap(p.winStreak, fever), furyRungCap(state.players[1-playerIdx].winStreak, fever));
  const decl = (typeof OD !== 'undefined' && OD.Wagers && typeof OD.Wagers.commitDeclaration === 'function')
    ? OD.Wagers.commitDeclaration() : null;
  const stance = (decl && decl.wager) ? decl.wager : 'normal';
  let stanceLine = '';
  if(stance === 'allin'){
    stanceLine = ` <b style="color:var(--accent-gold-ink,#8a5a10)">ALL IN</b> declared: you commit every Troop, and a win pays <b>+${(typeof OD.Wagers.ALL_IN_WIN!=='undefined'?OD.Wagers.ALL_IN_WIN:3)} Influence</b> on top, a loss costs you <b>-${(typeof OD.Wagers.ALL_IN_LOSS!=='undefined'?OD.Wagers.ALL_IN_LOSS:2)} Influence</b>.`;
  } else if(stance === 'ghost'){
    stanceLine = ` <b style="color:var(--accent-gold-ink,#8a5a10)">GHOST</b> declared: you commit no Troop and keep all of them, and a win pays <b>+${(typeof OD.Wagers.GHOST_WIN!=='undefined'?OD.Wagers.GHOST_WIN:2)} Influence</b> on top. A loss costs Influence nothing.`;
  }
  const token = (decl && decl.betrayal && decl.betrayal.plus) ? ' A <b>+1 token</b> is declared and is already in the projection above.' : '';
  const reroll = (decl && decl.betrayal && decl.betrayal.reroll) ? ' A <b>RE-ROLL</b> is declared: your die is cast twice, second cast stands.' : '';
  return `<div class="odds-consequence" style="margin-top:8px;font-size:12px;line-height:1.5">`
    + `<b>At stake.</b> Win: +the margin in Influence, capped at <b>${cap}</b>${isFeverRound()?' (Skirmish Fever)':''}, and they lose their committed Troops. `
    + `Lose: you lose the <b>${troops}</b> Troop${troops===1?'':'s'} you commit${troops===0?' (none)':''} and no Influence moves. `
    + `Tie: no Influence either way, but both sides still lose their committed Troops.`
    + (stanceLine ? stanceLine : '')
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

function showSkirmishDecisionModal(aggressorName, defenderName, defenderTroops, defenderHandCount, onDecision, forceHtml){
  showModal("Skirmish Decision", `
    <p>${aggressorName}, you hold the Garrison. Attack ${defenderName}?</p>
    <p style="color:var(--muted);font-size:13px">Defender has ${defenderTroops} Troops, ${defenderHandCount} cards in hand.</p>
    ${skirmishStakesHtml()}
    ${forceHtml || ''}
    <div class="footer-actions">
      <button class="secondary" id="skipAttack">Hold Back</button>
      <button id="doAttack">Attack!</button>
    </div>
    <div id="meltdownHoldNote" class="hidden" style="margin-top:10px;padding:8px 10px;border:1px solid #8c1d18;border-radius:6px;background:rgba(140,29,24,.10);font-size:12px;color:#8c1d18">
      <b>MELTDOWN &mdash; no holding back.</b> In the last round the Garrison is an obligation, not an option. The button above is off; press <b>Attack!</b> to fight.
    </div>
  `);
  /* >>> CHAOS (feature-chaos.js) - MELTDOWN makes holding the Garrison an
     OBLIGATION. promptAggressorDecision() already ignores a hold-back
     (`noRetreat`), which means the button used to render, look clickable,
     accept the click, and then do nothing but log a complaint. A control
     that silently refuses is worse than no control: this disables it and
     says why, in the same words the log will use. */
  if(state && state.meltdown){
    const hold = document.getElementById('skipAttack');
    if(hold){
      hold.disabled = true;
      hold.setAttribute('aria-disabled', 'true');
      hold.textContent = 'Hold Back — locked by MELTDOWN';
      hold.title = 'Meltdown: holding the Garrison obliges you to attack.';
    }
    const note = document.getElementById('meltdownHoldNote');
    if(note) note.classList.remove('hidden');
  }
  document.getElementById('skipAttack').onclick = ()=>{
    if(state && state.meltdown){ return; }
    hideModal(); onDecision(false, false);
  };
  document.getElementById('doAttack').onclick = ()=>{ hideModal(); onDecision(true, false); };
  // >>> WAGERS (feature: Betrayal tokens) - the FORCE button is injected by the
  // >>> feature and reports a token spend through the SAME decision handler.
  const forceBtn = document.getElementById('wagersForceAttack');
  if(forceBtn && forceBtn.dataset.token==='1'){
    forceBtn.onclick = ()=>{ hideModal(); onDecision(true, true); };
  }
}

/* "What is at stake" for the attack/hold decision, before any Troops are
   committed. The Influence cap is the piece that was completely invisible
   and is decision-changing: a player on a 3-win streak is capped at 5 and a
   player on 4+ at 6, and Skirmish Fever lifts every rung to 6. Holding back
   is not a neutral pass either - a round with no Skirmish doubles the
   Pressure tick, which is the tax that eventually causes a Collapse. */
function skirmishStakesHtml(){
  if(!state) return '';
  const fever = isFeverRound();
  const [a, b] = state.players;
  const rows = [a, b].map(p=>{
    const f = furyRung(p.winStreak);
    return `<div style="font-size:12px">${p.name}: <b>Fury ${f.streak}</b> `
      + `<span style="color:var(--muted)">(+${f.bonus} to their total, Influence cap ${furyRungCap(f.winStreak, fever)})</span></div>`;
  }).join('');
  const dread = (state.dread|0);
  return `<div class="odds-panel" id="stakesPanel" style="margin:10px 0;padding:8px 10px;border:1px solid rgba(140,120,90,.4);border-radius:6px">`
    + `<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);font-weight:700">What is at stake</div>`
    + rows
    + `<div style="font-size:12px;margin-top:4px">${fever
        ? '<b style="color:var(--accent-gold-ink,#8a5a10)">SKIRMISH FEVER is in play</b> &mdash; every Influence ceiling is lifted to <b>6</b> this round.'
        : 'Influence is capped at the <b>winner&rsquo;s</b> Fury rung ceiling.'}</div>`
    + `<div style="font-size:12px;margin-top:4px"><b>Hold back</b> and you keep every Troop and settle for no Influence &mdash; but a round with no Skirmish adds <b>2</b> to Pressure instead of 1, and Pressure ends in a Collapse.</div>`
    + (dread>0 ? `<div style="font-size:12px;margin-top:4px;color:var(--muted)">Pressure is at ${dread} &mdash; attacking keeps it at +1.</div>` : '')
    + `</div>`;
}

function showCommitModal(playerName, maxTroops, hand, onSubmit, playerIdx=-1){
  let selectedCardId = null;
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

  showModal(`${playerName} — Commit Troops`, `
    <p>You have ${maxTroops} Troops available.</p>
    <div class="troop-picker">
      <span>0</span>
      <input type="range" id="troopSlider" min="0" max="${maxTroops}" value="${Math.min(1,maxTroops)}">
      <span>${maxTroops}</span>
    </div>
    <p>Committing: <b id="troopVal">${Math.min(1,maxTroops)}</b> <span id="troopWord">Troops</span></p>
    <p style="margin-top:10px">Optionally play one hidden Tactic card as a modifier:</p>
    <div class="card-select" id="cardSelect">${cardOptsHtml}</div>
    <div id="oddsSlot"></div>
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
     commitOddsHtml total). */
  function refreshOdds(){
    const slot = document.getElementById('oddsSlot');
    if(!slot) return;
    const html = (playerIdx>=0) ? commitOddsHtml(playerIdx, Number(slider.value), selectedCardId) : '';
    slot.innerHTML = html;
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
    const toggle = (e)=>{
      if(e){ e.preventDefault(); e.stopPropagation(); }
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
         >>> of freezing at open time. The feature currently calls
         >>> `wireCommit(host, null)` and drops this, so until that one line is
         >>> changed the panel is truthful at open and static after; it can
         >>> never be WRONG, which is the half that mattered. */
      onChange: ()=> refreshOdds(),
    });
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

  document.getElementById('commitBtn').onclick = ()=>{
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
  };
}

/* ------------------------- Setup / round flow ------------------------- */

function startGame(){
  const mode = document.getElementById('gameMode').value;
  /* Any countdown left over from the previous game's end screen would fire
     into this one and restart it out from under the player. */
  if(demoLoopTimer){ clearInterval(demoLoopTimer); demoLoopTimer = null; }
  online.enabled = (mode==='host');
  online.isHost = (mode==='host');
  online.myIndex = 0;
  delete handRenderCache[0]; delete handRenderCache[1];
  prevBoardSnapshot = null;
  stageBanner.lastRound = 0;

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
      capped: {credits:0, ore:0, troops:0},
    },
    history: [],             // per-round summaries, appended in endRound
    betrayed: {plus:false, reroll:false},  // this round's betrayal flags
    lastActiveIdx: 0,        // whose hand to show outside the draft
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
     report "+3 this round" as a real delta instead of a running total. */
  s.roundRec = {round: s.round, picks: [], intrigue: null, skirmish: false, capped: {credits:0, ore:0, troops:0},
                prevInfluence: s.players.map(p=>p.influence)};
  s.betrayed = {plus:false, reroll:false};

  if(canRunExtensions()) OD.Ext.hooks.run('roundBegin', extCtx('draft', -1));

  if(eventsUnlocked()){
    s.currentEvent = EVENTS[Math.floor(Math.random()*EVENTS.length)].id;
    const eventDef = getEvent();
    if(s.currentEvent==='windfall_round') s.players.forEach(p=>{ p.credits+=2; reportCaps(p, applyCaps(p)); });
    if(s.currentEvent==='trade_winds') s.players.forEach(p=>{ p.ore+=1; reportCaps(p, applyCaps(p)); });
    if(s.currentEvent==='recruitment_drive') s.players.forEach(p=>{ p.troops+=1; reportCaps(p, applyCaps(p)); });
    if(s.currentEvent==='council_session') s.players.forEach(p=> log(`${p.name} studies Council Session -> ${drawLog(p, 1, drawCard(p,1), 'hand already at the limit')}`));
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

  log(`<b>— Round ${s.round} begins —</b> ${s.players[s.firstPlayerIdx].name} drafts first.`);
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
    log(`${player.name} is at the resource cap${trimmed} - discarded, not banked.`);
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

function baseLocationValue(loc, player){
  switch(loc.id){
    /* >>> CHAOS (feature-chaos.js) — the Rift is worth a FLAT 1.8 on
       purpose. The mutation is public, but the bot does not read the
       reveal, so any value tuned per mutation would be a guess dressed up
       as knowledge. Flat is honest: the bot is genuinely uncertain, and a
       human who reads the announcement systematically out-drafts it. */
    case 'rift': return 1.8;
    case 'market': return 1.5;
    case 'quarry': return 1.7;
    case 'garrison': {
      const afterTroops = player.troops + 2;
      const opp = state.players[1-state.players.indexOf(player)];
      return 1.4 + (afterTroops > opp.troops ? 0.8 : 0.2);
    }
    case 'outpost': return (player.credits>=3 && player.ore>=2) ? 3.2 : 0.6;
    case 'archive': return 1.2;
    case 'foundry': return 1.6;
    case 'bazaar': return player.ore>=2 ? 1.5 : 0.4;
    case 'shrine': return 1.0;
  }
  return 1;
}

function botChoosePick(playerIdx){
  const player = state.players[playerIdx];
  const opts = openLocations();
  const jitter = {easy:0.9, normal:0.45, hard:0.15}[state.difficulty] ?? 0.45;
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
      const gain = (tier==='advanced' ? 6 : 3) + bonus;
      if(tier==='advanced') charged = takeCost(player, tierCost('market','advanced'));
      player.credits += gain;
      log(`${player.name} works the <b>Market</b> (${tier}) -> +${gain} Credits${tier==='advanced'?paidNote(charged):''}${bonus?' (+1 Merchant)':''}.`);
      popupText = {text: `+${gain} Credits`, good: true};
      break;
    }
    case 'quarry': {
      const bonus = leader.id==='engineer' ? 1 : 0;
      const oreGain = (tier==='advanced'?4:2) + bonus, troopGain = tier==='advanced'?2:1;
      if(tier==='advanced') charged = takeCost(player, tierCost('quarry','advanced'));
      player.ore += oreGain; player.troops += troopGain;
      log(`${player.name} works the <b>Quarry</b> (${tier}) -> +${oreGain} Ore, +${troopGain} Troops${tier==='advanced'?paidNote(charged):''}${bonus?' (+1 Engineer)':''}.`);
      popupText = {text: `+${oreGain} Ore, +${troopGain} Troops`, good: true};
      break;
    }
    case 'garrison': {
      const bonus = leader.id==='warmonger' ? 1 : 0;
      const troopGain = (tier==='advanced'?4:2) + bonus;
      if(tier==='advanced'){ charged = takeCost(player, tierCost('garrison','advanced')); player.aggressorBonus=1; } else { player.aggressorBonus=0; }
      player.troops += troopGain; player.isAggressor = true;
      log(`${player.name} rallies the <b>Garrison</b> (${tier}) -> +${troopGain} Troops${bonus?' (+1 Warmonger)':''}. Aggressor this round${tier==='advanced'?' with +1 Skirmish bonus':''}.`);
      popupText = {text: `+${troopGain} Troops - Aggressor!`, good: true};
      break;
    }
    case 'outpost': {
      const bonus = leader.id==='diplomat' ? 1 : 0;
      /* The price and the consolation both come from the one table now, so
         the printed sentence and the number debited are the same object. */
      const need = tierCost('outpost', tier);
      const reward = (tier==='advanced' ? 7 : 4) + bonus;
      const consolation = (tier==='advanced' ? 2 : 1) + bonus;
      if(canPayCost(player, need)){
        charged = takeCost(player, need); player.influence+=reward;
        log(`${player.name} invests in the <b>Outpost</b> (${tier}) -> pays ${need.credits} Credits + ${need.ore} Ore for +${reward} Influence${bonus?' (+1 Diplomat)':''}.`);
        popupText = {text: `+${reward} Influence`, good: true};
      } else {
        player.influence += consolation;
        log(`${player.name} eyes the <b>Outpost</b> (${tier}) but can't afford it -> consolation +${consolation} Influence${bonus?' (+1 Diplomat)':''}.`);
        popupText = {text: `+${consolation} Influence`, good: true};
      }
      break;
    }
    case 'archive': {
      const bonus = leader.id==='scholar' ? 1 : 0;
      const draws = (tier==='advanced' ? 3 : 1) + bonus;
      if(tier==='advanced') charged = takeCost(player, tierCost('archive','advanced'));
      const drew = drawCard(player, draws);
      const reason = player.hand.length >= HAND_CAP ? 'hand already at the limit' : 'deck and discard are empty';
      log(`${player.name} studies the <b>Archive</b> (${tier}) -> ${drawLog(player, draws, drew, reason)}${tier==='advanced'?paidNote(charged):''}${bonus?' (+1 Scholar)':''}.`);
      popupText = {text: drew>0 ? `+${drew} Card${drew!==1?'s':''}` : 'Hand full, 0 Cards', good: drew>0};
      break;
    }
    case 'foundry': {
      const bonus = leader.id==='engineer' ? 1 : 0;
      const crGain = tier==='advanced'?4:2, oreGain = (tier==='advanced'?3:1) + bonus;
      if(tier==='advanced') charged = takeCost(player, tierCost('foundry','advanced'));
      player.credits += crGain; player.ore += oreGain;
      log(`${player.name} runs the <b>Foundry</b> (${tier}) -> +${crGain} Credits, +${oreGain} Ore${tier==='advanced'?paidNote(charged):''}${bonus?' (+1 Engineer)':''}.`);
      popupText = {text: `+${crGain} Credits, +${oreGain} Ore`, good: true};
      break;
    }
    case 'bazaar': {
      const bonus = leader.id==='merchant' ? 1 : 0;
      const crGain = (tier==='advanced'?6:3) + bonus;
      /* A trade, but priced from the same table as every other cost - so the
         Rift's Toll doubles the 2 Ore instead of being unable to see it. */
      const trade = tierCost('bazaar', tier);
      if(canPayCost(player, trade)){
        charged = takeCost(player, trade); player.credits+=crGain;
        log(`${player.name} trades at the <b>Bazaar</b> (${tier}) -> trades ${trade.ore} Ore for +${crGain} Credits${bonus?' (+1 Merchant)':''}.`);
        popupText = {text: `+${crGain} Credits`, good: true};
      } else {
        const consolation = (tier==='advanced'?2:1) + bonus;
        player.credits += consolation;
        log(`${player.name} visits the <b>Bazaar</b> (${tier}) without enough Ore -> consolation +${consolation} Credits${bonus?' (+1 Merchant)':''}.`);
        popupText = {text: `+${consolation} Credits`, good: true};
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
          log(`${player.name} prays at the <b>Shrine</b> (advanced) -> pays ${rite.credits} Credits + ${rite.ore} Ore for +${reward} Influence${bonus?' (+1 Diplomat)':''}.`);
          popupText = {text: `+${reward} Influence`, good: true};
        } else {
          player.influence += 1 + bonus;
          log(`${player.name} can't afford the deep Shrine rite -> +${1+bonus} Influence instead${bonus?' (+1 Diplomat)':''}.`);
          popupText = {text: `+${1+bonus} Influence`, good: true};
        }
      } else {
        player.influence += reward;
        log(`${player.name} prays at the <b>Shrine</b> (basic) -> +${reward} Influence${bonus?' (+1 Diplomat)':''}.`);
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

  // >>> WAGERS (feature: Siege) - a contested site pauses the draft and offers
  // >>> the opponent one chance to buy it. Returns true when the feature has
  // >>> taken the pick over, in which case IT calls applyLocationEffect
  // >>> EXACTLY ONCE. The online guest's pick is routed through the very same
  // >>> interceptor in handleHostIncomingAction's 'pick' branch.
  if(window.OD && OD.Wagers && OD.Wagers.beforePick && OD.Wagers.beforePick(idx, locId, tier)) return;

  applyLocationEffect(idx, locId, tier);
  advanceDraftOrSkirmish();
}

function maybeAutoPick(){
  if(state.phase!=='draft') return;
  const idx = currentPicker();
  if(idx===null) { advanceDraftOrSkirmish(); return; }
  if(state.players[idx].type==='bot'){
    setTimeout(()=>{
      const player = state.players[idx];
      if(player.intrigueHand.length>0 && canPlayIntrigue(player) && Math.random()<0.8){
        const cardId = player.intrigueHand[Math.floor(Math.random()*player.intrigueHand.length)];
        playIntrigueCard(idx, cardId);
      }
      const pick = botChoosePick(idx);
      // >>> WAGERS (feature: Siege) - bot picks go through the SAME contested-
      // >>> site interceptor as human picks, so the rule cannot be dodged by
      // >>> letting the Bot pick first.
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
     they just pressed did nothing. */
  const noRetreat = !!(state && state.meltdown);

  if(aggressor.type==='bot'){
    const wantsAttack = noRetreat ? true : botWantsToAttack(aggressor, defender);
    setTimeout(()=>{
      if(wantsAttack) startSkirmishCommit(aggressorIdx, defenderIdx);
      else { log(`${aggressor.name} holds back — no Skirmish this round.`); OD.Sound.play('turn.pass'); endRound(); }
    }, BOT_TICK_MS);
    return;
  }

  const decisionHandler = (attack, force)=>{
    // >>> WAGERS (feature: Betrayal tokens) - a declared FORCE spends the token
    // >>> and guarantees the attack.
    if(force && typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.spendForce) OD.Wagers.spendForce(aggressorIdx);
    if(attack) startSkirmishCommit(aggressorIdx, defenderIdx);
    else if(noRetreat) log(`<b>MELTDOWN — no holding back.</b> ${aggressor.name} holds the Garrison, and in Meltdown that means you attack.`);
    else { log(`${aggressor.name} holds back — no Skirmish this round.`); OD.Sound.play('turn.pass'); endRound(); }
  };

  if(online.enabled && aggressorIdx!==online.myIndex){
    pendingGuestDecision = decisionHandler;
    // >>> WAGERS: `forceHtml` lets the guest render the FORCE button, and it is
    // >>> omitted entirely when the aggressor holds no Betrayal token.
    wsSend({type:'requestSkirmishDecision', aggressorName:aggressor.name, defenderName:defender.name, defenderTroops:defender.troops, defenderHandCount:defender.hand.length,
      forceHtml: (typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.forceAttackHtml) ? OD.Wagers.forceAttackHtml(aggressorIdx) : ''});
    return;
  }

  /* The horn: the one sound in the game that means "this is about to go
     badly for someone". Fired the moment the aggressor commits to a fight,
     so the two commit modals that follow are already framed by it. */
  OD.Sound.play('skirmish.horn');
  // >>> WAGERS: injects the "break the Quiet Round / buy the attack" button.
  showSkirmishDecisionModal(aggressor.name, defender.name, defender.troops, defender.hand.length, decisionHandler,
    (typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.forceAttackHtml) ? OD.Wagers.forceAttackHtml(aggressorIdx) : '');
}

function botWantsToAttack(aggressor, defender){
  const aggression = {easy:0.5, normal:0.65, hard:0.8}[state.difficulty] ?? 0.65;
  const advantage = aggressor.troops - defender.troops;
  // >>> WAGERS (feature: Fury) - every rung of the ladder adds +0.10
  // >>> aggression, so a Bot on a hot streak presses it instead of coasting.
  const furyDrive = Math.min(4, Math.max(0, aggressor.winStreak|0)) * 0.10;
  const chance = clamp(aggression + advantage*0.05 + furyDrive, 0.15, 0.95);
  /* >>> CHAOS (feature-chaos.js) — Dread makes aggression a moving target.
     A LEADING bot presses harder, because every round it stalls feeds the
     Collapse it is about to cash in; a trailing bot six Influence down stops
     feeding a tax it cannot convert. Returns 0 whenever the clock says
     nothing, and the base clamp above is untouched in that case. */
  const dread = (typeof OD !== 'undefined' && OD.Chaos && OD.Chaos.dreadMod) ? OD.Chaos.dreadMod(aggressor, defender, state) : 0;
  if(isFinite(dread) && dread !== 0) return Math.random() < clamp(chance + dread, 0.05, 0.99);
  return Math.random() < chance;
}

let skirmishCtx = null;

function startSkirmishCommit(aggressorIdx, defenderIdx){
  state.phase = 'skirmish-commit';
  skirmishCtx = {aggressorIdx, defenderIdx, aggCommit:null, defCommit:null};
  // >>> WAGERS (feature: Betrayal tokens) - at most one RE-ROLL per player per
  // >>> Skirmish; the record lives on the existing skirmishCtx object.
  skirmishCtx.wagersReroll = [false, false];
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

function collectCommit(playerIdx, onDone){
  const player = state.players[playerIdx];
  const role = (playerIdx===skirmishCtx.aggressorIdx) ? 'aggCommit' : 'defCommit';

  if(player.type==='bot'){
    // >>> WAGERS (feature: Wagers + Betrayal tokens) - the card is chosen FIRST
    // >>> so the stance decision (All In when your floor beats their expected
    // >>> total, Ghost when your card alone does) can see what was played.
    // >>> `troops` is then PINNED by botChooseTroops BEFORE the subtraction
    // >>> below runs, which is what makes All In / Ghost real.
    const cardIdx = botChooseCard(player);
    const card = cardIdx>=0 ? player.hand.splice(cardIdx,1)[0] : null;
    const wagerStance = (typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.botStance) ? OD.Wagers.botStance(playerIdx, card, player.troops) : null;
    const troops = botChooseTroops(player, playerIdx, wagerStance);
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
    const idx = cardId ? player.hand.indexOf(cardId) : -1;
    const card = idx>=0 ? player.hand.splice(idx,1)[0] : null;
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
    const commitTroops = (wagerDecl && typeof wagerDecl.troops === 'number')
      ? clamp(wagerDecl.troops, 0, player.troops) : troops;
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
  const frac = {easy:[0.2,0.6], normal:[0.3,0.75], hard:[0.4,0.9]}[state.difficulty] ?? [0.3,0.75];
  const [lo,hi] = frac;
  const pct = lo + Math.random()*(hi-lo);
  return Math.round(player.troops * pct);
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
      rerollNote += ` ${r.name} declared a <b>RE-ROLL</b>: ${r.from!==null && r.from!==undefined ? r.from : '?'} &rarr; ${r.to}.`;
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
  if(aggCommit.card==='undermine'){ defTotal -= 2; undermineNote += ` ${aggressor.name}'s Undermine saps ${defender.name} for -2.`; }
  if(defCommit.card==='undermine'){ aggTotal -= 2; undermineNote += ` ${defender.name}'s Undermine saps ${aggressor.name} for -2.`; }

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
    const wName = CU.leaderIdx===0 ? aggressor.name : defender.name;
    const lName = CU.leaderIdx===0 ? defender.name : aggressor.name;
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
  const FEVER = state.currentEvent === 'skirmish_fever' ? 6 : 0;
  const winnerCap = (aggWins ? AGGF.cap : DEFF.cap);
  const inflCap = isTie ? 4 : Math.max(winnerCap, FEVER);
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
    aggTotal, defTotal, aggName: aggressor.name, defName: defender.name
  };

  // The numbers are already locked in - the dice-roll animation is a
  // suspense/legibility beat, not a source of new information.
  animateDiceRoll(aggressor.name, defender.name, aggRoll, defRoll, aggTotal, defTotal,
    aggCommit.card ? CARD_DEFS[aggCommit.card].name : null,
    defCommit.card ? CARD_DEFS[defCommit.card].name : null,
    skirmishResult, ()=>{
    log(`<b>Skirmish!</b> ${aggressor.name} rolls ${aggRoll} + ${aggCommit.troops} troops${aggressor.aggressorBonus?` + 1 (Garrison bonus)`:''}${AGGF.bonus?` + ${AGGF.bonus} (Fury ${aggressor.winStreak})`:''}${aggBetrayal?' + 1 (Betrayal token)':''}${aggMod.card?` + ${aggMod.card}(${aggMod.mod})${aggMod.note}`:''} = <b>${aggTotal}</b>. ` +
        `${defender.name} rolls ${defRoll} + ${defCommit.troops} troops${DEFF.bonus?` + ${DEFF.bonus} (Fury ${defender.winStreak})`:''}${defBetrayal?' + 1 (Betrayal token)':''}${defMod.card?` + ${defMod.card}(${defMod.mod})${defMod.note}`:''} = <b>${defTotal}</b>.${undermineNote}${rerollNote}${catchingUp}`);

    if(aggCommit.card) aggressor.discard.push(aggCommit.card);
    if(defCommit.card) defender.discard.push(defCommit.card);

    if(aggTotal===defTotal){
      log(`It's a tie — both sides lose their committed Troops, no Influence changes.`);
      aggressor.winStreak = 0; defender.winStreak = 0;
      // >>> WAGERS (feature: All In / Ghost) - a tie pays NOTHING to either
      // >>> stance. An All In that ties is simply dead.
      if(typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.settleWagers){
        OD.Wagers.settleWagers(-1, aggCommit, defCommit);
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
      if(winner.winStreak===2) log(`${winner.name} reaches <b>Fury 2</b> - +1 to their next Skirmish total, Influence cap 4.`);
      if(winner.winStreak===3) log(`${winner.name} reaches <b>Fury 3</b> - +2 to their next Skirmish total, and the Influence cap rises to 5.`);
      if(winner.winStreak>=4) log(`${winner.name} is <b>Fury ${winner.winStreak}</b> - +3 to their next Skirmish total, Influence cap 6.`);
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
        log(`${loser.name} loses the Skirmish but Feint returns their committed Troops.`);
      } else if(loser===aggressor && loserCommit.card==='feint'){
        aggressor.troops += aggCommit.troops;
        log(`${loser.name} loses the Skirmish but Feint returns their committed Troops.`);
      } else if(loserCommit.card==='ambush'){
        loser.troops = Math.max(0, loser.troops-1);
        log(`${loser.name}'s own Ambush backfires — 1 extra Troop lost.`);
      }

      if(winnerCommit.card==='ambuscade'){
        loser.troops = Math.max(0, loser.troops-1);
        log(`${winner.name}'s Ambuscade costs ${loser.name} 1 extra Troop.`);
      }

      /* Report the SAME number the result modal shows: `margin` is the
         post-Guard figure, which is also what produced `gained` and
         skirmishResult.margin. Printing the raw difference here used to
         contradict the modal whenever Guard was in play. */
      log(`<b>${winner.name} wins the Skirmish</b> by ${margin} -> +${gained} Influence.${guardNote}`);

      // >>> WAGERS (feature: All In / Ghost) - the wagers settle INSIDE the
      // >>> existing win/lose branch: no new resolution pipeline, and the same
      // >>> totals that produced `margin` are the ones being paid on.
      if(typeof OD !== 'undefined' && OD.Wagers && OD.Wagers.settleWagers){
        OD.Wagers.settleWagers(aggWins ? 0 : 1, aggCommit, defCommit);
      }
    }

    // Effects that always apply, win/lose/tie alike.
    [{commit:aggCommit, self:aggressor, opp:defender},{commit:defCommit, self:defender, opp:aggressor}].forEach(({commit,self,opp})=>{
      if(!commit.card) return;
      if(commit.card==='fortify'){
        self.troops += commit.troops;
        log(`${self.name}'s Fortify returns their committed Troops.`);
      }
      if(commit.card==='berserker'){
        self.troops = Math.max(0, self.troops-2);
        log(`${self.name}'s Berserker costs them 2 additional Troops.`);
      }
      if(commit.card==='scout'){
        const drew = drawCard(self,1);
        log(`${self.name}'s Scout -> ${drawLog(self, 1, drew, 'hand already at the limit')}`);
      }
      if(commit.card==='sabotage' && opp.hand.length>0){
        const idx = Math.floor(Math.random()*opp.hand.length);
        const discarded = opp.hand.splice(idx,1)[0];
        opp.discard.push(discarded);
        log(`${self.name}'s Sabotage forces ${opp.name} to discard ${CARD_DEFS[discarded].name}.`);
      }
      if(commit.card==='insight'){
        const drew = drawCard(self,1);
        log(`${self.name}'s Insight -> ${drawLog(self, 1, drew, 'hand already at the limit')}`);
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
      <div class="dice-col"><div class="who">${aggName} (Aggressor)</div><div class="die rolling" id="dieAgg">?</div>
        <div class="dice-card">${aggCardName ? `Card: <b>${aggCardName}</b>` : 'No card played'}</div></div>
      <div class="dice-col"><div class="who">${defName} (Defender)</div><div class="die rolling" id="dieDef">?</div>
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
        verdict = `${result.winnerName} wins the Skirmish!`;
        detail =
          `<div class="skirmish-totals">Totals (dice + troops + cards): <b>${result.aggTotal}</b> (${result.aggName}) vs <b>${result.defTotal}</b> (${result.defName})</div>` +
          `<div class="skirmish-result win">${verdict}</div>` +
          `<div class="skirmish-detail">Won by a margin of <b>${result.margin}</b> &rarr; <b>+${result.influence} Influence</b>${result.rally ? ` <span class="skirmish-bonus">Rally +1</span>` : ''}${result.guarded ? ` <span class="skirmish-bonus">Guard cut ${result.guardCut}</span>` : ''}.</div>` +
          `<div class="skirmish-detail skirmish-split">${result.winnerName} takes the contested Troops; ${result.loserName} loses theirs${result.influence ? ` &mdash; the Influence split is <b>${result.winnerName} +${result.influence}</b>` : ''}.</div>`;
      } else if(result && result.tie){
        verdict = "It's a tie!";
        detail =
          `<div class="skirmish-totals">Totals (dice + troops + cards): <b>${result.aggTotal}</b> vs <b>${result.defTotal}</b></div>` +
          `<div class="skirmish-result">${verdict}</div>` +
          `<div class="skirmish-detail">Both sides lose their committed Troops &mdash; no Influence changes hands.</div>`;
      } else {
        if(aggTotal===defTotal) verdict = "It's a tie!";
        else if(aggTotal>defTotal) verdict = `${aggName} wins the Skirmish!`;
        else verdict = `${defName} wins the Skirmish!`;
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
  setTimeout(finish, rollMs + Math.max(holdMs, 2600));
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
   banner's big "Round N" stays the only place it is announced. */
function showRoundDebrief(rec, nextRound){
  if(!rec) return;
  const [a, b] = state.players;
  const capped = rec.capped || {credits:0, ore:0, troops:0};
  const cappedTotal = (capped.credits|0) + (capped.ore|0) + (capped.troops|0);

  /* What the Skirmish actually paid, read off the round record rather than
     re-derived: the log line and the history entry are the same numbers the
     resolution actually moved, so the debrief cannot quote a different
     figure from the one that was banked. */
  const skirmishRows = state.players.map((p,i)=>{
    const gained = Math.max(0, p.influence - rec.prevInfluence[i]);
    return `<div style="font-size:12px">${p.name}: <b style="color:${gained>0?'var(--accent-cool-ink,#2c4d58)':'var(--muted)'}">`
      + `${p.influence} Influence</b> <span style="color:var(--muted)">(${gained>=0?'+':''}${gained} this round)</span></div>`;
  }).join('');

  const capLine = cappedTotal > 0
    ? `<div style="font-size:12px;margin-top:4px;color:#b5502e"><b>Caps ate ${cappedTotal} resource${cappedTotal!==1?'s':''}</b>`
      + ` this round &mdash; gained and immediately discarded, never banked. A site that pays more than you can hold is worth less than it reads.</div>`
    : '';

  const picks = (rec.picks||[]).map(p=>{
    const t = (p.tier==='advanced') ? 'Adv' : 'Basic';
    return `<span class="debrief-pick">${locationName(p.locId)} <span style="color:var(--muted)">${t}</span></span>`;
  }).join('');

  /* What changes NEXT round is the actionable half. Three unlocks happen on
     fixed rounds and one of them (Meltdown) takes an option away rather than
     adding one - both are invisible until the player is already in the round
     they land in. */
  const lookahead = [];
  if(nextRound === 2) lookahead.push('<b>Round 2:</b> the <b>Advanced</b> tier and <b>Intrigue</b> cards unlock, and the <b>All In / Ghost</b> wagers become legal.');
  if(nextRound === 3) lookahead.push('<b>Round 3:</b> <b>Round Events</b> start, <b>Betrayal tokens</b> pay +1, <b>Siege</b> marks a site CONTESTED, the <b>Rift</b> opens as a ninth site, and the first <b>Bounty</b> is published.');
  if(nextRound === 5) lookahead.push('<b>Round 5:</b> a second <b>Betrayal token</b> and a second <b>Bounty</b>.');
  if(nextRound === 6) lookahead.push('<b style="color:#8c1d18">MELTDOWN.</b> Caps rise, <b>every Advanced cost is free</b>, a <b>Surge</b> of 1&ndash;6 Influence is rolled at the top of the round &mdash; and if you take the Garrison you <b>must attack</b>. Holding back is not on the table.');

  const dread = state.dread|0;
  const dreadLine = (nextRound >= 4 && dread > 0)
    ? `<div style="font-size:12px;margin-top:4px;color:var(--muted)">Pressure stands at <b>${dread}</b>. A round with no Skirmish adds 2.</div>` : '';

  showModal(`Round ${rec.round} debrief`, `
    <div class="debrief-panel" id="roundDebrief" data-round="${rec.round}">
      <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);font-weight:700">Where the round left you</div>
      ${skirmishRows}
      <div style="font-size:12px;margin-top:6px">${rec.skirmish
        ? 'A Skirmish was fought &mdash; the margin is in the log above.'
        : 'No Skirmish this round &mdash; whoever held the Garrison held back.'}</div>
      ${capLine}
      ${picks ? `<div style="font-size:12px;margin-top:6px;color:var(--muted)">Picks: ${picks}</div>` : ''}
      ${dreadLine}
      ${lookahead.length ? `<div class="debrief-lookahead" style="margin-top:10px;padding:8px 10px;border:1px solid var(--gold,#c98a2b);border-radius:6px;font-size:12px;line-height:1.55">
        <b>Coming up.</b><br>${lookahead.join('<br>')}</div>` : ''}
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
  let advanced = false;
  let failsafe = null;
  const next = ()=>{
    if(advanced) return;
    advanced = true;
    if(failsafe !== null){ clearTimeout(failsafe); failsafe = null; }
    hideModal(); beginRound();
  };
  const btn = document.getElementById('debriefNext');
  if(btn) btn.onclick = next;
  failsafe = setTimeout(()=>{
    failsafe = null;
    if(advanced) return;
    /* Not this round's debrief any more - whatever is on screen belongs to
       somebody else and must not be advanced by a leftover timer. */
    if(!state || state.round !== debriefRound) return;
    const modal = document.getElementById('skirmishModal');
    if(!modal || modal.classList.contains('hidden')) return;
    next();
  }, 14000);
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
     `state.history` in gameEnd sees every round including this one. */
  state.history.push({
    round: state.round,
    influence: state.players.map(p=>p.influence),
    resources: state.players.map(p=>({credits:p.credits, ore:p.ore, troops:p.troops})),
    event: state.currentEvent,
    picks: (state.roundRec && state.roundRec.picks) ? state.roundRec.picks.slice() : [],
    skirmish: !!(state.roundRec && state.roundRec.skirmish),
  });

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

  if(state.round >= TOTAL_ROUNDS){
    state.players.forEach(p=>{
      const obj = getObjective(p);
      if(obj && obj.check(p)){
        p.influence += obj.bonus;
        log(`${p.name} completes their objective <b>${obj.name}</b> -> +${obj.bonus} Influence.`);
        OD.Sound.play('objective.met');
      }
    });
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
function modalFocusables(){
  const box = document.getElementById('skirmishModal').querySelector('.box');
  if(!box) return [];
  return Array.prototype.filter.call(
    box.querySelectorAll(MODAL_FOCUSABLE),
    /* offsetParent is null for display:none subtrees; the explicit
       `disabled` check covers form controls, which stay focusable-flagged
       but are not tabbable in every browser. */
    el => !el.disabled && el.offsetParent !== null
  );
}
function showModal(title, bodyHtml, opts={}){
  const dismissible = !!opts.dismissible;
  const modal = document.getElementById('skirmishModal');
  const box = modal.querySelector('.box');
  const wasHidden = modal.classList.contains('hidden');
  if(wasHidden) modalReturnFocus = document.activeElement;
  document.getElementById('skirmishTitle').textContent = title;
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
     not be able to wander into the board underneath. */
  const enter = ()=>{
    if(dismissible && !modal.classList.contains('hidden')){
      const closeBtn = document.getElementById('modalCloseBtn');
      if(closeBtn) closeBtn.focus();
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
function hideModal(){
  const modal = document.getElementById('skirmishModal');
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
document.getElementById('modalCloseBtn').addEventListener('click', hideModal);
document.getElementById('skirmishModal').addEventListener('click', (e)=>{
  if(e.target.id==='skirmishModal' && e.currentTarget.dataset.dismissible==='1') hideModal();
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
  let next = null;
  if(e.shiftKey){
    /* Shift+Tab off the head wraps to the tail. If focus is NOT on a listed
       item (it is on .box, say) treat it as "before the first" so a
       backwards Tab from the dialog chrome lands inside, not behind it. */
    if(inside<=0) next = last;
  } else {
    if(inside===-1 || inside===items.length-1) next = first;
  }
  if(!next) return;
  e.preventDefault();
  try{ next.focus(); }catch(_){ /* never swallow the Tab entirely */ }
});
document.addEventListener('keydown', (e)=>{
  const modal = document.getElementById('skirmishModal');
  if(e.key==='Escape' && !modal.classList.contains('hidden') && modal.dataset.dismissible==='1') hideModal();
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
  el.className = `gain-popup ${good?'good':'bad'}`;
  el.textContent = text;
  el.style.left = `${rect.left + rect.width/2}px`;
  el.style.top = `${rect.top - stack*22}px`;
  document.body.appendChild(el);
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

  const rift = riftLocIfLive();
  if(rift){
    const contested = state.riftContested ? ' <b>CONTESTED</b>' : '';
    const name = state.riftTarget ? rift.name : rift.name;
    parts.unshift(`<span class="rift-reveal" style="font-size:12px;color:var(--gold)">RIFT OPEN &mdash; ${name}${contested}</span>`);
  } else if(r >= 3 && !meltdown){
    parts.unshift(`<span class="rift-reveal" style="font-size:12px;color:var(--muted)">Rift closed &mdash; taken or not this round.</span>`);
  }
  el.innerHTML = parts.join('');
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
  document.getElementById('roundLabel').textContent = `${state.round} / ${TOTAL_ROUNDS}`;
  const phaseNames = {draw:'Drawing cards…', draft:'Drafting the board', 'skirmish-decide':'Skirmish decision', 'skirmish-commit':'Skirmish in progress', ended:'Game over'};
  document.getElementById('phaseLabel').textContent = phaseNames[state.phase] ? `— ${phaseNames[state.phase]}` : '';
  const ev = getEvent();
  document.getElementById('eventLine').innerHTML = ev ? `Round Event: <b style="color:var(--gold)">${ev.name}</b> - ${ev.desc}` : '';
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
      <div class="track-label">${p.name}</div>
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
    el.innerHTML = isMe ? `<b>Your turn</b> to draft a site.` : `Waiting on <b>${player.name}</b> to draft...`;
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
      <div class="name"><span>${p.name} ${p.type==='bot'?'(Bot)':''}</span><span class="influence-badge">${p.influence} Influence</span></div>
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
      if(pr.need > 1) progress = ` <span class="obj-progress">${pr.have} of ${pr.need} ${pr.unit||''}</span>`;
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

/* What the Advanced tier's note actually says. Under Meltdown every
   Advanced cost is waived for every site, so canAffordExtra() returns true
   for all of them - and the old code then printed each tile's real price
   ("pay 1 Ore") for a cost that is NOT charged. The tile was lying on all
   eight sites at once. The Rift is different: its own price is this round's
   MUTATED one (Toll doubles it, Open Hands zeroes it), and it goes through
   the identical check, so its own note is the right thing to print - except
   that Meltdown overrides even the Rift, so the Meltdown branch comes first
   for every tile. */
function advancedNote(loc, advUnlocked, advAffordable){
  if(!advUnlocked) return 'unlocks Round 2';
  if(!advAffordable) return 'cannot afford';
  if(state && state.meltdown) return 'FREE — MELTDOWN';
  return loc.advanced.note || '';
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
    const advAffordable = actor ? canAffordExtra(loc, actor) : false;

    const advUnlocked = advancedUnlocked();
    const takenBasic = taken && taken.tier==='basic';
    const takenAdvanced = taken && taken.tier==='advanced';

    const basicDisabled = !pickable;
    const advDisabled = !pickable || !advUnlocked || !advAffordable;

    function row(tier, label, note, isTaken, disabled, takenOwner){
      const tag = tier==='advanced' ? 'ADV' : 'BASIC';
      const cls = ['tier-row', tier, isTaken?'is-taken':'', (disabled && !isTaken)?'disabled':''].join(' ');
      const actionable = pickable && !isTaken && !disabled;
      const data = actionable ? `data-loc="${loc.id}" data-tier="${tier}"` : '';
      const takenTag = isTaken ? `<span class="taken-tag p${(takenOwner+1)}">${state.players[takenOwner].name}</span>` : '';
      const noteEl = (!isTaken && note) ? `<span class="tier-note">${note}</span>` : '';
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
      + row('advanced', loc.advanced.label, advancedNote(loc, advUnlocked, advAffordable), takenAdvanced, advDisabled, taken ? taken.owner : null);

    const locIcon = locIconFor(loc.id);
    /* The Rift gets its own class so the mutation reads at a glance, and the
       `contested` class is REUSED from the ordinary contested-site styling
       (feature-wagers.js) because `state.riftContested` means exactly the
       same thing here. Both are state names in the markup, not colours. */
    const riftCls = (loc.id==='rift') ? ' loc-rift' : '';
    const contestedCls = (loc.id==='rift' && state.riftContested) ? ' contested' : '';
    const riftTag = (loc.id==='rift') ? '<span class="taken-tag rift-tag">RIFT</span>' : '';

    return `
      <div class="loc${riftCls}${contestedCls}${pickable?' pickable':''}${taken?' loc-taken':''}${justTaken?' just-taken':''}" data-loc="${loc.id}">
        <div class="loc-head">
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
    return `<div class="intrigue-card" data-card="${c}">
      <b>${def.name}</b>
      <div class="intrigue-desc">${def.desc}</div>
      <button type="button" class="secondary intrigue-play-btn" data-card="${c}"${affordable?'':' disabled'}>Play (${INTRIGUE_PLAY_COST} Credits)</button>
    </div>`;
  }).join('');
  el.querySelectorAll('.intrigue-play-btn').forEach(btn=>{
    if(btn.hasAttribute('disabled')) return;
    btn.onclick = ()=> humanPlayIntrigue(btn.dataset.card);
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

function renderHand(){
  const el = document.getElementById('hand');
  let showIdx;
  if(online.enabled){
    showIdx = online.myIndex;
  } else {
    const activeIdx = currentPicker();
    /* In the draft, show whoever is picking right now. Outside the draft
       there is no active picker, so fall back to the player who most
       recently acted (`lastActiveIdx`, set in applyLocationEffect). The old
       fallback was findIndex(p => p.type === 'human'), which is always 0
       in a two-human hotseat - so after Player 2's Skirmish the panel
       silently flipped back to showing Player 1's hand. */
    if(state.phase==='draft' && activeIdx!==null && state.players[activeIdx].type==='human'){
      showIdx = activeIdx;
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
  setHandHeading(online.enabled ? 'Your hand' : `${player.name}'s hand`, 'used only in a Skirmish');

  const prevSeen = handRenderCache[showIdx] || new Set();
  const groups = groupHand(player.hand);
  handRenderCache[showIdx] = new Set(player.hand);

  el.innerHTML = (groups.length ? groups.map(g=>`
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

function renderLog(){
  const el = document.getElementById('log');
  el.innerHTML = state.logEntries.slice().reverse().map(e=>`<div class="entry">${e}</div>`).join('');
}

function showEndScreen(){
  document.getElementById('game').classList.add('hidden');
  const end = document.getElementById('endScreen');
  end.classList.remove('hidden');
  const [p1,p2] = state.players;
  const obj1 = getObjective(p1), obj2 = getObjective(p2);
  let headline, winnerIdx;
  if(p1.influence===p2.influence){ headline = "It's a draw!"; winnerIdx = -1; }
  else if(p1.influence>p2.influence){ headline = `${p1.name} wins!`; winnerIdx = 0; }
  else { headline = `${p2.name} wins!`; winnerIdx = 1; }

  if(winnerIdx!==-1){
    if(!online.enabled || winnerIdx===online.myIndex){ sfx.win(); OD.Sound.play('victory.fanfare'); }
    else { sfx.lose(); OD.Sound.play('defeat'); }
  } else {
    /* A draw used to be completely silent - it now gets its own cue. */
    OD.Sound.play('tie');
  }

  function statRow(label, key, fmt){
    const v1 = fmt ? fmt(p1[key]) : p1[key];
    const v2 = fmt ? fmt(p2[key]) : p2[key];
    return `<tr><td>${label}</td><td>${v1}</td><td>${v2}</td></tr>`;
  }

  /* END-SCREEN TRAJECTORY (G9). The final tally is a static number; the game
     that produced it is not. The player scored all of this across six rounds
     of drafts, caps and Skirmishes, and the end screen used to present only
     the sum - so a 22-4 win and a 22-4 lead built the same way read
     identically. `state.history` already carries a per-round Influence pair,
     appended in endRound before anything could end the game.

     The PIVOT is the single round where the lead changed hands by the largest
     margin. It is the round the loser would point at and the winner would
     rather forget, which is exactly why it earns a line of its own. */
  const history = (state.history || []).slice();
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
       measured from 0-0. */
    history.forEach(h=>{
      const now = lead(h);
      const before = prev(h);
      const was = before ? lead(before) : 0;
      const swing = Math.abs(now - was);
      if(!pivot || swing > pivot.swing) pivot = {h, swing, was, now};
    });

    const rows = history.map((h,i)=>{
      const before = prev(h);
      const d0 = h.influence[0] - (before ? before.influence[0] : 0);
      const d1 = h.influence[1] - (before ? before.influence[1] : 0);
      const gap = lead(h);
      const leader = gap === 0 ? '-' : (gap > 0 ? p1.name : p2.name);
      const cls = gap === 0 ? '' : (gap > 0 ? 'p1' : 'p2');
      return `<tr${pivot && pivot.h===h ? ' class="pivot-round"' : ''}>`
        + `<td>${h.round}</td>`
        + `<td>${h.influence[0]} <span style="color:var(--muted);font-size:11px">(${d0>=0?'+':''}${d0})</span></td>`
        + `<td>${h.influence[1]} <span style="color:var(--muted);font-size:11px">(${d1>=0?'+':''}${d1})</span></td>`
        + `<td class="${cls}">${leader}</td>`
        + `<td>${h.skirmish ? 'yes' : '<span style="color:var(--muted)">held back</span>'}</td>`
        + `</tr>`;
    }).join('');

    const pivotLine = (pivot && pivot.swing > 0)
      ? `<div class="pivot-note"><b>The pivot was Round ${pivot.h.round}.</b> `
        + `${pivot.now === 0 ? 'The lead tied out'
          : `${(pivot.now > 0 ? p1.name : p2.name)} took it`}`
        + `${pivot.was === 0 ? '' : ` from ${(pivot.was > 0 ? p1.name : p2.name)}`}`
        + ` &mdash; a swing of <b>${pivot.swing} Influence</b> in a single round.</div>`
      : '';

    trajectoryHtml = `
      <div class="trajectory">
        <h3>How it went</h3>
        <table class="stats-table">
          <thead><tr><th>Round</th><th>${p1.name}</th><th>${p2.name}</th><th>Led by</th><th>Skirmish</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${pivotLine}
      </div>`;
  }

  /* The objective bonus is the LARGEST single swing available in the whole
     game - +4 in one line, against a Skirmish that pays 4-6 but only for
     holding a Garrison. It was rendered as one more table cell, which reads
     as bookkeeping. It gets a callout, and the callout is scored: it shows
     what each player would have finished on WITHOUT it, so the player who
     lost by 3 can see exactly how close the objective was to mattering. */
  const objMet = (p, obj)=> !!(obj && obj.check(p));
  const met1 = objMet(p1, obj1), met2 = objMet(p2, obj2);
  const objectiveCallout = (met1 || met2)
    ? `<div class="objective-callout">
        <div class="objective-callout-h">Objective bonus &mdash; +${OBJECTIVE_BONUS} each</div>
        <div class="objective-callout-row">
          <b>${p1.name}</b> &mdash; ${obj1.name}: ${met1
            ? `<b class="met">MET, +${OBJECTIVE_BONUS}</b>. Without it: <b>${p1.influence - OBJECTIVE_BONUS}</b>.`
            : `not met. On the Influence they actually scored: <b>${p1.influence}</b>.`}
        </div>
        <div class="objective-callout-row">
          <b>${p2.name}</b> &mdash; ${obj2.name}: ${met2
            ? `<b class="met">MET, +${OBJECTIVE_BONUS}</b>. Without it: <b>${p2.influence - OBJECTIVE_BONUS}</b>.`
            : `not met. On the Influence they actually scored: <b>${p2.influence}</b>.`}
        </div>
        ${(met1 !== met2) ? `<div class="objective-callout-flip">The bonus did not change the winner &mdash; but it is the
          difference between a win and a defeat on the board by ${Math.abs((p1.influence - (met1?OBJECTIVE_BONUS:0)) - (p2.influence - (met2?OBJECTIVE_BONUS:0)))} Influence.</div>` : ''}
      </div>`
    : '';

  end.innerHTML = `
    <h1>${headline}</h1>
    <div class="row" style="justify-content:center">
      <div class="player-card p1"><div class="name">${p1.name}<span class="influence-badge">${p1.influence} Influence</span></div></div>
      <div class="player-card p2"><div class="name">${p2.name}<span class="influence-badge">${p2.influence} Influence</span></div></div>
    </div>
    ${objectiveCallout}
    ${trajectoryHtml}
    <table class="stats-table">
      <thead><tr><th>Final tally</th><th>${p1.name}</th><th>${p2.name}</th></tr></thead>
      <tbody>
        ${statRow('Influence','influence')}
        ${statRow('Credits','credits')}
        ${statRow('Ore','ore')}
        ${statRow('Troops','troops')}
        ${statRow('Cards in hand','hand',h=>h.length)}
        <tr><td>Objective</td><td>${obj1.name}${obj1.check(p1)?' (met, +'+obj1.bonus+')':''}</td><td>${obj2.name}${obj2.check(p2)?' (met, +'+obj2.bonus+')':''}</td></tr>
      </tbody>
    </table>
    <div class="footer-actions" style="justify-content:center;margin-top:20px">
      <button id="playAgain">Play Again</button>
    </div>
    <div id="demoLoopBar" class="hidden" style="justify-content:center;margin-top:14px"></div>
  `;
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

document.querySelectorAll('.mode-card').forEach(card=>{
  card.addEventListener('click', ()=>{
    ensureAudioCtx();
    document.getElementById('gameMode').value = card.dataset.mode;
    document.querySelectorAll('.mode-card').forEach(c=>c.classList.remove('selected'));
    card.classList.add('selected');
    updateModeUI();
  });
});

document.getElementById('soundToggle').addEventListener('click', toggleSound);
document.getElementById('soundToggleGame').addEventListener('click', toggleSound);
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
  {id:'rules-wagers', label:'Wagers',   short:'Wagers', feature:'Wagers', key:'RULES_HTML'},
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
   table a feature has to agree with it lives here and nowhere else. */
if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    LOCATIONS, COST_RESOURCES, TOTAL_ROUNDS, CAPS,
    tierCost, tierIsAlwaysTakeable, canPayCost, takeCost, costPhrase,
  };
}
