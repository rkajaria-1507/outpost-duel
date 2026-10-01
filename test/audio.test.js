/* OD.Sound — the recipe table and the node-safe degradation.

   There is no AudioContext in node and that must never be a problem: the
   whole point of the guard is that the module loads and its recipe table is
   inspectable from a plain `node --test` run. */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {Sound} = require('../js/audio.js');

/* The exact set of recipe names features and game.js call by name. Keeping
   this list literal in the test is deliberate: adding a recipe without
   listing it here means nobody has committed to calling it. */
const RECIPES = [
  'ui.hover', 'ui.click', 'ui.toggle',
  'modal.open', 'modal.close',
  'slider.tick',
  'card.play', 'card.draw', 'card.select', 'card.deselect',
  'loc.claim', 'board.bot_tick',
  'credit.spend', 'stat.gain', 'stat.loss', 'influence.gain',
  'cap.hit', 'objective.met', 'intrigue.play',
  'turn.ping', 'turn.pass', 'quiet.round',
  'skirmish.horn',
  'dice.roll_start', 'dice.tick', 'dice.settle', 'dice.tie',
  'stinger.win', 'stinger.kill', 'stinger.loss', 'stinger.round',
  'stinger.final', 'stinger.matchpoint',
  'victory.fanfare', 'defeat', 'tie',
];

/* Silence the deliberate no-op warnings for the duration of a test. */
function quiet(fn){
  const real = console.warn;
  console.warn = () => {};
  try{ return fn(); }
  finally{ console.warn = real; }
}

test('every one of the 36 recipes exists', () => {
  assert.strictEqual(RECIPES.length, 36, 'the spec lists 36 recipe names');
  RECIPES.forEach(name => {
    assert.ok(Sound.recipes[name], 'missing recipe: ' + name);
    assert.ok(Array.isArray(Sound.recipes[name].steps) && Sound.recipes[name].steps.length > 0,
      'recipe ' + name + ' has no steps');
  });
});

test('the recipe table has exactly those 36 keys - no strays, no omissions', () => {
  const actual = Object.keys(Sound.recipes).sort();
  const expected = RECIPES.slice().sort();
  assert.deepStrictEqual(actual, expected);
  assert.deepStrictEqual(Sound.names.slice().sort(), expected);
  assert.ok(Object.isFrozen(Sound.recipes), 'the recipe table is frozen');
});

test('an unknown recipe name is a safe no-op, not a throw', () => {
  assert.strictEqual(quiet(() => Sound.play('nope.not.here')), false);
  assert.strictEqual(quiet(() => Sound.play('')), false);
  assert.strictEqual(quiet(() => Sound.play(undefined)), false);
  assert.doesNotThrow(() => Sound.play('ui.click'));
});

test('every recipe step is a well-formed voice/noise/thump', () => {
  Object.keys(Sound.recipes).forEach(name => {
    Sound.recipes[name].steps.forEach((step, i) => {
      const where = name + '[' + i + ']';
      assert.ok(step && typeof step === 'object', where + ' is not an object');
      assert.ok(['v', 'n', 't'].indexOf(step.kind) !== -1, where + ' has kind ' + step.kind);
      assert.strictEqual(typeof step.at, 'number', where + ' needs a numeric `at` offset');
      if(step.kind === 'v') assert.ok(typeof step.freq === 'number' && step.freq > 0, where + ' needs a positive freq');
      if(step.kind === 't') assert.ok(typeof step.base === 'number', where + ' needs a thump base pitch');
    });
  });
});

test('skirmish.horn is the signature stack: 3 detuned saws, a filter sweep, a 73 Hz sub and noise', () => {
  const horn = Sound.recipes['skirmish.horn'];
  const saws = horn.steps.filter(s => s.type === 'sawtooth');
  assert.ok(saws.length >= 3, 'expected a 3-voice detuned sawtooth stack, got ' + saws.length);
  const detunes = new Set(saws.map(s => s.detune || 0));
  assert.ok(detunes.size >= 3, 'the saws must be detuned from each other');
  saws.forEach(s => {
    assert.ok(s.vibrato > 0 && s.vibratoHz > 0, 'each saw carries a vibrato LFO');
    assert.strictEqual(s.filter, 'lowpass');
    assert.strictEqual(s.filterFreq, 520);
    assert.strictEqual(s.filterTo, 1500, 'the lowpass opens 520 -> 1500 Hz');
    assert.strictEqual(s.filterTime, 0.42, 'over 420 ms');
  });
  assert.ok(horn.steps.some(s => s.type === 'sine' && s.freq === 73), 'sub sine at 73 Hz');
  assert.ok(horn.steps.some(s => s.kind === 'n'), 'bandpassed noise breath');
});

test('stinger.kill falls, thumps twice, rises, and ducks', () => {
  const kill = Sound.recipes['stinger.kill'];
  assert.ok(kill.duck, 'the kill stinger must duck the master bus');
  assert.ok(kill.duck.ms > 0);
  const thumps = kill.steps.filter(s => s.kind === 't');
  assert.ok(thumps.length >= 2, 'double timpani thump');
  assert.ok(thumps[0].at < thumps[1].at, 'thumps are sequential, not simultaneous');
  const saws = kill.steps.filter(s => s.type === 'sawtooth');
  assert.ok(saws.some(s => s.freqTo < s.freq), 'descending motif');
  assert.ok(saws.some(s => s.freqTo > s.freq), 'then ascending');
  assert.ok(kill.steps.some(s => s.kind === 'n'), 'noise tail');
});

test('dice.tick is rate limited and pitch jittered', () => {
  const tick = Sound.recipes['dice.tick'];
  assert.strictEqual(tick.minGap, 0.028, 'rapid dice ticks must not stack into clipping');
  assert.ok(tick.jitter > 0, 'ticks need random pitch jitter');
});

test('rate limiting metadata is present and sane on every recipe', () => {
  Object.keys(Sound.recipes).forEach(name => {
    const r = Sound.recipes[name];
    assert.ok(typeof r.minGap === 'number' && r.minGap >= 0, name + ' needs a numeric minGap');
    assert.ok(r.minGap <= 1, name + ' minGap looks wrong: ' + r.minGap);
  });
  /* the busiest recipes need the tightest gates */
  assert.ok(Sound.recipes['dice.tick'].minGap < Sound.recipes['skirmish.horn'].minGap);
  assert.ok(Sound.recipes['board.bot_tick'].minGap <= Sound.recipes['victory.fanfare'].minGap);
});

test('the public API surface is the documented one, and frozen', () => {
  ['ensure', 'play', 'tone', 'noise', 'seq', 'thump', 'duck', 'setEnabled'].forEach(k => {
    assert.strictEqual(typeof Sound[k], 'function', 'OD.Sound.' + k + ' must be a function');
  });
  assert.strictEqual(typeof Sound.enabled, 'boolean');
  assert.ok(Object.isFrozen(Sound));
  assert.strictEqual(Sound.MAX_VOICES, 24, 'voice cap is a documented constant');
  assert.strictEqual(Sound.STORAGE_KEY, 'od_sound', 'the legacy localStorage key is preserved');
});

test('with no AudioContext present, every entry point is a safe no-op', () => {
  assert.strictEqual(typeof window, 'undefined', 'this test assumes node, not a browser');
  assert.strictEqual(Sound.ready, false);
  assert.strictEqual(Sound.ensure(), null, 'ensure() returns null instead of throwing');
  assert.doesNotThrow(() => Sound.tone({freq: 440, dur: 0.1}));
  assert.doesNotThrow(() => Sound.noise({dur: 0.1}));
  assert.doesNotThrow(() => Sound.seq([{freq: 440, dur: 0.1}], {}));
  assert.doesNotThrow(() => Sound.thump(0, 0.2, 70));
  assert.doesNotThrow(() => Sound.duck(200, 0.5));
  RECIPES.forEach(name => assert.doesNotThrow(() => Sound.play(name)));
});

test('setEnabled round-trips and survives without localStorage', () => {
  const before = Sound.enabled;
  try{
    assert.strictEqual(Sound.setEnabled(false), false);
    assert.strictEqual(Sound.enabled, false);
    assert.strictEqual(Sound.setEnabled(true), true);
    assert.strictEqual(Sound.enabled, true);
    Sound.setEnabled(0);
    assert.strictEqual(Sound.enabled, false, 'coerced to a strict boolean');
  } finally {
    Sound.setEnabled(before);
  }
});

test('Sound.resetRateLimit clears the per-recipe gate', () => {
  Sound.resetRateLimit();
  assert.strictEqual(Sound.voiceCount, 0);
  assert.strictEqual(quiet(() => Sound.play('dice.tick')), false, 'still false: no AudioContext in node');
});
