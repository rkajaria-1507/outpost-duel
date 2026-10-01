/* ---------------------------------------------------------------------
   OUTPOST DUEL — screen juice (pure DOM, no game knowledge)

   Every effect here is fire-and-forget: append a node or toggle a class,
   then clean itself up on `animationend` with a setTimeout fallback (the
   same pattern as showRoundBanner in js/game.js). Nothing in this file
   knows what a card or a round is.

   Accessibility: if the user has asked for reduced motion, every effect
   degrades to a no-op rather than a smaller animation — a vestibular
   trigger is not something to half-measure.
--------------------------------------------------------------------- */

;(function(root){
'use strict';

const STYLE_ID = 'od-fx-css';

const CSS = `
.od-shake{animation:od-shake .4s cubic-bezier(.36,.07,.19,.97) both}
@keyframes od-shake{
  10%,90%{transform:translate3d(calc(var(--od-shake-amp,8px) * -0.25),0,0)}
  20%,80%{transform:translate3d(calc(var(--od-shake-amp,8px) *  0.50),0,0)}
  30%,50%,70%{transform:translate3d(calc(var(--od-shake-amp,8px) * -0.90),0,0)}
  40%,60%{transform:translate3d(calc(var(--od-shake-amp,8px) *  0.90),0,0)}
}
.od-flash{position:fixed;inset:0;pointer-events:none;z-index:9999;opacity:0}
.od-flash-on{animation:od-flash var(--od-flash-ms,300ms) ease-out both}
@keyframes od-flash{0%{opacity:0}18%{opacity:.55}100%{opacity:0}}
.od-pulse{animation:od-pulse .45s ease-out both}
@keyframes od-pulse{0%{transform:scale(1)}40%{transform:scale(1.09)}100%{transform:scale(1)}}
.od-burst{position:absolute;inset:0;pointer-events:none;overflow:visible;z-index:5}
.od-burst i{position:absolute;left:50%;top:50%;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;
  border-radius:50%;background:currentColor;opacity:.9;
  animation:od-burst var(--od-burst-ms,620ms) cubic-bezier(.2,.7,.4,1) both}
@keyframes od-burst{
  from{transform:translate3d(0,0,0) scale(.4);opacity:1}
  to{transform:translate3d(var(--dx,0),var(--dy,0),0) scale(0);opacity:0}
}
.od-confetti{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:6}
.od-confetti i{position:absolute;top:-14px;width:8px;height:13px;border-radius:2px;
  animation:od-confetti var(--od-confetti-ms,2100ms) linear both}
@keyframes od-confetti{
  0%{transform:translate3d(0,0,0) rotate(0deg);opacity:1}
  100%{transform:translate3d(var(--dx,0),105vh,0) rotate(var(--rot,540deg));opacity:.15}
}
@media (prefers-reduced-motion: reduce){
  .od-shake,.od-pulse,.od-burst i,.od-confetti i,.od-flash-on{animation:none !important}
  .od-flash{display:none}
}
`;

/* The @media block, returned separately so a host page (or a test) can
   inject or assert it without side effects. */
function reducedMotionStyles(){
  return '@media (prefers-reduced-motion: reduce){' + CSS.slice(CSS.indexOf('@media')) ;
}

function injectOnce(){
  if(typeof document === 'undefined') return false;
  if(document.getElementById(STYLE_ID)) return true;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
  return true;
}

/* Both spellings exist because the two read differently at the call site;
   they are the same predicate. Cached, because matchMedia can allocate. */
let reduceCache = null;
function reduceMotion(){
  if(reduceCache !== null) return reduceCache;
  let on = false;
  try{
    if(typeof window !== 'undefined' && window.matchMedia){
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      on = !!mq.matches;
      if(typeof mq.addEventListener === 'function'){
        mq.addEventListener('change', (e)=>{ reduceCache = !!e.matches; });
      } else if(typeof mq.addListener === 'function'){
        mq.addListener((e)=>{ reduceCache = !!e.matches; });
      }
    }
  }catch(_){ /* no matchMedia: assume motion is fine */ }
  reduceCache = on;
  return reduceCache;
}

function resolveEl(target){
  if(!target) return null;
  if(typeof target === 'string'){
    if(typeof document === 'undefined') return null;
    return document.querySelector(target);
  }
  if(target.nodeType === 1) return target;
  return null;
}

/* Resolve to a live element, but never throw. Returns null instead so every
   caller can early-return instead of wrapping itself in try/catch. */
function el(target){
  try{ return resolveEl(target); }catch(_){ return null; }
}

/* animationend + timeout, the cleanup pattern used across this project. */
function autoClean(node, ms, extra){
  let done = false;
  const cleanup = ()=>{
    if(done) return;
    done = true;
    if(typeof extra === 'function'){ try{ extra(); }catch(_){} }
    try{ if(node.isConnected) node.remove(); }catch(_){}
  };
  node.addEventListener('animationend', cleanup);
  setTimeout(cleanup, ms);
  return cleanup;
}

/* --------------------------------------------------------------- effects */

const Fx = Object.freeze({

  shake(target, opts){
    if(reduceMotion()) return;
    const node = el(target);
    if(!node) return;
    const o = opts || {};
    const amp = (o.amp === undefined ? 8 : o.amp);
    const ms = (o.ms === undefined ? 400 : o.ms);
    injectOnce();
    /* --amp drives the keyframe translations so one keyframe block serves
       every amplitude instead of injecting a new rule per call. */
    node.style.setProperty('--od-shake-amp', String(amp));
    node.style.animationDuration = ms + 'ms';
    node.classList.remove('od-shake');
    void node.offsetWidth; // restart the animation if it is already running
    node.classList.add('od-shake');
    const onEnd = ()=>{
      node.classList.remove('od-shake');
      node.style.animationDuration = '';
      node.style.removeProperty('--od-shake-amp');
    };
    node.addEventListener('animationend', onEnd, {once: true});
    setTimeout(onEnd, ms + 120);
  },

  /* Full-screen colour veil. `target` is accepted for signature symmetry
     with the other effects but a flash is always whole-viewport. */
  flash(target, color, ms){
    if(reduceMotion()) return;
    if(typeof document === 'undefined' || !document.body) return;
    injectOnce();
    const dur = (ms === undefined ? 300 : ms);
    const old = document.querySelector('.od-flash');
    if(old) old.remove();
    const veil = document.createElement('div');
    veil.className = 'od-flash';
    if(color) veil.style.background = color;
    veil.style.setProperty('--od-flash-ms', dur + 'ms');
    document.body.appendChild(veil);
    /* Force a reflow so the animation actually starts. */
    void veil.offsetWidth;
    veil.classList.add('od-flash-on');
    autoClean(veil, dur + 80);
  },

  countUp(node, from, to, ms){
    const target = el(node);
    if(!target) return;
    const a = (typeof from === 'number' && isFinite(from)) ? from : 0;
    const b = (typeof to === 'number' && isFinite(to)) ? to : 0;
    const dur = (ms === undefined ? 600 : ms);
    if(reduceMotion() || a === b){ target.textContent = String(b); return; }
    const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    let raf = 0;
    const step = ()=>{
      const t = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const p = Math.min(1, (t - start) / dur);
      /* easeOutCubic: fast start, soft landing, so the final number is easy to read. */
      const eased = 1 - Math.pow(1 - p, 3);
      target.textContent = String(Math.round(a + (b - a) * eased));
      if(p < 1) raf = setTimeout(step, 16);
    };
    step();
    setTimeout(()=>{ if(raf) clearTimeout(raf); target.textContent = String(b); }, dur + 60);
  },

  pulse(target, cls){
    const node = el(target);
    if(!node) return;
    if(reduceMotion()) return;
    injectOnce();
    const klass = cls || 'od-pulse';
    node.classList.remove(klass);
    void node.offsetWidth;
    node.classList.add(klass);
    const onEnd = ()=> node.classList.remove(klass);
    node.addEventListener('animationend', onEnd, {once: true});
    setTimeout(onEnd, 600);
  },

  /* CSS-only particles: absolutely positioned <i> elements that translate
     outward and fade. No canvas, no rAF, nothing to cancel. */
  burst(target, opts){
    const node = el(target);
    if(!node) return;
    if(reduceMotion()) return;
    injectOnce();
    const o = opts || {};
    const count = Math.max(0, Math.min(60, o.count === undefined ? 14 : o.count));
    if(!count) return;
    const spread = (o.spread === undefined ? 70 : o.spread);
    const color = o.color || 'currentColor';

    const host = document.createElement('div');
    host.className = 'od-burst';
    host.style.color = color;
    for(let i = 0; i < count; i++){
      const p = document.createElement('i');
      const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      const dist = spread * (0.55 + Math.random() * 0.65);
      p.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
      p.style.setProperty('--dy', Math.sin(angle) * dist + 'px');
      p.style.animationDelay = (Math.random() * 90) + 'ms';
      host.appendChild(p);
    }
    /* The host is position-relative-free: anchor to the target's box. */
    if(getComputedStyle(node).position === 'static') node.style.position = 'relative';
    node.appendChild(host);
    autoClean(host, 800);
  },

  confetti(container, opts){
    const node = el(container);
    if(!node) return;
    if(reduceMotion()) return;
    injectOnce();
    const o = opts || {};
    const count = Math.max(0, Math.min(300, o.count === undefined ? 90 : o.count));
    if(!count) return;
    const palette = o.colors || ['#c98a2b', '#b5502e', '#5a7a3a', '#8a5aa8', '#2f6f7a', '#e0c56a'];

    const host = document.createElement('div');
    host.className = 'od-confetti';
    for(let i = 0; i < count; i++){
      const p = document.createElement('i');
      p.style.left = (Math.random() * 100) + '%';
      p.style.background = palette[i % palette.length];
      p.style.setProperty('--dx', ((Math.random() - 0.5) * 220) + 'px');
      p.style.setProperty('--rot', (Math.round((Math.random() - 0.5) * 1440)) + 'deg');
      p.style.animationDelay = (Math.random() * 700) + 'ms';
      host.appendChild(p);
    }
    node.appendChild(host);
    autoClean(host, 3000);
  },

  reduceMotion,
  reducedMotion: reduceMotion,
  reducedMotionStyles,
  injectStyles: injectOnce,
  STYLE_ID,
});

root.OD = root.OD || {};
root.OD.Fx = Fx;

if(typeof module !== 'undefined' && module.exports) module.exports = {Fx: Fx};

})(typeof globalThis !== 'undefined' ? globalThis : this);
