/* ---------------------------------------------------------------------
   BALANCE SIMULATOR — the permanent instrument.

   WHAT THIS IS
   ------------
   A headless harness that drives the REAL engine (js/*.js, loaded in
   index.html order, no rules reimplemented here) through N simulated games
   and reports where every point of Influence came from, which site dominates,
   how much of the score the Skirmish system owns, whether each Objective is a
   real target, whether the three bot difficulties separate, and what happens
   to the winner when a named system is deleted.

   A throwaway version of this ran ~25,000 games and produced a rebalance
   (js/feature-wagers.js's header comment records what it cut). This file is
   that harness, kept, so the next engineer tunes against numbers instead of
   vibes - and so a reviewer can verify a rebalance did what it claimed.

       node test/balance.sim.js            full report + writes balance.baseline.json
       node test/balance.sim.js --check    seeded diff against the baseline (CI gate)

   WHY A MINI-DOM AT ALL
   --------------------
   game.js renders through document on almost every action, so there is no
   "just call the rules" path: the engine reads the DOM even to advance a
   phase. test/skirmish-odds.test.js already proved the pattern (fake document
   + a synchronous timer queue). This harness extends it in one direction: the
   fake element RECORDS the innerHTML it is given and answers the three
   selector queries the engine uses to bind its real controls, so a `human`
   seat can be driven through the genuine UI entry points - humanPick(),
   humanPlayIntrigue(), the Skirmish decision handler and the commit modal's
   applyCommit - instead of being faked with a second copy of the rules.

   WHAT THE HARNESS IS NOT
   ----------------------
   It does not change game behaviour. No js/ file is edited, no state key is
   invented (state must stay JSON-serialisable for the online relay), and the
   rules are never restated. Where a measurement needs a lever the engine does
   not expose, the limitation is reported instead of worked around by patching
   the engine - see "ENGINE SEAMS THE BRIEF ASSUMED" in the report.

   DETERMINISM
   -----------
   Math.random is replaced by a seeded PRNG (mulberry32) before the engine
   loads, so a given seed replays exactly. That is what makes `--check` a real
   gate: unchanged code + unchanged seed = byte-identical numbers, so a
   tolerance only has to cover a genuine rule change.
--------------------------------------------------------------------- */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'balance.baseline.json');

/* ==================================================================
   0. CONFIG
   ================================================================== */

/* Fixed by default on purpose. `--check` re-runs these exact numbers, so the
   seed and the game counts are part of the contract, not a convenience: change
   one and every recorded figure is a different sample.

   The counts are sized against wall-clock (a full report is ~3,000 real engine
   games, about a minute) and against sampling noise. Each one is justified in
   the tolerance table below; the objective block is the binding constraint,
   because six objectives dealt at random means the baseline's n per objective is
   games*2/6 - 300 games buys 100 player-games per objective, which is a Wilson
   half-width of about +-10 points. */
const DEFAULT_SEED = 20260903;
const DEFAULT_GAMES = 600;
const DEFAULT_IV_GAMES = 250;
const DEFAULT_SEAT_GAMES = 150;
const DEFAULT_DIFF_GAMES = 200;

/* ==================================================================
   1. SEEDED RNG  (installed before the engine loads)
   ================================================================== */

const REAL_RANDOM = Math.random;

function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rng = mulberry32(DEFAULT_SEED);
Math.random = function(){ return rng(); };

/* ==================================================================
   2. SYNCHRONOUS TIMER QUEUE
   The engine's whole round loop is setTimeout-driven (bot picks, the dice
   reveal, the round-debrief failsafe). Draining the queue is how one game
   runs to completion. clearTimeout also dequeues, so an armed-but-cancelled
   handle cannot fire into the next game.
   ================================================================== */

let timerQueue = [];
let timerSeq = 1;
const timerFns = new Map();

/* OD_SIM_TRACE=1 prints every timer this harness fires and the state it fired
   into. It exists because a deadlock in a synchronous timer queue is otherwise
   invisible: the game simply stops, and the only symptom is "phase is draft,
   not ended". With it, the last line printed before the stall is the call that
   armed nothing. */
const TRACE = !!process.env.OD_SIM_TRACE;
function trace(msg){
  if(!TRACE) return;
  try{ process.stdout.write('[trace] ' + msg + '\n'); }catch(_){ /* stdout may be gone */ }
}

globalThis.setTimeout = function(fn){
  const id = timerSeq++;
  timerFns.set(id, fn);
  timerQueue.push(id);
  if(TRACE) trace('arm   #' + id + ' (queue ' + timerQueue.length + ')');
  return id;
};
globalThis.clearTimeout = function(id){
  if(TRACE && timerFns.has(id)) trace('cancel #' + id);
  timerFns.delete(id);
  const i = timerQueue.indexOf(id);
  if(i >= 0) timerQueue.splice(i, 1);
};
globalThis.setInterval = function(){ return timerSeq++; };
globalThis.clearInterval = function(){};

/* `window` must exist BEFORE the requires: game.js publishes
   OD.WagersBridge under `typeof window !== 'undefined'`, and the Wagers
   feature is inert without it. `document` must NOT exist yet, so onDom()
   declines to wire the page at load time. */
globalThis.window = globalThis;
globalThis.addEventListener = function(){};
globalThis.removeEventListener = function(){};

/* ==================================================================
   3. MINIMAL DOM
   Enough of one for the engine's render path, plus just enough selector
   support for the three queries the engine uses to BIND real controls:
     #board        '.tier-row[data-loc]'   -> humanPick()
     #intrigueHand '.intrigue-play-btn'    -> humanPlayIntrigue()
     body          '#cardSelect .opt'      -> the commit modal's card choice
   Everything else answers [] / a detached element, which is what
   test/skirmish-odds.test.js proved safe over thousands of games.
   ================================================================== */

function makeClassList(){
  const set = new Set(['hidden']);
  return {
    _s:set,
    add(){ for(const c of arguments) set.add(c); },
    remove(){ for(const c of arguments) set.delete(c); },
    toggle(c, on){ if(on === undefined) on = !set.has(c); if(on) set.add(c); else set.delete(c); return on; },
    contains(c){ return set.has(c); },
  };
}

function makeStyle(){
  return {cssText:'', setProperty(){}, removeProperty(){}, getPropertyValue(){ return ''; }};
}

/* Ids discovered in the html most recently assigned to some element. This is
   the one DOM behaviour the harness cannot fake with a plain property, and
   getting it wrong is silently fatal.

   `innerHTML = ...` DESTROYS the element's descendants and builds new ones. The
   engine leans on that: showCommitModal() renders `<button id="commitBtn">` and
   then disables it on the first click, so the NEXT Skirmish must get a NEW
   button - a cached one is still `disabled`, has the old `onclick` closure over
   a spent `commitFired` latch, and the game deadlocks in `skirmish-commit` on
   the second fight of every game. The same applies to `#troopSlider`'s value,
   `#doAttack`/`#skipAttack`'s disabled state under MELTDOWN, and
   `#debriefNext`'s handler.

   So the setter registers one fresh element per `id="..."` in the new markup,
   retires the ids the previous markup owned, and DOC.getElementById prefers
   them over its cache. Children with no id (the board's tier rows, the Intrigue
   play buttons, the commit card options) are served by the selector engine
   above, which memoises on the html for the same reason. */
const fragEls = new Map();

/* Which containers are worth parsing for ids.

   Measured over a full bot-vs-bot game plus a hotseat game, the engine writes
   innerHTML into fourteen containers and publishes ids from exactly two of
   them: #skirmishBody (every modal - the commit slider and Commit button, the
   Attack/Hold Back pair, the dice reveal, the round debrief, the Quiet Round
   offer) and #endScreen. The other twelve are per-render repaints of #board,
   #log, #hand, the HUD cards and the Chaos panels, which carry no id at all.

   So fragments are registered only for those two, plus any anonymous element
   (createElement/querySelector results), which are rare and cheap. That skips
   ~1,500 fake elements per game and about a seventh of the wall clock, and it
   is self-checking in the way that matters: if a future edit ever puts a
   looked-up id into one of the other twelve, the control it belongs to stops
   existing and the game deadlocks in a phase - and the deadlock message names
   the phase and the state, so the cause is obvious rather than mysterious.
   OD_SIM_TRACE=1 prints every fragment publication, so the list can be
   re-measured rather than believed. */
const FRAG_OWNERS = new Set(['skirmishBody', 'endScreen']);

function registerFragment(owner, html){
  /* Retire whatever this owner used to own. */
  if(owner._fragIds){
    owner._fragIds.forEach(id=>{ if(fragEls.get(id) === owner._fragEls[id]) fragEls.delete(id); });
    owner._fragIds = null;
    owner._fragEls = null;
  }
  /* The ownership check comes FIRST, before even looking for an id: the twelve
     repaint containers are written ~960 times a game and a 2 KB substring scan
     on each of those is the single largest avoidable cost in the harness. */
  if(!FRAG_OWNERS.has(owner._id) && owner._id !== null) return;
  /* No ids means no work. */
  if(html.indexOf('id="') === -1 && html.indexOf("id='") === -1) return;
  const ids = [];
  const made = Object.create(null);
  parseTags(html).forEach(parsed=>{
    const id = parsed.attrs && parsed.attrs.id;
    if(!id || made[id]) return;
    const child = elementFromTag(parsed);
    /* A fresh element inherits nothing from the cache: `disabled` starts
       false, `value` starts empty, `onclick` is undefined. That is what makes
       the second Skirmish's Commit button live again. */
    made[id] = child;
    ids.push(id);
  });
  ids.forEach(id=>{ fragEls.set(id, made[id]); });
  owner._fragIds = ids;
  owner._fragEls = made;
  if(TRACE) trace('frag  ' + owner._id + ' published ' + ids.length + ' ids: ' + ids.join(','));
}

function makeElement(id){
  const attrs = Object.create(null);
  const el = {
    _id:id, _html:'',
    textContent:'', value:'', checked:false, disabled:false, isConnected:true,
    dataset:{}, className:'', scrollTop:0, scrollHeight:0, clientWidth:0, clientHeight:0,
    children:[], style:makeStyle(), classList:makeClassList(),
    setAttribute(k,v){ attrs[k] = String(v); },
    getAttribute(k){ return (k in attrs) ? attrs[k] : null; },
    hasAttribute(k){ return k in attrs; },
    removeAttribute(k){ delete attrs[k]; },
    remove(){}, focus(){}, blur(){}, click(){ if(typeof el.onclick === 'function') el.onclick(); },
    appendChild(c){ el.children.push(c); return c; }, append(){}, insertBefore(){},
    addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
    closest(){ return null; }, matches(){ return false; },
    contains(){ return false; }, removeChild(){}, insertAdjacentHTML(){},
    getBoundingClientRect(){ return {left:0, top:0, width:0, height:0}; },
    cloneNode(){ return makeElement(id); },
    querySelector(){ return makeElement(null); },
  };
  Object.defineProperty(el, 'innerHTML', {
    get(){ return el._html; },
    set(v){
      el._html = String(v == null ? '' : v);
      registerFragment(el, el._html);
    },
    enumerable:true,
  });
  el.querySelectorAll = function(sel){ return selectTags(el._html, sel); };
  return el;
}

/* --- the three-byte selector engine --------------------------------- */

const TAG_RE = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g;
const ATTR_RE = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/* Every element-looking tag in an HTML string, as {tag, classes, attrs}.
   Memoised on the string: renderAll() rewrites the same handful of containers
   dozens of times per game and a full game writes several hundred KB of markup
   in total, so re-parsing every byte of it was the single largest cost in the
   whole harness. The cache is bounded and dropped per game. */
const parseMemo = new Map();
function clearParseMemo(){ parseMemo.clear(); }

function parseTags(html){
  const src = String(html == null ? '' : html);
  const hit = parseMemo.get(src);
  if(hit) return hit;
  const out = [];
  let m;
  TAG_RE.lastIndex = 0;
  while((m = TAG_RE.exec(src)) !== null){
    const attrs = Object.create(null);
    let a;
    ATTR_RE.lastIndex = 0;
    while((a = ATTR_RE.exec(m[2] || '')) !== null){
      if(!a[1]) continue;
      attrs[a[1].toLowerCase()] = (a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : '')));
    }
    const classes = String(attrs['class'] || '').split(/\s+/).filter(Boolean);
    out.push({tag:m[1].toLowerCase(), classes, attrs});
    if(m[0].length === 0) TAG_RE.lastIndex++;   /* never spin */
  }
  if(parseMemo.size > 400) parseMemo.clear();
  parseMemo.set(src, out);
  return out;
}

function elementFromTag(parsed){
  const el = makeElement(null);
  for(const k in parsed.attrs){
    const v = parsed.attrs[k];
    if(k.indexOf('data-') === 0) el.dataset[k.slice(5)] = v;
    else el.setAttribute(k, v);
  }
  if(parsed.classes.length) el.classList = (function(classes){
    const cl = makeClassList();
    classes.forEach(c=>cl.add(c));
    return cl;
  })(parsed.classes);
  return el;
}

/* Compound selector: `tag`, `.class`, `#id`, `[attr]`, `[attr="v"]`. */
function matchCompound(parsed, compound){
  const spec = compound.trim();
  if(!spec) return false;
  const tagMatch = /^([a-zA-Z][\w-]*)/.exec(spec);
  if(tagMatch){
    if(parsed.tag !== tagMatch[1].toLowerCase()) return false;
    spec = spec.slice(tagMatch[0].length);
  }
  const parts = spec.match(/\.[\w-]+|#[\w-]+|\[[^\]]+\]/g) || [];
  for(const p of parts){
    if(p[0] === '.'){ if(parsed.classes.indexOf(p.slice(1)) === -1) return false; }
    else if(p[0] === '#'){ if(parsed.attrs['id'] !== p.slice(1)) return false; }
    else {
      const body = p.slice(1, -1);
      const eq = body.indexOf('=');
      if(eq === -1){ if(!(body.toLowerCase() in parsed.attrs)) return false; }
      else {
        const key = body.slice(0, eq).trim().toLowerCase();
        const want = body.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if(parsed.attrs[key] !== want) return false;
      }
    }
  }
  return parts.length > 0 || !!tagMatch;
}

/* Only the selectors the engine uses to bind a real control are answered.
   Everything else is [] - the long-proven behaviour.

   IDENTITY IS THE WHOLE POINT, and it is why this is memoised. The engine
   binds a handler on the elements ITS querySelectorAll returned
   (renderBoard -> r.onclick = go); a harness that then queries again has to
   get the SAME objects back or every onclick is undefined and the game
   deadlocks in the first draft. Keyed on (selector, html), so a re-render -
   which changes the html - correctly produces a fresh set, exactly as a real
   DOM would. */
const SUPPORTED = [
  {scope:'#board',        compounds:['.tier-row[data-loc]'],      needs:'data-loc='},
  {scope:'#intrigueHand', compounds:['.intrigue-play-btn'],      needs:'intrigue-play-btn'},
  {scope:'#skirmishBody', compounds:['#cardSelect .opt', '.opt'], needs:'cardSelect'},
];

const qaCache = new Map();
function clearQaCache(){ qaCache.clear(); }

function selectTags(html, sel){
  const want = String(sel == null ? '' : sel).trim();
  const rule = SUPPORTED.find(r => want === r.compounds[0] || want === r.compounds[1]);
  if(!rule) return [];
  const src = String(html == null ? '' : html);
  if(src.indexOf('<') === -1) return [];
  /* A container can only hold the answer if it holds the literal the answer is
     built from. renderBoard writes `data-loc=` only on a row that is actually
     clickable, so in a bot-vs-bot game the board markup never has one and the
     whole 9 KB parse is skipped on every render. Same shape for the Intrigue
     buttons and the commit modal's card options. */
  if(src.indexOf(rule.needs) === -1) return [];
  const key = want + ' ' + src;
  const hit = qaCache.get(key);
  if(hit) return hit;
  const compounds = rule.compounds.filter(c => c === want);
  const out = [];
  parseTags(src).forEach(parsed=>{
    for(const c of compounds){
      const bare = c.replace(/^#[\w-]+\s*/, '');
      if(matchCompound(parsed, bare)){ out.push(elementFromTag(parsed)); break; }
    }
  });
  /* Bounded: a full game re-renders the board on every action, and this cache
     is cleared per game anyway. */
  if(qaCache.size > 512) qaCache.clear();
  qaCache.set(key, out);
  return out;
}

/* --- document ------------------------------------------------------- */

/* Built here, PUBLISHED as `globalThis.document` only AFTER the engine has
   loaded (see section 4). That ordering is deliberate and is the pattern
   test/skirmish-odds.test.js proved: onDom() runs every block of page wiring
   at module load, so a `document` in scope while js/game.js is being required
   means the harness executes index.html's click wiring - which reads the setup
   screen, writes ARIA attributes and binds handlers this harness never wants.
   Declining to wire the page is not a limitation here; it is what makes the
   harness measure the RULES rather than the page. */
const SETUP = {};
function setupEl(over){ return Object.assign(makeElement(null), over); }

const domEls = new Map();
function el(id){ return DOC.getElementById(id); }

const DOC = {
  getElementById(id){
    if(SETUP[id]) return SETUP[id];
    /* A node that the last innerHTML assignment created wins over anything
       cached, because in a real document it is the only node with that id. */
    const frag = fragEls.get(id);
    if(frag) return frag;
    if(!domEls.has(id)) domEls.set(id, makeElement(id));
    return domEls.get(id);
  },
  createElement(tag){ return makeElement(null); },
  querySelector(){ return makeElement(null); },
  /* Only '#cardSelect .opt' is served document-wide; the rest stay []. */
  querySelectorAll(sel){
    if(String(sel).trim() !== '#cardSelect .opt') return [];
    return selectTags(el('skirmishBody') ? el('skirmishBody')._html : '', sel);
  },
  body:makeElement('body'),
  activeElement:null,
  addEventListener(){}, removeEventListener(){},
  documentElement:makeElement('html'),
};

/* Per-game DOM reset. Bindings (onclick, disabled, a spent one-shot latch) and
   the element identity they hang off both belong to the game that made them. */
function resetDom(){
  domEls.clear();
  fragEls.clear();
  clearQaCache();
  clearParseMemo();
}

/* ==================================================================
   4. ENGINE LOAD — index.html order, exactly as tools/check-scripts.js
   asserts. Read out of index.html rather than hardcoded, so the harness can
   never measure a different game than the page ships.
   ================================================================== */

const EXPECTED_ORDER = ['ext.js','audio.js','fx.js','rules.js','feature-wagers.js','feature-chaos.js','game.js'];

function scriptOrder(){
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const out = [];
  const re = /<script[^>]*\ssrc="js\/([^"]+)"/g;
  let m;
  while((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

const SCRIPTS = scriptOrder();
if(SCRIPTS.join(',') !== EXPECTED_ORDER.join(',')){
  throw new Error('balance.sim: index.html script order changed (' + SCRIPTS.join(',')
    + '). Expected ' + EXPECTED_ORDER.join(',') + '. The harness measures index.html\'s game.');
}

let Engine = null;
SCRIPTS.forEach(file=>{
  const mod = require(path.join(ROOT, 'js', file));
  if(file === 'game.js') Engine = mod;
});
if(!Engine) throw new Error('balance.sim: js/game.js exported nothing');

/* NOW the fake document goes in. The engine has loaded without it (so
   onDom() declined every block of page wiring) and will read it from here on
   - startGame() finds its setup fields, renderAll() paints into an element
   that throws nothing away. */
globalThis.document = DOC;

const TOTAL_ROUNDS = Engine.TOTAL_ROUNDS;
const OBJECTIVES = Engine.OBJECTIVES;
const SITE_IDS = Engine.LOCATIONS.map(l=>l.id);
const RIFT_ID = 'rift';
const ALL_SITES = SITE_IDS.concat([RIFT_ID]);

/* The brief listed this engine surface as available. It is worth recording
   which of those names actually leave the module: the ones that do not are
   the reason some counterfactuals are reachable only through hooks. */
const ASSUMED_SURFACE = ['startGame','beginRound','applyLocationEffect','advanceDraftOrSkirmish',
  'endRound','collectCommit','resolveSkirmish','humanPick','maybeAutoPick','botChoosePick',
  'botWantsToAttack','botChooseTroops','botChooseCard','getState'];
function surfaceReport(){
  return ASSUMED_SURFACE.map(name=>({name, exported: typeof Engine[name] === 'function'}));
}

/* ==================================================================
   5. ATTRIBUTION LEDGER
   Every Influence write in the build happens inside exactly one of these
   hook windows, and `mark()` diffs the two seats across each one:

     locationResolved  the 8 sites and the Rift  (a Rift pick reports the
                      TARGET site's id in ctx.locId - state.roundRec.picks
                      is what says the slot was `rift`)
     intriguePlayed    Coup, the only Intrigue card that pays Influence
     roundBegin        The Surge, and only the Surge
     roundEnd @+5      the Bounty   (feature-chaos resolves it at +10)
     roundEnd @-200    Collapse / the Pressure tick (tickDread runs at -5)
     skirmishResolved  the margin, Guard, Rally, Undermine
     gameEnd           the Objective payout

   Influence is never capped (applyCaps only touches credits/ore/troops), so
   no window can lose or invent a point: the ledger reconciles EXACTLY against
   the two seats' final totals. Anything left over lands in `unattributed`
   and fails the run.
   ================================================================== */

const SOURCES = ['surge','bounty','collapse','objective','intrigue','skirmish','rift']
  .concat(ALL_SITES.map(id=>'site:' + id));

function emptyLedger(){
  const bySource = Object.create(null);
  SOURCES.forEach(k=>{ bySource[k] = {points:0, events:0, gross:0, bySeat:[0,0]}; });
  bySource['unattributed'] = {points:0, events:0, gross:0, bySeat:[0,0]};
  return bySource;
}

function newRecord(seed, iv){
  return {
    seed, iv: iv || null,
    ledger: emptyLedger(),
    lastInf: [0, 0],
    lastTroops: [0, 0],
    /* economy */
    capDiscard:{credits:0, ore:0, troops:0, events:0},
    destroyedTroops:0,
    destroyedBySource:Object.create(null),
    drawsRefused:0,
    skirmishes:0, ties:0, maxStreak:0, gamesWithHotStreak:false, catchingUp:0,
    /* combat accounting: the margin actually converted into Influence */
    combatMargin:0, combatRally:0,
    /* how much each counterfactual removed, per system */
    combatRemoved:0, bountyRemoved:0, collapseRemoved:0, surgeRemoved:0,
    objectiveRemoved:0, riftRemoved:0,
    /* the driver's own counters, and the scratch the always-attack seat
       promotion needs. Kept here rather than assigned in playGame so a new
       field cannot be forgotten by the next engineer. */
    humanIntriguePlays:0, humanCommits:0, humanPicks:0,
    quietOffers:0, quietBreaks:0,
    forcedSeat:-1, humanDecisions:0,
    errors:[],
    /* per-game facts filled at the end */
    influence:[0,0], picks:Object.create(null), advancedPicks:Object.create(null),
    siteInfluence:Object.create(null),
    riftTargets:Object.create(null), finalPools:[{credits:0,ore:0,troops:0},{credits:0,ore:0,troops:0}],
objectiveMet:[false,false], objectiveId:[null,null], leaderIds:['?','?'],
    rounds:0, phase:'', surges:[0,0], objectiveBonus:[0,0], advancedTotal:[0,0],
    skirmishWins:[0,0], skirmishLosses:[0,0],
    seatTypes:['bot','bot'], collapses:0, skirmishRounds:0,
  };
}

/* The active record. null between games, which is what makes the permanently
   registered hooks inert outside a run. */
let rec = null;

function state(){ return Engine.getState(); }

/* Influence per seat, right now. */
function snapInf(){
  const st = state();
  return (st && st.players) ? [st.players[0].influence|0, st.players[1].influence|0] : [0,0];
}

/* Diff the two seats' Influence into `source`, and rebase the tracker onto the
   new totals. `source` must be a key of SOURCES or the delta lands in
   `unattributed` and fails the run - which is the point: a window that missed
   an Influence write has to be visible, not averaged away. */
function mark(source){
  const st = state();
  if(!st || !st.players) return [0,0];
  const now = snapInf();
  const delta = [now[0] - rec.lastInf[0], now[1] - rec.lastInf[1]];
  const ledger = rec.ledger;
  for(let i = 0; i < 2; i++){
if(delta[i] !== 0){
      const k = (source && ledger[source]) ? source : 'unattributed';
      ledger[k].points += delta[i];
      ledger[k].bySeat[i] += delta[i];
      ledger[k].events += 1;
      /* GROSS movement, because net can be a liar. The Collapse takes 2 from
         the leader and hands 2 to the trailer, so its net is exactly 0 and a
         share table would report it as "this system does nothing" when in fact
         it moved Influence on every Collapse it fired. `points` answers "where
         does the score come from"; `gross` answers "how much did this touch". */
      ledger[k].gross += Math.abs(delta[i]);
    }
    rec.lastInf[i] = now[i];
    /* Troops: a NEGATIVE delta is never a resource cap (applyCaps only ever
       trims an over-cap GAIN down to the ceiling), so every negative delta is
       a real unit destroyed and can be attributed to its window. */
    const tr = st.players[i].troops | 0;
    const td = tr - rec.lastTroops[i];
    if(td < 0){
      rec.destroyedTroops += -td;
      const k = source || 'unattributed';
      rec.destroyedBySource[k] = (rec.destroyedBySource[k] || 0) + (-td);
    }
    rec.lastTroops[i] = tr;
  }
  return delta;
}

/* Subtract Influence from a seat, never below 0, and report how much was
   actually removed. Used only by the counterfactual interventions. */
function clawBack(playerIdx, amount){
  const st = state();
  const p = st.players[playerIdx];
  if(!p || !(amount > 0)) return 0;
  const n = Math.min(p.influence, amount);
  p.influence -= n;
  return n;
}

/* "Delete a system" == that system pays ZERO Influence.
   `delta` is the per-seat movement the window just produced, measured by
   mark() before the claw-back, so this removes EXACTLY what the window paid
   and nothing else. Clamping at 0 is honest here and only here: a system that
   paid a point the player had already been clawed of cannot be clawed twice,
   and the shortfall is what `removed` reports.

   The second mark() then rebases the tracker, so the ledger nets the claw-back
   out against the same source and the per-game reconciliation still holds. */
function zeroWindow(delta, source){
  let removed = 0;
  for(let i = 0; i < 2; i++) removed += clawBack(i, delta[i] > 0 ? delta[i] : 0);
  mark(source);
  return removed;
}

/* Which board slot the pick that just resolved came from. The Rift resolves
   as a copy of its target, so ctx.locId is the TARGET; state.roundRec.picks
   is pushed before that rewrite and still says `rift`. */
function slotOf(ctx){
  const st = state();
  const rec2 = st && st.roundRec && Array.isArray(st.roundRec.picks) ? st.roundRec.picks : [];
  const last = rec2[rec2.length - 1];
  const isRift = !!(last && last.locId === RIFT_ID && last.playerIdx === ctx.playerIdx);
  return {slot: isRift ? RIFT_ID : ctx.locId, isRift: isRift, target: isRift ? st.riftTarget : null};
}

/* --- the hooks, registered once for the whole process ---------------- */

/* The unsubscribe handles are kept, and never used, on purpose: the harness is
   a process-lifetime instrument, `rec` is what makes every handler inert
   between games, and tearing the hooks down would only be possible by
   re-registering them - which is exactly the sort of thing that silently drops
   one. `installedHooks()` exists so a test can still see the count. */
const HOOK_UNSUBSCRIBE = [];

/* The intervention the current game is running under, or null. Hooks read it
   off `rec.iv`, which is null between games - that is what makes the whole
   counterfactual machinery inert for a baseline run. */
function iv(){ return rec ? rec.iv : null; }

/* The one lever the engine does not expose through a hook.
   botWantsToAttack() is module-private, so the only way to make the aggressor
   always attack is to make it not a bot for the length of the decision:
   promptAggressorDecision() branches on `aggressor.type`, and
   advanceDraftOrSkirmish() calls it the instant the sixth pick resolves. So
   the promotion is written from the LAST locationResolved of the round (the
   last hook before that call) and undone at skirmishBegin (the first hook
   after it), which leaves collectCommit on the bot's own card and troop
   policy. Round-begin and game-end undo it too, so a Quiet Round or a
   Garrison nobody drafted cannot leak a flipped seat into the next game.

   It is a player-field write, and it is the ONLY one in this file. It exists
   because the alternative - patching the engine - is not available to a
   measurement harness that promises not to touch the engine. */
function installHooks(){
  const H = OD.Ext.hooks;

  /* --- roundBegin: the board interventions, then the Surge -------------- */
  HOOK_UNSUBSCRIBE.push(H.on('roundBegin', (ctx)=>{
    restoreSeat();
    if(!rec) return;
    const v = iv();
    /* Behavioural interventions rewrite the board. beginRound() rebuilds
       state.board from LOCATIONS and chaos re-opens the Rift at priority 0,
       so the ban has to be written after both; {owner:-1,tier:'basic'} is the
       whole shape openLocations() reads. */
    if(v && typeof v.onRoundBeginLate === 'function') v.onRoundBeginLate(ctx);
    /* The Surge: chaos rolls it inside onRoundBegin (priority 0) and nothing
       else in this window touches Influence, so the window delta IS the
       Surge - a pure d6 grant, capped at nothing. */
    const delta = mark('surge');
    if(v && v.noSurge) rec.surgeRemoved += zeroWindow(delta, 'surge');
  }, {priority:-200}));

  /* --- locationResolved: the eight sites and the Rift ------------------- */
  HOOK_UNSUBSCRIBE.push(H.on('locationResolved', (ctx)=>{
    if(!rec) return;
    const info = slotOf(ctx);
    const v = iv();
    if(info.isRift) rec.riftTargets[state().riftTarget] = (rec.riftTargets[state().riftTarget] || 0) + 1;
    const delta = mark(info.slot === RIFT_ID ? 'rift' : ('site:' + info.slot));
    /* "The Rift pays 0 Influence": the slot's whole movement goes back, which
       is the target site's own payout plus the mutation's. That is the honest
       reading of "delete the Rift from scoring" - the ninth tile stops
       scoring, it does not stop being drafted. */
    if(info.isRift && v && v.noRiftInfluence) rec.riftRemoved += zeroWindow(delta, 'rift');
    if(v && typeof v.onLocationResolved === 'function') v.onLocationResolved(ctx, info, delta);
    /* always-attack: the pick queue is already shifted, so an empty queue
       means the draft is over and advanceDraftOrSkirmish() is next. */
    if(v && v.alwaysAttack){
      const st = state();
      if(st.pickQueue.length === 0 && st.currentEvent !== 'quiet_round'){
        const agg = st.players.findIndex(p=>p.isAggressor);
        if(agg >= 0) promoteSeat(agg);
      }
    }
  }, {priority:200}));

  HOOK_UNSUBSCRIBE.push(H.on('intriguePlayed', ()=>{
    if(!rec) return;
    /* Coup is the only Intrigue card that pays Influence, and it pays inside
       playIntrigueCard before this hook fires, so the window delta is exactly
       it. The other cards log nothing here and move nothing. */
    const delta = mark('intrigue');
    const v = iv();
    if(v && v.noIntrigue) rec.intrigueRemoved = (rec.intrigueRemoved || 0) + zeroWindow(delta, 'intrigue');
  }, {priority:200}));

  /* --- skirmishBegin: undo the always-attack seat promotion ------------ */
  HOOK_UNSUBSCRIBE.push(H.on('skirmishBegin', ()=>{
    if(!rec) return;
    /* The promotion exists only to reach promptAggressorDecision, which reads
       `aggressor.type`. By the time this fires the decision is in and
       collectCommit is next, so putting the seat back here keeps the COMMIT
       on the bot's own policy - "always attack", not "attack the way a greedy
       scripted player would". */
    restoreSeat();
  }, {priority:0}));

  /* --- skirmishResolved: the margin, Guard, Rally, Undermine ------------- */
HOOK_UNSUBSCRIBE.push(H.on('skirmishResolved', (ctx)=>{
    if(!rec) return;
    rec.skirmishes += 1;
    const res = ctx.result || {};
    if(res.tie) rec.ties += 1;
    /* The Fury ladder's reach, and therefore whether the Catching Up valve
       (which only fires against a 3+ streak) has anything to fire against.
       Sampled here because this hook runs after the winner's streak has been
       incremented and before the next fight can change it. */
    const st0 = state();
    st0.players.forEach(p=>{
      const s = p.winStreak|0;
      if(s > rec.maxStreak) rec.maxStreak = s;
      if(s >= 3) rec.gamesWithHotStreak = true;
    });
    if(res.influence > 0){
      rec.combatMargin += res.influence;
      if(res.rally) rec.combatRally += 1;
    }
    const delta = mark('skirmish');
    const v = iv();
    /* "Delete the Skirmish system" = it pays zero Influence. The margin and
       the Rally bonus are the whole of it - All In / Ghost were cut from the
       build, so settleWagers no longer exists (see the systems probe). */
    if(v && v.noCombat) rec.combatRemoved += zeroWindow(delta, 'skirmish');
    if(v && typeof v.onSkirmishResolved === 'function') v.onSkirmishResolved(ctx);
  }, {priority:200}));

  /* --- roundEnd: the Bounty at 6, then Collapse at -6 ------------------ */
  /* feature-chaos registers resolveBounty at +10 and tickDread at -5. The two
     windows the harness attributes therefore bracket each of those exactly:
     6 sits between them (Bounty only) and -6 sits just below the tick
     (Pressure/Collapse only). Nothing in between touches Influence. */
  HOOK_UNSUBSCRIBE.push(H.on('roundEnd', ()=>{
    if(!rec) return;
    const delta = mark('bounty');
    const v = iv();
    if(v && v.noBounty) rec.bountyRemoved += zeroWindow(delta, 'bounty');
  }, {priority:6}));

  HOOK_UNSUBSCRIBE.push(H.on('roundEnd', ()=>{
    if(!rec) return;
    const delta = mark('collapse');
    const v = iv();
    /* Collapse moves Influence BETWEEN the seats - the leader -2 (floored at
       0), the trailer +2 - so zeroWindow's per-seat sign handling takes the
       gain back and leaves the loss, which is exactly "the Collapse neither
       pays nor costs anyone". */
    if(v && v.noCollapse) rec.collapseRemoved += zeroWindow(delta, 'collapse');
  }, {priority:-6}));

  HOOK_UNSUBSCRIBE.push(H.on('gameEnd', ()=>{
    if(!rec) return;
    /* The objective payout happens immediately before this hook is run, so the
       window delta is exactly the bonus that was paid. */
    const delta = mark('objective');
    const v = iv();
    if(v && v.noObjectives) rec.objectiveRemoved += zeroWindow(delta, 'objective');
    /* A game can end without a Skirmish ever being fought (every Garrison
       drafted late or a Quiet Round), so close the last open window: anything
       still unattributed at gameEnd is a bug in the window list above, and
       finishRecord's reconciliation is what catches it. */
    mark('objective');
    restoreSeat();
  }, {priority:200}));
}

/* The always-attack promotion. See promoteSeat(). */
function promoteSeat(idx){
  if(!rec || rec.forcedSeat >= 0) return;
  const st = state();
  const p = st.players[idx];
  if(!p || p.type === 'human') return;
  rec.forcedSeat = idx;
  p.type = 'human';
}
function restoreSeat(){
  if(!rec || rec.forcedSeat < 0) return;
  const st = state();
  const p = st.players[rec.forcedSeat];
  if(p) p.type = p.origType || 'bot';
  rec.forcedSeat = -1;
}

/* ==================================================================
   6. INTERVENTIONS — the pluggable "what if" list
   Each entry is a named object; the next engineer adds one by appending a
   literal here. Nothing else in the file needs to change.

   Two kinds, and the difference matters:
     * behavioural - the board or the policy changes (a banned site, a forced
       attack). This is a genuinely different game.
     * deletion    - a named system pays ZERO Influence. The game still runs
       and still decides, so "would the same player have won?" is a real
       question. It is NOT the same as deleting the code, and the report says
       so.
   ================================================================== */

/* Take a site off the board for one game.
   beginRound() rebuilds state.board from LOCATIONS and feature-chaos re-opens
   the Rift at priority 0, so the ban has to be written after both - hence the
   roundBegin handler that calls this.

   The entry is written TRUTHY rather than deleted, because both readers insist
   on it. openLocations() filters `board[id] === null`, so `undefined` would also
   remove it from the draft - but OD.Chaos.riftLoc() closes on
   `if(state.board.rift)`, so a deleted Rift slot would simply re-open. A truthy
   `{owner, tier}` closes both. The value is deliberately a shape both readers
   accept rather than a new key the engine has never heard of: no state key is
   invented, nothing crosses the wire format, and the rule the harness is
   measuring ("nobody can draft this site") is exactly the rule that lands.

   Honest limitation, and it is only ever a limitation of the VISUALS: the tile
   is still drawn, and renderBoard will attribute it to a player. These
   counterfactuals run bot-vs-bot, where no tile is clickable anyway, and what
   is being measured is Influence, not the board's appearance. */
function boardBan(siteId){
  return function onRoundBeginLate(ctx){
    const st = ctx.state;
    if(!st || !st.board) return;
    /* The Rift only exists from Round 3; closing it before that is a no-op. */
    if(siteId === RIFT_ID){
      if(st.round >= 3) st.board[RIFT_ID] = {owner:0, tier:'blocked'};
      return;
    }
    st.board[siteId] = {owner:0, tier:'blocked'};
  };
}

const INTERVENTIONS = [
  {id:'none', label:'baseline (no intervention)', deletable:false},

  /* ---- "delete a system": it pays ZERO Influence ---------------------- */
  {id:'no-combat', label:'Skirmish system pays 0 Influence', deletable:true,
    noCombat:true},

  {id:'no-objectives', label:'Objectives pay 0 Influence', deletable:true,
    noObjectives:true},

  {id:'no-bounty', label:'Bounties pay 0 Influence', deletable:true,
    noBounty:true},

  {id:'no-collapse', label:'Collapse pays 0 Influence', deletable:true,
    noCollapse:true},

  {id:'no-surge', label:'The Surge pays 0 Influence', deletable:true,
    noSurge:true},

  {id:'no-rift-influence', label:'The Rift pays 0 Influence', deletable:true,
    noRiftInfluence:true},

  {id:'no-intrigue', label:'the Coup Intrigue card pays 0 Influence', deletable:true,
    noIntrigue:true},

  /* ---- behavioural: the board or the policy changes -------------------- */
  {id:'ban-outpost', label:'Outpost removed from the board', deletable:false,
    onRoundBeginLate: boardBan('outpost')},

  {id:'ban-shrine', label:'Shrine removed from the board', deletable:false,
    onRoundBeginLate: boardBan('shrine')},

  {id:'ban-garrison', label:'Garrison removed (no Skirmish possible)', deletable:false,
    onRoundBeginLate: boardBan('garrison')},

  {id:'ban-rift', label:'The Rift never opens', deletable:false,
    onRoundBeginLate: boardBan(RIFT_ID)},

  {id:'always-attack', label:'the aggressor always attacks', deletable:false,
    alwaysAttack:true},
];

const BY_ID = new Map(INTERVENTIONS.map(iv2=>[iv2.id, iv2]));
function intervention(id){
  const v = BY_ID.get(id);
  if(!v) throw new Error('balance.sim: no intervention called "' + id + '". Known: '
    + INTERVENTIONS.map(x=>x.id).join(', '));
  return v;
}

/* ADDING ONE. The next engineer appends a literal to INTERVENTIONS and reads
   it off `rec.iv` in one of the hook windows above. Two kinds:

     * a boolean flag the windows already test (noCombat, noBounty, ...)
       - zero new wiring;
     * a function the window calls at a known point
       (onRoundBeginLate(ctx) after feature-chaos has built the board,
        onLocationResolved(ctx, info, delta) after the site's own effect and
        the Rift mutation have been applied and before anything else,
        onSkirmishResolved(ctx) after the fight settles)
       - pick the window whose timing matches what you want to change, and
       remember that the seat-promotion helper (promoteSeat/restoreSeat) is
       the only sanctioned way to reach a private bot decision.

   Nothing in the engine is edited, no state key is invented, and a new entry
   cannot make a run silently meaningless: `deletable:true` marks the entries
   that are quotable as a "delete a system" counterfactual, and the report only
   prints those in the delete table. */

/* ==================================================================
   7. THE SCRIPTED HUMAN
   A deliberately plain greedy policy. It is a PLAYER, not a rule: nothing
   here knows what the game means, only what a person who reads the tile
   labels would do. It exists so `human/bot` seat types run through the real
   humanPick() / humanPlayIntrigue() / commit-modal paths instead of being
   simulated by a second copy of the engine's decisions.
   ================================================================== */

const HUMAN_VALUE = {
  outpost:3.0, shrine:2.2, garrison:1.4, quarry:1.6, market:1.5,
  foundry:1.5, bazaar:1.3, archive:1.0, rift:1.2,
};
const HUMAN_NOISE = 0.35;
const HUMAN_ATTACK_P = 0.7;
const HUMAN_CARD_P = 0.6;
const HUMAN_INTRIGUE_P = 0.5;

function pickHumanSite(rec2){
  const st = state();
  const idx = st.pickQueue.length ? st.pickQueue[0] : null;
  if(idx === null || st.phase !== 'draft') return false;
  if(st.players[idx].type !== 'human') return false;
  const board = el('board');
  if(!board) return false;
  const rows = board.querySelectorAll('.tier-row[data-loc]').filter(r=>typeof r.onclick === 'function');
  if(!rows.length) return false;

  /* A free Intrigue play is a real option on your turn. Play at most one per
     pick so the turn cannot loop forever. The synthetic click coordinates are
     spaced well outside humanPlayIntrigue's 24px latch slop, and the hand
     length is checked afterwards: a press the engine's own D5 latch swallowed
     must fall through to a site pick rather than report an action that never
     happened (which the stall detector would then turn into a failed game). */
  const hand = el('intrigueHand');
  if(hand){
    const btns = hand.querySelectorAll('.intrigue-play-btn').filter(b=>typeof b.onclick === 'function');
    if(btns.length && st.players[idx].credits >= 2 && rng() < HUMAN_INTRIGUE_P){
      const b = btns[Math.floor(rng() * btns.length)];
      const before = st.players[idx].intrigueHand.length;
      rec2.humanIntriguePlays += 1;
      b.onclick({clientX: 4000 + rec2.humanIntriguePlays * 137, clientY: 9000});
      if(st.players[idx].intrigueHand.length < before) return true;
    }
  }

  let best = null, bestScore = -Infinity;
  rows.forEach(r=>{
    const locId = r.dataset.loc, tier = r.dataset.tier;
    const base = HUMAN_VALUE[locId] != null ? HUMAN_VALUE[locId] : 1.0;
    const val = (tier === 'advanced' ? base * 1.6 : base) + (rng() * 2 - 1) * HUMAN_NOISE;
    if(val > bestScore){ bestScore = val; best = r; }
  });
  if(!best) return false;
  rec2.humanPicks += 1;
  best.onclick();
  return true;
}

function serviceHumanCommit(rec2){
  const st = state();
  if(st.phase !== 'skirmish-commit') return false;
  const btn = el('commitBtn');
  if(!btn || typeof btn.onclick !== 'function' || btn.disabled) return false;
  /* collectCommit() writes state.lastActiveIdx before opening the modal, so
     that is the seat this #commitBtn belongs to - not "the aggressor", which
     is the seat that committed FIRST and is already on the dice. */
  const seat = (typeof st.lastActiveIdx === 'number' && st.lastActiveIdx >= 0) ? st.lastActiveIdx : 0;
  const hold = Math.max(0, st.players[seat].troops | 0);
  const slider = el('troopSlider');
  const max = Math.max(0, parseInt(slider && slider.value, 10) || 0);
  /* Commit between 30% and 75% of the pool - a plain middle-of-the-road
     player, and clamped to the slider's own range so the modal's readout
     cannot disagree with what is submitted. */
  const troops = Math.max(0, Math.min(max, Math.round(hold * (0.30 + rng() * 0.45))));
  if(slider) slider.value = String(troops);
  if(rng() < HUMAN_CARD_P){
    const opts = document.querySelectorAll('#cardSelect .opt').filter(o=>typeof o.onclick === 'function');
    if(opts.length){
      const o = opts[Math.floor(rng() * opts.length)];
      o.onclick();
    }
  }
  rec2.humanCommits += 1;
  btn.onclick();
  return true;
}

function serviceHumanDecision(rec2, forceAttack){
  const st = state();
  if(st.phase !== 'skirmish-decide') return false;
  const atk = el('doAttack'), hold = el('skipAttack');
  if(!atk || typeof atk.onclick !== 'function') return false;
  const agg = st.players.findIndex(p=>p.isAggressor);
  const realHuman = agg >= 0 && st.players[agg].origType === 'human';
  const attack = forceAttack ? true : (realHuman ? rng() < HUMAN_ATTACK_P : true);
  if(attack) atk.onclick();
  else if(hold && typeof hold.onclick === 'function' && !hold.disabled) hold.onclick();
  else atk.onclick();
  rec2.humanDecisions += 1;
  return true;
}

/* The Quiet Round offer. This is the ONE modal in the whole game that waits
   for a click with no failsafe timer behind it: when the human aggressor holds
   Betrayal tokens, feature-wagers asks whether to spend one to force the fight
   through, and the engine's advanceDraftOrSkirmish() returns without ending the
   round until the answer arrives. Left unanswered, the game deadlocks in the
   draft with an empty pick queue - which is exactly the symptom the deadlock
   detector reported.

   The scripted human answers it, because it is a real decision a person makes.
   It breaks the silence half the time: the engine's own bot rule
   (botWantsQuietBreak) is module-private and not restated here, so the
   harness's own plain appetite is used and the number of offers is reported,
   so a reader can see how much of the run it touched. */
const HUMAN_FORCE_P = 0.5;

function serviceQuietOffer(rec2){
  const yes = el('odWagersQuietYes'), no = el('odWagersQuietNo');
  if(!yes || typeof yes.onclick !== 'function') return false;
  rec2.quietOffers += 1;
  if(rng() < HUMAN_FORCE_P){
    rec2.quietBreaks += 1;
    yes.onclick();
  } else if(no && typeof no.onclick === 'function'){
    no.onclick();
  } else {
    return false;
  }
  return true;
}

/* One pump of the scripted human. Returns true when it acted, so the caller
   can count stalls. Deliberately services ONE interaction per call. */
function serviceHuman(rec2){
  return serviceHumanDecision(rec2, !!(rec2.iv && rec2.iv.alwaysAttack))
      || serviceQuietOffer(rec2)
      || serviceHumanCommit(rec2)
      || pickHumanSite(rec2);
}

/* A cheap signature of "the game moved", used only to detect a stalled pump
   (a control the driver clicked that changed nothing). */
function gameSignature(st){
  if(!st) return 'none';
  return [st.round, st.phase, st.pickQueue.length, st.logEntries.length,
    st.players[0].influence, st.players[1].influence].join('|');
}

/* ==================================================================
   8. ONE GAME
   ================================================================== */

function playGame(cfg){
rng = mulberry32(cfg.seed);
  timerQueue = [];
  timerFns.clear();
  resetDom();

  const r = newRecord(cfg.seed, cfg.iv || null);

  /* The setup screen, as the engine reads it. */
  SETUP.gameMode = setupEl({value: cfg.mode || 'local'});
  SETUP.demoLoop = setupEl({checked:false});
  SETUP.botDifficulty = setupEl({value: cfg.difficulty || 'normal'});
  SETUP.botSpeed = setupEl({value:'instant'});
  SETUP.p1name = setupEl({value:'P1'});
  SETUP.p2name = setupEl({value:'P2'});
  SETUP.p1type = setupEl({value: cfg.seats ? cfg.seats[0] : 'bot'});
  SETUP.p2type = setupEl({value: cfg.seats ? cfg.seats[1] : 'bot'});

  rec = r;
  Engine.startGame();

  /* `origType` is the seat's real type, remembered before any intervention
     can promote it, and is what serviceHumanDecision and restoreSeat both
     read. It is on the player object rather than on the record because the
     restore has to happen from inside a hook, and the hooks only get
     `ctx.state`. */
  const st0 = state();
  st0.players.forEach(p=>{ p.origType = p.type; });
  r.seatTypes = st0.players.map(p=>p.type);

let guard = 0;
  let stalls = 0;
  const MAX_GUARD = 500000;
  /* Only a HUMAN pump that changes nothing counts as a stall. A timer that
     changes nothing is normal and constant: fx.js arms a cleanup timer for
     every popup and every count-up, and a synchronous queue drains those in
     the same breath. Counting them as stalls aborted healthy games - the
     first symptom was a bot-vs-bot game stopping dead in Round 3's draft with
     three harmless cleanup timers still queued. A timer-driven step always
     re-arms or ends the game on its own, so it gets a free pass. */
  const MAX_STALL = 4;

  for(;;){
    if(++guard > MAX_GUARD){
      r.errors.push('the game never finished (guard ' + MAX_GUARD + ')');
      break;
    }
    if(timerQueue.length){
      stalls = 0;
      const id = timerQueue.shift();
      const fn = timerFns.get(id);
      timerFns.delete(id);
      if(TRACE) trace('fire  #' + id + ' at ' + gameSignature(state()));
      if(fn) fn();
      continue;
    }
    /* The queue is empty. Either the game is over, or the only thing that can
       move it is a person - and if even that cannot, the game is wedged and
       the run must say so rather than print the half-finished score. */
    const st = state();
    if(!st || st.phase === 'ended') break;
    const before = gameSignature(st);
    const acted = serviceHuman(r);
    if(!acted){
      r.errors.push('deadlock in phase "' + st.phase + '" at ' + before
        + ' - nothing queued and no scripted human could act');
      break;
    }
    if(gameSignature(state()) === before){
      if(++stalls > MAX_STALL){
        r.errors.push('the scripted human clicked something inert, four times over, at ' + before);
        break;
      }
    } else {
      stalls = 0;
    }
  }

  restoreSeat();

  const st = state();
  finishRecord(r, st);

  rec = null;
  return r;
}

installHooks();

/* ==================================================================
   9. FINISHING A GAME: invariants + per-game facts
   ================================================================== */

function finishRecord(r, st){
  r.phase = st.phase;
  r.rounds = st.round;
  r.influence = st.players.map(p=>p.influence|0);
  r.finalPools = st.players.map(p=>({credits:p.credits|0, ore:p.ore|0, troops:p.troops|0}));
  r.surges = st.surgeRolls && Array.isArray(st.surgeRolls.values) ? st.surgeRolls.values.slice() : [0,0];
  r.leaderIds = st.players.map(p=>p.leaderId);
  r.collapses = st.collapses|0;
  r.skirmishRounds = (st.history || []).filter(h=>h.skirmish).length;
  st.players.forEach((p,i)=>{
    r.advancedTotal[i] += p.advancedPicks|0;
    r.skirmishWins[i] += p.skirmishWins|0;
    r.skirmishLosses[i] += p.skirmishLosses|0;
  });

  /* Site picks and site Influence. `history` is the engine's own record, and
     it stores the RIFT slot id (picks are pushed before the target rewrite),
     so the ninth site is counted here and nowhere else.

     One honest limitation, reported rather than worked around: cap discards
     are read off history, which endRound snapshots at push time. A discard
     caused by a feature inside a roundEnd hook lands in roundRec AFTER that
     snapshot and is therefore not counted. Every discard caused by an ordinary
     action, an event or a site IS counted, and that is the overwhelming
     majority. */
  (st.history || []).forEach(h=>{
    (h.picks || []).forEach(pk=>{
      r.picks[pk.locId] = (r.picks[pk.locId] || 0) + 1;
      if(pk.tier === 'advanced') r.advancedPicks[pk.locId] = (r.advancedPicks[pk.locId] || 0) + 1;
    });
    if(h.capped){
      /* reportCaps() folds all three resources into `capped.credits`, so
         `credits` here is the COMBINED number, not Credits alone. */
      r.capDiscard.credits += h.capped.credits|0;
      r.capDiscard.ore += h.capped.ore|0;
      r.capDiscard.troops += h.capped.troops|0;
      if((h.capped.credits|0) + (h.capped.ore|0) + (h.capped.troops|0) > 0) r.capDiscard.events += 1;
    }
    if(h.objectiveBonus) r.objectiveBonus = h.objectiveBonus.slice();
  });

  /* Influence already attributed to each slot comes straight off the ledger. */
  ALL_SITES.forEach(id=>{
    r.siteInfluence[id] = (id === RIFT_ID)
      ? r.ledger.rift.points
      : r.ledger['site:' + id].points;
  });

  st.players.forEach((p, i)=>{
    const o = OBJECTIVES.find(x=>x.id === p.objectiveId);
    r.objectiveMet[i] = !!(o && o.check(p));
    r.objectiveId[i] = o ? o.id : null;
  });

  /* Card draws refused for a full hand, counted from the engine's own log
     lines - drawLog() prints "draws nothing - <reason>" and the Rift's
     mutation print says "drew 0 Tactic cards". There is no hook on a refused
     draw (the adapter is installed by game.js and cannot be wrapped), so the
     log is the honest source. */
(st.logEntries || []).forEach(line=>{
    if(/draws nothing/.test(line) || /drew 0 Tactic cards/.test(line)) r.drawsRefused += 1;
    /* Catching Up is announced on the Skirmish log line and nowhere else, and
       it is the whole of the anti-snowball valve - so whether it fires at all
       is a balance fact, not a detail. */
    if(/CATCHING UP:/.test(line)) r.catchingUp += 1;
  });
  /* Kept on the record so a failed run can be read: the tail is the engine's
     own account of what it thought was happening when it stopped. */
  r.logTail = (st.logEntries || []).slice(-14).map(s=>String(s).replace(/<[^>]+>/g,''));

  /* --- invariants: a corrupt run must fail loudly, not get reported --- */
  const bad = [];
  if(!st) bad.push('no state');
  else {
    if(st.phase !== 'ended') bad.push('phase is "' + st.phase + '", not "ended"');
    if(st.round !== TOTAL_ROUNDS) bad.push('round is ' + st.round + ', expected ' + TOTAL_ROUNDS);
    if(!Array.isArray(st.history) || st.history.length !== TOTAL_ROUNDS){
      bad.push('history has ' + (st.history ? st.history.length : 0) + ' rounds, expected ' + TOTAL_ROUNDS);
    }
    if(!Array.isArray(st.players) || st.players.length !== 2) bad.push('players is not a pair');
    else st.players.forEach((p, i)=>{
      ['influence','credits','ore','troops'].forEach(k=>{
        const v = p[k];
        if(typeof v !== 'number' || !isFinite(v)) bad.push('p' + (i+1) + '.' + k + ' = ' + v);
        else if(v < 0) bad.push('p' + (i+1) + '.' + k + ' = ' + v + ' (below 0)');
      });
    });
    if(!Array.isArray(st.pickQueue) || st.pickQueue.length < 0 || st.pickQueue.length > 6){
      bad.push('pickQueue length ' + (st.pickQueue ? st.pickQueue.length : 'n/a'));
    }
    const nan = findBadNumber(st);
    if(nan) bad.push('non-finite number at ' + nan);
  }

  /* --- the reconciliation, which is the whole point --- */
  const attributed = Object.keys(r.ledger).reduce((s, k)=> s + r.ledger[k].points, 0);
  const finalTotal = r.influence[0] + r.influence[1];
  r.attributed = attributed;
  r.finalTotal = finalTotal;
  r.reconcileDelta = attributed - finalTotal;
  if(r.reconcileDelta !== 0){
    bad.push('attribution ' + attributed + ' != final Influence ' + finalTotal
      + ' (delta ' + r.reconcileDelta + ')');
  }
  r.winner = r.influence[0] > r.influence[1] ? 0 : (r.influence[1] > r.influence[0] ? 1 : -1);
  r.ok = bad.length === 0;
  r.errors = r.errors.concat(bad);
}

/* Depth-limited scan for a NaN / Infinity anywhere in the serialised state. */
function findBadNumber(node, pathStr, depth){
  if(depth > 8 || node === null || typeof node !== 'object') return null;
  for(const k in node){
    const v = node[k];
    if(typeof v === 'number'){
      if(!isFinite(v)) return (pathStr ? pathStr + '.' : '') + k;
    } else if(typeof v === 'object' && v !== null){
      const hit = findBadNumber(v, (pathStr ? pathStr + '.' : '') + k, depth + 1);
      if(hit) return hit;
    }
  }
  return null;
}

/* Depth-limited scan for a NaN / Infinity anywhere in the serialised state. */
function findBadNumber(node, pathStr, depth){
  if(depth > 8 || node === null || typeof node !== 'object') return null;
  for(const k in node){
    const v = node[k];
    if(typeof v === 'number'){
      if(!isFinite(v)) return (pathStr ? pathStr + '.' : '') + k;
    } else if(typeof v === 'object' && v !== null){
      const hit = findBadNumber(v, (pathStr ? pathStr + '.' : '') + k, depth + 1);
      if(hit) return hit;
    }
  }
  return null;
}

/* ==================================================================
   10. A BATCH
   ================================================================== */

function runBatch(cfg){
  const out = [];
  for(let g = 0; g < cfg.games; g++){
    /* One seed per game, derived from the batch seed, so any single game is
       reproducible on its own and the batch is reproducible as a whole. */
    const gameSeed = (cfg.seed + g * 7919) >>> 0;
    const rec2 = playGame(Object.assign({}, cfg, {seed: gameSeed}));
    if(rec2.errors.length){
      const err = new Error('balance.sim: corrupt game (seed ' + gameSeed + ', ' + cfg.label + '): '
        + rec2.errors.join('; '));
      err.record = rec2;
      throw err;
    }
    out.push(rec2);
  }
  return out;
}

/* ==================================================================
   11. STATS
   ================================================================== */

const mean = a => a.length ? a.reduce((x, y)=> x + y, 0) / a.length : 0;
const sum = a => a.reduce((x, y)=> x + y, 0);

/* Wilson score interval: the honest one for a proportion near 0 or 1, where
   the normal approximation is not. */
function wilson(successes, n, z){
  if(!n) return {lo:0, hi:1};
  const zz = z === undefined ? 1.96 : z;
  const p = successes / n;
  const d = 1 + zz * zz / n;
  const c = p + zz * zz / (2 * n);
  const s = zz * Math.sqrt((p * (1 - p) + zz * zz / (4 * n)) / n);
  return {lo: Math.max(0, (c - s) / d), hi: Math.min(1, (c + s) / d)};
}

const pctOf = (n, d) => d ? (100 * n / d) : 0;
const r1 = n => Math.round(n * 10) / 10;
const r2 = n => Math.round(n * 100) / 100;
/* ==================================================================
   12. AGGREGATION
   Every headline figure in the report is produced here, from records that
   have already passed their own invariant and reconciliation checks. A
   number printed in this file has been earned by a game that finished,
   reconciled to the point and had no NaN in it.
   ================================================================== */

const SITE_NAMES = {};
Engine.LOCATIONS.forEach(l=>{ SITE_NAMES[l.id] = l.name; });
SITE_NAMES[RIFT_ID] = 'The Rift (9th site)';

/* The eight board systems plus the four Chaos beats. `kind` says what the
   number means; `window` names the hook that owns it, so a reader can go and
   check the attribution against the engine. */
const SOURCE_META = [
  {key:'skirmish', label:'Skirmish (winning margin)',      window:'skirmishResolved'},
  {key:'rift',     label:'The Rift (9th site)',            window:'locationResolved / rift'},
  {key:'surge',    label:'The Surge (Round 6 dice)',       window:'roundBegin'},
  {key:'objective',label:'Objectives',                     window:'gameEnd'},
  {key:'collapse', label:'Collapse / Pressure',            window:'roundEnd -6'},
  {key:'bounty',   label:'Bounties',                       window:'roundEnd +6'},
  {key:'intrigue', label:'Intrigue (Coup)',                window:'intriguePlayed'},
];
ALL_SITES.filter(id=>id !== RIFT_ID).forEach(id=>{
  SOURCE_META.push({key:'site:' + id, label:SITE_NAMES[id], window:'locationResolved'});
});

function tallyLedger(records){
  const keys = SOURCES.concat(['unattributed']);
  const out = Object.create(null);
  keys.forEach(k=>{ out[k] = {points:0, events:0, gross:0, bySeat:[0,0]}; });
  records.forEach(r=>{
    keys.forEach(k=>{
      const l = r.ledger[k];
      out[k].points += l.points; out[k].events += l.events; out[k].gross += l.gross;
      out[k].bySeat[0] += l.bySeat[0]; out[k].bySeat[1] += l.bySeat[1];
    });
  });
  return out;
}

function tallyPicks(records, key){
  const out = Object.create(null);
  records.forEach(r=>{ Object.keys(r[key]).forEach(k=>{ out[k] = (out[k] || 0) + r[key][k]; }); });
  return out;
}

function tallyObjectiveMet(records){
  /* Each player is dealt one of six objectives, so the denominator is the
     number of PLAYER-games that were dealt it - not the game count. */
  const out = Object.create(null);
  OBJECTIVES.forEach(o=>{ out[o.id] = {met:0, n:0}; });
  records.forEach(r=>{
    for(let i = 0; i < 2; i++){
      const id = r.objectiveId[i];
      if(!id || !out[id]) continue;
      out[id].n += 1;
      if(r.objectiveMet[i]) out[id].met += 1;
    }
  });
  return out;
}

function tallyLeaders(records){
  const out = Object.create(null);
  records.forEach(r=>{
    r.leaderIds.forEach((id, i)=>{
      if(!id) return;
      if(!out[id]) out[id] = {influence:0, n:0};
      out[id].influence += r.influence[i];
      out[id].n += 1;
    });
  });
  return out;
}

function block(records, label){
  const n = records.length;
  const ledger = tallyLedger(records);
  const picks = tallyPicks(records, 'picks');
  const adv = tallyPicks(records, 'advancedPicks');

  /* The denominator is the sum of the ledger, which by construction equals the
     two seats' combined final Influence (checked per game, exactly). It is
     computed from the ledger rather than from the totals so a bug in either
     shows up as a wrong share rather than as a quietly self-consistent one. */
  const totalPoints = Object.keys(ledger).reduce((s,k)=> s + ledger[k].points, 0);
  const totalInfluence = records.reduce((s,r)=> s + r.influence[0] + r.influence[1], 0);

const sources = SOURCE_META.map(m=>({
    key:m.key, label:m.label, window:m.window,
    points:ledger[m.key].points,
    gross:ledger[m.key].gross,
    sharePct:pctOf(ledger[m.key].points, totalPoints),
    perGame:(ledger[m.key].points / n),
    events:ledger[m.key].events,
    bySeat:ledger[m.key].bySeat.slice(),
  }));
  const unattributed = ledger.unattributed.points;

  /* --- the sites ------------------------------------------------------- */
  const totalPicks = Object.keys(picks).reduce((s,k)=> s + picks[k], 0);
  const sites = ALL_SITES.map(id=>{
    const points = (id === RIFT_ID) ? ledger.rift.points : ledger['site:' + id].points;
    const p = picks[id] || 0;
return {
      id, name:SITE_NAMES[id] || id,
      points,
      gross:((id === RIFT_ID) ? ledger.rift.gross : ledger['site:' + id].gross),
      sharePct:pctOf(points, totalPoints),
      picks:p,
      advancedPicks:adv[id] || 0,
      advancedSharePct:pctOf(adv[id] || 0, p),
      draftFreqPct:pctOf(p, totalPicks),
      influencePerPick:p ? (points / p) : 0,
      bySeat:(id === RIFT_ID) ? ledger.rift.bySeat.slice() : ledger['site:' + id].bySeat.slice(),
    };
  });
  /* Sorted by points so "the top site" is a fact about the run and not an
     accident of the LOCATIONS table's order. */
  const ranked = sites.slice().sort((a,b)=> b.points - a.points);
  const topSite = ranked[0];
  const siteBlock = ALL_SITES.filter(id=>id !== RIFT_ID).reduce((s,id)=> s + (ledger['site:' + id].points), 0);

  /* --- combat ---------------------------------------------------------- */
  const margin = sum(records.map(r=>r.combatMargin));
  const rallies = sum(records.map(r=>r.combatRally));
  const fights = sum(records.map(r=>r.skirmishes));
  const ties = sum(records.map(r=>r.ties));
const combat = {
    points:ledger.skirmish.points,
    sharePct:pctOf(ledger.skirmish.points, totalPoints),
    perGame:(ledger.skirmish.points / n),
    /* the share of the SITE total, which is the question the board actually
       poses: of everything the nine tiles paid, how much was combat? */
    shareOfSitePct:pctOf(ledger.skirmish.points, siteBlock + ledger.rift.points),
    fights, fightsPerGame:(fights / n), ties, tiesPerGame:(ties / n),
    roundsWithSkirmish:sum(records.map(r=>r.skirmishRounds)),
    marginPoints:margin, rallyBonuses:rallies,
    pointsPerFight:fights ? (margin / fights) : 0,
    /* The Fury ladder and the valve built on it. maxStreak is the deepest run
       of wins either seat reached in a game; Catching Up can only fire against
       a 3+, so gamesWithHotStreak is the ceiling on how often it can matter. */
    maxStreakSeen:records.reduce((m,r)=> Math.max(m, r.maxStreak), 0),
    gamesWithHotStreakPct:pctOf(records.filter(r=>r.gamesWithHotStreak).length, n),
    catchingUp:sum(records.map(r=>r.catchingUp)),
    catchingUpPerGame:r2(mean(records.map(r=>r.catchingUp))),
  };

  /* --- economy --------------------------------------------------------- */
  const capEvents = sum(records.map(r=>r.capDiscard.events));
  const capUnits = sum(records.map(r=>r.capDiscard.credits + r.capDiscard.ore + r.capDiscard.troops));
  const destroyed = sum(records.map(r=>r.destroyedTroops));
  const refused = sum(records.map(r=>r.drawsRefused));
  const economy = {
    capDiscardEvents:capEvents, capDiscardEventsPerGame:(capEvents / n),
    capDiscardUnits:capUnits, capDiscardUnitsPerGame:(capUnits / n),
    unitsDestroyed:destroyed, unitsDestroyedPerGame:(destroyed / n),
    drawsRefused:refused, drawsRefusedPerGame:(refused / n),
    finalPools:[0,1].map(i=>({
      credits:r1(mean(records.map(r=>r.finalPools[i].credits))),
      ore:r1(mean(records.map(r=>r.finalPools[i].ore))),
      troops:r1(mean(records.map(r=>r.finalPools[i].troops))),
    })),
    advancedPicksPerGame:r2(mean(records.map(r=>(r.advancedTotal[0] + r.advancedTotal[1]) / 2))),
    collapsesPerGame:r2(mean(records.map(r=>r.collapses))),
  };

  const inf = [];
  records.forEach(r=>{ inf.push(r.influence[0]); inf.push(r.influence[1]); });
  const perSeat = [0,1].map(i=>records.map(r=>r.influence[i]));

  return {
    label, games:n,
    totalPoints, totalInfluence,
    reconcile:{unattributed, ok:(unattributed === 0)},
    meanInfluencePerSeat:r2(mean(inf)),
    seatInfluence:[r2(mean(perSeat[0])), r2(mean(perSeat[1]))],
    seatWinRatePct:[
      pctOf(records.filter(r=>r.winner===0).length, n),
      pctOf(records.filter(r=>r.winner===1).length, n),
    ],
    drawPct:pctOf(records.filter(r=>r.winner<0).length, n),
    sources, unattributedPoints:unattributed,
    sites:ranked, topSite, totalPicks,
    combat, economy,
    objectives:objectiveBlock(tallyObjectiveMet(records)),
    leaders:leaderBlock(tallyLeaders(records)),
  };
}

function objectiveBlock(tally){
  return OBJECTIVES.map(o=>{
    const c = tally[o.id] || {met:0, n:0};
    const ci = wilson(c.met, c.n);
    return {
      id:o.id, name:o.name, desc:o.desc, bonus:o.bonus,
      met:c.met, n:c.n, ratePct:(c.n ? 100 * c.met / c.n : 0),
      wilsonLoPct:100*ci.lo, wilsonHiPct:100*ci.hi,
    };
  });
}

function leaderBlock(tally){
  return Object.keys(tally).sort().map(id=>{
    const t = tally[id];
    return {id, n:t.n, meanInfluence:r2(t.n ? t.influence / t.n : 0)};
  });
}

/* ==================================================================
   13. THE DELETE-A-SYSTEM COUNTERFACTUAL
   What share of DECIDED games would have a different winner if a named system
   paid nothing?

   "Decided" means the baseline game actually had a winner. A tied game is
   excluded from the denominator because "the winner changed" is not a
   meaningful claim about a game that had no winner - and both the baseline and
   the counterfactual use the SAME per-game seeds, so the comparison is
   paired: any difference is the intervention, not a different sample.

   IMPORTANT, AND STATED IN THE OUTPUT TOO: this is not "delete the code". It
   is "the system stops paying". The game still runs, still drafts, still
   spends the Influence on nothing - so the figure answers the question a
   designer actually has ("is this system load-bearing for the OUTCOME?"), and
   not the question "would the code still parse?".
   ================================================================== */

function counterfactual(baseline, cfg){
  const iv = intervention(cfg.intervention);
  const other = runBatch({
    games:cfg.games, seed:cfg.seed, difficulty:cfg.difficulty || 'normal',
    mode:'local', seats:null, label:iv.label, iv,
  });
  const n = Math.min(baseline.length, other.length);
  let compared = 0, changed = 0, newlyDecided = 0, stillUndecided = 0;
  const flipByMargin = [];
  for(let g = 0; g < n; g++){
    const a = baseline[g], b = other[g];
    if(a.winner < 0 && b.winner < 0){ stillUndecided++; continue; }
    if(a.winner < 0){ newlyDecided++; continue; }
    compared++;
    if(a.winner !== b.winner){
      changed++;
      flipByMargin.push(Math.abs(a.influence[0] - a.influence[1]) - Math.abs(b.influence[0] - b.influence[1]));
    }
  }
  const baseInf = sum(baseline.map(r=>r.influence[0] + r.influence[1]));
  const othInf  = sum(other.map(r=>r.influence[0] + r.influence[1]));
  const ledger = tallyLedger(other);
  return {
    id:iv.id, label:iv.label, deletable:!!iv.deletable,
    games:other.length,
    decided:compared, winnerChanged:changed,
    newlyDecided, stillUndecided,
    winnerChangedPct:pctOf(changed, compared),
    meanInfluencePerSeatBase:r2(baseInf / (baseline.length * 2)),
    meanInfluencePerSeatAlt:r2(othInf / (other.length * 2)),
    /* The negative of the removed total: how much score the system was
       actually worth, which is the number a designer wants. */
    pointsPaid:Object.keys(ledger).reduce((s,k)=> s + ledger[k].points, 0),
    meanMarginLostOnFlip:(flipByMargin.length ? r2(mean(flipByMargin)) : 0),
  };
}

/* ==================================================================
   14. THE HEADLINE SET AND ITS TOLERANCES
   `--check` compares exactly this set. It is deliberately small and entirely
   headline: the numbers a rebalance decision is made from, and nothing that
   is a function of a single game's luck.

   WHY THE TOLERANCES ARE NOT ZERO, given the seed is fixed:

   Unchanged code + unchanged seed replays bit-identically, so a correct
   baseline diffs to 0.000 on every metric. A tolerance is therefore not there
   to hide engine changes - a real rule change moves these figures far more
   than the tolerances below, which is the point of the gate.

It is there for the OTHER case: a change that does not touch the rules but
   does touch the ORDER or COUNT of Math.random() calls (a new jitter term, a
   feature reading a random number, a hook that draws). That reshuffles which
   game each seed becomes, so every figure moves by ordinary sampling noise
   even though nothing about the design changed. A zero tolerance would call
   that a regression and train everyone to re-baseline instead of reading the
   report.

   SIZING. Every number below was set by running this same report at a seed
   1,000,003 away (see `--noise`) and taking the movement, at least twice over
   two independent pairs, then rounding up. Each tolerance is therefore at or
   above the observed noise and far below any real rebalance: retuning a site
   value, a cap or the Collapse clock moves the shares by tens of points, and
   the widest band here is 14. The honest caveat is stated where it applies: the
   objective band is coarse, and the per-objective Wilson interval printed in
   section 5 - not this gate - is the precise instrument for a threshold change.

   `--noise` re-derives the floor on demand and PRINTS a warning naming any
   tolerance that has become tighter than the noise it is meant to absorb, so a
   tolerance table that rots cannot rot silently.
   ================================================================== */

/* A tolerance key is a PREFIX of the dotted metric path. A `*` matches exactly
   one segment, which is how a per-list metric gets one rule for all its
   members: `objectives.*.ratePct` covers objectives.warlord.ratePct through
   objectives.archivist.ratePct without listing six near-identical numbers.
   Anything with no matching rule is reported as unbounded rather than being
   silently treated as "must not move", because a metric that is in the report
   and out of the gate is a trap for the next engineer. */
const TOLERANCES = {
  'attribution.reconcileMax':        {abs:0,     why:'integer arithmetic; a nonzero value is a missing hook, not noise'},
  'attribution.totalPointsPerGame':  {abs:0.60,  why:'a mean over 600 games, both seats'},
  'topSite.id':                      {abs:0,     why:'a string: the dominant site changing is checked exactly, never within a tolerance'},
  'topSite.sharePct':                {abs:1.5,   why:'share of a ~38,000-point total, 600 games'},
  'sites.*.sharePct':                {abs:1.5,   why:'same denominator as the top site'},
  'combat.sharePct':                 {abs:1.5,   why:'5 Skirmishes a game, each capped by the Fury rung'},
  'combat.shareOfSitePct':           {abs:2.0,   why:'the same quantity over a different denominator; measured 1.4pp of movement'},
  'combat.fightsPerGame':            {abs:0.20,  why:'a count of fights per game, not a proportion'},
  'objectives.*.ratePct':            {abs:14.0,  why:'COARSE. n = 200 player-games per objective, and warlord is a threshold on a variable number of fights, so its own sampling error is the widest of the six: 10.7pp measured between seeds. Use the per-objective Wilson interval in section 5 to judge a threshold change, not this gate.'},
  'difficulty.*.meanInfluencePerSeat':{abs:1.5,   why:'200 games; the DIFFERENCE between levels is the signal, not the level'},
  'difficulty.separationPts':        {abs:2.0,   why:'a difference of two 200-game means; measured 0.98pp of movement'},
  'economy.capDiscardEventsPerGame': {abs:0.50,  why:'a Poisson count at ~4.7/game'},
  'economy.unitsDestroyedPerGame':   {abs:1.20,  why:'a count, but it moves with the whole draft'},
  'economy.drawsRefusedPerGame':     {abs:0.60,  why:'a count per game of draws refused by a full hand'},
  'systems.*.winnerChangedPct':      {abs:10.0,  why:'~240 decided games, and the counterfactual is a different trajectory, not a coin re-flip: measured seed-to-seed movement reaches 13pp at half this n'},
  'leaders.*.meanInfluence':         {abs:3.0,   why:'n = 200 player-games per leader'},
  'seats.*.meanInfluencePerSeat':    {abs:1.5,   why:'150 games of human-vs-bot and hotseat'},
};

/* Flatten a report into the dotted-number map `--check` compares. Returns
   [flatMap, prefix] so a list metric like `objectives.ratePct` gets one entry
   per objective with a readable key. */
function headline(report){
  const h = {};
  h['attribution.reconcileMax'] = report.baseline.reconcile.unattributed;
  h['attribution.totalPointsPerGame'] = report.baseline.totalPoints / report.baseline.games;
  h['topSite.id'] = report.baseline.topSite.id;
  h['topSite.sharePct'] = report.baseline.topSite.sharePct;
  report.baseline.sites.forEach(s=>{ h['sites.' + s.id + '.sharePct'] = s.sharePct; });
  h['combat.sharePct'] = report.baseline.combat.sharePct;
  h['combat.shareOfSitePct'] = report.baseline.combat.shareOfSitePct;
  h['combat.fightsPerGame'] = report.baseline.combat.fightsPerGame;
  report.baseline.objectives.forEach(o=>{ h['objectives.' + o.id + '.ratePct'] = o.ratePct; });
  report.difficulty.forEach(d=>{
    h['difficulty.' + d.id + '.meanInfluencePerSeat'] = d.meanInfluencePerSeat;
  });
  h['difficulty.separationPts'] = report.difficultySeparation.pts;
  const e = report.baseline.economy;
  h['economy.capDiscardEventsPerGame'] = e.capDiscardEventsPerGame;
  h['economy.unitsDestroyedPerGame'] = e.unitsDestroyedPerGame;
  h['economy.drawsRefusedPerGame'] = e.drawsRefusedPerGame;
  /* Only the DELETABLE systems are gated. The behavioural ones (a site removed
     from the board, "always attack") change the whole random trajectory, so
     their winner-flip rate is a far noisier statistic - measured at up to 13
     percentage points of seed-to-seed movement at this sample size, which is
     more than any tolerance that would still be a gate rather than a shrug.
     They are printed, they are not gated, and this line says so. */
  report.systems.filter(s=>s.deletable).forEach(s=>{
    h['systems.' + s.id + '.winnerChangedPct'] = s.winnerChangedPct;
  });
  report.baseline.leaders.forEach(l=>{ h['leaders.' + l.id + '.meanInfluence'] = l.meanInfluence; });
  report.seats.forEach(s=>{ h['seats.' + s.id + '.meanInfluencePerSeat'] = s.meanInfluencePerSeat; });
  return h;
}

/* Which TOLERANCES rule governs a given dotted key: the LONGEST matching
   prefix wins, and a `*` in any position of the prefix matches exactly one
   segment. That is what lets `objectives.*.ratePct` cover all six objectives
   and `leaders.*.meanInfluence` all six leaders without six near-identical
   rules each. Anything with no matching rule is reported as unbounded rather
   than silently treated as "must not move", because a metric that appears in
   the report and not in the gate is a trap for the next engineer. */
function toleranceFor(key){
  const parts = key.split('.');
  for(let n = parts.length; n > 0; n--){
    const head = parts.slice(0, n);
    if(TOLERANCES[head.join('.')]) return TOLERANCES[head.join('.')];
    for(let s = 0; s < head.length; s++){
      const wild = head.slice();
      if(wild[s] === '*') continue;
      wild[s] = '*';
      const k = wild.join('.');
      if(TOLERANCES[k]) return TOLERANCES[k];
    }
  }
  return {abs:Infinity, why:'NO TOLERANCE RULE - reported but not gated; add one or drop the metric'};
}

/* ==================================================================
   15. THE RUN
   Six batches, each answering one question. The batch counts are part of the
   `--check` contract: same seed AND same counts replays identically.
   ================================================================== */

const DIFFICULTIES = ['easy', 'normal', 'hard'];
const SEAT_CONFIGS = [
  {id:'human-bot',   seats:['human','bot'],   label:'Human vs Bot'},
  {id:'hotseat',     seats:['human','human'], label:'hotseat (two scripted humans)'},
];

function runAll(cfg){
  const seed = cfg.seed;

  const baseRecords = runBatch({
    games:cfg.games, seed, difficulty:'normal', mode:'local', seats:null,
    label:'baseline (bot vs bot, normal)',
  });
  const baseline = block(baseRecords, 'baseline (bot vs bot, normal)');

  const seatBlocks = SEAT_CONFIGS.map(sc=>{
    const recs = runBatch({
      games:cfg.seatGames, seed:seed + 101, difficulty:'normal', mode:'local',
      seats:sc.seats, label:sc.label,
    });
    const b = block(recs, sc.label);
    return {id:sc.id, label:sc.label, games:recs.length,
      meanInfluencePerSeat:b.meanInfluencePerSeat,
      seatInfluence:b.seatInfluence,
      seatWinRatePct:b.seatWinRatePct,
      topSiteSharePct:b.topSite.sharePct,
      combatSharePct:b.combat.sharePct,
humanCommitsPerGame:r2(mean(recs.map(x=>x.humanCommits))),
      humanDecisionsPerGame:r2(mean(recs.map(x=>x.humanDecisions))),
      humanPicksPerGame:r2(mean(recs.map(x=>x.humanPicks))),
      quietOffersPerGame:r2(mean(recs.map(x=>x.quietOffers))),
      quietBreaksPerGame:r2(mean(recs.map(x=>x.quietBreaks)))};
  });

  const difficulty = DIFFICULTIES.map(d=>{
    const recs = runBatch({
      games:cfg.diffGames, seed:seed + 202, difficulty:d, mode:'local',
      seats:null, label:'difficulty ' + d,
    });
    const b = block(recs, 'difficulty ' + d);
    /* The two seats are the SAME difficulty, so this is not a head-to-head and
       a win rate cannot separate them - it should sit at 50% and does. The
       signal is whether the harder policy banks MORE of the same board, which
       is the only thing "the difficulty levels differ" can mean when the two
       seats are identical. */
    return {
      id:d, label:'difficulty ' + d, games:recs.length,
      meanInfluencePerSeat:b.meanInfluencePerSeat,
      seatInfluence:b.seatInfluence,
      seatWinRatePct:b.seatWinRatePct,
      standardError:r2(seOfMean(recs.map(x=>(x.influence[0] + x.influence[1]) / 2))),
      topSiteSharePct:b.topSite.sharePct,
      combatSharePct:b.combat.sharePct,
      advancedPicksPerGame:b.economy.advancedPicksPerGame,
      capDiscardEventsPerGame:b.economy.capDiscardEventsPerGame,
      objectiveMetRatePct:meanMetRate(b.objectives),
    };
  });

  /* Every intervention runs over a PREFIX of the baseline's per-game seeds, so
     the winner comparison is paired rather than two independent samples. */
  const systems = INTERVENTIONS.filter(i=>i.id !== 'none').map(i=>
    counterfactual(baseRecords, {
      games:Math.min(cfg.ivGames, baseRecords.length),
      seed, intervention:i.id,
    })
  );

const easy = difficulty[0], hard = difficulty[difficulty.length-1];
  /* Separation = the harder policy's mean minus the easier one's, in Influence
     per seat. The uncertainty is a difference of two independent means, so it
     is the root-sum-square of the two standard errors; the factor sqrt(2)
     converts each per-seat SE (which was measured over GAMES) to the same
     scale the per-seat difference lives on. */
  const diffMean = x => x.meanInfluencePerSeat;
  const seDiff = Math.sqrt(
    Math.pow(hard.standardError * Math.SQRT2, 2) +
    Math.pow(easy.standardError * Math.SQRT2, 2)
  );
  const separation = {
    from:hard.id, to:easy.id,
    pts:r2(diffMean(hard) - diffMean(easy)),
    se:r2(seDiff),
  };
  separation.z = separation.se ? r2(separation.pts / separation.se) : 0;
  separation.reading = separation.se && Math.abs(separation.z) >= 2
    ? 'the three levels separate (|z| >= 2)'
    : 'the three levels do NOT separate at n=' + easy.games + ' (|z| < 2) - the slider changes the game, not the scores';

  return {
    meta:{
      seed, games:cfg.games, seatGames:cfg.seatGames, diffGames:cfg.diffGames,
      ivGames:Math.min(cfg.ivGames, cfg.games),
      rounds:TOTAL_ROUNDS, sites:ALL_SITES.length,
      scriptOrder:SCRIPTS,
      note:'Every figure is measured on js/*.js exactly as index.html loads them. No rule is restated here.',
    },
    surface:surfaceReport(),
    baseline,
    seats:seatBlocks,
    difficulty,
    difficultySeparation:separation,
    systems,
    interventions:INTERVENTIONS.map(i=>({id:i.id, label:i.label, deletable:!!i.deletable})),
  };
}

/* The mean met-rate across the six objectives, which is how "did this
   difficulty level make objectives easier" is asked. Only objectives that were
   actually dealt at least once count. */
function meanMetRate(objs){
  const c = objs.filter(o=>o.n > 0);
  return c.length ? r1(c.reduce((s,o)=> s + o.ratePct, 0) / c.length) : 0;
}

/* Standard error of a mean, from the sample. */
function seOfMean(a){
  const n = a.length;
  if(n < 2) return 0;
  const m = mean(a);
  let ss = 0;
  a.forEach(v=>{ const d = v - m; ss += d * d; });
  return Math.sqrt(ss / (n - 1) / n);
}

/* ==================================================================
   16. THE HUMAN-READABLE REPORT
   ================================================================== */

const LINE = '='.repeat(78);
const THIN = '-'.repeat(78);

/* Left- and right-aligned fixed columns. Labels go left, numbers go right, and
   the gap between them is part of the width - which is the whole trick, and the
   reason there are two functions rather than one flag: a right-aligned LABEL
   ends flush against the next column's first digit and the table reads as one
   run-together word ("Outpost574"). */
function L(s, n){ s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
function R(s, n){ s = String(s); return ' '.repeat(Math.max(0, n - s.length)) + s; }
function num(v, dp){
  if(typeof v !== 'number' || !isFinite(v)) return String(v);
  return v.toFixed(dp === undefined ? 1 : dp);
}
function bar(sharePct, width){
  const n = Math.max(0, Math.min(width, Math.round(sharePct / 100 * width)));
  return '#'.repeat(n);
}

function printReport(rep, out){
  const w = (s)=>out.write(s + '\n');
  const b = rep.baseline;

  w(LINE);
  w('  OUTPOST DUEL - BALANCE SIMULATOR');
  w(LINE);
  w('  seed ' + rep.meta.seed + '   baseline ' + rep.meta.games + ' games'
    + ', ' + rep.meta.seatGames + '/seat-config, ' + rep.meta.diffGames + '/difficulty, '
    + rep.meta.ivGames + '/intervention');
  w('  engine: ' + rep.meta.scriptOrder.join(' -> '));
  w('  rounds ' + rep.meta.rounds + ', board slots ' + rep.meta.sites);
  w('  ' + rep.meta.note);
  w('');

  /* --- 0. integrity first: a corrupt run must say so before quoting numbers */
  w(THIN);
  w('  0. INTEGRITY - a corrupt run fails here rather than being reported');
  w(THIN);
  w('  attribution reconciles to the two seats\' final Influence in '
    + b.games + '/' + b.games + ' games.   residual: ' + b.reconcile.unattributed + ' points');
  w('  total attributed ' + b.totalPoints + '  ==  total final Influence ' + b.totalInfluence
    + (b.reconcile.ok ? '   OK' : '   MISMATCH'));
  w('  invariants per game (no negative pool, exactly ' + rep.meta.rounds + ' rounds in history,'
    + ' no NaN/Infinity anywhere in state, pickQueue in range, phase "ended"):'
    + ' ' + b.games + '/' + b.games + ' passed');
  w('  every game in every batch passed the same checks; runBatch() throws on the');
  w('  first that does not, so nothing below this line can be a half-finished game.');
  w('');

  /* --- 1. where every point came from ---------------------------------- */
  w(THIN);
  w('  1. INFLUENCE ATTRIBUTION - where every point of the final score came from');
  w(THIN);
  w('  ' + L('source', 28) + R('points', 8) + R('% of score', 11) + R('pts/game', 10)
    + R('events', 8) + '  ' + 'hook window that owns it');
  const ordered = b.sources.slice().sort((x,y)=> y.points - x.points);
  ordered.forEach(s=>{
    w('  ' + L(s.label, 28) + R(s.points, 8) + R(num(s.sharePct) + '%', 11)
      + R(num(s.perGame, 2), 10) + R(s.events, 8) + '  ' + s.window);
  });
  w('  ' + L('(unattributed)', 28) + R(b.unattributedPoints, 8)
    + R(num(pctOf(b.unattributedPoints, b.totalPoints)) + '%', 11)
    + R(num(b.unattributedPoints / b.games, 2), 10) + R('-', 8));
  w('  ' + L('TOTAL', 28) + R(b.totalPoints, 8) + R('100.0%', 11)
    + R(num(b.totalPoints / b.games, 2), 10));
  w('');
  w('  mean Influence per seat ' + num(b.meanInfluencePerSeat, 2)
    + '   (seat 1 ' + num(b.seatInfluence[0], 2) + ' / seat 2 ' + num(b.seatInfluence[1], 2)
    + ')   games with a winner ' + num(100 - b.drawPct) + '%');
  w('  read the gross column too: the Collapse is a TRANSFER (the leader -2, the');
  w('  trailer +2), so its net contribution to the total is 0 by construction while');
  w('  the Influence it actually moved is not zero.');
  w('');

  /* --- 2. the board ----------------------------------------------------- */
  w(THIN);
  w('  2. THE BOARD - which sites own the score');
  w(THIN);
  w('  ' + L('site', 22) + R('points', 8) + R('% of score', 11) + R('picks', 8)
    + R('inf/pick', 9) + R('drafted%', 9) + R('adv%', 7) + R('moved', 8) + '  profile');
  b.sites.forEach(s=>{
    w('  ' + L(s.name, 22) + R(s.points, 8) + R(num(s.sharePct) + '%', 11) + R(s.picks, 8)
      + R(num(s.influencePerPick, 2), 9) + R(num(s.draftFreqPct) + '%', 9)
      + R(num(s.advancedSharePct) + '%', 7) + R(s.gross, 8) + '  ' + bar(s.sharePct, 16));
  });
  w('');
  w('  TOP SITE: ' + b.topSite.name + ' - ' + num(b.topSite.sharePct)
    + '% of all Influence (' + num(b.topSite.influencePerPick, 2)
    + ' per pick, taken in ' + num(b.topSite.draftFreqPct) + '% of all picks, '
    + num(b.topSite.advancedSharePct) + '% of them Advanced)');
  const weakest = b.sites[b.sites.length-1];
  w('  nine sites, so an even board would put each at ' + num(100 / b.sites.length)
    + '%. The weakest site that actually pays is ' + weakest.name + ' at '
    + num(weakest.sharePct) + '%' + (weakest.points > 0
      ? ' - a ' + num(b.topSite.points / weakest.points, 1) + 'x gap to the top site.'
      : ' - and it pays nothing at all in this run.'));
  w('');

  /* --- 3. combat -------------------------------------------------------- */
  w(THIN);
  w('  3. COMBAT - how much of the score the Skirmish owns');
  w(THIN);
  w('  combat share of the FINAL SCORE   : ' + num(b.combat.sharePct) + '%   ('
    + num(b.combat.perGame, 2) + ' Influence per game, both seats)');
  w('  combat share of everything the BOARD paid : ' + num(b.combat.shareOfSitePct) + '%');
  w('  fights per game                  : ' + num(b.combat.fightsPerGame, 2)
    + '   ties ' + num(b.combat.tiesPerGame, 2)
    + '   rounds with a fight ' + num(b.combat.roundsWithSkirmish / b.games, 2)
    + ' of ' + rep.meta.rounds);
w('  Influence per decided fight      : ' + num(b.combat.pointsPerFight, 2)
    + '   Rally bonuses ' + b.combat.rallyBonuses + ' in ' + b.games + ' games');
  w('  Fury ladder                     : deepest win run seen ' + b.combat.maxStreakSeen
    + ', a 3+ streak occurred in ' + num(b.combat.gamesWithHotStreakPct) + '% of games');
  w('  CATCHING UP fired               : ' + b.combat.catchingUp + ' times in ' + b.games
    + ' games (' + num(b.combat.catchingUpPerGame, 2) + '/game) - the whole of the anti-snowball');
  w('                                     valve, and it can only fire against that 3+ streak');
  w('');

  /* --- 4. delete a system ---------------------------------------------- */
  w(THIN);
  w('  4. DELETE A SYSTEM - what share of DECIDED games would change winner?');
  w('     the named system pays 0 Influence. The game still runs and still');
  w('     decides, so this answers "is it load-bearing for the OUTCOME?" and');
  w('     not "would the code still load?". Paired: the same per-game seeds.');
  w(THIN);
  w('  ' + L('system removed from scoring', 36) + R('pts/seat', 10) + R('was worth', 11)
    + R('winner flips', 13) + R('n decided', 10) + '  profile');
  rep.systems.filter(s=>s.deletable).forEach(s=>{
    const worth = s.meanInfluencePerSeatBase - s.meanInfluencePerSeatAlt;
    w('  ' + L(s.label, 36) + R(num(s.meanInfluencePerSeatAlt, 2), 10)
      + R('-' + num(worth, 2), 11) + R(num(s.winnerChangedPct) + '%', 13)
      + R(s.decided, 10) + '  ' + bar(s.winnerChangedPct, 12));
  });
  w('');
w('  behavioural counterfactuals - a different GAME, not a deleted system, so the');
  w('  score column moves for reasons other than "the points stopped paying". These');
  w('  are printed but NOT in the --check gate: they reroute the whole random');
  w('  trajectory, so their flip rate moves up to 13 points between seeds at this n.');
  w('  ' + L('intervention', 36) + R('pts/seat', 10) + R('', 11) + R('winner flips', 13)
    + R('n decided', 10) + '  profile');
  rep.systems.filter(s=>!s.deletable).forEach(s=>{
    w('  ' + L(s.label, 36) + R(num(s.meanInfluencePerSeatAlt, 2), 10) + R('', 11)
      + R(num(s.winnerChangedPct) + '%', 13) + R(s.decided, 10)
      + '  ' + bar(s.winnerChangedPct, 12));
  });
  w('');

  /* --- 5. objectives ---------------------------------------------------- */
  w(THIN);
  w('  5. OBJECTIVES - met-rate per objective. Each player is dealt one of six,');
  w('     so n is player-games, not games.');
  w(THIN);
  w('  ' + L('objective', 15) + R('met/n', 11) + R('rate', 8) + R('95% Wilson', 18)
    + R('bonus', 7) + '  condition');
  b.objectives.forEach(o=>{
    w('  ' + L(o.id, 15) + R(o.met + '/' + o.n, 11) + R(num(o.ratePct) + '%', 8)
      + R('[' + num(o.wilsonLoPct) + ', ' + num(o.wilsonHiPct) + ']', 18)
      + R('+' + o.bonus, 7) + '  ' + o.desc);
  });
  w('');
  const auto = b.objectives.filter(o=>o.ratePct >= 95 || (o.ratePct <= 5 && o.n >= 30))
    .map(o=>o.id + ' (' + num(o.ratePct) + '%)');
  w('  an objective has to be missable AND achievable, so nothing may sit at 0% or 100%: '
    + (auto.length ? 'NOT SATISFIED by ' + auto.join(', ') : 'all six sit inside 5%-95% - OK'));
  w('');

  /* --- 6. difficulty ---------------------------------------------------- */
  w(THIN);
  w('  6. DIFFICULTY SEPARATION. Both seats run the SAME level, so a win rate');
  w('     cannot separate them - it should sit at 50% and does. What separates');
  w('     them is how much of the same board each policy banks.');
  w(THIN);
  w('  ' + L('difficulty', 12) + R('pts/seat', 11) + R('SE', 8) + R('seat-1 win%', 13)
    + R('top site%', 11) + R('adv picks', 11) + R('obj met%', 10) + R('cap/game', 10));
  rep.difficulty.forEach(d=>{
    w('  ' + L(d.id, 12) + R(num(d.meanInfluencePerSeat, 2), 11) + R(num(d.standardError, 2), 8)
      + R(num(d.seatWinRatePct[0]) + '%', 13) + R(num(d.topSiteSharePct) + '%', 11)
      + R(num(d.advancedPicksPerGame, 1), 11) + R(num(d.objectiveMetRatePct) + '%', 10)
      + R(num(d.capDiscardEventsPerGame, 2), 10));
  });
  const sep = rep.difficultySeparation;
  w('  n = ' + rep.difficulty[0].games + ' games per level ('
    + rep.difficulty[0].games * 2 + ' player-games each).');
  w('  ' + sep.from + ' minus ' + sep.to + ': ' + num(sep.pts, 2)
    + ' Influence per seat, SE ' + num(sep.se, 2) + ', z ' + num(sep.z, 2));
  w('  ' + sep.reading);
  w('  noise note: at n=' + rep.difficulty[0].games + ' the 95% interval on one level\'s own mean is'
    + ' about +-' + num(1.96 * rep.difficulty[0].standardError, 2) + ' points, so read any'
    + ' separation under about ' + num(2 * 1.96 * rep.difficulty[0].standardError, 2)
    + ' as noise rather than as a difficulty.');
  w('');

  /* --- 7. economy ------------------------------------------------------- */
  w(THIN);
  w('  7. ECONOMY - what the caps and the Skirmish do to the pools');
  w(THIN);
  const e = b.economy;
  w('  cap-discard events per game    : ' + num(e.capDiscardEventsPerGame, 2)
    + '   (' + e.capDiscardEvents + ' events, ' + num(e.capDiscardUnitsPerGame, 2)
    + ' units gained and immediately thrown away)');
  w('  units destroyed per game       : ' + num(e.unitsDestroyedPerGame, 2)
    + '   (Troops committed to a fight, Ambush backfires, Berserker)');
  w('  card draws refused per game    : ' + num(e.drawsRefusedPerGame, 2)
    + '   (hand already at the cap)');
  w('  advanced picks per seat        : ' + num(e.advancedPicksPerGame, 2)
    + '   of 18 possible');
  w('  collapses per game             : ' + num(e.collapsesPerGame, 2)
    + '   (the ' + rep.meta.rounds + '-round Pressure clock)');
  w('  final pools, mean              : credits ' + num(e.finalPools[0].credits, 1)
    + '   ore ' + num(e.finalPools[0].ore, 1) + '   troops ' + num(e.finalPools[0].troops, 1));
  w('');

  /* --- 8. leaders ------------------------------------------------------- */
  w(THIN);
  w('  8. PER-LEADER MEAN INFLUENCE. Leaders are dealt at random, so n is the');
  w('     number of player-games that held that leader.');
  w(THIN);
  const leadSorted = b.leaders.slice().sort((x,y)=> y.meanInfluence - x.meanInfluence);
  leadSorted.forEach(l=>{
    w('  ' + L(l.id, 14) + R(num(l.meanInfluence, 2) + ' pts', 14) + R('n ' + l.n, 9)
      + '  ' + bar((l.meanInfluence / Math.max(1, leadSorted[0].meanInfluence)) * 100, 24));
  });
  const leadSpread = leadSorted.length
    ? leadSorted[0].meanInfluence - leadSorted[leadSorted.length-1].meanInfluence : 0;
  w('  spread best to worst: ' + num(leadSpread, 2) + ' Influence per seat');
  w('');

  /* --- 9. seats --------------------------------------------------------- */
  w(THIN);
  w('  9. SEAT TYPES. The scripted human drives the real humanPick(), the real');
  w('     commit modal and the real Quiet Round offer - no second copy of the rules.');
  w(THIN);
  w('  ' + L('configuration', 30) + R('pts/seat', 11) + R('top site%', 11) + R('combat%', 10)
    + R('commits/gm', 11) + R('decides/gm', 11) + R('quiet offers', 13));
  rep.seats.forEach(s=>{
    w('  ' + L(s.label, 30) + R(num(s.meanInfluencePerSeat, 2), 11)
      + R(num(s.topSiteSharePct) + '%', 11) + R(num(s.combatSharePct) + '%', 10)
      + R(num(s.humanCommitsPerGame, 2), 11) + R(num(s.humanDecisionsPerGame, 2), 11)
      + R(num(s.quietOffersPerGame, 2), 13));
  });
  w('  ' + L('baseline: bot vs bot', 30) + R(num(b.meanInfluencePerSeat, 2), 11)
    + R(num(b.topSite.sharePct) + '%', 11) + R(num(b.combat.sharePct) + '%', 10));
  w('');

  /* --- 10. engine surface ---------------------------------------------- */
  w(THIN);
  w('  10. ENGINE SEAMS - what js/game.js actually exports, measured not assumed');
  w(THIN);
  w('  ' + L('name', 26) + '  exported');
  rep.surface.forEach(s=>{
    w('  ' + L(s.name, 26) + '  ' + (s.exported ? 'yes' : 'no  - reachable only through OD.Ext'));
  });
  w('');
  w('  A counterfactual that needs one of the "no" names above is why every');
  w('  intervention in this harness is built out of hooks and player fields.');
  w(LINE);
}
/* ==================================================================
   17. THE BASELINE AND `--check`

   The baseline is the JSON the next engineer diffs against. It is written by
   a plain run and it is only as good as the tolerance set beside it, so both
   live in the same file and the file names the reason for every tolerance.

   `--check` does three things, in this order:
     1. NOISE FLOOR - the whole report is recomputed at a DIFFERENT seed and
        every gated metric is compared to itself. That prints the sampling
        noise of the batch size, which is what the tolerances are sized
        against, and it names any tolerance that is tighter than the noise it
        is meant to absorb (that is a bug in the tolerance table, and it is
        reported as one).
     2. BASELINE DIFF - the report is recomputed at the CONTRACT seed and
        compared to test/balance.baseline.json. Any metric outside its
        tolerance fails, and the failure names the metric, both values and the
        tolerance.
     3. EXIT CODE - 0 only if both passed.
   ================================================================== */

const BASELINE_VERSION = 2;

function baselineDoc(rep){
  const h = headline(rep);
  return {
    version:BASELINE_VERSION,
    /* The engine this baseline was measured against. A diff against a
       baseline recorded for a different engine is not a rebalance, it is a
       different game, and the check says so by name. */
    engine:{
      scriptOrder:rep.meta.scriptOrder,
      rounds:rep.meta.rounds,
      sites:rep.meta.sites,
    },
    config:{
      seed:rep.meta.seed, games:rep.meta.games, seatGames:rep.meta.seatGames,
      diffGames:rep.meta.diffGames, ivGames:rep.meta.ivGames,
    },
    tolerances:TOLERANCES,
    headline:h,
    topSiteId:rep.baseline.topSite.id,
    full:rep,
  };
}

function diffHeadlines(now, was, opts){
  const rows = [];
  const keys = Object.keys(now).sort();
  keys.forEach(k=>{
    const a = now[k], b = was[k];
    if(typeof a !== 'number'){
      rows.push({key:k, now:a, was:b, tol:null, pass:(a === b),
        note:'string metric - must match exactly'});
      return;
    }
    if(typeof b !== 'number'){
      rows.push({key:k, now:a, was:undefined, tol:null, pass:false,
        note:'NEW headline metric - re-baseline deliberately or this gate will always fail'});
      return;
    }
    const t = toleranceFor(k);
    const d = a - b;
    rows.push({key:k, now:a, was:b, delta:d, tol:t.abs, why:t.why,
      pass:Math.abs(d) <= t.abs});
  });
  /* A metric that vanished from the current headline set is a real problem:
     the baseline is describing a report this build no longer produces. */
  Object.keys(was).forEach(k=>{
    if(!(k in now)) rows.push({key:k, now:undefined, was:was[k], tol:null, pass:false,
      note:'metric is GONE from the report - the baseline and the harness disagree'});
  });
  void opts;
  return rows;
}

function printDiff(rows, title){
  const out = process.stdout;
  out.write('\n' + LINE + '\n  ' + title + '\n' + LINE + '\n');
  out.write('  ' + L('metric', 46) + R('now', 11) + R('baseline', 11)
    + R('delta', 10) + R('tol', 9) + '  verdict\n');
  rows.forEach(r=>{
    const verdict = r.pass ? 'ok' : ('FAIL  ' + (r.note || ''));
    out.write('  ' + L(r.key, 46)
      + R(typeof r.now === 'number' ? num(r.now, 3) : String(r.now), 11)
      + R(typeof r.was === 'number' ? num(r.was, 3) : String(r.was), 11)
      + R(typeof r.delta === 'number' ? (r.delta >= 0 ? '+' : '') + num(r.delta, 3) : '-', 10)
      + R(r.tol === null ? '-' : num(r.tol, 2), 9)
      + '  ' + verdict + (r.pass ? '' : (r.why ? '  [' + r.why + ']' : '')) + '\n');
  });
  const failed = rows.filter(r=>!r.pass);
  out.write('  ' + (failed.length ? failed.length + ' of ' + rows.length + ' METRICS OUT OF TOLERANCE'
    : 'all ' + rows.length + ' headline metrics within tolerance') + '\n');
  return failed;
}

function parseArgs(argv){
  const a = {check:false, write:true, noise:false, seed:DEFAULT_SEED,
    games:DEFAULT_GAMES, seatGames:DEFAULT_SEAT_GAMES, diffGames:DEFAULT_DIFF_GAMES,
    ivGames:DEFAULT_IV_GAMES, quiet:false};
  for(let i = 0; i < argv.length; i++){
    const t = argv[i];
    if(t === '--check'){ a.check = true; a.write = false; }
    else if(t === '--noise'){ a.noise = true; a.write = false; }
    else if(t === '--no-write'){ a.write = false; }
    else if(t === '--quiet'){ a.quiet = true; }
    else if(t === '--seed'){ a.seed = Number(argv[++i]); }
    else if(t === '--games'){ a.games = Number(argv[++i]); }
    else if(t === '--iv-games'){ a.ivGames = Number(argv[++i]); }
    else if(t === '--help' || t === '-h'){ a.help = true; }
    else throw new Error('balance.sim: unknown argument "' + t + '"');
  }
  return a;
}

const USAGE = [
  'usage: node test/balance.sim.js [options]',
  '',
  '  (no arguments)   run the full report and write test/balance.baseline.json',
  '  --check         seeded deterministic comparison against the baseline;',
  '                   exit 1 if a headline metric moves past its tolerance',
  '  --noise         print the sampling noise floor (same report, second seed)',
  '  --no-write      run the report without touching the baseline file',
  '  --seed N        override the batch seed',
  '  --games N       override the baseline game count',
  '  --iv-games N    override the per-intervention game count',
  '',
  'npm run balance  ==  node test/balance.sim.js',
].join('\n');

function main(argv){
  let opts;
  try{ opts = parseArgs(argv); }
  catch(err){ process.stderr.write(err.message + '\n\n' + USAGE + '\n'); return 2; }
  if(opts.help){ process.stdout.write(USAGE + '\n'); return 0; }

  /* The engine is already loaded and the hooks already registered by the time
     this file is required; `rec` is null, so every hook is inert until a game
     sets it. */
  const cfg = {seed:opts.seed, games:opts.games, seatGames:opts.seatGames,
    diffGames:opts.diffGames, ivGames:opts.ivGames};

  process.stdout.write('[balance.sim] running ' + (cfg.games + 2*cfg.seatGames + 3*cfg.diffGames
    + (INTERVENTIONS.length - 1) * Math.min(cfg.ivGames, cfg.games)) + ' games (seed ' + cfg.seed + ')...\n');
  const t0 = Date.now();
  const rep = runAll(cfg);
  process.stdout.write('[balance.sim] done in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's\n');
  printReport(rep, process.stdout);

  const h = headline(rep);

/* --- 1. the noise floor ---------------------------------------------- */
  if(opts.noise){
    /* A seed FAR from the contract seed, not seed+1. mulberry32 folds its state
       through imul and xor, but two seeds one apart still start from states one
       apart and their first draws are correlated - which is not a measurement
       of anything, it is a measurement of the PRNG. 1,000,003 is far enough
       that the two batches share no prefix of the stream. */
    const altSeed = cfg.seed + 1000003;
    const alt = runAll(Object.assign({}, cfg, {seed:altSeed}));
    const rows = diffHeadlines(h, headline(alt), {});
    printDiff(rows, 'NOISE FLOOR - the same report at seed ' + altSeed
      + ' (this is what the tolerances have to absorb)');
    const tooTight = rows.filter(r => typeof r.tol === 'number' && r.tol > 0
      && Math.abs(r.delta) > r.tol);
    if(tooTight.length){
      process.stdout.write('\n  WARNING: ' + tooTight.length + ' tolerance(s) are TIGHTER than the observed'
        + ' seed-to-seed noise. Those would flag a harmless reordering of Math.random() as a rebalance:\n');
      tooTight.forEach(r=>{
        process.stdout.write('    ' + L(r.key, 46) + 'moved ' + num(r.delta, 3)
          + ' but the tolerance is ' + num(r.tol, 2) + '\n');
      });
    } else {
      process.stdout.write('\n  every tolerance is at least the observed seed-to-seed movement - OK\n');
    }
    return 0;
  }

  /* --- 2. write, or check ---------------------------------------------- */
  if(!opts.check){
if(opts.write){
      const doc = baselineDoc(rep);
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(doc, null, 2) + '\n');
      process.stdout.write('\n[balance.sim] wrote ' + path.relative(ROOT, BASELINE_PATH)
        + ' - ' + Object.keys(h).length + ' headline metrics, '
        + Object.keys(TOLERANCES).length + ' tolerance rules\n');
      process.stdout.write('[balance.sim] verify it with: node test/balance.sim.js --check\n');
    } else {
      process.stdout.write('\n[balance.sim] --no-write: the baseline file was not touched\n');
    }
    return 0;
  }

  if(!fs.existsSync(BASELINE_PATH)){
    process.stderr.write('\n[balance.sim] FAIL: no baseline at '
      + path.relative(ROOT, BASELINE_PATH) + '. Run `node test/balance.sim.js` first.\n\n');
    return 1;
  }
  let base;
  try{ base = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); }
  catch(err){
    process.stderr.write('\n[balance.sim] FAIL: the baseline is not readable JSON: ' + err.message + '\n\n');
    return 1;
  }

  if(base.version !== BASELINE_VERSION){
    process.stderr.write('\n[balance.sim] FAIL: the baseline is version ' + base.version
      + ', this harness writes version ' + BASELINE_VERSION + '. Re-baseline with'
      + ' `node test/balance.sim.js` and read the new report before committing.\n\n');
    return 1;
  }
  const engNow = (rep.meta.scriptOrder || []).join(','), engWas = ((base.engine||{}).scriptOrder || []).join(',');
  if(engNow !== engWas){
    process.stderr.write('\n[balance.sim] FAIL: the baseline was measured against a different engine.\n'
      + '  baseline: ' + engWas + '\n  now     : ' + engNow + '\n'
      + '  That is a different game, not a rebalance. Re-baseline and read the report.\n\n');
    return 1;
  }
  const cNow = JSON.stringify(rep.meta), cWas = JSON.stringify(base.config || {});
  void cNow; void cWas;

/* Every metric, including the top site's identity, goes through the same
     diff. `topSite.id` is a string and diffHeadlines compares strings exactly,
     so "the dominant site changed" can never hide inside a tolerance. */
  const rows = diffHeadlines(h, base.headline || {}, {});
  const failed = printDiff(rows, '--check: seed ' + cfg.seed + ' vs the recorded baseline');
  if(failed.length){
    process.stderr.write('\n[balance.sim] FAIL: ' + failed.length + ' headline metric(s) moved past tolerance.\n');
    process.stderr.write('  Either a rule changed (read the report above - the numbers ARE the change),\n');
    process.stderr.write('  or a Math.random() call was added or removed (see --noise), or the\n');
    process.stderr.write('  tolerances in TOLERANCES no longer match the batch size.\n');
    process.stderr.write('  A baseline is only rewritten by running `node test/balance.sim.js`, and the\n');
    process.stderr.write('  commit that rewrites it has to carry the report.\n\n');
    return 1;
  }
  process.stdout.write('\n[balance.sim] PASS: ' + rows.length
    + ' headline metrics match the baseline at seed ' + cfg.seed + '.\n\n');
  return 0;
}

module.exports = {
  /* The surface test/balance.test.js drives. Deliberately small: play one
     game, run a batch, aggregate it, read a headline, resolve a tolerance. */
  playGame, runBatch, block, headline, runAll, intervention, toleranceFor,
  INTERVENTIONS, SOURCES, ALL_SITES, RIFT_ID, siteNames:()=>SITE_NAMES,
  getState:state, getRecord:()=>rec, installedHooks:()=>HOOK_UNSUBSCRIBE.length,
  TOLERANCES, BASELINE_PATH, BASELINE_VERSION, parseArgs,
};

/* `npm run balance` and `node test/balance.sim.js --check` are the two
   entry points; `require`ing this file from a test must not run either. */
if(require.main === module){
  process.exit(main(process.argv.slice(2)));
}
