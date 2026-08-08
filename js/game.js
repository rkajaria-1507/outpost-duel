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
   sixteen meaningful choices on an eight-slot board. */
const LOCATIONS = [
  {id:'market',   name:'Market',
    basic:{label:'+3 Credits'},
    advanced:{label:'+6 Credits', cost:{ore:1}, note:'pay 1 Ore'}},
  {id:'quarry',   name:'Quarry',
    basic:{label:'+2 Ore, +1 Troop'},
    advanced:{label:'+4 Ore, +2 Troops', cost:{credits:1}, note:'pay 1 Credit'}},
  {id:'garrison', name:'Garrison',
    basic:{label:'+2 Troops, become Aggressor'},
    advanced:{label:'+4 Troops, Aggressor gets +1 combat', cost:{ore:1}, note:'pay 1 Ore'}},
  {id:'outpost',  name:'Outpost',
    basic:{label:'Pay 3 Credits + 2 Ore -> +4 Influence'},
    advanced:{label:'Pay 5 Credits + 3 Ore -> +7 Influence', cost:{}, note:'big investment'}},
  {id:'archive',  name:'Archive',
    basic:{label:'Draw 1 Tactic card'},
    advanced:{label:'Draw 3 Tactic cards', cost:{credits:1}, note:'pay 1 Credit'}},
  {id:'foundry',  name:'Foundry',
    basic:{label:'+2 Credits, +1 Ore'},
    advanced:{label:'+4 Credits, +3 Ore', cost:{troops:1}, note:'pay 1 Troop'}},
  {id:'bazaar',   name:'Bazaar',
    basic:{label:'Trade 2 Ore for 3 Credits'},
    advanced:{label:'Trade 2 Ore for 6 Credits', cost:{}, note:'needs 2 Ore'}},
  {id:'shrine',   name:'Shrine',
    basic:{label:'+1 Influence'},
    advanced:{label:'Pay 2 Credits + 1 Ore -> +3 Influence', cost:{}, note:'devotion rite'}},
];

const TOTAL_ROUNDS = 6;
const CAPS = {credits:8, ore:6, troops:6};
let BOT_TICK_MS = 500;

/* ------------------------------ Sound ------------------------------
   Tiny synthesized sound effects via Web Audio - no external asset files.
   Browsers block audio until a user gesture, so the AudioContext is only
   created/resumed lazily on first use (which always happens inside a
   click handler somewhere in this app). */
let audioCtx = null;
let soundOn = localStorage.getItem('od_sound') !== 'off';

function ensureAudioCtx(){
  if(!audioCtx){
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if(!Ctx) return null;
    audioCtx = new Ctx();
  }
  if(audioCtx.state==='suspended') audioCtx.resume();
  return audioCtx;
}

function beep(freq, durationMs, type, volume, delayMs){
  if(!soundOn) return;
  try{
    const ctx = ensureAudioCtx();
    if(!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    const startAt = ctx.currentTime + (delayMs||0)/1000;
    gain.gain.setValueAtTime(volume||0.12, startAt);
    gain.gain.exponentialRampToValueAtTime(0.001, startAt + durationMs/1000);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + durationMs/1000 + 0.03);
  }catch(e){ /* audio unavailable - fail silently, sound is cosmetic */ }
}

const sfx = {
  click: ()=> beep(520, 70, 'triangle', 0.12),
  diceTick: ()=> beep(260+Math.random()*140, 35, 'square', 0.05),
  diceSettle: ()=>{ beep(180,160,'sawtooth',0.18); beep(360,160,'sawtooth',0.12,50); },
  gain: ()=>{ beep(700,90,'sine',0.12); beep(950,120,'sine',0.09,60); },
  win: ()=> [523,659,784,1047].forEach((f,i)=> beep(f,190,'triangle',0.15,i*95)),
  lose: ()=> [392,330,262].forEach((f,i)=> beep(f,240,'sine',0.13,i*130)),
};

function setSoundUI(){
  [document.getElementById('soundToggle'), document.getElementById('soundToggleGame')].forEach(el=>{
    if(!el) return;
    el.textContent = `Sound: ${soundOn?'On':'Off'}`;
    el.classList.toggle('on', soundOn);
  });
}
function toggleSound(){
  soundOn = !soundOn;
  localStorage.setItem('od_sound', soundOn?'on':'off');
  ensureAudioCtx();
  setSoundUI();
  if(soundOn) sfx.click();
}

const INTRIGUE_PLAY_COST = 2;
const HAND_CAP = 5;

const RULES_HTML = `
  <p id="rules-objective"><b>Objective.</b> Play 6 rounds. Whoever has the most Influence at the end wins. Equal Influence is a draw.</p>

  <p><b>Setup.</b> Each player starts with 2 Credits, 1 Ore, 1 Troop, 0 Influence, and a personal deck of 14 different Tactic cards (shuffled). Resource caps apply at all times: Credits max 8, Ore max 6, Troops max 6 - anything above the cap is lost at the end of a round.</p>

  <p><b>Each round has four steps, in order:</b></p>
  <ol>
    <li><b>Draw.</b> Both players draw 2 Tactic cards from their own deck.</li>
    <li><b>Draft.</b> The 8 board sites are drafted one pick at a time, 3 picks per player (6 picks total), in snake order: first player, second player, second player, first player, first player, second player. Two sites always go unused each round, so deciding what to skip is a real decision. The player who drafts first alternates every round. Taking a site immediately resolves its action for either its Basic tier (free) or its Advanced tier (costs extra resources, bigger payoff) - see Board Sites below.</li>
    <li><b>Skirmish.</b> If a player took the Garrison this round, they become the Aggressor and may choose to attack the other player (the Defender). See Skirmish below. If nobody took the Garrison, this step is skipped.</li>
    <li><b>Upkeep.</b> Resources above the caps are discarded, and the next round begins.</li>
  </ol>

  <p id="rules-board"><b>Board Sites (Basic tier / Advanced tier):</b></p>
  <ul>
    <li><b>Market</b> - Basic: +3 Credits. Advanced (pay 1 Ore): +6 Credits.</li>
    <li><b>Quarry</b> - Basic: +2 Ore and +1 Troop. Advanced (pay 1 Credit): +4 Ore and +2 Troops.</li>
    <li><b>Garrison</b> - Basic: +2 Troops, become Aggressor this round. Advanced (pay 1 Ore): +4 Troops, become Aggressor with a permanent +1 bonus to your Skirmish total this round.</li>
    <li><b>Outpost</b> - Basic: pay 3 Credits + 2 Ore for +4 Influence (if you can't afford it, +1 Influence instead). Advanced: pay 5 Credits + 3 Ore for +7 Influence (if you can't afford it, +2 Influence instead).</li>
    <li><b>Archive</b> - Basic: draw 1 Tactic card. Advanced (pay 1 Credit): draw 3 Tactic cards.</li>
    <li><b>Foundry</b> - Basic: +2 Credits and +1 Ore. Advanced (pay 1 Troop): +4 Credits and +3 Ore.</li>
    <li><b>Bazaar</b> - Basic: trade 2 Ore for 3 Credits (if you don't have 2 Ore, +1 Credit instead). Advanced: trade 2 Ore for 6 Credits (if you don't have 2 Ore, +2 Credits instead).</li>
    <li><b>Shrine</b> - Basic: +1 Influence, free. Advanced: pay 2 Credits + 1 Ore for +3 Influence (if you can't afford it, +1 Influence instead).</li>
  </ul>

  <p id="rules-cards"><b>Tactic Cards.</b> Your 14-card deck has one of each card below, grouped into four categories. They are only played face-down as a Skirmish modifier, never outside a Skirmish, and your hand always displays grouped by category with each card's combat number shown up front. You start with a hand of ${HAND_CAP} cards and can never hold more than ${HAND_CAP} - the only way to draw more Tactic cards is to place a worker on the Archive (or a Round Event that draws them), so card draw is a real board choice.</p>
  <p><b>Aggressive</b> - raw combat power, usually at a cost:</p>
  <ul>
    <li><b>Ambush</b> - +2 combat. If you still lose the Skirmish, you lose 1 extra Troop.</li>
    <li><b>Overrun</b> - +3 combat. Costs 1 Ore to play; if you have none, it acts as +0 instead.</li>
    <li><b>Berserker</b> - +5 combat, the single biggest number in the deck. You lose 2 Troops regardless of whether you win or lose.</li>
    <li><b>Blitz</b> - +2 combat if you are the Aggressor this round, otherwise +0.</li>
    <li><b>Onslaught</b> - +4 combat. Costs 2 Credits to play; if you're short, it acts as +1 instead.</li>
    <li><b>Ambuscade</b> - +3 combat. If you win, your opponent loses 1 extra Troop on top of the Skirmish result.</li>
  </ul>
  <p><b>Defensive</b> - protect your position:</p>
  <ul>
    <li><b>Feint</b> - +0 combat. If you lose, your committed Troops are returned to you instead of being lost.</li>
    <li><b>Guard</b> - +1 combat. If you lose, reduce the winner's Influence gain from the margin by 1.</li>
    <li><b>Fortify</b> - +0 combat. Your committed Troops are always returned, whether you win or lose.</li>
  </ul>
  <p><b>Utility</b> - economy, information, and momentum:</p>
  <ul>
    <li><b>Rally</b> - +1 combat. If you win, gain 1 extra bonus Influence.</li>
    <li><b>Scout</b> - +1 combat. Draw 1 extra Tactic card after the Skirmish resolves.</li>
    <li><b>Undermine</b> - +0 combat to you, but subtracts 2 from your opponent's total instead - the only card that reaches across the table.</li>
    <li><b>Sabotage</b> - +1 combat. After the Skirmish resolves, your opponent discards one random card from their hand.</li>
    <li><b>Insight</b> - +2 combat. You draw 1 Tactic card after the Skirmish resolves, whether you win or lose.</li>
  </ul>
  <p><b>Chaos</b> - high variance, high ceiling:</p>
  <ul>
    <li><b>Wildcard</b> - the modifier equals a fresh 6-sided die roll (1 to 6) each time it is played.</li>
    <li><b>Desperate Gambit</b> - roll two 6-sided dice, the modifier equals the higher of the two - a bigger, more reliable swing than the Wildcard.</li>
  </ul>

  <p id="rules-skirmish"><b>Skirmish, step by step.</b></p>
  <ol>
    <li>The Aggressor decides whether to attack the Defender. Declining ends the round with no Skirmish.</li>
    <li>If attacking, the Aggressor commits any number of their own Troops (from 0 up to everything they have) and may play one Tactic card face-down as a modifier.</li>
    <li>The Defender does the same: commits any number of their Troops and may play one Tactic card face-down.</li>
    <li>Committed Troops are spent by both sides no matter who wins (unless a card effect says otherwise, such as Feint).</li>
    <li>Each side rolls one 6-sided die and adds: their committed Troops, their card's combat modifier, and (for the Aggressor only, if they took the Advanced Garrison this round) a further +1 bonus. If either side played Undermine, subtract 2 from the other side's total instead.</li>
    <li>Higher total wins. The winner gains Influence equal to the margin between the two totals, capped at 4 Influence. A tie means no Influence changes hands, but both sides still lose their committed Troops. Cards like Fortify, Berserker, Scout, and Sabotage apply their effect regardless of who wins.</li>
  </ol>

  <p id="rules-extras"><b>Objectives.</b> Each player is randomly dealt one Objective at the start of the game - visible to both sides in the HUD, so you can see exactly what your opponent is racing for (and decide whether to deny it to them). Fulfilling your Objective by the end of Round 6 grants a bonus to Influence on top of everything else, so the board fight is only half the game.</p>

  <p><b>Intrigue Cards.</b> A second, separate kind of card. Instead of a personal deck, both players draw from one shared pool - 1 card every round starting Round 2. Unlike Tactic cards (which are hidden and only played face-down in a Skirmish), an Intrigue card can be played face-up at any time on your own draft turn, as a free action that doesn't cost you a location pick, and it resolves immediately. They're not free, though: <b>playing one costs ${INTRIGUE_PLAY_COST} Credits</b>, so you're always weighing the effect against the spend. Effects: Raid (steal up to 2 Credits), Requisition (+2 Ore, +1 Credit), Coup (+3 Influence), Sabotage Supply (opponent loses 1 Troop), Foresight (draw 2 Tactic cards), Windfall (+3 Credits), Reinforce (+2 Troops), or Marketplace (trade 2 Ore for 4 Credits).</p>

  <p><b>Getting more complex as you go.</b> Round 1 is deliberately simple: only the Basic tier is available on the board, and there are no Intrigue cards or Round Events yet - just draft, resources, and (maybe) a Skirmish. The Advanced tier and Intrigue cards unlock from Round 2 onward, and Round Events start from Round 3. By the back half of the game you're juggling all of it at once - the ramp is intentional.</p>

  <p><b>Momentum.</b> Win two Skirmishes in a row and you gain Momentum: a +1 bonus added to your total in your next Skirmish. Losing or tying a Skirmish resets your streak back to zero, so a hot streak is powerful but fragile - and worth watching on your opponent's HUD.</p>

  <p><b>Leaders.</b> Each player is randomly dealt one persistent Leader ability at the start of the game, shown in the HUD: Merchant (+1 Credit from Market/Bazaar), Engineer (+1 Ore from Quarry/Foundry), Warmonger (+1 Troop from Garrison), Diplomat (+1 Influence from Shrine/Outpost), Scholar (+1 card from Archive), or Gambler (+1 to Wildcard and Desperate Gambit results). Knowing your opponent's Leader tells you which sites they'll be drawn to.</p>

  <p><b>Round Events.</b> A shared event is drawn fresh at the start of every round and applies equally to both players - shown under the Board heading. Windfall Round, Trade Winds, and Recruitment Drive hand out an immediate resource bump; Council Session hands out an extra Tactic card; Skirmish Fever raises the Skirmish Influence cap from 4 to 6 for the round; and a Quiet Round cancels the Skirmish entirely, no matter who holds the Garrison.</p>

  <p id="rules-modes"><b>Ways to play.</b> Same screen: two people share one device and take turns. Online: one person hosts a room and gets a short code, the other joins with that code to play from a separate device. Demo: both seats are bots and the game plays itself automatically at your choice of speed, optionally looping into a new game when one ends.</p>
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
    // Store only the id - the full definition (with its check function) can't
    // survive JSON.stringify over the online-play WebSocket relay, so it's
    // looked back up from the shared client-side OBJECTIVES array instead.
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
      drawCard(player, 2);
      log(`${player.name} plays <b>Foresight</b> -> draws 2 Tactic cards.`);
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
  applyCaps(player); applyCaps(opp);
  popupGain(playerIdx, `Intrigue: ${INTRIGUE_DEFS[cardId].name} (-${INTRIGUE_PLAY_COST})`, true);
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
   hidden-information plumbing over the network relay. */
const OBJECTIVES = [
  {id:'warlord',       name:'Warlord',       desc:'Win 3 or more Skirmishes.',                         bonus:4, check:p=> p.skirmishWins>=3},
  {id:'unscathed',     name:'Unscathed',     desc:'Fight at least one Skirmish and never lose one.',    bonus:4, check:p=> (p.skirmishWins+p.skirmishLosses)>0 && p.skirmishLosses===0},
  {id:'industrialist', name:'Industrialist', desc:'Take the Advanced tier 4 or more times.',            bonus:4, check:p=> p.advancedPicks>=4},
  {id:'financier',     name:'Financier',     desc:'End the game with 7 or more Credits.',               bonus:4, check:p=> p.credits>=7},
  {id:'prospector',    name:'Prospector',    desc:'End the game with 6 or more Ore.',                   bonus:4, check:p=> p.ore>=6},
  {id:'archivist',     name:'Archivist',     desc:'End the game with 5 or more cards in hand.',         bonus:4, check:p=> p.hand.length>=5},
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

function drawCard(player, n=1){
  for(let i=0;i<n;i++){
    if(player.hand.length >= HAND_CAP) return;
    if(player.deck.length===0){
      if(player.discard.length===0) return;
      player.deck = shuffle(player.discard);
      player.discard = [];
    }
    player.hand.push(player.deck.pop());
  }
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
    } else log(`<b>Your friend disconnected.</b>`);
  } else if(msg.type==='action'){
    handleHostIncomingAction(msg);
  }
}

function handleHostIncomingAction(msg){
  if(msg.kind==='pick'){
    const idx = currentPicker();
    if(idx===1 && state.phase==='draft' && state.board[msg.locId]===null){
      applyLocationEffect(1, msg.locId, msg.tier);
      advanceDraftOrSkirmish();
    }
  } else if(msg.kind==='skirmishDecision'){
    if(pendingGuestDecision){ const cb=pendingGuestDecision; pendingGuestDecision=null; cb(msg.attack); }
  } else if(msg.kind==='commit'){
    if(pendingGuestCommit){ const cb=pendingGuestCommit; pendingGuestCommit=null; cb(msg.troops, (msg.cardId===undefined?null:msg.cardId)); }
  } else if(msg.kind==='intrigue'){
    const idx = currentPicker();
    if(idx===1 && state.phase==='draft'){ playIntrigueCard(1, msg.cardId); }
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
      (attack)=> wsSend({type:'action', kind:'skirmishDecision', attack}));
  } else if(msg.type==='requestCommit'){
    showCommitModal(msg.playerName, msg.maxTroops, msg.hand,
      (troops, cardId)=> wsSend({type:'action', kind:'commit', troops, cardId}));
  } else if(msg.type==='peerLeft'){
    alert('The host disconnected.');
  }
}

function showSkirmishDecisionModal(aggressorName, defenderName, defenderTroops, defenderHandCount, onDecision){
  showModal("Skirmish Decision", `
    <p>${aggressorName}, you hold the Garrison. Attack ${defenderName}?</p>
    <p style="color:var(--muted);font-size:13px">Defender has ${defenderTroops} Troops, ${defenderHandCount} cards in hand.</p>
    <div class="footer-actions">
      <button class="secondary" id="skipAttack">Hold Back</button>
      <button id="doAttack">Attack!</button>
    </div>
  `);
  document.getElementById('skipAttack').onclick = ()=>{ hideModal(); onDecision(false); };
  document.getElementById('doAttack').onclick = ()=>{ hideModal(); onDecision(true); };
}

function showCommitModal(playerName, maxTroops, hand, onSubmit){
  let selectedCardId = null;
  const groups = groupHand(hand);
  const cardOptsHtml = groups.map(g=>`
    <div class="hand-group-label">${g.category}</div>
    <div class="hand-group-cards">
      ${g.cards.map(c=>{
        const def = CARD_DEFS[c];
        const powerLabel = def.mod===null ? '?' : `+${def.mod}`;
        return `<div class="opt" data-card="${c}">
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
    <p>Committing: <b id="troopVal">${Math.min(1,maxTroops)}</b> Troops</p>
    <p style="margin-top:10px">Optionally play one hidden Tactic card as a modifier:</p>
    <div class="card-select" id="cardSelect">${cardOptsHtml}</div>
    <div class="footer-actions">
      <button id="commitBtn">Commit</button>
    </div>
  `);

  const slider = document.getElementById('troopSlider');
  slider.oninput = ()=> document.getElementById('troopVal').textContent = slider.value;

  document.querySelectorAll('#cardSelect .opt').forEach(el=>{
    el.onclick = ()=>{
      const cardId = el.dataset.card;
      if(selectedCardId===cardId){ selectedCardId=null; el.classList.remove('selected'); }
      else {
        document.querySelectorAll('#cardSelect .opt').forEach(o=>o.classList.remove('selected'));
        selectedCardId = cardId; el.classList.add('selected');
      }
    };
  });

  document.getElementById('commitBtn').onclick = ()=>{
    const troops = Number(slider.value);
    const cardId = selectedCardId;
    hideModal();
    onSubmit(troops, cardId);
  };
}

/* ------------------------- Setup / round flow ------------------------- */

function startGame(){
  const mode = document.getElementById('gameMode').value;
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
  };

  state.players.forEach(p => drawCard(p, HAND_CAP));

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

  if(eventsUnlocked()){
    s.currentEvent = EVENTS[Math.floor(Math.random()*EVENTS.length)].id;
    const eventDef = getEvent();
    if(s.currentEvent==='windfall_round') s.players.forEach(p=>{ p.credits+=2; applyCaps(p); });
    if(s.currentEvent==='trade_winds') s.players.forEach(p=>{ p.ore+=1; applyCaps(p); });
    if(s.currentEvent==='recruitment_drive') s.players.forEach(p=>{ p.troops+=1; applyCaps(p); });
    if(s.currentEvent==='council_session') s.players.forEach(p=> drawCard(p,1));
  } else {
    s.currentEvent = null;
  }

  s.firstPlayerIdx = (s.round % 2 === 1) ? 0 : 1;
  const F = s.firstPlayerIdx, S = 1-F;
  s.pickQueue = [F,S,S,F,F,S]; // 3 picks each, snake order
  s.phase = 'draft';

  log(`<b>— Round ${s.round} begins —</b> ${s.players[s.firstPlayerIdx].name} drafts first.`);
  const eventDef = getEvent();
  if(eventDef) log(`Round Event: <b>${eventDef.name}</b> - ${eventDef.desc}`);
  else if(!advancedUnlocked()) log(`Basic tier only this round - Advanced tier unlocks Round 2.`);
  showRoundBanner(`Round ${s.round}`);
  stageBanner.lastRound = s.round;
  renderAll();
  maybeAutoPick();
}

function currentPicker(){
  return state.pickQueue.length ? state.pickQueue[0] : null;
}

function openLocations(){
  return LOCATIONS.filter(l => state.board[l.id] === null);
}

function canAffordExtra(loc, player){
  const cost = loc.advanced.cost || {};
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
      const score = val + noise;
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
  const leader = getLeader(player);

  switch(locId){
    case 'market': {
      const bonus = leader.id==='merchant' ? 1 : 0;
      const gain = (tier==='advanced' ? 6 : 3) + bonus;
      if(tier==='advanced') player.ore = Math.max(0, player.ore-1);
      player.credits += gain;
      log(`${player.name} works the <b>Market</b> (${tier}) -> +${gain} Credits${tier==='advanced'?' (paid 1 Ore)':''}${bonus?' (+1 Merchant)':''}.`);
      popupGain(playerIdx, `+${gain} Credits`, true);
      break;
    }
    case 'quarry': {
      const bonus = leader.id==='engineer' ? 1 : 0;
      const oreGain = (tier==='advanced'?4:2) + bonus, troopGain = tier==='advanced'?2:1;
      if(tier==='advanced') player.credits = Math.max(0, player.credits-1);
      player.ore += oreGain; player.troops += troopGain;
      log(`${player.name} works the <b>Quarry</b> (${tier}) -> +${oreGain} Ore, +${troopGain} Troops${tier==='advanced'?' (paid 1 Credit)':''}${bonus?' (+1 Engineer)':''}.`);
      popupGain(playerIdx, `+${oreGain} Ore, +${troopGain} Troops`, true);
      break;
    }
    case 'garrison': {
      const bonus = leader.id==='warmonger' ? 1 : 0;
      const troopGain = (tier==='advanced'?4:2) + bonus;
      if(tier==='advanced'){ player.ore = Math.max(0, player.ore-1); player.aggressorBonus=1; } else { player.aggressorBonus=0; }
      player.troops += troopGain; player.isAggressor = true;
      log(`${player.name} rallies the <b>Garrison</b> (${tier}) -> +${troopGain} Troops${bonus?' (+1 Warmonger)':''}. Aggressor this round${tier==='advanced'?' with +1 Skirmish bonus':''}.`);
      popupGain(playerIdx, `+${troopGain} Troops - Aggressor!`, true);
      break;
    }
    case 'outpost': {
      const bonus = leader.id==='diplomat' ? 1 : 0;
      const need = tier==='advanced' ? {credits:5,ore:3} : {credits:3,ore:2};
      const reward = (tier==='advanced' ? 7 : 4) + bonus;
      const consolation = (tier==='advanced' ? 2 : 1) + bonus;
      if(player.credits>=need.credits && player.ore>=need.ore){
        player.credits-=need.credits; player.ore-=need.ore; player.influence+=reward;
        log(`${player.name} invests in the <b>Outpost</b> (${tier}) -> pays ${need.credits} Credits + ${need.ore} Ore for +${reward} Influence${bonus?' (+1 Diplomat)':''}.`);
        popupGain(playerIdx, `+${reward} Influence`, true);
      } else {
        player.influence += consolation;
        log(`${player.name} eyes the <b>Outpost</b> (${tier}) but can't afford it -> consolation +${consolation} Influence${bonus?' (+1 Diplomat)':''}.`);
        popupGain(playerIdx, `+${consolation} Influence`, true);
      }
      break;
    }
    case 'archive': {
      const bonus = leader.id==='scholar' ? 1 : 0;
      const draws = (tier==='advanced' ? 3 : 1) + bonus;
      if(tier==='advanced') player.credits = Math.max(0, player.credits-1);
      drawCard(player, draws);
      log(`${player.name} studies the <b>Archive</b> (${tier}) -> draws ${draws} Tactic card${draws>1?'s':''}${tier==='advanced'?' (paid 1 Credit)':''}${bonus?' (+1 Scholar)':''}.`);
      popupGain(playerIdx, `+${draws} Card${draws>1?'s':''}`, true);
      break;
    }
    case 'foundry': {
      const bonus = leader.id==='engineer' ? 1 : 0;
      const crGain = tier==='advanced'?4:2, oreGain = (tier==='advanced'?3:1) + bonus;
      if(tier==='advanced') player.troops = Math.max(0, player.troops-1);
      player.credits += crGain; player.ore += oreGain;
      log(`${player.name} runs the <b>Foundry</b> (${tier}) -> +${crGain} Credits, +${oreGain} Ore${tier==='advanced'?' (paid 1 Troop)':''}${bonus?' (+1 Engineer)':''}.`);
      popupGain(playerIdx, `+${crGain} Credits, +${oreGain} Ore`, true);
      break;
    }
    case 'bazaar': {
      const bonus = leader.id==='merchant' ? 1 : 0;
      const crGain = (tier==='advanced'?6:3) + bonus;
      if(player.ore>=2){
        player.ore-=2; player.credits+=crGain;
        log(`${player.name} trades at the <b>Bazaar</b> (${tier}) -> trades 2 Ore for +${crGain} Credits${bonus?' (+1 Merchant)':''}.`);
        popupGain(playerIdx, `+${crGain} Credits`, true);
      } else {
        const consolation = (tier==='advanced'?2:1) + bonus;
        player.credits += consolation;
        log(`${player.name} visits the <b>Bazaar</b> (${tier}) without enough Ore -> consolation +${consolation} Credits${bonus?' (+1 Merchant)':''}.`);
        popupGain(playerIdx, `+${consolation} Credits`, true);
      }
      break;
    }
    case 'shrine': {
      const bonus = leader.id==='diplomat' ? 1 : 0;
      const reward = (tier==='advanced' ? 3 : 1) + bonus;
      if(tier==='advanced'){
        if(player.credits>=2 && player.ore>=1){
          player.credits-=2; player.ore-=1; player.influence+=reward;
          log(`${player.name} prays at the <b>Shrine</b> (advanced) -> pays 2 Credits + 1 Ore for +${reward} Influence${bonus?' (+1 Diplomat)':''}.`);
          popupGain(playerIdx, `+${reward} Influence`, true);
        } else {
          player.influence += 1 + bonus;
          log(`${player.name} can't afford the deep Shrine rite -> +${1+bonus} Influence instead${bonus?' (+1 Diplomat)':''}.`);
          popupGain(playerIdx, `+${1+bonus} Influence`, true);
        }
      } else {
        player.influence += reward;
        log(`${player.name} prays at the <b>Shrine</b> (basic) -> +${reward} Influence${bonus?' (+1 Diplomat)':''}.`);
        popupGain(playerIdx, `+${reward} Influence`, true);
      }
      break;
    }
  }
  applyCaps(player);
}

function applyCaps(player){
  player.credits = clamp(player.credits,0,CAPS.credits);
  player.ore = clamp(player.ore,0,CAPS.ore);
  player.troops = clamp(player.troops,0,CAPS.troops);
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

  const loc = LOCATIONS.find(l=>l.id===locId);
  if(tier==='advanced' && (!advancedUnlocked() || !canAffordExtra(loc, state.players[idx]))) return;

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
      applyLocationEffect(idx, pick.locId, pick.tier);
      advanceDraftOrSkirmish();
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

  if(aggressor.type==='bot'){
    const wantsAttack = botWantsToAttack(aggressor, defender);
    setTimeout(()=>{
      if(wantsAttack) startSkirmishCommit(aggressorIdx, defenderIdx);
      else { log(`${aggressor.name} holds back — no Skirmish this round.`); endRound(); }
    }, BOT_TICK_MS);
    return;
  }

  const decisionHandler = (attack)=>{
    if(attack) startSkirmishCommit(aggressorIdx, defenderIdx);
    else { log(`${aggressor.name} holds back — no Skirmish this round.`); endRound(); }
  };

  if(online.enabled && aggressorIdx!==online.myIndex){
    pendingGuestDecision = decisionHandler;
    wsSend({type:'requestSkirmishDecision', aggressorName:aggressor.name, defenderName:defender.name, defenderTroops:defender.troops, defenderHandCount:defender.hand.length});
    return;
  }

  showSkirmishDecisionModal(aggressor.name, defender.name, defender.troops, defender.hand.length, decisionHandler);
}

function botWantsToAttack(aggressor, defender){
  const aggression = {easy:0.5, normal:0.65, hard:0.8}[state.difficulty] ?? 0.65;
  const advantage = aggressor.troops - defender.troops;
  const chance = clamp(aggression + advantage*0.05, 0.15, 0.95);
  return Math.random() < chance;
}

let skirmishCtx = null;

function startSkirmishCommit(aggressorIdx, defenderIdx){
  state.phase = 'skirmish-commit';
  skirmishCtx = {aggressorIdx, defenderIdx, aggCommit:null, defCommit:null};
  collectCommit(aggressorIdx, ()=> collectCommit(defenderIdx, ()=> resolveSkirmish()));
}

function collectCommit(playerIdx, onDone){
  const player = state.players[playerIdx];
  const role = (playerIdx===skirmishCtx.aggressorIdx) ? 'aggCommit' : 'defCommit';

  if(player.type==='bot'){
    const troops = botChooseTroops(player);
    const cardIdx = botChooseCard(player);
    const card = cardIdx>=0 ? player.hand.splice(cardIdx,1)[0] : null;
    skirmishCtx[role] = {troops, card};
    player.troops -= troops;
    setTimeout(onDone, Math.max(60, BOT_TICK_MS*0.8));
    return;
  }

  const applyCommit = (troops, cardId)=>{
    const idx = cardId ? player.hand.indexOf(cardId) : -1;
    const card = idx>=0 ? player.hand.splice(idx,1)[0] : null;
    skirmishCtx[role] = {troops, card};
    player.troops -= troops;
    onDone();
  };

  if(online.enabled && playerIdx!==online.myIndex){
    pendingGuestCommit = applyCommit;
    wsSend({type:'requestCommit', role, playerName:player.name, maxTroops:player.troops, hand:player.hand});
    return;
  }

  showCommitModal(player.name, player.troops, player.hand, applyCommit);
}

function botChooseTroops(player){
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

  const aggMod = cardModifier(aggCommit, aggressor, true);
  const defMod = cardModifier(defCommit, defender, false);

  const aggRoll = rollD6();
  const defRoll = rollD6();
  const aggMomentum = aggressor.winStreak>=2 ? 1 : 0;
  const defMomentum = defender.winStreak>=2 ? 1 : 0;
  let aggTotal = aggRoll + aggCommit.troops + aggMod.mod + (aggressor.aggressorBonus||0) + aggMomentum;
  let defTotal = defRoll + defCommit.troops + defMod.mod + defMomentum;

  // Undermine subtracts from the OPPONENT's total - applied before the
  // reveal so the totals shown in the dice-roll animation are already final.
  let undermineNote = '';
  if(aggCommit.card==='undermine'){ defTotal -= 2; undermineNote += ` ${aggressor.name}'s Undermine saps ${defender.name} for -2.`; }
  if(defCommit.card==='undermine'){ aggTotal -= 2; undermineNote += ` ${defender.name}'s Undermine saps ${aggressor.name} for -2.`; }

  // Pre-compute the outcome so the result modal can spell it out clearly
  // (who won, by how much, and the Influence split) instead of only a log line.
  const isTie = aggTotal === defTotal;
  const aggWins = aggTotal > defTotal;
  const winnerName = isTie ? '' : (aggWins ? aggressor.name : defender.name);
  const loserName  = isTie ? '' : (aggWins ? defender.name : aggressor.name);
  let rawMargin = Math.abs(aggTotal - defTotal);
  const loserCard  = isTie ? null : (aggWins ? defCommit.card : aggCommit.card);
  if(loserCard === 'guard') rawMargin = Math.max(0, rawMargin - 1);
  const inflCap = state.currentEvent === 'skirmish_fever' ? 6 : 4;
  const influenceGained = isTie ? 0 : Math.min(rawMargin, inflCap);
  const winnerCard = isTie ? null : (aggWins ? aggCommit.card : defCommit.card);
  const rallyBonus = winnerCard === 'rally';
  const skirmishResult = {
    tie: isTie, winnerName, loserName, margin: rawMargin,
    influence: influenceGained, rally: rallyBonus,
    aggTotal, defTotal, aggName: aggressor.name, defName: defender.name
  };

  // The numbers are already locked in - the dice-roll animation is a
  // suspense/legibility beat, not a source of new information.
  animateDiceRoll(aggressor.name, defender.name, aggRoll, defRoll, aggTotal, defTotal,
    aggCommit.card ? CARD_DEFS[aggCommit.card].name : null,
    defCommit.card ? CARD_DEFS[defCommit.card].name : null,
    skirmishResult, ()=>{
    log(`<b>Skirmish!</b> ${aggressor.name} rolls ${aggRoll} + ${aggCommit.troops} troops${aggressor.aggressorBonus?` + 1 (Garrison bonus)`:''}${aggMomentum?` + 1 (Momentum)`:''}${aggMod.card?` + ${aggMod.card}(${aggMod.mod})${aggMod.note}`:''} = <b>${aggTotal}</b>. ` +
        `${defender.name} rolls ${defRoll} + ${defCommit.troops} troops${defMomentum?` + 1 (Momentum)`:''}${defMod.card?` + ${defMod.card}(${defMod.mod})${defMod.note}`:''} = <b>${defTotal}</b>.${undermineNote}`);

    if(aggCommit.card) aggressor.discard.push(aggCommit.card);
    if(defCommit.card) defender.discard.push(defCommit.card);

    if(aggTotal===defTotal){
      log(`It's a tie — both sides lose their committed Troops, no Influence changes.`);
      aggressor.winStreak = 0; defender.winStreak = 0;
    } else {
      const aggWins = aggTotal > defTotal;
      const winner = aggWins ? aggressor : defender;
      const loser = aggWins ? defender : aggressor;
      const loserCommit = aggWins ? defCommit : aggCommit;
      const winnerCommit = aggWins ? aggCommit : defCommit;
      winner.skirmishWins++; loser.skirmishLosses++;
      winner.winStreak++; loser.winStreak = 0;
      if(winner.winStreak===2) log(`${winner.name} has Momentum now - +1 to their next Skirmish total.`);
      let margin = Math.abs(aggTotal-defTotal);

      if(loserCommit.card==='guard') margin = Math.max(0, margin-1);

      const gained = Math.min(margin, state.currentEvent==='skirmish_fever' ? 6 : 4);
      winner.influence += gained;
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

      log(`<b>${winner.name} wins the Skirmish</b> by ${Math.abs(aggTotal-defTotal)} (margin ${margin} after modifiers) -> +${gained} Influence.`);
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
        drawCard(self,1);
        log(`${self.name}'s Scout draws an extra card.`);
      }
      if(commit.card==='sabotage' && opp.hand.length>0){
        const idx = Math.floor(Math.random()*opp.hand.length);
        const discarded = opp.hand.splice(idx,1)[0];
        opp.discard.push(discarded);
        log(`${self.name}'s Sabotage forces ${opp.name} to discard ${CARD_DEFS[discarded].name}.`);
      }
      if(commit.card==='insight'){
        drawCard(self,1);
        log(`${self.name}'s Insight draws them an extra card.`);
      }
    });

    applyCaps(aggressor); applyCaps(defender);
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
          `<div class="skirmish-detail">Won by a margin of <b>${result.margin}</b> &rarr; <b>+${result.influence} Influence</b>${result.rally ? ` <span class="skirmish-bonus">Rally +1</span>` : ''}.</div>` +
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

function endRound(){
  state.players.forEach(applyCaps);
  if(state.round >= TOTAL_ROUNDS){
    state.players.forEach(p=>{
      const obj = getObjective(p);
      if(obj && obj.check(p)){
        p.influence += obj.bonus;
        log(`${p.name} completes their objective <b>${obj.name}</b> -> +${obj.bonus} Influence.`);
      }
    });
    state.phase = 'ended';
    renderAll();
    showEndScreen();
  } else {
    state.round += 1;
    state.phase = 'draw';
    renderAll();
    beginRound();
  }
}

/* -------------------------------- Modal -------------------------------- */

/* dismissible:true adds a close (X) button plus backdrop-click / Escape
   support - used for informational modals like Rules. Decision modals
   (Skirmish attack/hold, troop commit) are NOT dismissible: they represent a
   choice the game needs to continue, so they're only closed by picking one
   of their own action buttons, same as before. */
function showModal(title, bodyHtml, opts={}){
  const dismissible = !!opts.dismissible;
  const modal = document.getElementById('skirmishModal');
  document.getElementById('skirmishTitle').textContent = title;
  document.getElementById('skirmishBody').innerHTML = bodyHtml;
  document.getElementById('modalCloseBtn').classList.toggle('hidden', !dismissible);
  modal.dataset.dismissible = dismissible ? '1' : '0';
  modal.classList.remove('hidden');
  modal.scrollTop = 0;
  document.getElementById('skirmishBody').scrollTop = 0;
}
function hideModal(){
  document.getElementById('skirmishModal').classList.add('hidden');
}
document.getElementById('modalCloseBtn').addEventListener('click', hideModal);
document.getElementById('skirmishModal').addEventListener('click', (e)=>{
  if(e.target.id==='skirmishModal' && e.currentTarget.dataset.dismissible==='1') hideModal();
});
document.addEventListener('keydown', (e)=>{
  const modal = document.getElementById('skirmishModal');
  if(e.key==='Escape' && !modal.classList.contains('hidden') && modal.dataset.dismissible==='1') hideModal();
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
  credits: '<svg width="14" height="14" viewBox="0 0 16 16" style="vertical-align:-2px;margin-right:4px"><circle cx="8" cy="8" r="6" fill="none" stroke="#c98a2b" stroke-width="2"/><text x="8" y="11" text-anchor="middle" fill="#c98a2b" font-size="8" font-weight="bold">$</text></svg>',
  ore: '<svg width="14" height="14" viewBox="0 0 16 16" style="vertical-align:-2px;margin-right:4px"><path d="M8 1 L14 5 L11.5 14 H4.5 L2 5 Z" fill="none" stroke="#6b7a4a" stroke-width="1.6"/></svg>',
  troops: '<svg width="14" height="14" viewBox="0 0 16 16" style="vertical-align:-2px;margin-right:4px"><path d="M8 1 L13 3.5 V8 C13 11.5 8 15 8 15 C8 15 3 11.5 3 8 V3.5 Z" fill="#b5502e"/></svg>',
  cards: '<svg width="14" height="14" viewBox="0 0 16 16" style="vertical-align:-2px;margin-right:4px"><rect x="3" y="2" width="10" height="12" rx="1.5" fill="none" stroke="#8a5aa8" stroke-width="1.6"/><line x1="6" y1="6" x2="10" y2="6" stroke="#8a5aa8" stroke-width="1.2"/><line x1="6" y1="9" x2="10" y2="9" stroke="#8a5aa8" stroke-width="1.2"/></svg>',
  influence: '<svg width="14" height="14" viewBox="0 0 16 16" style="vertical-align:-2px;margin-right:4px"><path d="M8 1 L9.5 6 H15 L10.5 9.2 L12 14.5 L8 11 L4 14.5 L5.5 9.2 L1 6 H6.5 Z" fill="#5a7a3a"/></svg>',
};
function icon(name){ return ICONS[name] || ''; }

const LOC_ICONS = {
  market:   {icon:'credits',   bg:'#f0ddc0'},
  bazaar:   {icon:'credits',   bg:'#f0ddc0'},
  quarry:   {icon:'ore',       bg:'#e4e6d4'},
  foundry:  {icon:'ore',       bg:'#e4e6d4'},
  garrison: {icon:'troops',    bg:'#f5d8c8'},
  outpost:  {icon:'influence', bg:'#f5dea0'},
  shrine:   {icon:'influence', bg:'#f5dea0'},
  archive:  {icon:'cards',     bg:'#ece0f5'},
};

/* -------------------------------- Render -------------------------------- */

function renderAll(){
  renderHud();
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

function renderInfluenceTrack(){
  const el = document.getElementById('influenceTrack');
  if(!el) return;
  const [p1,p2] = state.players;
  const maxScale = Math.max(20, p1.influence, p2.influence, 1) + 4;
  el.innerHTML = [p1,p2].map((p,i)=>`
    <div class="track-row">
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
        ${p.winStreak>=2?`<span class="pill momentum">Momentum +1</span>`:''}
      </div>
      ${leader?`<div class="objective-line">Leader: <b>${leader.name}</b> - ${leader.desc}</div>`:''}
      ${obj?`<div class="objective-line">Objective: <b>${obj.name}</b> - ${obj.desc} <span class="obj-status ${obj.check(p)?'met':''}">${obj.check(p)?'met':'not yet'}</span></div>`:''}
    </div>`;
  }).join('');
}

function renderBoard(){
  const el = document.getElementById('board');
  const activeIdx = currentPicker();
  const humanCanPick = online.enabled
    ? (state.phase==='draft' && activeIdx===online.myIndex)
    : (state.phase==='draft' && activeIdx!==null && state.players[activeIdx].type==='human');
  const actor = humanCanPick ? state.players[online.enabled?online.myIndex:activeIdx] : null;

  const newSnapshot = {};
  el.innerHTML = LOCATIONS.map(loc=>{
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
      const data = (pickable && !isTaken && !disabled) ? `data-loc="${loc.id}" data-tier="${tier}"` : '';
      const takenTag = isTaken ? `<span class="taken-tag p${(takenOwner+1)}">${state.players[takenOwner].name}</span>` : '';
      const noteEl = (!isTaken && note) ? `<span class="tier-note">${note}</span>` : '';
      return `<div class="${cls}" ${data}>`
        + `<span class="tier-tag">${tag}</span>`
        + `<span class="tier-label">${label}</span>`
        + noteEl + takenTag
        + `</div>`;
    }

    const tierRows = row('basic', loc.basic.label, '', takenBasic, basicDisabled, taken ? taken.owner : null)
      + row('advanced', loc.advanced.label, advUnlocked ? (advAffordable ? loc.advanced.note : 'cannot afford') : 'unlocks Round 2', takenAdvanced, advDisabled, taken ? taken.owner : null);

    const locIcon = LOC_ICONS[loc.id];

    return `
      <div class="loc ${pickable?'pickable':''}${taken?' loc-taken':''}${justTaken?' just-taken':''}" data-loc="${loc.id}">
        <div class="loc-icon" style="background:${locIcon.bg}">${icon(locIcon.icon)}</div>
        <h3>${loc.name}</h3>
        ${tierRows}
      </div>`;
  }).join('');
  prevBoardSnapshot = newSnapshot;

  if(humanCanPick){
    el.querySelectorAll('.tier-row[data-loc]').forEach(r=>{
      r.onclick = (e)=>{ e.stopPropagation(); sfx.click(); humanPick(r.dataset.loc, r.dataset.tier); };
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

function renderHand(){
  const el = document.getElementById('hand');
  let showIdx;
  if(online.enabled){
    showIdx = online.myIndex;
  } else {
    const activeIdx = currentPicker();
    const humanIdx = state.players.findIndex(p=>p.type==='human');
    showIdx = (state.phase==='draft' && activeIdx!==null && state.players[activeIdx].type==='human') ? activeIdx : (humanIdx>=0?humanIdx:0);
  }
  const player = state.players[showIdx];
  if(!player || (!online.enabled && player.type!=='human')){ el.innerHTML = '<span style="color:var(--muted)">No human player — sit back and watch the bots duel.</span>'; return; }

  const prevSeen = handRenderCache[showIdx] || new Set();
  const groups = groupHand(player.hand);
  handRenderCache[showIdx] = new Set(player.hand);

  el.innerHTML = `<div style="width:100%;color:var(--muted);font-size:12px;margin-bottom:6px">${player.name}'s hand:</div>` +
    (groups.length ? groups.map(g=>`
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
    if(!online.enabled || winnerIdx===online.myIndex) sfx.win();
    else sfx.lose();
  }

  function statRow(label, key, fmt){
    const v1 = fmt ? fmt(p1[key]) : p1[key];
    const v2 = fmt ? fmt(p2[key]) : p2[key];
    return `<tr><td>${label}</td><td>${v1}</td><td>${v2}</td></tr>`;
  }

  end.innerHTML = `
    <h1>${headline}</h1>
    <div class="row" style="justify-content:center">
      <div class="player-card p1"><div class="name">${p1.name}<span class="influence-badge">${p1.influence} Influence</span></div></div>
      <div class="player-card p2"><div class="name">${p2.name}<span class="influence-badge">${p2.influence} Influence</span></div></div>
    </div>
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
  `;
  document.getElementById('playAgain').onclick = ()=>{
    end.classList.add('hidden');
    if(online.ws){ online.ws.close(); online.ws = null; }
    online.enabled=false; online.isHost=false; online.guestReady=false; online.roomCode=null;
    document.getElementById('gameMode').value = 'local';
    updateModeUI();
    document.getElementById('setup').classList.remove('hidden');
  };

  if(state.demoLoop && !online.enabled){
    setTimeout(()=>{
      end.classList.add('hidden');
      startGame();
    }, 3000);
  }
}

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

const RULES_TABS = [
  {id:'rules-objective', label:'Overview'},
  {id:'rules-board',     label:'Board Sites'},
  {id:'rules-cards',     label:'Tactic Cards'},
  {id:'rules-skirmish',  label:'Skirmish'},
  {id:'rules-extras',    label:'Objectives & More'},
  {id:'rules-modes',     label:'Ways to Play'},
];
function openRulesModal(){
  const tabsHtml = `<div class="rules-tabs">${RULES_TABS.map(t=>
    `<button type="button" class="rules-tab" data-target="${t.id}">${t.label}</button>`).join('')}</div>`;
  showModal('Full Rules', tabsHtml + RULES_HTML, {dismissible:true});
  document.querySelectorAll('.rules-tab').forEach(btn=>{
    btn.onclick = ()=>{
      document.querySelectorAll('.rules-tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const target = document.getElementById(btn.dataset.target);
      if(target) target.scrollIntoView({behavior:'smooth', block:'start'});
    };
  });
}
document.getElementById('rulesBtn').addEventListener('click', openRulesModal);
document.getElementById('rulesBtnSetup').addEventListener('click', openRulesModal);

updateModeUI();
