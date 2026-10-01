/* ---------------------------------------------------------------------
   OUTPOST DUEL — extension seam (loaded first)

   This is the ONLY place features are meant to hook into. Nothing in this
   file knows about the game rules, the DOM, or the board — it is a tiny,
   defensive event bus plus the single sanctioned mutation surface (`api`).

   Design rules that must not be broken:
     1. Every feature callback runs inside try/catch and is swallowed. A bug
        in a fan-made mode must never be able to brick a real game.
     2. `state` is JSON-serialized over the WebSocket relay, so nothing
        registered here may ever be stored on it. Registration lives in this
        module's closure.
     3. Hook names and effect triggers are frozen sets: registering under a
        typo throws immediately instead of silently never firing.

   Usage:
     OD.Ext.hooks.on('roundBegin', (ctx)=>{ ... }, {priority: 10});
     OD.Ext.effects.register('myMod', {trigger:'roundBegin', resolve(ctx){}});
     OD.Ext.panels.register('myPanel', {label:'Wagers', order: 10, render(){}});
--------------------------------------------------------------------- */

;(function(root){
'use strict';

/* Frozen allow-lists. Adding a name here is a deliberate act: it means the
   engine actually calls that hook somewhere. */
const HOOK_NAMES = Object.freeze([
  'gameStart', 'roundBegin', 'roundEventApplied', 'locationResolved',
  'intriguePlayed', 'skirmishBegin', 'skirmishCommitted', 'skirmishResolved',
  'roundEnd', 'gameEnd',
]);

const EFFECT_TRIGGERS = Object.freeze([
  'tacticCommitted', 'tacticResolved', 'locationResolved',
  'roundEventApplied', 'roundBegin', 'roundEnd',
]);

/* Mutable module-private registries. Deliberately NOT on OD so nothing can
   reach in and reorder or delete another feature's handler. */
let hookTable = Object.create(null);      // name    -> [{fn, priority, seq}]
let effectTable = Object.create(null);    // trigger -> [{id, effect, seq}]
let panelTable = Object.create(null);     // id      -> {id, label, order, render}
let adapters = {draw: null, popup: null, render: null};
let seqCounter = 0;

function nextSeq(){ return seqCounter++; }

function warn(what, err){
  try{ console.warn('[OD.Ext] ' + what, err || ''); }catch(_){ /* console may be absent */ }
}

/* Run one user callback, swallowing anything it throws. */
function safely(what, fn, ctx){
  try{ fn(ctx); }
  catch(err){ warn(what + ' threw and was ignored:', err); }
}

function isKnown(list, name){
  return list.indexOf(name) !== -1;
}

/* ------------------------------------------------------------------ hooks */

const hooks = {
  /* Register a handler. Returns an unsubscribe function so a feature can
     cleanly detach itself (e.g. a mode that turns off mid-game). */
  on(name, fn, opts){
    if(!isKnown(HOOK_NAMES, name)) throw new Error('OD.Ext.hooks.on: unknown hook "' + name + '"');
    if(typeof fn !== 'function') throw new Error('OD.Ext.hooks.on: handler must be a function');
    const priority = (opts && typeof opts.priority === 'number') ? opts.priority : 0;
    const entry = {fn, priority, seq: nextSeq()};
    if(!hookTable[name]) hookTable[name] = [];
    hookTable[name].push(entry);
    return function off(){
      const list = hookTable[name];
      if(!list) return;
      const i = list.indexOf(entry);
      if(i >= 0) list.splice(i, 1);
    };
  },

  /* Fire a hook. Handlers run by DESCENDING priority, then registration
     order, so a feature can jump the queue without re-registering. `ctx` is
     mutated in place and shared by every handler in the chain. */
  run(name, ctx){
    if(!isKnown(HOOK_NAMES, name)) throw new Error('OD.Ext.hooks.run: unknown hook "' + name + '"');
    const list = hookTable[name];
    if(!list || list.length === 0) return;
    /* Snapshot + sort: a handler is allowed to register or unregister
       handlers (including itself) without corrupting this dispatch. */
    const order = list.slice().sort((a, b)=> (b.priority - a.priority) || (a.seq - b.seq));
    for(let i = 0; i < order.length; i++){
      safely('hook "' + name + '" handler', order[i].fn, ctx);
    }
  },
};

/* ---------------------------------------------------------------- effects */

const effects = {
  register(id, spec){
    if(typeof id !== 'string' || !id) throw new Error('OD.Ext.effects.register: id must be a non-empty string');
    if(!spec || !isKnown(EFFECT_TRIGGERS, spec.trigger)) throw new Error('OD.Ext.effects.register: effect "' + id + '" has an unknown trigger');
    if(typeof spec.resolve !== 'function') throw new Error('OD.Ext.effects.register: effect "' + id + '" needs a resolve(ctx) function');
    if(effectTable[spec.trigger] && effectTable[spec.trigger].some(e => e.id === id)){
      throw new Error('OD.Ext.effects.register: duplicate effect id "' + id + '" for trigger "' + spec.trigger + '"');
    }
    const priority = (typeof spec.priority === 'number') ? spec.priority : 0;
    if(!effectTable[spec.trigger]) effectTable[spec.trigger] = [];
    effectTable[spec.trigger].push({id, effect: spec, seq: nextSeq(), priority});

    let removed = false;
    return function off(){
      if(removed) return;
      removed = true;
      const list = effectTable[spec.trigger];
      if(!list) return;
      const i = list.findIndex(e => e.id === id);
      if(i >= 0) list.splice(i, 1);
    };
  },

  run(trigger, ctx){
    if(!isKnown(EFFECT_TRIGGERS, trigger)) throw new Error('OD.Ext.effects.run: unknown trigger "' + trigger + '"');
    const list = effectTable[trigger];
    if(!list || list.length === 0) return;
    const order = list.slice().sort((a, b)=> (b.priority - a.priority) || (a.seq - b.seq));
    for(let i = 0; i < order.length; i++){
      const eff = order[i].effect;
      /* An effect that doesn't apply is simply skipped — a broken
         `condition` counts as "doesn't apply", never as a crash. */
      let applies = true;
      if(typeof eff.condition === 'function'){
        try{ applies = !!eff.condition(ctx); }
        catch(err){ warn('effect "' + order[i].id + '" condition threw; skipping:', err); applies = false; }
      }
      if(!applies) continue;
      safely('effect "' + order[i].id + '"', eff.resolve, ctx);
    }
  },
};

/* ---------------------------------------------------------------- panels */

/* HUD/status widgets a feature contributes. game.js owns the container and
   the rendering cadence; features only hand back an HTML string. */
const panels = {
  register(id, spec){
    if(typeof id !== 'string' || !id) throw new Error('OD.Ext.panels.register: id must be a non-empty string');
    if(!spec || typeof spec.render !== 'function') throw new Error('OD.Ext.panels.register: panel "' + id + '" needs a render(ctx) function');
    if(panelTable[id]) throw new Error('OD.Ext.panels.register: duplicate panel id "' + id + '"');
    const entry = Object.freeze({
      id,
      label: typeof spec.label === 'string' ? spec.label : id,
      order: (typeof spec.order === 'number') ? spec.order : 0,
      render: spec.render,
    });
    panelTable[id] = entry;
    return function off(){ if(panelTable[id] === entry) delete panelTable[id]; };
  },

  /* Sorted snapshot for the renderer. `include` is an optional map of
     {id: renderContext} overriding the default game context. */
  list(include){
    return Object.keys(panelTable)
      .map(k => panelTable[k])
      .sort((a, b)=> (a.order - b.order) || a.id.localeCompare(b.id))
      .map(p => {
        let html = '';
        try{ html = p.render(include && include[p.id] !== undefined ? include[p.id] : include); }
        catch(err){ warn('panel "' + p.id + '" render threw; showing placeholder:', err); html = ''; }
        return {id: p.id, label: p.label, html: String(html == null ? '' : html)};
      });
  },

  has(){ return Object.keys(panelTable).length > 0; },
};

/* ------------------------------------------------------------------- api */

/* THE mutation surface. Features mutate the game exclusively through this
   object, which keeps every change clamp-checked and logged consistently
   and means a feature can never reach into game.js internals.

   `grant` / `spend` never let a resource go below 0, and `spend` is all-or-
   nothing: if you can't fully afford it, nothing is spent. The engine's
   applyCaps() then trims anything above the round caps, exactly as it does
   for its own gains. */
const makeApi = function makeApi(state){
  const RES = ['credits', 'ore', 'troops', 'influence'];

  function playerOf(i){
    return (state && state.players && typeof i === 'number') ? state.players[i] : null;
  }

  const api = {
    /* Add resources. Negative amounts are ignored (use spend for that).
       Returns the amount actually added. */
    grant(i, amounts){
      const p = playerOf(i);
      if(!p || !amounts) return 0;
      let total = 0;
      RES.forEach(res => {
        const n = amounts[res];
        if(typeof n !== 'number' || !isFinite(n) || n <= 0) return;
        p[res] = (p[res] || 0) + n;
        total += n;
      });
      return total;
    },

    /* Spend resources. If any single required resource is short, NOTHING is
       spent and 0 is returned (no partial payment). Resources clamp at 0. */
    spend(i, amounts){
      const p = playerOf(i);
      if(!p || !amounts) return 0;
      let total = 0;
      for(const res in amounts){
        if(!Object.prototype.hasOwnProperty.call(amounts, res)) continue;
        const n = amounts[res];
        if(typeof n !== 'number' || !isFinite(n) || n <= 0) continue;
        if((p[res] || 0) < n) return 0;   // all-or-nothing
        total += n;
      }
      for(const res in amounts){
        if(!Object.prototype.hasOwnProperty.call(amounts, res)) continue;
        const n = amounts[res];
        if(typeof n !== 'number' || !isFinite(n) || n <= 0) continue;
        p[res] = Math.max(0, (p[res] || 0) - n);
      }
      return total;
    },

    /* Draw Tactic cards. Delegates to the engine's deck logic (shuffle,
       reshuffle-from-discard, hand cap) via the adapter game.js installs. */
    draw(i, n){
      const p = playerOf(i);
      if(!p || typeof n !== 'number' || n <= 0) return 0;
      if(typeof adapters.draw !== 'function') return 0;
      const drew = adapters.draw(p, n, state);
      return typeof drew === 'number' ? drew : 0;
    },

    /* Append a log line. Deliberately does NOT re-render — the engine
       re-renders at its own cadence, and features fire mid-resolution. */
    log(html){
      if(!state || !Array.isArray(state.logEntries)) return;
      state.logEntries.push(String(html));
    },

    /* Floating "+3 Credits" badge near a player's HUD card. */
    popup(i, text, good){
      if(typeof adapters.popup !== 'function') return;
      try{ adapters.popup(i, String(text), good !== false); }
      catch(err){ warn('api.popup failed:', err); }
    },

    /* Force a phase transition (e.g. 'skirmish-decide'). */
    phase(name){
      if(!state) return;
      state.phase = String(name);
    },

    /* Set a top-level state key. Plain JSON data only. */
    set(key, value){
      if(!state || typeof key !== 'string' || !key) return;
      state[key] = value;
    },
  };

  return Object.freeze(api);
};

/* game.js installs the few pieces of engine behaviour `api` cannot know:
   how a Tactic card is actually drawn, and how a popup is actually shown. */
function setAdapters(next){
  if(!next) return;
  ['draw', 'popup', 'render'].forEach(k => {
    if(typeof next[k] === 'function' || next[k] === null) adapters[k] = next[k];
  });
}

/* Wipe every registration. Test-only: never call this from the game. */
function reset(){
  hookTable = Object.create(null);
  effectTable = Object.create(null);
  panelTable = Object.create(null);
  adapters = {draw: null, popup: null, render: null};
  seqCounter = 0;
}

const Ext = Object.freeze({
  hooks, effects, panels, makeApi, setAdapters, reset,
  HOOK_NAMES, EFFECT_TRIGGERS,
});

root.OD = root.OD || {};
root.OD.Ext = Ext;

if(typeof module !== 'undefined' && module.exports) module.exports = {Ext: Ext};

})(typeof globalThis !== 'undefined' ? globalThis : this);
