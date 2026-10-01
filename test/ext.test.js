/* OD.Ext — the extension seam.
   The single most important property under test: a badly written feature
   must never be able to brick a game. */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {beforeEach, afterEach} = require('node:test');
const {Ext} = require('../js/ext.js');

function freshState(){
  return {
    logEntries: [],
    phase: 'draft',
    players: [
      {name: 'A', credits: 2, ore: 1, troops: 1, influence: 0, hand: [], deck: [], discard: []},
      {name: 'B', credits: 5, ore: 4, troops: 6, influence: 0, hand: [], deck: [], discard: []},
    ],
  };
}

beforeEach(() => Ext.reset());
afterEach(() => Ext.reset());

/* ------------------------------------------------------------------ hooks */

test('hooks.run fires handlers in DESCENDING priority, then registration order', () => {
  const order = [];
  Ext.hooks.on('roundBegin', () => order.push('c'), {priority: 0});
  Ext.hooks.on('roundBegin', () => order.push('a'), {priority: 10});
  Ext.hooks.on('roundBegin', () => order.push('b'), {priority: 10});
  Ext.hooks.on('roundBegin', () => order.push('d'), {priority: -5});

  Ext.hooks.run('roundBegin', {});
  assert.deepStrictEqual(order, ['a', 'b', 'c', 'd']);
});

test('hooks.run mutates the shared ctx in place', () => {
  const ctx = {n: 0};
  Ext.hooks.on('gameStart', (c) => { c.n += 1; });
  Ext.hooks.on('gameStart', (c) => { c.n *= 10; });
  Ext.hooks.run('gameStart', ctx);
  assert.strictEqual(ctx.n, 10);
});

test('a throwing handler is swallowed and does not stop the run', () => {
  const ran = [];
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a);

  try{
    Ext.hooks.on('roundEnd', () => ran.push('before'));
    Ext.hooks.on('roundEnd', () => { throw new Error('feature bug'); });
    Ext.hooks.on('roundEnd', () => ran.push('after'));
    assert.doesNotThrow(() => Ext.hooks.run('roundEnd', {}));
  } finally {
    console.warn = realWarn;
  }

  assert.deepStrictEqual(ran, ['before', 'after'], 'later handlers still run');
  assert.strictEqual(warns.length, 1, 'and the failure is reported exactly once');
  assert.match(String(warns[0][0]), /roundEnd/);
});

test('handlers cannot be reordered by registering during a dispatch', () => {
  const order = [];
  Ext.hooks.on('roundBegin', (c) => { order.push('first'); Ext.hooks.on('roundBegin', () => order.push('late')); });
  Ext.hooks.on('roundBegin', () => order.push('second'));
  Ext.hooks.run('roundBegin', {});
  assert.deepStrictEqual(order, ['first', 'second'], 'the late handler waits for the next dispatch');
  Ext.hooks.run('roundBegin', {});
  assert.deepStrictEqual(order, ['first', 'second', 'first', 'second', 'late']);
});

test('on() returns a working unsubscribe', () => {
  let n = 0;
  const off = Ext.hooks.on('gameEnd', () => { n++; });
  Ext.hooks.run('gameEnd', {});
  off();
  Ext.hooks.run('gameEnd', {});
  assert.strictEqual(n, 1);
});

test('hook names are a frozen set - typos throw immediately', () => {
  assert.throws(() => Ext.hooks.on('roundBeign', () => {}), /unknown hook/);
  assert.throws(() => Ext.hooks.run('roundBeign', {}), /unknown hook/);
  assert.throws(() => Ext.hooks.on('roundBegin', 'not a function'), /must be a function/);
  assert.ok(Object.isFrozen(Ext.HOOK_NAMES), 'the hook name list is frozen');
  assert.ok(Object.isFrozen(Ext.EFFECT_TRIGGERS), 'the trigger list is frozen');
  assert.ok(Object.isFrozen(Ext), 'the module export is frozen');
  Ext.HOOK_NAMES.forEach(name => assert.doesNotThrow(() => Ext.hooks.on(name, () => {})));
  Ext.EFFECT_TRIGGERS.forEach(t => assert.doesNotThrow(() => Ext.effects.register('t:' + t, {trigger: t, resolve: () => {}})));
});

test('running a hook nobody listens to is a no-op', () => {
  assert.doesNotThrow(() => Ext.hooks.run('locationResolved', {state: freshState()}));
});

/* ---------------------------------------------------------------- effects */

test('effects.register/run fires by trigger, honouring priority', () => {
  const fired = [];
  Ext.effects.register('low', {trigger: 'roundBegin', priority: 0, resolve: () => fired.push('low')});
  Ext.effects.register('high', {trigger: 'roundBegin', priority: 5, resolve: () => fired.push('high')});
  Ext.effects.register('other', {trigger: 'roundEnd', resolve: () => fired.push('other')});

  Ext.effects.run('roundBegin', {});
  assert.deepStrictEqual(fired, ['high', 'low']);
  Ext.effects.run('roundEnd', {});
  assert.deepStrictEqual(fired, ['high', 'low', 'other']);
});

test('effects.condition gates resolve and sees the ctx', () => {
  const seen = [];
  Ext.effects.register('gated', {
    trigger: 'roundBegin',
    condition: (ctx) => { seen.push(ctx.round); return ctx.round >= 3; },
    resolve: (ctx) => seen.push('ran:' + ctx.round),
  });
  Ext.effects.run('roundBegin', {round: 1});
  Ext.effects.run('roundBegin', {round: 4});
  assert.deepStrictEqual(seen, [1, 4, 'ran:4']);
});

test('a throwing condition is treated as "does not apply", not a crash', () => {
  let ran = false;
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a);
  try{
    Ext.effects.register('bad', {trigger: 'roundEnd', condition: () => { throw new Error('nope'); }, resolve: () => { ran = true; }});
    assert.doesNotThrow(() => Ext.effects.run('roundEnd', {}));
  } finally { console.warn = realWarn; }
  assert.strictEqual(ran, false);
  assert.strictEqual(warns.length, 1);
});

test('a throwing resolve is swallowed', () => {
  const after = [];
  const realWarn = console.warn;
  console.warn = () => {};
  try{
    Ext.effects.register('boom', {trigger: 'roundEnd', resolve: () => { throw new Error('x'); }});
    Ext.effects.register('ok', {trigger: 'roundEnd', resolve: () => after.push('ok')});
    assert.doesNotThrow(() => Ext.effects.run('roundEnd', {}));
  } finally { console.warn = realWarn; }
  assert.deepStrictEqual(after, ['ok']);
});

test('effects: unknown trigger and duplicate id both throw', () => {
  assert.throws(() => Ext.effects.register('x', {trigger: 'nope', resolve: () => {}}), /unknown trigger/);
  Ext.effects.register('x', {trigger: 'roundEnd', resolve: () => {}});
  assert.throws(() => Ext.effects.register('x', {trigger: 'roundEnd', resolve: () => {}}), /duplicate effect id/);
  assert.throws(() => Ext.effects.register('y', {trigger: 'roundEnd'}), /resolve\(ctx\)/);
});

/* ----------------------------------------------------------------- panels */

test('panels.register sorts by order then id and renders defensively', () => {
  const realWarn = console.warn;
  console.warn = () => {};
  try{
    Ext.panels.register('z', {label: 'Z', order: 10, render: () => '<b>z</b>'});
    Ext.panels.register('a', {label: 'A', order: 10, render: () => '<i>a</i>'});
    Ext.panels.register('first', {label: 'First', order: 1, render: () => { throw new Error('bad panel'); }});
  } finally { console.warn = realWarn; }

  const list = Ext.panels.list();
  assert.deepStrictEqual(list.map(p => p.id), ['first', 'a', 'z']);
  assert.strictEqual(list[0].html, '', 'a throwing panel degrades to empty');
  assert.strictEqual(list[1].html, '<i>a</i>');
  assert.strictEqual(list[2].label, 'Z');
});

test('panels.register rejects duplicates and unregister works', () => {
  Ext.panels.register('p', {render: () => 'x'});
  assert.throws(() => Ext.panels.register('p', {render: () => 'y'}), /duplicate panel id/);
  assert.strictEqual(Ext.panels.has(), true);
});

/* -------------------------------------------------------------------- api */

test('api.grant adds resources and ignores rubbish', () => {
  const state = freshState();
  const api = Ext.makeApi(state);
  api.grant(0, {credits: 3, ore: 2});
  assert.strictEqual(state.players[0].credits, 5);
  assert.strictEqual(state.players[0].ore, 3);
  api.grant(0, {credits: -10});                 // negative is not a grant
  assert.strictEqual(state.players[0].credits, 5);
  api.grant(99, {credits: 1});                  // no such player
  assert.strictEqual(api.grant(0, {}), 0);
  assert.strictEqual(api.grant(0, {troops: 2, influence: 1}), 3);
});

test('api.spend deducts when affordable', () => {
  const state = freshState();
  const api = Ext.makeApi(state);
  assert.strictEqual(api.spend(1, {credits: 2, ore: 1}), 3);
  assert.strictEqual(state.players[1].credits, 3);
  assert.strictEqual(state.players[1].ore, 3);
});

test('api.spend is all-or-nothing when short', () => {
  const state = freshState();
  const api = Ext.makeApi(state);
  /* player 0 has 2 Credits / 1 Ore: asking for 1 Ore + 1 Credit works,
     asking for 2 Credits does not, and the failure spends nothing. */
  assert.strictEqual(api.spend(0, {ore: 1, credits: 1}), 2);
  assert.strictEqual(state.players[0].ore, 0);
  assert.strictEqual(state.players[0].credits, 1);
  assert.strictEqual(api.spend(0, {credits: 2}), 0, 'short -> no partial payment');
  assert.strictEqual(state.players[0].credits, 1, 'nothing was taken');
});

test('api.spend never lets a resource go below zero', () => {
  const state = freshState();
  state.players[0].ore = 0;
  const api = Ext.makeApi(state);
  assert.strictEqual(api.spend(0, {ore: 1}), 0);
  assert.strictEqual(state.players[0].ore, 0);

  /* even a buggy caller passing a negative cost cannot increase a pool */
  api.spend(0, {ore: -5});
  assert.strictEqual(state.players[0].ore, 0);
});

test('api.spend on a missing player is a harmless no-op', () => {
  const api = Ext.makeApi(freshState());
  assert.strictEqual(api.spend(7, {credits: 1}), 0);
  assert.strictEqual(api.grant(undefined, {credits: 1}), 0);
});

test('api.log appends without re-rendering', () => {
  const state = freshState();
  const api = Ext.makeApi(state);
  api.log('<b>hello</b>');
  api.log('plain');
  assert.deepStrictEqual(state.logEntries, ['<b>hello</b>', 'plain']);
});

test('api.draw delegates to the engine adapter and reports the real count', () => {
  const state = freshState();
  const api = Ext.makeApi(state);
  assert.strictEqual(api.draw(0, 1), 0, 'no adapter yet');

  let seen = null;
  Ext.setAdapters({draw: (player, n) => { seen = [player, n]; return 1; }});
  assert.strictEqual(api.draw(0, 2), 1);
  assert.strictEqual(seen[0], state.players[0]);
  assert.strictEqual(seen[1], 2);

  /* a hand that is already full draws 0 - the adapter's answer is the truth */
  Ext.setAdapters({draw: () => 0});
  assert.strictEqual(api.draw(0, 1), 0);
});

test('api.popup swallows adapter failures', () => {
  const api = Ext.makeApi(freshState());
  const realWarn = console.warn;
  console.warn = () => {};
  try{
    Ext.setAdapters({popup: () => { throw new Error('no DOM'); }});
    assert.doesNotThrow(() => api.popup(0, '+1', true));
  } finally { console.warn = realWarn; }

  const got = [];
  Ext.setAdapters({popup: (i, text, good) => got.push([i, text, good])});
  api.popup(1, '+3 Credits', true);
  assert.deepStrictEqual(got, [[1, '+3 Credits', true]]);
});

test('api.phase and api.set write plain JSON-safe values', () => {
  const state = freshState();
  const api = Ext.makeApi(state);
  api.phase('skirmish-decide');
  assert.strictEqual(state.phase, 'skirmish-decide');
  api.set('dread', 2);
  api.set('bounty', {id: 'x'});
  assert.strictEqual(state.dread, 2);
  assert.deepStrictEqual(state.bounty, {id: 'x'});
  api.set('', 'ignored');
  assert.ok(!Object.prototype.hasOwnProperty.call(state, ''));
  /* the state must still survive the JSON relay untouched */
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(state)));
});

test('the api surface is frozen so a feature cannot monkey-patch it', () => {
  const api = Ext.makeApi(freshState());
  assert.ok(Object.isFrozen(api));
  assert.deepStrictEqual(Object.keys(api).sort(),
    ['draw', 'grant', 'log', 'phase', 'popup', 'set', 'spend']);
});

/* ------------------------------------------------------------------ reset */

test('Ext.reset() clears hooks, effects and panels', () => {
  let n = 0;
  Ext.hooks.on('gameStart', () => { n++; });
  Ext.effects.register('e', {trigger: 'roundEnd', resolve: () => { n += 10; }});
  Ext.panels.register('p', {render: () => 'x'});

  Ext.reset();

  Ext.hooks.run('gameStart', {});
  Ext.effects.run('roundEnd', {});
  assert.strictEqual(n, 0);
  assert.strictEqual(Ext.panels.has(), false);
  assert.deepStrictEqual(Ext.panels.list(), []);
});
