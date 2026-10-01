/* ---------------------------------------------------------------------
   OUTPOST DUEL — procedural Web Audio (no asset files, no network)

   Every sound in the game is synthesized at play time from an ADSR +
   frequency-ramp recipe, so there is nothing to download and nothing to
   keep in sync with the art.

   Signal graph
   ------------
     voice (osc / noise src / thump)
        -> [lowpass|bandpass|highpass filter]
        -> ADSR gain
        -> [stereo panner]
        -> master gain
        -> DynamicsCompressor
        -> destination
     with a parallel send from the ADSR gain into a procedurally-generated
     convolution reverb (an exponentially-decaying stereo noise impulse).

   Two details that matter a lot in practice:
     * Impacts use PINK noise, not white. White noise reads as a digital
       glitch / TV static; pink reads as a physical thump.
     * Rapid triggers (dice ticks) are rate-limited per recipe via minGap
       and capped by MAX_VOICES, so a fast roll can't pile up into clipping.

   The AudioContext is created lazily and only ever from a user gesture
   (browsers refuse to start audio otherwise), so `ensure()` must be called
   from inside a click handler.
--------------------------------------------------------------------- */

;(function(root){
'use strict';

const STORAGE_KEY = 'od_sound';
const MAX_VOICES = 24;

/* ------------------------------------------------------------------ state */

let ctx = null;
let master = null;
let compressor = null;
let reverb = null;
let reverbSend = null;
let pinkBuffer = null;
let enabled = readStoredEnabled();
let lastPlayed = Object.create(null);
let liveVoices = 0;
let duckUntil = 0;

/* ----------------------------------------------------------------- helpers */

function readStoredEnabled(){
  try{
    if(typeof localStorage !== 'undefined' && localStorage) return localStorage.getItem(STORAGE_KEY) !== 'off';
  }catch(_){ /* private mode / sandboxed iframe */ }
  return true;
}

function storeEnabled(v){
  try{
    if(typeof localStorage !== 'undefined' && localStorage) localStorage.setItem(STORAGE_KEY, v ? 'on' : 'off');
  }catch(_){ /* ignore */ }
}

function hasAudioApi(){
  return typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
}

function now(){ return ctx ? ctx.currentTime : 0; }
function at(offsetSeconds){ return now() + (offsetSeconds || 0); }

/* -------------------------------------------------------------- buffers */

/* Pink noise via the classic 3-pole (Paul Kellett) approximation. Built
   once, then reused as a looping buffer source for every impact/hit. */
function buildPinkBuffer(){
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for(let ch = 0; ch < 2; ch++){
    const data = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0;
    for(let i = 0; i < len; i++){
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.0990460;
      b1 = 0.96300 * b1 + white * 0.2965164;
      b2 = 0.57000 * b2 + white * 1.0526913;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.22;
    }
  }
  return buf;
}

/* Exponentially-decaying stereo noise impulse. Stereo decorrelation is what
   makes the tail feel wide instead of sitting in the middle of the head. */
function buildImpulseResponse(seconds, decay){
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const ir = ctx.createBuffer(2, len, rate);
  for(let ch = 0; ch < 2; ch++){
    const data = ir.getChannelData(ch);
    for(let i = 0; i < len; i++){
      const t = i / len;
      /* Slight per-channel offset decorrelates the two sides. */
      const decorrelate = (ch === 0) ? 1 : 0.87;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * decorrelate;
    }
  }
  return ir;
}

function buildReverb(){
  const conv = ctx.createConvolver();
  conv.buffer = buildImpulseResponse(1.9, 2.6);
  const wet = ctx.createGain();
  wet.gain.value = 0.9;
  conv.connect(wet);
  wet.connect(master);
  reverb = conv;
  reverbSend = conv;
  return conv;
}

/* ------------------------------------------------------------------ graph */

function ensure(){
  if(!hasAudioApi()) return null;
  if(!ctx){
    try{
      const Ctor = window.AudioContext || window.webkitAudioContext;
      ctx = new Ctor();

      master = ctx.createGain();
      master.gain.value = 0.85;

      compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -14;
      compressor.knee.value = 22;
      compressor.ratio.value = 3.2;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.22;

      master.connect(compressor);
      compressor.connect(ctx.destination);

      buildReverb();
      pinkBuffer = buildPinkBuffer();
    }catch(err){
      /* Audio is cosmetic. Never let a failure here take the game down. */
      try{ console.warn('[OD.Sound] audio unavailable:', err); }catch(_){}
      ctx = null;
      return null;
    }
  }
  if(ctx.state === 'suspended'){ try{ ctx.resume(); }catch(_){} }
  return ctx;
}

/* ---------------------------------------------------------------- voices */

function trackVoice(node, stopAt){
  liveVoices++;
  const release = ()=>{
    liveVoices = Math.max(0, liveVoices - 1);
    try{ node.disconnect(); }catch(_){}
  };
  node.onended = release;
  /* Belt and braces: onended is not guaranteed if the context is suspended. */
  setTimeout(release, Math.max(0, (stopAt - now()) * 1000) + 250);
}

function overVoiceBudget(durSec){
  return liveVoices >= MAX_VOICES;
}

/* ADSR envelope on a fresh gain node. All four stages are expressed in
   seconds; `curve` picks linear attack / exponential decay. */
function adsr(param, t0, a, d, s, r, peak, sustainLevel){
  const hold = Math.max(0, (a + d + (s || 0)));
  param.cancelScheduledValues(t0);
  param.setValueAtTime(0.0001, t0);
  param.linearRampToValueAtTime(Math.max(0.0001, peak), t0 + a);
  if(s > 0){
    param.linearRampToValueAtTime(Math.max(0.0001, peak * sustainLevel), t0 + a + d);
    param.setValueAtTime(Math.max(0.0001, peak * sustainLevel), t0 + a + d + s);
  } else {
    param.exponentialRampToValueAtTime(0.0001, t0 + hold + r);
  }
  return hold + r;
}

function makeFilter(type, freq, q){
  if(!freq) return null;
  const f = ctx.createBiquadFilter();
  f.type = type || 'lowpass';
  f.frequency.value = freq;
  if(q) f.Q.value = q;
  return f;
}

function makePan(pan){
  if(pan === undefined || pan === null) return null;
  if(typeof ctx.createStereoPanner === 'function'){
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    return p;
  }
  return null; // older browsers: mono is fine
}

/* One oscillator voice through the standard chain. */
function voice(o){
  if(!ctx) return;
  const t0 = at(o.at);
  const dur = (o.dur || 0.2);
  if(overVoiceBudget(dur)) return;

  const osc = ctx.createOscillator();
  osc.type = o.type || 'sine';

  const f0 = o.freq || 440;
  osc.frequency.setValueAtTime(f0, t0);
  if(o.freqTo && o.freqTo !== f0){
    if(o.freqCurve === 'linear') osc.frequency.linearRampToValueAtTime(o.freqTo, t0 + (o.freqTime || dur));
    else osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqTo), t0 + (o.freqTime || dur));
  }
  if(o.detune) osc.detune.setValueAtTime(o.detune, t0);

  /* Vibrato LFO, for anything that should feel played rather than fired. */
  let lfo = null, lfoGain = null;
  if(o.vibrato && o.vibratoHz){
    lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = o.vibratoHz;
    lfoGain = ctx.createGain();
    lfoGain.gain.value = o.vibrato;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    lfo.start(t0);
    lfo.stop(t0 + dur + 0.1);
  }

  const env = ctx.createGain();
  const peak = (o.gain === undefined ? 0.2 : o.gain) * (duckUntil > now() ? 0.7 : 1);
  const tail = adsr(env.gain, t0, o.attack || 0.004, o.decay || 0.06, o.sustain || 0, o.release || 0.12, peak, o.sustainLevel || 0.6);

  const filter = makeFilter(o.filter, o.filterFreq, o.filterQ);
  if(filter && o.filterTo && o.filterTo !== o.filterFreq){
    filter.frequency.setValueAtTime(o.filterFreq, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, o.filterTo), t0 + (o.filterTime || dur));
  }

  const pan = makePan(o.pan);

  osc.connect(env);
  if(filter){ env.connect(filter); filter.connect(pan || master); if(pan) pan.connect(master); }
  else if(pan){ env.connect(pan); pan.connect(master); }
  else env.connect(master);

  const sendAmt = o.reverb === undefined ? 0.12 : o.reverb;
  if(sendAmt > 0 && reverbSend){ const send = ctx.createGain(); send.gain.value = sendAmt; env.connect(send); send.connect(reverbSend); }

  osc.start(t0);
  osc.stop(t0 + dur + 0.12);
  trackVoice(osc, t0 + dur + 0.12);
}

/* Noise voice — pink by default, because white noise sounds like a bug. */
function noise(o){
  if(!ctx || !pinkBuffer) return;
  const t0 = at(o.at);
  const dur = (o.dur || 0.15);
  if(overVoiceBudget(dur)) return;

  const src = ctx.createBufferSource();
  src.buffer = pinkBuffer;
  src.loop = true;
  if(o.rate) src.playbackRate.value = o.rate;

  const filter = makeFilter(o.filter || 'bandpass', o.filterFreq || 1200, o.filterQ || 0.9);
  const env = ctx.createGain();
  const peak = (o.gain === undefined ? 0.15 : o.gain) * (duckUntil > now() ? 0.7 : 1);
  adsr(env.gain, t0, o.attack || 0.002, o.decay || 0.05, o.sustain || 0, o.release || 0.1, peak, o.sustainLevel || 0.5);

  src.connect(env);
  if(filter){ env.connect(filter); filter.connect(master); }
  else env.connect(master);

  const sendAmt = o.reverb === undefined ? 0.1 : o.reverb;
  if(sendAmt > 0 && reverbSend){ const send = ctx.createGain(); send.gain.value = sendAmt; env.connect(send); send.connect(reverbSend); }

  src.start(t0, Math.random() * 1.5);
  src.stop(t0 + dur + 0.12);
  trackVoice(src, t0 + dur + 0.12);
}

/* A pitched timpani-ish thump: fast pitch drop + a noise transient. */
function thump(atSec, gain, baseFreq){
  const t0 = at(atSec);
  const g = (gain === undefined ? 0.35 : gain);
  const f = (baseFreq || 78);
  voice({at: atSec, type: 'sine', freq: f * 2.1, freqTo: f * 0.62, freqTime: 0.16, gain: g, attack: 0.002, decay: 0.03, release: 0.2, reverb: 0.05});
  noise({at: atSec, filter: 'lowpass', filterFreq: 380, gain: g * 0.5, attack: 0.001, decay: 0.02, release: 0.09, reverb: 0.04});
}

/* Play an array of note specs back to back. Each note is
   {at (offset s), freq, freqTo, dur, gain, type, ...} — a subset of the
   `tone` options. Relative offsets only, so a motif can be written as
   literal music. */
function seq(notes, o){
  if(!Array.isArray(notes)) return;
  const opts = o || {};
  notes.forEach(n => {
    tone(Object.assign({}, opts, n, {at: (opts.at || 0) + (n.at || 0)}));
  });
}

/* Duck the master bus for `ms` milliseconds down to `to` (0..1) and bring it
   back, so a big stinger makes room for itself. */
function duck(ms, to){
  if(!ctx || !master) return;
  const level = (to === undefined ? 0.45 : to);
  const t = now();
  const dur = Math.max(20, (ms === undefined ? 400 : ms)) / 1000;
  const g = master.gain;
  try{
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(level, t + 0.04);
    g.linearRampToValueAtTime(0.85, t + dur);
  }catch(_){}
  duckUntil = t + dur;
}

/* Public single-oscillator entry point (kept as the `beep` replacement). */
function tone(o){
  if(!enabled) return;
  if(!ctx) return;
  try{ voice(o || {}); }catch(err){ silent(err); }
}

function silent(err){
  try{ console.warn('[OD.Sound]', err || ''); }catch(_){}
}

/* ---------------------------------------------------------------- recipes */

/* Each recipe is a list of steps. `voice`-shaped steps become oscillators,
   `noise`-shaped steps become filtered pink noise, and `thump` steps become
   percussion. minGap is the minimum seconds between two triggers of the
   SAME recipe, which is what stops a fast dice roll from turning to mud. */
function v(at, o){ return Object.assign({kind: 'v', at}, o); }
function n(at, o){ return Object.assign({kind: 'n', at}, o); }
function th(at, gain, base){ return {kind: 't', at, gain, base}; }

const R = Object.freeze({
  'ui.hover': {minGap: 0.05, steps: [v(0, {type: 'sine', freq: 1180, freqTo: 1320, dur: 0.05, gain: 0.035, attack: 0.002, release: 0.05, reverb: 0.05})]},
  'ui.click': {minGap: 0.02, steps: [v(0, {type: 'triangle', freq: 520, freqTo: 430, dur: 0.07, gain: 0.14, attack: 0.002, decay: 0.02, release: 0.05}), v(0.005, {type: 'sine', freq: 1040, freqTo: 900, dur: 0.05, gain: 0.05, release: 0.04, reverb: 0.08})]},
  'ui.toggle': {minGap: 0.02, steps: [v(0, {type: 'square', freq: 660, freqTo: 880, dur: 0.06, gain: 0.09, release: 0.05})]},
  'modal.open': {minGap: 0.05, steps: [v(0, {type: 'sine', freq: 300, freqTo: 620, dur: 0.14, gain: 0.11, attack: 0.006, release: 0.11, reverb: 0.18})]},
  'modal.close': {minGap: 0.05, steps: [v(0, {type: 'sine', freq: 620, freqTo: 260, dur: 0.13, gain: 0.1, attack: 0.005, release: 0.1, reverb: 0.12})]},
  'slider.tick': {minGap: 0.018, steps: [v(0, {type: 'square', freq: 1500, dur: 0.022, gain: 0.05, attack: 0.001, release: 0.02, reverb: 0.03})]},
  'card.play': {minGap: 0.04, steps: [n(0, {filter: 'bandpass', filterFreq: 2400, filterQ: 1.2, dur: 0.11, gain: 0.16, release: 0.1}), v(0, {type: 'triangle', freq: 420, freqTo: 720, dur: 0.1, gain: 0.1, release: 0.08})]},
  'card.draw': {minGap: 0.04, steps: [n(0, {filter: 'highpass', filterFreq: 1800, dur: 0.09, gain: 0.1, release: 0.08, reverb: 0.06}), v(0.02, {type: 'sine', freq: 880, freqTo: 1180, dur: 0.06, gain: 0.05, release: 0.05})]},
  'card.select': {minGap: 0.02, steps: [v(0, {type: 'triangle', freq: 780, freqTo: 980, dur: 0.06, gain: 0.1, release: 0.05})]},
  'card.deselect': {minGap: 0.02, steps: [v(0, {type: 'triangle', freq: 980, freqTo: 660, dur: 0.06, gain: 0.08, release: 0.05})]},
  'loc.claim': {minGap: 0.05, steps: [th(0, 0.2, 92), v(0.02, {type: 'sawtooth', freq: 196, freqTo: 262, dur: 0.14, gain: 0.09, filter: 'lowpass', filterFreq: 900, release: 0.12, reverb: 0.16})]},
  'board.bot_tick': {minGap: 0.03, steps: [v(0, {type: 'square', freq: 340, dur: 0.03, gain: 0.045, attack: 0.001, release: 0.025, reverb: 0.03})]},
  'credit.spend': {minGap: 0.03, steps: [v(0, {type: 'triangle', freq: 880, freqTo: 520, dur: 0.08, gain: 0.09, release: 0.07})]},
  'stat.gain': {minGap: 0.03, steps: [v(0, {type: 'sine', freq: 700, freqTo: 900, dur: 0.09, gain: 0.11, release: 0.08}), v(0.05, {type: 'sine', freq: 950, freqTo: 1250, dur: 0.12, gain: 0.08, release: 0.1, reverb: 0.14})]},
  'stat.loss': {minGap: 0.03, steps: [v(0, {type: 'sine', freq: 380, freqTo: 190, dur: 0.14, gain: 0.11, release: 0.12}), n(0, {filter: 'lowpass', filterFreq: 500, dur: 0.1, gain: 0.06, release: 0.09})]},
  'influence.gain': {minGap: 0.04, steps: [v(0, {type: 'triangle', freq: 523, freqTo: 784, dur: 0.16, gain: 0.1, release: 0.14, reverb: 0.22}), v(0.07, {type: 'sine', freq: 1046, dur: 0.18, gain: 0.06, release: 0.16, reverb: 0.26})]},
  'cap.hit': {minGap: 0.05, steps: [v(0, {type: 'square', freq: 220, freqTo: 165, dur: 0.07, gain: 0.09, filter: 'lowpass', filterFreq: 1100, release: 0.06}), n(0, {filter: 'lowpass', filterFreq: 700, dur: 0.06, gain: 0.05, release: 0.05})]},
  'objective.met': {minGap: 0.1, steps: [v(0, {type: 'triangle', freq: 659, dur: 0.1, gain: 0.09, release: 0.08}), v(0.08, {type: 'triangle', freq: 880, dur: 0.1, gain: 0.09, release: 0.08}), v(0.16, {type: 'sine', freq: 1319, dur: 0.26, gain: 0.08, release: 0.24, reverb: 0.3})]},
  'intrigue.play': {minGap: 0.04, steps: [v(0, {type: 'sawtooth', freq: 330, freqTo: 495, dur: 0.13, gain: 0.08, filter: 'lowpass', filterFreq: 1400, release: 0.11, reverb: 0.2}), n(0.01, {filter: 'bandpass', filterFreq: 3000, filterQ: 2, dur: 0.09, gain: 0.07, release: 0.08})]},
  'turn.ping': {minGap: 0.05, steps: [v(0, {type: 'sine', freq: 880, dur: 0.07, gain: 0.08, release: 0.06, reverb: 0.1}), v(0.06, {type: 'sine', freq: 1320, dur: 0.09, gain: 0.05, release: 0.08, reverb: 0.14})]},
  'turn.pass': {minGap: 0.05, steps: [v(0, {type: 'sine', freq: 660, freqTo: 440, dur: 0.12, gain: 0.07, release: 0.1, reverb: 0.12})]},
  'quiet.round': {minGap: 0.1, steps: [v(0, {type: 'sine', freq: 440, freqTo: 220, dur: 0.3, gain: 0.07, attack: 0.02, release: 0.28, reverb: 0.3})]},
  'skirmish.horn': {
    minGap: 0.15,
    steps: [
      /* The signature sound: a detuned 3-saw brass stack with a slow
         vibrato, a lowpass that opens from 520 to 1500 Hz, a 73 Hz sub for
         body, and a bandpassed noise breath. */
      v(0,     {type: 'sawtooth', freq: 146.83, detune: -11, vibrato: 5.2, vibratoHz: 5.4, dur: 0.62, gain: 0.11, attack: 0.05, sustain: 0.3, sustainLevel: 0.72, release: 0.3, filter: 'lowpass', filterFreq: 520, filterTo: 1500, filterTime: 0.42, filterQ: 3.2, reverb: 0.34, pan: -0.22}),
      v(0.008, {type: 'sawtooth', freq: 146.83, detune: 0,   vibrato: 5.6, vibratoHz: 5.1, dur: 0.62, gain: 0.12, attack: 0.05, sustain: 0.3, sustainLevel: 0.72, release: 0.3, filter: 'lowpass', filterFreq: 520, filterTo: 1500, filterTime: 0.42, filterQ: 3.2, reverb: 0.34}),
      v(0.016, {type: 'sawtooth', freq: 146.83, detune: 12,  vibrato: 5.0, vibratoHz: 5.6, dur: 0.62, gain: 0.11, attack: 0.05, sustain: 0.3, sustainLevel: 0.72, release: 0.3, filter: 'lowpass', filterFreq: 520, filterTo: 1500, filterTime: 0.42, filterQ: 3.2, reverb: 0.34, pan: 0.22}),
      v(0,     {type: 'sine',     freq: 73, dur: 0.6, gain: 0.16, attack: 0.04, sustain: 0.26, sustainLevel: 0.7, release: 0.3, reverb: 0.1}),
      n(0.02,  {filter: 'bandpass', filterFreq: 640, filterQ: 0.8, dur: 0.5, gain: 0.09, attack: 0.06, sustain: 0.22, sustainLevel: 0.5, release: 0.28, reverb: 0.24}),
    ],
  },
  'dice.roll_start': {minGap: 0.1, steps: [v(0, {type: 'triangle', freq: 300, freqTo: 620, dur: 0.12, gain: 0.1, release: 0.1}), n(0, {filter: 'highpass', filterFreq: 2600, dur: 0.16, gain: 0.06, release: 0.14})]},
  'dice.tick': {minGap: 0.028, jitter: 0.16, steps: [v(0, {type: 'square', freq: 300, dur: 0.032, gain: 0.055, attack: 0.001, decay: 0.008, release: 0.02, reverb: 0.03})]},
  'dice.settle': {minGap: 0.05, steps: [v(0, {type: 'sawtooth', freq: 180, freqTo: 150, dur: 0.16, gain: 0.16, filter: 'lowpass', filterFreq: 1400, release: 0.14, reverb: 0.18}), v(0.05, {type: 'sawtooth', freq: 360, dur: 0.13, gain: 0.1, release: 0.12, reverb: 0.2})]},
  'dice.tie': {minGap: 0.08, steps: [v(0, {type: 'sine', freq: 440, dur: 0.1, gain: 0.09, release: 0.08}), v(0.09, {type: 'sine', freq: 415, dur: 0.12, gain: 0.08, release: 0.1, reverb: 0.14})]},
  /* Kill stinger: fall away, hit hard, rise. Ducks the bus so the next
     round starts clean. */
  'stinger.kill': {
    minGap: 0.2,
    duck: {ms: 700, to: 0.5},
    steps: [
      v(0,    {type: 'sawtooth', freq: 330, freqTo: 110, dur: 0.2, gain: 0.11, filter: 'lowpass', filterFreq: 1800, filterTo: 500, filterTime: 0.2, release: 0.1, reverb: 0.18}),
      th(0.2, 0.4, 72),
      th(0.34, 0.28, 64),
      v(0.36, {type: 'sawtooth', freq: 165, freqTo: 440, dur: 0.24, gain: 0.1, filter: 'lowpass', filterFreq: 700, filterTo: 2600, filterTime: 0.24, release: 0.2, reverb: 0.26}),
      n(0.36, {filter: 'bandpass', filterFreq: 1800, filterQ: 0.7, dur: 0.3, gain: 0.1, attack: 0.01, release: 0.28, reverb: 0.26}),
    ],
  },
  'stinger.win': {minGap: 0.15, steps: [v(0, {type: 'triangle', freq: 523, dur: 0.18, gain: 0.13, release: 0.16, reverb: 0.2}), v(0.09, {type: 'triangle', freq: 659, dur: 0.18, gain: 0.13, release: 0.16, reverb: 0.22}), v(0.18, {type: 'triangle', freq: 784, dur: 0.2, gain: 0.13, release: 0.18, reverb: 0.24}), v(0.28, {type: 'sine', freq: 1047, dur: 0.4, gain: 0.11, release: 0.36, reverb: 0.32})]},
  'stinger.loss': {minGap: 0.15, steps: [v(0, {type: 'sine', freq: 392, dur: 0.24, gain: 0.12, release: 0.2, reverb: 0.2}), v(0.13, {type: 'sine', freq: 330, dur: 0.26, gain: 0.11, release: 0.22, reverb: 0.22}), v(0.28, {type: 'sine', freq: 262, dur: 0.46, gain: 0.11, release: 0.4, reverb: 0.3})]},
  'stinger.round': {minGap: 0.1, steps: [v(0, {type: 'triangle', freq: 392, dur: 0.1, gain: 0.08, release: 0.09, reverb: 0.14}), v(0.08, {type: 'triangle', freq: 523, dur: 0.14, gain: 0.08, release: 0.12, reverb: 0.18})]},
  'stinger.final': {minGap: 0.15, steps: [v(0, {type: 'sawtooth', freq: 174.61, dur: 0.5, gain: 0.1, attack: 0.02, sustain: 0.2, sustainLevel: 0.6, release: 0.4, filter: 'lowpass', filterFreq: 700, filterTo: 2200, filterTime: 0.5, reverb: 0.34}), th(0, 0.3, 70), th(0.42, 0.24, 62)]},
  'stinger.matchpoint': {minGap: 0.15, steps: [v(0, {type: 'triangle', freq: 587, freqTo: 880, dur: 0.2, gain: 0.1, release: 0.18, reverb: 0.24}), th(0.2, 0.22, 76), v(0.24, {type: 'sine', freq: 1175, dur: 0.24, gain: 0.07, release: 0.22, reverb: 0.28})]},
  'victory.fanfare': {minGap: 0.2, steps: [v(0, {type: 'triangle', freq: 523, dur: 0.16, gain: 0.12, release: 0.14, reverb: 0.2}), v(0.12, {type: 'triangle', freq: 659, dur: 0.16, gain: 0.12, release: 0.14, reverb: 0.2}), v(0.24, {type: 'triangle', freq: 784, dur: 0.16, gain: 0.12, release: 0.14, reverb: 0.22}), v(0.36, {type: 'sine', freq: 1047, dur: 0.7, gain: 0.12, attack: 0.01, release: 0.6, reverb: 0.36}), th(0.36, 0.26, 78)]},
  'defeat': {minGap: 0.2, steps: [v(0, {type: 'sine', freq: 330, freqTo: 262, dur: 0.4, gain: 0.1, attack: 0.03, release: 0.36, reverb: 0.28}), v(0.36, {type: 'sine', freq: 196, dur: 0.7, gain: 0.1, attack: 0.02, release: 0.6, reverb: 0.34})]},
  'tie': {minGap: 0.2, steps: [v(0, {type: 'triangle', freq: 440, dur: 0.16, gain: 0.09, release: 0.14, reverb: 0.18}), v(0.14, {type: 'triangle', freq: 440, dur: 0.3, gain: 0.09, release: 0.28, reverb: 0.24})]},
});

const RECIPE_NAMES = Object.freeze(Object.keys(R));

/* ------------------------------------------------------------- playback */

function play(name){
  /* Unknown name is a deliberate, safe no-op — a typo in a call site must
     never throw into the game loop. */
  const recipe = R[name];
  if(!recipe) return false;
  if(!enabled) return false;
  if(!hasAudioApi()) return false;

  const t = now();
  const last = lastPlayed[name];
  if(last !== undefined && (t - last) < (recipe.minGap || 0)) return false;
  if(overVoiceBudget(0.4)) return false;

  if(!ctx && !ensure()) return false;
  lastPlayed[name] = now();

  try{
    if(recipe.duck) duck(recipe.duck.ms, recipe.duck.to);
    recipe.steps.forEach(step => {
      /* Pitch jitter keeps repeated hits from sounding machine-gunned. */
      if(recipe.jitter && step.freq){
        const j = 1 + (Math.random() * 2 - 1) * recipe.jitter;
        step = Object.assign({}, step, {freq: step.freq * j});
      }
      if(step.kind === 'n') noise(step);
      else if(step.kind === 't') thump(step.at, step.gain, step.base);
      else voice(step);
    });
    return true;
  }catch(err){
    silent(err);
    return false;
  }
}

function setEnabled(v){
  enabled = !!v;
  storeEnabled(enabled);
  if(enabled){ ensure(); if(master) try{ master.gain.value = 0.85; }catch(_){} }
  return enabled;
}

const Sound = Object.freeze({
  ensure, play, tone, noise, seq, thump, duck, setEnabled,
  recipes: R,
  names: RECIPE_NAMES,
  MAX_VOICES,
  STORAGE_KEY,
  get enabled(){ return enabled; },
  get ready(){ return !!ctx; },
  get voiceCount(){ return liveVoices; },
  /* Test-only: forget the rate limiter without touching the AudioContext. */
  resetRateLimit(){ lastPlayed = Object.create(null); liveVoices = 0; },
});

root.OD = root.OD || {};
root.OD.Sound = Sound;

if(typeof module !== 'undefined' && module.exports) module.exports = {Sound: Sound};

})(typeof globalThis !== 'undefined' ? globalThis : this);
