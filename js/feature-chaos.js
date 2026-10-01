/* ---------------------------------------------------------------------
   OUTPOST DUEL — CHAOS (feature region rules-b)

   Four late-game systems that turn the last three rounds into a
   different game than the first three. Nothing here changes an early
   round: Dread only exists from Round 3, Bounties are only published in
   Rounds 3 and 5, the Rift only joins the board in Round 3, and
   Meltdown is Round 6 and nothing else.

     MELTDOWN (R6)  "No cap, no retreat, no excuses."
                    caps 10/8/8, every Advanced cost waived, holding the
                    Garrison obliges you to attack, and a 1d6 SURGE is
                    added straight to Influence for both players.
     DREAD          "Two more quiet rounds and the sky opens."
                    +1 Pressure every round from R3, +2 when a round
                    passes with no Skirmish; at 4 the board collapses and
                    2 Influence moves from the leader to the trailer.
     BOUNTIES       Two public, single-qualifier contracts (R3, R5) that
                    rewrite what the board is for, and pay out at the end
                    of the very round they were published in.
     THE RIFT       A ninth site from R3 - a random mutation of a real
                    one. 6 picks out of 9, so the round is the same length
                    with one more decision nobody can forecast.

   Contract with the engine (all of these are the ONLY places this file
   is allowed to reach into game.js, and every one is marked `>>> CHAOS`):

     capOverrides(state)   meltdown caps, or null
     advancedWaived(state) true when every Advanced cost is free
     riftLoc(state)        the ninth site's loc object, or null
     applyRift(ctx)        applies this round's mutation delta
     bountyMod(...)        bot draft-value nudge from the live Bounty
     dreadMod(...)         bot aggression nudge from the current Pressure
     RULES_HTML            rules copy the integrator can splice in
--------------------------------------------------------------------- */

;(function(root){
'use strict';

const Chaos = (() => {

/* ============================ frozen tables ============================ */

/* Mirrors of game.js. Kept as local constants (not read from globals) so
   this file is loadable and testable on its own; the one thing it must
   never guess at is randomness, and the one thing it must never store is
   a function. `state` goes over the online relay as JSON. */
const TOTAL_ROUNDS = 6;
const MELTDOWN_ROUND = TOTAL_ROUNDS;
const MELTDOWN_CAPS = Object.freeze({credits:10, ore:8, troops:8});
const DREAD_START_ROUND = 3;
const COLLAPSE_AT = 4;
const MAX_COLLAPSES = 2;
const RIFT_FROM_ROUND = 3;
const RIFT_ID = 'rift';
/* game.js keeps BOT_TICK_MS in its own module scope. The Surge only needs
   it to know how long a bot "thinks", so it uses a nominal value. */
const BOT_TICK_ESTIMATE_MS = 500;

/* Bounties. `check` is a FUNCTION and therefore can never live on state -
   the same reason game.js stores `objectiveId` and looks the definition
   back up. Which bounty is live is the id; the definition is here. */
const BOUNTIES = Object.freeze([
  Object.freeze({
    id:'deep_cut', name:'Deep Cut', pays:2, unit:'most Advanced picks',
    text:'Take more Advanced picks than your opponent this round.',
    check:(r)=> r.advanced > r.advancedOpp,
  }),
  Object.freeze({
    id:'blood_price', name:'Blood Price', pays:3, unit:'fewest Troops at round end',
    text:'End the round with strictly fewer Troops than your opponent.',
    check:(r)=> r.troops < r.troopsOpp,
  }),
  Object.freeze({
    id:'long_haul', name:'The Long Haul', pays:2, unit:'most Tactic cards drawn',
    text:'Draw more Tactic cards than your opponent this round.',
    check:(r)=> r.cards > r.cardsOpp,
  }),
  Object.freeze({
    id:'crushing', name:'Crushing Mandate', pays:3, unit:'Skirmish won by 3+',
    text:'Win the Skirmish by a margin of 3 or more. No Skirmish, no claim.',
    check:(r)=> r.skirmishWin >= 3,
  }),
  Object.freeze({
    id:'glory', name:'Garrison Glory', pays:2, unit:'took the Garrison',
    text:'Take the Garrison this round.',
    check:(r)=> r.garrison > 0,
  }),
  Object.freeze({
    id:'bankrupt', name:'Bankrupt!', pays:3, unit:'fewest Credits at round end',
    text:'End the round with strictly fewer Credits than your opponent.',
    check:(r)=> r.credits < r.creditsOpp,
  }),
]);
const BOUNTY_BY_ID = Object.freeze(BOUNTIES.reduce((m,b)=>{ m[b.id]=b; return m; }, Object.create(null)));
const BOUNTY_ROUNDS = Object.freeze([3, 5]);

/* The eight real sites, reduced to what the Rift needs: a display name, the
   resource that site is "about", and the side resource it also hands out.

   >>> THERE IS NO COST IN HERE, AND THAT IS THE POINT (BLOCKER 1). This table
   >>> used to carry an `advCost` mirror of game.js's LOCATIONS[].advanced.cost,
   >>> and the mirror was EMPTY for Outpost, Bazaar and Shrine — the three sites
   >>> whose real prices were hardcoded inside applyLocationEffect's switch. A
   >>> Rift-of-Outpost wearing "Open Hands" therefore charged the player
   >>> 5 Credits + 3 Ore and then logged "Advanced was free anyway", and
   >>> "Toll" silently charged nothing at all for those three. A second copy of
   >>> the board is a second set of truths; it is now a first-class error.
   >>> Prices are read from the engine through OD.Board (advancedCostOf below),
   >>> which returns {} when there is no engine — "unknown", not "free". */
const SITES = Object.freeze({
  market:   Object.freeze({name:'Market',  main:'credits',   other:'ore'}),
  quarry:   Object.freeze({name:'Quarry',  main:'ore',       other:'troops'}),
  garrison: Object.freeze({name:'Garrison',main:'troops',    other:'influence'}),
  outpost:  Object.freeze({name:'Outpost', main:'influence', other:'credits'}),
  archive:  Object.freeze({name:'Archive', main:'cards',     other:'influence'}),
  foundry:  Object.freeze({name:'Foundry', main:'credits',   other:'ore'}),
  bazaar:   Object.freeze({name:'Bazaar',  main:'credits',   other:'ore'}),
  shrine:   Object.freeze({name:'Shrine',  main:'influence', other:'credits'}),
});
const SITE_IDS = Object.freeze(Object.keys(SITES));

/* The six mutations. `clause` is the honest, human sentence printed in the
   reveal - the whole feature is that the Rift is announced, not hidden. */
const MUTATIONS = Object.freeze([
  Object.freeze({id:'generous',         name:'Generous',      clause:'everything it gives comes +1 richer'}),
  Object.freeze({id:'greedy',           name:'Greedy',        clause:'it pays double its main yield and slips the other side a cut'}),
  Object.freeze({id:'toll',             name:'Toll',          clause:'Advanced costs double and the main yield drops by 1'}),
  Object.freeze({id:'free_advanced',    name:'Open Hands',    clause:'Advanced costs nothing at all'}),
  Object.freeze({id:'contested_always', name:'Contested',     clause:'it is permanently Contested'}),
  Object.freeze({id:'cursed',           name:'Cursed',        clause:'you get the Basic effect only, and you lose 1 Troop for the privilege'}),
]);
const MUT_BY_ID = Object.freeze(MUTATIONS.reduce((m,x)=>{ m[x.id]=x; return m; }, Object.create(null)));

/* What each mutation does to the bot's draft value, by site. `advMul`
   scales the value of an Advanced pick (applied as a fraction of the
   value the engine already computed, so it composes with its own 1.6
   Advanced multiplier instead of hardcoding a second one). */
const BOUNTY_SITE_MODS = Object.freeze({
  /* Blood Price devalues the troop-granting sites and pays a premium for
     the Shrine, which is the one site that is not troops. */
  blood_price: Object.freeze({market:-0.8, quarry:-0.8, foundry:-0.8, shrine:0.5}),
  glory:       Object.freeze({garrison:1.2}),
  long_haul:   Object.freeze({archive:1.0}),
  bankrupt:    Object.freeze({market:0.6, bazaar:0.6}),
  deep_cut:    Object.freeze({}),   // expressed as advMul instead
  crushing:    Object.freeze({}),   // a combat target, not a site
});
const BOUNTY_ADV_MUL = Object.freeze({deep_cut:0.25});
/* Easy stays Easy. The Bounty is a public contract, so a bot that cannot
   see it is not "harder", it is just better at a different thing. */
const BOUNTY_BOT_WEIGHT = Object.freeze({easy:0, normal:0.7, hard:1});

const RES_LABEL = Object.freeze({credits:'Credit', ore:'Ore', troops:'Troop', influence:'Influence'});
const COST_RESOURCES = Object.freeze(['credits','ore','troops']);

/* The REAL price of `siteId`'s Advanced tier, straight from the engine. The
   engine publishes these through OD.Board.tierCost(); this file keeps no copy,
   so a rebalance in game.js reaches the Rift's Toll and Open Hands with no edit
   here at all. With no engine on the page (this file loaded standalone, or a
   hand-built unit-test state) it returns {} — "no price known", which is NOT
   the same claim as "free", and the mutations below treat it that way. */
function advancedCostOf(siteId){
  const board = (root.OD && root.OD.Board) ? root.OD.Board : null;
  if(!board || typeof board.tierCost !== 'function') return {};
  const c = board.tierCost(siteId, 'advanced');
  const out = {};
  COST_RESOURCES.forEach(res => { const n = c && c[res]; out[res] = (typeof n === 'number' && n > 0) ? n : 0; });
  return out;
}
const costTotal = (cost)=> COST_RESOURCES.reduce((n, res)=> n + ((cost && cost[res]) || 0), 0);
/* "1 Ore" / "10 Credits + 6 Ore" — every resource in the price, so a doubled
   or multi-resource cost is never announced as one of its halves. */
function costPhrase(cost){
  return COST_RESOURCES
    .filter(res => ((cost && cost[res]) || 0) > 0)
    .map(res => `${resName(res, cost[res])}`)
    .join(' + ');
}

/* ============================ small helpers ============================ */

const timers = [];
function later(fn, ms){
  const id = setTimeout(()=>{
    const i = timers.indexOf(id);
    if(i >= 0) timers.splice(i, 1);
    fn();
  }, ms);
  timers.push(id);
  return id;
}
function every(fn, ms){
  const id = setInterval(fn, ms);
  timers.push(id);
  return id;
}
function dropTimer(id){
  const i = timers.indexOf(id);
  if(i >= 0) timers.splice(i, 1);
  try{ clearTimeout(id); }catch(_){}
  try{ clearInterval(id); }catch(_){}
}
function clearTimers(){
  while(timers.length) dropTimer(timers[timers.length-1]);
  /* A reveal interrupted by a new game must not leave its overlay on the
     page: the timer that would have taken it down is one of the timers
     just dropped. */
  try{
    if(typeof document !== 'undefined' && document.getElementById){
      const wrap = document.getElementById('odChaosSurge');
      if(wrap) wrap.remove();
    }
  }catch(_){}
}
function num(v){ return (typeof v === 'number' && isFinite(v)) ? v : 0; }
function pick(list){ return list[Math.floor(Math.random()*list.length)]; }
function resName(res, n){
  if(res === 'influence') return `${n} Influence`;
  const one = RES_LABEL[res] || res;
  /* Ore is a mass noun everywhere in this game's copy ("+3 Ore"), so it never
     takes an -s; Credits and Troops do. */
  const plural = (res === 'ore' || n === 1) ? '' : 's';
  return `${n} ${one}${plural}`;
}
/* `firstResOf` used to live here: it returned only the FIRST resource in a
   price, which is why a 5 Credits + 3 Ore Outpost was announced as "5 Credits"
   and why Toll's `n > 1` guard silently skipped every 1-resource site. Every
   caller now walks the whole cost object (costPhrase / costTotal) instead. */
function sound(name){ try{ if(root.OD && root.OD.Sound) root.OD.Sound.play(name); }catch(_){} }
function fx(){
  return (root.OD && root.OD.Fx) ? root.OD.Fx : null;
}
function reduceMotion(){
  const f = fx();
  return !!(f && typeof f.reduceMotion === 'function' && f.reduceMotion());
}
function shake(sel, amp, ms){
  const f = fx();
  if(!f) return;
  try{ f.shake(sel, {amp, ms}); }catch(_){}
}
function flash(color, ms){
  const f = fx();
  if(!f) return;
  try{ f.flash(null, color, ms); }catch(_){}
}
function countUp(node, from, to, ms){
  const f = fx();
  if(!f) return;
  try{ f.countUp(node, from, to, ms); }catch(_){}
}
function popup(api, i, text, good){
  if(!api) return;
  try{ api.popup(i, text, good !== false); }catch(_){}
}
/* Prefer the seam's own setter, fall back to a direct write for nested
   feature-owned scratch data (roundRec) that the api has no setter for. */
function setKey(api, state, key, value){
  if(api && typeof api.set === 'function'){ api.set(key, value); return; }
  if(state) state[key] = value;
}

/* roundRec carries this feature's per-round scratch. game.js rebuilds the
   object at the top of every round, so it has to be re-seeded every round
   too - and seeded for BOTH players, or the second player's counts read
   undefined. */
function ensureRoundRec(state, api){
  if(!state) return null;
  if(!state.roundRec) setKey(api, state, 'roundRec', {round:state.round, picks:[]});
  const rec = state.roundRec;
  if(!Array.isArray(rec.cards)) rec.cards = [0,0];
  if(!Array.isArray(rec.advanced)) rec.advanced = [0,0];
  if(!Array.isArray(rec.garrison)) rec.garrison = [0,0];
  if(typeof rec.skirmishMargin !== 'number') rec.skirmishMargin = 0;
  if(typeof rec.skirmishWinner !== 'number') rec.skirmishWinner = -1;
  return rec;
}

/* Everything the six bounty conditions need, as plain numbers, evaluated
   at the end of the round for player `i`. */
function recordFor(state, i){
  const rec = (state && state.roundRec) || {};
  const p = state.players[i], o = state.players[1-i];
  return {
    advanced:      num(rec.advanced && rec.advanced[i]),
    advancedOpp:   num(rec.advanced && rec.advanced[1-i]),
    cards:         num(rec.cards && rec.cards[i]),
    cardsOpp:      num(rec.cards && rec.cards[1-i]),
    garrison:      num(rec.garrison && rec.garrison[i]),
    troops:        num(p.troops),  troopsOpp:  num(o.troops),
    credits:       num(p.credits), creditsOpp: num(o.credits),
    /* "Won by 3+" -> the winning margin, 0 for everyone else. */
    skirmishWin:   (rec.skirmishWinner === i) ? num(rec.skirmishMargin) : 0,
  };
}

/* ============================== MELTDOWN ============================== */

function capOverrides(state){
  return (state && state.meltdown) ? MELTDOWN_CAPS : null;
}
function advancedWaived(state){
  return !!(state && state.meltdown);
}

/* THE SURGE. Called once, at the top of Round 6, before the first pick.
   The dice are pure variance on purpose: both players roll one d6, both
   numbers are written into state (so the online guest animates the same
   values the host rolled), and the Influence is applied immediately -
   the animation is presentation, never a source of truth. */
function rollSurge(ctx){
  const state = ctx.state, api = ctx.api;
  const values = state.players.map(()=> 1 + Math.floor(Math.random()*6));
  setKey(api, state, 'surgeRolls', {round:state.round, values:values});

  state.players.forEach((p, i)=>{
    api.grant(i, {influence:values[i]});
    api.log(`<b>THE SURGE.</b> ${p.name} rolled <b>${values[i]}</b> &rarr; straight to Influence. No cap, no choice, no take-backs.`);
    popup(api, i, `+${values[i]} Influence`, true);
  });
  sound('influence.gain');
  return values;
}

/* The activation beat: the loudest frame the game has. */
function meltdownBeat(){
  sound('stinger.final');
  flash('rgba(190, 24, 24, 0.55)', 760);
  shake('#game', 12, 620);
  shake('#playerCards', 7, 520);
  shake('#board', 5, 460);
}

/* Single-die reveal, modelled on animateDiceRoll but self-contained: the
   modal belongs to the engine, so this builds its own overlay node and
   takes it (and every timer) back down. ~20 lines of real work. */
function surgeReveal(state, values){
  sound('dice.roll_start');
  if(reduceMotion() || typeof document === 'undefined' || !document.body){
    sound('dice.settle');
    return;
  }
  const wrap = document.createElement('div');
  wrap.id = 'odChaosSurge';
  wrap.setAttribute('role','status');
  wrap.setAttribute('aria-live','polite');
  wrap.style.cssText = [
    'position:fixed','inset:0','z-index:9990','display:flex','align-items:center',
    'justify-content:center','pointer-events:none','background:rgba(10,4,4,.55)',
  ].join(';');
  wrap.innerHTML = `<div class="dice-row" style="gap:28px">` +
    state.players.map((p, i)=>`<div class="dice-col">
      <div class="who">${p.name}</div>
      <div class="die rolling" data-die="${i}">?</div>
      <div class="dice-card" data-gain="${i}">SURGE &mdash; rolling</div>
    </div>`).join('') + `</div>`;
  document.body.appendChild(wrap);

  const dice = values.map((_, i)=> wrap.querySelector(`[data-die="${i}"]`));
  const gains = values.map((_, i)=> wrap.querySelector(`[data-gain="${i}"]`));
  let done = false;
  const finish = ()=>{
    if(done) return;
    done = true;
    dropTimer(tickId);
    try{ if(wrap.isConnected) wrap.remove(); }catch(_){}
  };

  const rollMs = 720;
  const tickId = every(()=>{
    dice.forEach(d=>{ if(d) d.textContent = String(1 + Math.floor(Math.random()*6)); });
    sound('dice.tick');
  }, 60);
  later(()=>{
    dropTimer(tickId);
    values.forEach((v, i)=>{
      const d = dice[i];
      if(d){ d.textContent = String(v); d.classList.remove('rolling'); d.classList.add('settled'); }
      if(gains[i]) gains[i].innerHTML = `<b>+${v} Influence</b> - the board is done being polite`;
      countUp(gains[i], 0, v, 600);
    });
    sound('dice.settle');
    sound('stat.gain');
    flash('rgba(190, 24, 24, 0.35)', 420);
    shake('#playerCards', 6, 420);
    later(finish, 2200);   // fallback so the overlay can never stick
  }, rollMs);
}

/* ================================ DREAD ================================ */

function pressureLine(state){
  const pips = [0,1,2,3].map(i=> i < num(state.dread)
    ? `<span style="color:${num(state.dread) >= 3 ? '#b5502e' : '#c98a2b'}">&#9679;</span>`
    : `<span style="color:var(--muted)">&#9675;</span>`).join('');
  return `${pips} <span style="color:var(--muted);font-size:12px">${num(state.dread)}/${COLLAPSE_AT} &mdash; collapse at ${COLLAPSE_AT}, ${MAX_COLLAPSES} per game</span>`;
}

/* Collapse: the leader pays 2, the trailer collects 2. An Influence tie is
   broken against the bigger pile, so a stalemate still costs somebody. */
function collapse(ctx){
  const state = ctx.state, api = ctx.api;
  const a = state.players[0], b = state.players[1];
  let lead;
  if(a.influence > b.influence) lead = 0;
  else if(b.influence > a.influence) lead = 1;
  else {
    const ra = a.credits + a.ore + a.troops, rb = b.credits + b.ore + b.troops;
    lead = (rb > ra) ? 0 : 1;   // equal Influence AND equal resources: 0 is crushed
  }
  const trailer = 1 - lead;
  const lost = Math.min(2, num(state.players[lead].influence));
  const tied = (a.influence === b.influence);   // BEFORE the swap, or it lies
  if(lost > 0) api.spend(lead, {influence:lost});
  api.grant(trailer, {influence:2});
  setKey(api, state, 'dread', 0);
  setKey(api, state, 'collapses', num(state.collapses) + 1);

  const why = tied
    ? `neither side led on Influence, so the thinner pile (${state.players[lead].name}) counts as the leader`
    : `${state.players[lead].name} is ahead on Influence`;
  api.log(`<b>THE SKY OPENS &mdash; COLLAPSE ${num(state.collapses)}/${MAX_COLLAPSES}.</b> ${why}. ` +
    (lost > 0
      ? `The pressure takes ${resName('influence', lost)} from ${state.players[lead].name}`
      : `${state.players[lead].name} has nothing left to take`) +
    ` and hands 2 Influence to ${state.players[trailer].name}. Pressure resets.`);
  popup(api, lead, `${lost} Influence`, false);
  popup(api, trailer, '+2 Influence', true);
  sound('stinger.loss');
  flash('rgba(120, 140, 190, 0.45)', 620);
  shake('#game', 10, 560);
  shake('#playerCards', 6, 460);
}

function tickDread(ctx){
  const state = ctx.state, api = ctx.api;
  if(num(state.collapses) >= MAX_COLLAPSES){
    if(!state.collapseSpent){
      setKey(api, state, 'collapseSpent', true);
      api.log(`<b>The ground has already settled.</b> ${MAX_COLLAPSES} Collapses is the limit &mdash; the sky will not open again.`);
    }
    return;
  }
  if(num(state.round) < DREAD_START_ROUND) return;
  const rec = state.roundRec || {};
  const quiet = !rec.skirmish;
  const gain = quiet ? 2 : 1;
  setKey(api, state, 'dread', num(state.dread) + gain);
  const hits = num(state.dread) >= COLLAPSE_AT;
  api.log(`<b>PRESSURE ${num(state.dread)}/${COLLAPSE_AT}</b> &mdash; Dread +${gain}.` +
    (quiet
      ? ` The round ended with no Skirmish, and standing still is exactly what the sky punishes.`
      : (hits ? ` That is all of it.` : ` Two more and the board collapses.`)));
  sound('turn.ping');
  shake('#playerCards', 3, 260);
  if(hits) collapse(ctx);
}

/* ============================== BOUNTIES ============================== */

function publishBounty(ctx){
  const state = ctx.state, api = ctx.api;
  if(!BOUNTY_ROUNDS.includes(num(state.round))) return;
  if(state.bounty) return;                 // one live at a time, always
  const def = pick(BOUNTIES);
  setKey(api, state, 'bounty', {id:def.id, round:state.round});
  setKey(api, state, 'bountyIds', (Array.isArray(state.bountyIds) ? state.bountyIds.slice() : []).concat([def.id]));
  api.log(`<b>BOUNTY PUBLISHED &mdash; ${def.name} (+${def.pays}).</b> ${def.text} ` +
    `Exactly one of you qualifies. Both or neither: nobody is paid.`);
  sound('turn.ping');
  flash('rgba(201, 138, 43, 0.28)', 420);
}

/* Runs BEFORE the Dread tick (higher hook priority) so a Collapse in the
   same breath cannot eat the Bounty someone just earned. */
function resolveBounty(ctx){
  const state = ctx.state, api = ctx.api;
  const live = state.bounty;
  if(!live || !live.id) return;
  /* A Bounty pays out at the end of the round it was published in - so a
     Round 5 Bounty is money in hand before Meltdown, not a post-game
     footnote. */
  if(num(live.round) !== num(state.round)){ setKey(api, state, 'bounty', null); return; }
  const def = BOUNTY_BY_ID[live.id];
  if(!def){ setKey(api, state, 'bounty', null); return; }

  const qualified = [0, 1].map(i=> !!def.check(recordFor(state, i)));
  let winner = -1;
  if(qualified[0] !== qualified[1]) winner = qualified[0] ? 0 : 1;

  if(winner >= 0){
    api.grant(winner, {influence:def.pays});
    api.log(`<b>${state.players[winner].name} claims the Bounty</b> &mdash; ${def.name} &rarr; +${def.pays} Influence.`);
    popup(api, winner, `+${def.pays} Influence`, true);
    sound('objective.met');
    flash('rgba(90, 122, 58, 0.30)', 380);
  } else {
    api.log(`<b>Nobody claims the Bounty</b> &mdash; ${def.name}: ${qualified[0] ? 'both of you qualified' : 'neither of you qualified'}. ` +
      `The pot stays cold.`);
    sound('stat.loss');
  }
  setKey(api, state, 'bounty', null);
}

/* The bot's draft nudge. `value` is the value botChoosePick already
   computed, so an advMul can scale it without this file having to know
   anything about tiers. */
function bountyMod(locId, tier, value, difficulty, state){
  const live = state && state.bounty;
  if(!live || !live.id) return 0;
  const weight = BOUNTY_BOT_WEIGHT[difficulty];
  if(!weight) return 0;                    // Easy never gets this
  const def = BOUNTY_BY_ID[live.id];
  if(!def) return 0;
  let mod = 0;
  const bySite = BOUNTY_SITE_MODS[live.id];
  if(bySite && typeof bySite[locId] === 'number') mod += bySite[locId];
  const mul = BOUNTY_ADV_MUL[live.id];
  if(mul && tier === 'advanced' && typeof value === 'number' && isFinite(value)) mod += value * mul;
  return mod * weight;
}

/* ============================== DREAD/BOT ============================== */

/* A leading bot knows that stalling feeds the Collapse it is about to
   cash in, so it presses. A hopeless trailing bot knows it cannot cash
   the Collapse in and stops paying a tax it does not get to collect. */
function dreadMod(aggressor, defender, state){
  if(!state) return 0;
  const dread = num(state.dread);
  if(dread <= 0) return 0;
  const lead = num(aggressor.influence) - num(defender.influence);
  if(lead > 0 && dread >= 2) return 0.2;                 // sitting pretty: press
  if(lead <= 0 && -lead >= 6 && dread >= 3) return -0.25; // six Influence down: stop feeding it
  return 0;
}

/* ================================ RIFT ================================ */

function riftUnlocked(state){
  return !!(state && num(state.round) >= RIFT_FROM_ROUND && state.riftTarget && state.riftMut);
}
/* The price this Rift's Advanced pick actually costs the player: the site's
   real price, doubled for Toll, nothing at all for Open Hands. */
function riftAdvCost(state){
  const base = advancedCostOf(state.riftTarget);
  if(state.riftMut === 'toll'){
    const out = {};
    COST_RESOURCES.forEach(res =>{ out[res] = base[res] * 2; });
    return out;
  }
  if(state.riftMut === 'free_advanced') return {credits:0, ore:0, troops:0};
  return base;
}
function riftSentence(state){
  const site = SITES[state.riftTarget];
  const mut = MUT_BY_ID[state.riftMut];
  if(!site || !mut) return '';
  let extra = '';
  if(state.riftMut === 'toll'){
    const c = riftAdvCost(state), base = advancedCostOf(state.riftTarget);
    if(costTotal(c) > 0 && costTotal(base) > 0) extra = ` It costs ${costPhrase(c)} instead of ${costPhrase(base)},`;
    if(site.main !== 'cards') extra += ` and pays ${resName(site.main, 1)} less.`;
  }
  return `THE RIFT &mdash; this round it is: <b>${site.name}</b>, but ${mut.clause}.${extra}`;
}

/* The loc object the engine picks from. It is rebuilt on demand rather
   than cached, because its cost depends on this round's mutation. The
   engine hands it straight to canAffordExtra / baseLocationValue, so the
   Rift's Toll and Open Hands prices are enforced by exactly the same
   check every other site goes through. */
function riftLoc(state){
  if(!riftUnlocked(state)) return null;
  if(!state.board) state.board = Object.create(null);
  if(state.board[RIFT_ID]) return null;          // already taken this round
  const site = SITES[state.riftTarget];
  const mut = MUT_BY_ID[state.riftMut];
  if(!site || !mut) return null;
  const cost = riftAdvCost(state);
  return {
    id:RIFT_ID,
    name:`The Rift - ${site.name} (${mut.name})`,
    basic:{label:`Take the ${site.name} Basic effect, ${mut.clause}`, note:'the Rift is announced - read it'},
    advanced:{label:`Take the ${site.name} Advanced effect, ${mut.clause}`, cost:cost, note:riftNote(state)},
  };
}
function riftNote(state){
  const cost = riftAdvCost(state);
  if(state.riftMut === 'free_advanced') return 'Advanced is free';
  const phrase = costPhrase(cost);
  if(phrase) return `Advanced costs ${phrase}`;
  return 'Advanced costs nothing';
}

/* The mutation delta, applied on top of the target site's own effect.
   game.js has already charged the ordinary Advanced cost and paid the
   ordinary yield, so Toll charges its second half here and Open Hands
   refunds its first half here, and Cursed has already been forced down to
   Basic before the switch ran. */
function applyRift(ctx){
  const state = ctx.state, api = ctx.api, i = ctx.playerIdx;
  const mut = ctx.mutation, site = SITES[ctx.targetId];
  if(!state || !api || !site || !mut) return;
  const adv = ctx.tier === 'advanced';
  /* What the engine REALLY debited for this pick, per resource. The two
     pricing mutations below trust this and nothing else: pricing them off the
     site's nominal cost is what let Open Hands announce a free Advanced pick
     it had just charged 5 Credits + 3 Ore for. */
  const paid = (adv && ctx.paidCost) ? ctx.paidCost : {credits:0, ore:0, troops:0};
  const gainCards = (n)=>{ const drew = api.draw(i, n); return drew > 0 ? `+${drew} Tactic card${drew!==1?'s':''}` : 'drew 0 Tactic cards'; };
  const give = (res, n)=>{ if(res === 'cards') return gainCards(n); api.grant(i, {[res]:n}); return `+${resName(res, n)}`; };
  let note = '';

  switch(mut){
    case 'generous':
      note = give(site.main, 1);
      break;
    case 'greedy':
      note = [give(site.main, 2), give(site.other, 1)].join(', ');
      break;
    case 'toll': {
      if(adv){
        /* Doubling means paying the price a SECOND time — not "paying
           `doubled - 1`", which is what the old code did (and which skipped
           every single-resource site outright, because `n > 1` was false
           whenever the price was 1). One resource at a time, because
           api.spend is all-or-nothing: a player who can afford the second Ore
           but not the second Credits pays the Ore and is told the rest is
           waived. */
        COST_RESOURCES.forEach(res=>{
          const n = paid[res] || 0;
          if(n <= 0) return;
          const got = api.spend(i, {[res]:n});
          note += (got === n
            ? `Toll: ${resName(res, n)} more. `
            : `Toll: cannot pay the extra ${resName(res, n)}, so it is waived. `);
        });
        if(site.main !== 'cards'){ api.spend(i, {[site.main]:1}); note += `-1 ${RES_LABEL[site.main]}.`; }
        if(!note) note = 'Toll: there was no Advanced cost to charge.';
      }
      break;
    }
    case 'free_advanced': {
      if(adv){
        /* Refund exactly what was taken. If nothing was taken — a free tier,
           or the consolation an Outpost owes a player who cannot pay — there
           is nothing to return, so there is nothing to claim. */
        if(costTotal(paid) > 0){
          api.grant(i, paid);
          note = `Open Hands: the ${costPhrase(paid)} Advanced cost is returned.`;
        } else {
          note = 'Open Hands: there was no Advanced cost to return.';
        }
      }
      break;
    }
    case 'contested_always': {
      setKey(api, state, 'riftContested', true);
      note = 'Contested.';
      break;
    }
    case 'cursed': {
      const before = num(state.players[i].troops);
      api.spend(i, {troops:1});
      const lost = before - num(state.players[i].troops);
      note = `Cursed: Basic effect only, and ${lost > 0 ? `1 Troop lost` : `no Troop to lose`}.`;
      break;
    }
  }
  if(note) api.log(`<b>The Rift mutates.</b> ${note}`);
}

/* The Rift is announced, never hidden: it goes in the log for the host
   and straight into a panel both seats can see. */
function revealRift(ctx){
  const state = ctx.state, api = ctx.api;
  api.log(riftSentence(state));
  api.log(`Nine sites on the board. Six picks. Three left cold.`);
  sound('turn.ping');
  flash('rgba(138, 90, 168, 0.30)', 460);
  shake('#board', 5, 400);
}

/* ========================= guest-side observation ====================== */

/* The online guest is a thin client: the engine never runs hooks there
   (canRunExtensions is false), so a guest would otherwise never see the
   Meltdown or the Surge. Panels ARE rendered on the guest, once per
   broadcast, so the panel render is the guest's change feed. Everything
   here is read-only and idempotent - it fires on a VALUE CHANGE, so
   re-rendering the same snapshot never re-fires anything. */
const observed = {meltdown:false, surge:null, rift:null};

function syncObserved(state){
  if(!state) return;
  const melt = !!state.meltdown;
  if(melt !== observed.meltdown){
    observed.meltdown = melt;
    if(melt) meltdownBeat();
  }
  const sr = state.surgeRolls;
  const key = (sr && Array.isArray(sr.values)) ? `r${sr.round}:${sr.values.join(',')}` : null;
  if(key !== observed.surge){
    observed.surge = key;
    if(key && sr) surgeReveal(state, sr.values);
  }
  const rk = (state.riftTarget && state.riftMut) ? `${state.riftTarget}:${state.riftMut}` : null;
  if(rk !== observed.rift){
    const wasNull = observed.rift === null;
    observed.rift = rk;
    if(rk && wasNull && !reduceMotion()) shake('#board', 4, 360);
  }
}

/* ================================ HOOKS ================================ */

function onGameStart(ctx){
  const state = ctx.state;
  clearTimers();
  observed.meltdown = false; observed.surge = null; observed.rift = null;
  /* Belt and braces: the literal in game.js already declares these, and
     a state that predates this feature (or a hand-built test state) must
     not read `undefined` here. */
  setKey(ctx.api, state, 'dread', num(state.dread));
  setKey(ctx.api, state, 'collapses', num(state.collapses));
  setKey(ctx.api, state, 'bounty', null);
  setKey(ctx.api, state, 'bountyIds', null);
  setKey(ctx.api, state, 'surgeRolls', null);
  setKey(ctx.api, state, 'riftTarget', null);
  setKey(ctx.api, state, 'riftMut', null);
  setKey(ctx.api, state, 'riftContested', false);
  ensureRoundRec(state, ctx.api);
}

function onRoundBegin(ctx){
  const state = ctx.state, api = ctx.api;
  ensureRoundRec(state, api);

  /* Dread is born in Round 3 already at 1, so three clean ticks land it on
     4 at the end of Round 5 - the guaranteed first Collapse, one round
     before Meltdown. Seeded on Round 3 EXACTLY: a Collapse resets Dread to
     0, and re-announcing "the sky closes" on the round after one would be
     a lie (and a second scary beat where none is warranted). */
  if(num(state.round) === DREAD_START_ROUND && num(state.dread) === 0 && num(state.collapses) < MAX_COLLAPSES){
    setKey(api, state, 'dread', 1);
    api.log(`<b>THE SKY CLOSES.</b> Pressure is on the board. Every round from here adds to it, a round with no Skirmish adds two, and at ${COLLAPSE_AT} the board collapses.`);
    sound('turn.ping');
  }
  if(num(state.round) >= RIFT_FROM_ROUND){
    if(!state.board) state.board = Object.create(null);
    state.board[RIFT_ID] = null;
    setKey(api, state, 'riftTarget', pick(SITE_IDS));
    setKey(api, state, 'riftMut', pick(MUTATIONS).id);
    setKey(api, state, 'riftContested', state.riftMut === 'contested_always');
    revealRift(ctx);
  } else {
    setKey(api, state, 'riftTarget', null);
    setKey(api, state, 'riftMut', null);
    setKey(api, state, 'riftContested', false);
  }

  publishBounty(ctx);

  if(num(state.round) === MELTDOWN_ROUND && !state.meltdown){
    setKey(api, state, 'meltdown', true);
    api.log(`<b>MELTDOWN &mdash; no cap, no retreat, no excuses.</b> Caps rise to Credits ${MELTDOWN_CAPS.credits} &middot; Ore ${MELTDOWN_CAPS.ore} &middot; Troops ${MELTDOWN_CAPS.troops}, every Advanced cost is waived, and holding the Garrison means you attack.`);
    rollSurge(ctx);
    /* Defensive re-clamp in case a Round Event or a feature pushed a
       player past the new ceiling before anything read it. */
    const caps = capOverrides(state);
    if(caps) state.players.forEach(p=>{
      ['credits','ore','troops'].forEach(res=>{ if(p[res] > caps[res]) p[res] = caps[res]; });
    });
  }
}

function onLocationResolved(ctx){
  const state = ctx.state, api = ctx.api;
  if(!state || num(ctx.playerIdx) < 0) return;
  const rec = ensureRoundRec(state, api);
  if(!rec) return;
  /* The Rift resolves as a copy of its target, so the hook sees the
     TARGET's id. The board still records the pick under `rift`, which is
     how the last entry is identified. */
  const picks = Array.isArray(rec.picks) ? rec.picks : [];
  const last = picks[picks.length-1];
  const isRift = !!(last && last.locId === RIFT_ID && last.playerIdx === ctx.playerIdx);
  const target = isRift ? state.riftTarget : ctx.locId;
  if(ctx.tier === 'advanced') rec.advanced[ctx.playerIdx]++;
  if(target === 'garrison') rec.garrison[ctx.playerIdx]++;
}

function onSkirmishResolved(ctx){
  const state = ctx.state, api = ctx.api;
  if(!state || num(ctx.playerIdx) < 0) return;
  const rec = ensureRoundRec(state, api);
  if(!rec) return;
  const res = ctx.result || {};
  rec.skirmishMargin = num(res.margin);
  const agg = num(ctx.playerIdx), def = (typeof ctx.defenderIdx === 'number') ? ctx.defenderIdx : -1;
  if(res.tie || !res.winnerName || !state.players[agg] || !state.players[def]) rec.skirmishWinner = -1;
  else rec.skirmishWinner = (state.players[agg].name === res.winnerName) ? agg : def;
}

function onGameEnd(ctx){
  /* Drop the pressure bookkeeping into the permanent record. The Meltdown
     itself is not undone - the caps revert by themselves once the round is
     over, because capOverrides() is a function of state.meltdown, which
     only ever changes inside a game. */
  const state = ctx.state, api = ctx.api;
  if(!state) return;
  clearTimers();
  if(num(state.collapses) > 0){
    api.log(`<b>FINAL TALLY &mdash; Pressure.</b> ${num(state.dread)} left on the board, ${num(state.collapses)} Collapse${num(state.collapses)===1?'':'s'} across the game.`);
  }
}

/* ================================ PANELS ============================== */

function registerPanels(){
  OD.Ext.panels.register('chaos-pressure', {
    label:'PRESSURE', order:10,
    render(ctx){
      /* The guest's change feed. First panel, so it runs before the rest
         of the panel pass on every render. */
      syncObserved(ctx && ctx.state);
      const state = ctx && ctx.state;
      if(!state) return '';
      if(num(state.collapses) >= MAX_COLLAPSES) return `<span style="color:var(--muted)">${pressureLine(state)} <span style="color:#b5502e">settled</span></span>`;
      if(num(state.round) < DREAD_START_ROUND) return `<span style="color:var(--muted)">quiet</span>`;
      return pressureLine(state);
    },
  });

  OD.Ext.panels.register('chaos-meltdown', {
    label:'MELTDOWN', order:20,
    render(ctx){
      const state = ctx && ctx.state;
      if(!state || !state.meltdown) return '';
      return `<span style="color:#b5502e;font-weight:700">NO CAP, NO RETREAT, NO EXCUSES.</span> ` +
        `<span style="color:var(--muted);font-size:12px">Caps Credits ${MELTDOWN_CAPS.credits} &middot; Ore ${MELTDOWN_CAPS.ore} &middot; Troops ${MELTDOWN_CAPS.troops}. Every Advanced cost is waived. Holding the Garrison means you attack. Surge: ` +
        (state.surgeRolls && Array.isArray(state.surgeRolls.values)
          ? state.surgeRolls.values.join(' and ')
          : 'pending') + ` straight to Influence.</span>`;
    },
  });

  OD.Ext.panels.register('chaos-bounty', {
    label:'BOUNTY', order:30,
    render(ctx){
      const state = ctx && ctx.state;
      const live = state && state.bounty;
      if(!live) return `<span style="color:var(--muted)">none standing</span>`;
      const def = BOUNTY_BY_ID[live.id];
      if(!def) return '';
      return `<b style="color:var(--gold)">${def.name}</b> <span style="color:var(--gold);font-weight:700">+${def.pays} Influence</span> ` +
        `<span style="color:var(--muted);font-size:12px">&mdash; ${def.text} Resolves at the end of Round ${num(live.round)}.</span>`;
    },
  });

  OD.Ext.panels.register('chaos-rift', {
    label:'RIFT', order:40,
    render(ctx){
      const state = ctx && ctx.state;
      if(!riftUnlocked(state)) return `<span style="color:var(--muted)">closed</span>`;
      const contested = state.riftContested ? ' <b style="color:#b5502e">CONTESTED</b>' : '';
      return `${riftSentence(state)}${contested} <span style="color:var(--muted);font-size:12px">9 sites, 6 picks.</span>`;
    },
  });
}

/* ================================= RULES ================================ */

const RULES_HTML = `
  <div class="rules-extra">
    <h3 class="rules-h">Meltdown &mdash; the last round</h3>
    <p><b>Round ${MELTDOWN_ROUND} only.</b> Caps rise to <b>Credits ${MELTDOWN_CAPS.credits} &middot; Ore ${MELTDOWN_CAPS.ore} &middot; Troops ${MELTDOWN_CAPS.troops}</b>, <b>every Advanced cost is waived</b>, and if you take the Garrison you <b>must attack</b> &mdash; holding back is not on the table.</p>
    <p><b>The Surge.</b> At the top of Round ${MELTDOWN_ROUND}, before the first pick, each player rolls 1d6 and adds the result <b>straight to Influence</b> (1&ndash;6). Same expected value for both: the round peaks on pure variance, at exactly the moment it should.</p>
  </div>
  <div class="rules-extra">
    <h3 class="rules-h">Pressure &mdash; the Dread clock</h3>
    <p>Pressure starts at 0 and rises from Round ${DREAD_START_ROUND}. At the end of every round from then on it goes up by <b>1</b>, and up by <b>2</b> if the round ended with <b>no Skirmish</b> &mdash; holding back is a tax you pay whether or not it works.</p>
    <p>At <b>${COLLAPSE_AT}</b> the sky opens: the player with <b>more Influence loses 2</b> (floored at 0) and the player with fewer <b>gains 2</b>. Pressure then resets. <b>${MAX_COLLAPSES} Collapses per game</b>, no more. On an Influence tie, the player with the <b>smaller pile</b> (Credits + Ore + Troops) counts as the leader and is the one that gets crushed.</p>
    <p>With a Skirmish every round this lands the first Collapse at the end of Round 5 &mdash; one round before Meltdown. Let a round go quiet and it can land a round earlier.</p>
  </div>
  <div class="rules-extra">
    <h3 class="rules-h">Bounties</h3>
    <p>Published at the start of Round 3 and Round 5, one live at a time, and resolved at the <b>end of the round it was published in</b>. <b>Exactly one</b> qualifier takes the Influence. Both qualify or neither does, and the pot stays cold.</p>
    <ul class="rules-inline-list">
      ${BOUNTIES.map(b=>`<li><b>${b.name}</b> (${b.pays}) &mdash; ${b.text}</li>`).join('')}
    </ul>
  </div>
  <div class="rules-extra">
    <h3 class="rules-h">The Rift</h3>
    <p>From Round 3 the board has <b>nine sites</b>. The ninth is the Rift, announced openly at the start of every round: one of the real eight sites, wearing one of six mutations. Picks stay <b>6 of 9</b>, so the round is the same length with one more thing to read.</p>
    <ul class="rules-inline-list">
      ${MUTATIONS.map(m=>`<li><b>${m.name}</b> &mdash; ${m.clause}.</li>`).join('')}
    </ul>
  </div>
`;

/* ================================ INSTALL =============================== */

let installed = false;

function install(){
  if(installed) return;
  if(!root.OD || !root.OD.Ext){ return; }   // ext.js must load first
  installed = true;
  const Ext = root.OD.Ext;
  /* Priorities matter inside the roundEnd hook: the Bounty is paid out
     first so a Collapse in the same breath cannot swallow it. */
  Ext.hooks.on('gameStart',         onGameStart,         {priority:  0});
  Ext.hooks.on('roundBegin',        onRoundBegin,        {priority:  0});
  Ext.hooks.on('locationResolved',  onLocationResolved,  {priority:  0});
  Ext.hooks.on('skirmishResolved',  onSkirmishResolved,  {priority:  0});
  Ext.hooks.on('roundEnd',          resolveBounty,       {priority: 10});
  Ext.hooks.on('roundEnd',          tickDread,           {priority:-5});
  Ext.hooks.on('gameEnd',           onGameEnd,           {priority:  0});
  registerPanels();
}

/* ---------------------------- engine surface ---------------------------- */
/* Everything game.js is allowed to call. Each one is defensive: a broken
   or absent feature must never throw into the engine. */
function safe(fn, fallback){ return function(){ try{ return fn.apply(null, arguments); }catch(_){ return fallback; } }; }

return Object.freeze({
  id:'chaos',
  install,
  RULES_HTML,

  /* game.js: applyCaps - the Meltdown ceiling */
  capOverrides: safe(capOverrides, null),
  /* game.js: canAffordExtra - the Meltdown waiver */
  advancedWaived: safe(advancedWaived, false),
  /* game.js: openLocations / humanPick - the ninth site */
  riftLoc: safe(riftLoc, null),
  /* game.js: applyLocationEffect - the mutation delta */
  applyRift: safe(applyRift, undefined),
  /* game.js: botChoosePick - the Bounty nudge */
  bountyMod: safe(bountyMod, 0),
  /* game.js: botWantsToAttack - the Dread nudge */
  dreadMod: safe(dreadMod, 0),

  /* Read-only introspection, exported for the integrator and the tests.
     `advancedCost` is the seam test/sites.test.js asserts against
     game.js's LOCATIONS — it deliberately resolves through OD.Board rather
     than carrying a price of its own, so the two can never disagree. */
  BOUNTIES, MUTATIONS, SITES,
  advancedCost: safe(advancedCostOf, null),
  costPhrase: safe(costPhrase, ''),
  MELTDOWN_CAPS, COLLAPSE_AT, MAX_COLLAPSES, RIFT_ID,
});

})();

root.OD = root.OD || {};
root.OD.Chaos = Chaos;
Chaos.install();

if (typeof module !== 'undefined' && module.exports) module.exports = { Chaos };

})(typeof globalThis !== 'undefined' ? globalThis : this);
