/* THE BOARD TABLE MUST HAVE EXACTLY ONE AUTHORITY — a structural test.

   js/game.js holds the real board: LOCATIONS[].<tier>.cost. js/feature-chaos.js
   used to hold a SECOND copy of it (SITES[id].advCost), and the two disagreed
   for three of the eight sites — Outpost, Bazaar and Shrine — because the real
   price for those three was hardcoded inside applyLocationEffect()'s switch and
   their `cost` field was left empty. The Rift's Toll and Open Hands mutations
   could only see the copy, so the game charged a player 5 Credits + 3 Ore for a
   Rift-of-Outpost and then logged "Open Hands: Advanced was free anyway", and
   Toll silently charged nothing at all for those sites.

   This file is the regression guard for that class of defect. It runs with NO
   DOM: it requires the two modules in index.html load order, which is why
   game.js wraps its page wiring in onDom() (see the PAGE WIRING MARKER) and
   publishes its board table through module.exports and OD.Board. */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

/* index.html load order, and it matters: the feature installs against
   OD.Ext, and the engine's OD.Board seam is published by the file that loads
   LAST. Requiring them in any other order is exactly the drift this test is
   here to prevent. */
require('../js/ext.js');
require('../js/audio.js');
require('../js/fx.js');
require('../js/rules.js');
require('../js/feature-wagers.js');
const {Chaos} = require('../js/feature-chaos.js');
const Engine = require('../js/game.js');

const LOCATIONS = Engine.LOCATIONS;
const SITES = Chaos.SITES;

const SITE_IDS = LOCATIONS.map(l => l.id);
const RES = Engine.COST_RESOURCES;
const nonzero = (cost)=> RES.filter(res => ((cost && cost[res]) || 0) > 0);

/* --------------------------------------------------- the board is one table */

test('SITES and LOCATIONS cover exactly the same eight site ids', ()=>{
  assert.deepStrictEqual(Object.keys(SITES).slice().sort(), SITE_IDS.slice().sort());
  assert.strictEqual(SITE_IDS.length, 8, 'the board is eight sites');
});

test('every site id is unique and non-empty in LOCATIONS', ()=>{
  assert.strictEqual(new Set(SITE_IDS).size, SITE_IDS.length, 'duplicate site id in LOCATIONS');
  SITE_IDS.forEach(id => assert.ok(id && typeof id === 'string', 'bad site id: ' + id));
});

test('every site has both tiers, each with a cost object', ()=>{
  LOCATIONS.forEach(loc=>{
    assert.ok(loc.basic, loc.id + ' has no basic tier');
    assert.ok(loc.advanced, loc.id + ' has no advanced tier');
    ['basic','advanced'].forEach(tier=>{
      assert.ok(loc[tier].cost && typeof loc[tier].cost === 'object',
        loc.id + '.' + tier + ' has no cost object');
      RES.forEach(res=>{
        const v = loc[tier].cost[res];
        assert.ok(v === undefined || (typeof v === 'number' && v >= 0),
          loc.id + '.' + tier + '.' + res + ' is not a non-negative number: ' + v);
      });
    });
  });
});

/* ------------------------------------------------ THE BLOCKER 1 REGRESSION */

test('EVERY site has a real Advanced cost — none of them empty', ()=>{
  /* The specific defect: outpost / shrine / bazaar carried `cost:{}` while
     applyLocationEffect charged 5C+3O, 2C+1O and a 2-Ore trade respectively. */
  const priced = LOCATIONS.filter(l => nonzero(Engine.tierCost(l.id, 'advanced')).length > 0);
  assert.strictEqual(priced.length, LOCATIONS.length,
    'these Advanced tiers are priced nothing: ' +
    LOCATIONS.filter(l => nonzero(Engine.tierCost(l.id, 'advanced')).length === 0).map(l => l.id).join(', '));
});

test('SITES and LOCATIONS agree on Advanced cost for every site id', ()=>{
  SITE_IDS.forEach(id=>{
    const fromEngine = Engine.tierCost(id, 'advanced');
    const fromFeature = Chaos.advancedCost(id);
    assert.deepStrictEqual(
      {credits: fromFeature.credits, ore: fromFeature.ore, troops: fromFeature.troops},
      {credits: fromEngine.credits, ore: fromEngine.ore, troops: fromEngine.troops},
      id + ': js/feature-chaos.js and js/game.js disagree on the Advanced cost');
  });
});

test('SITES carries no cost of its own — it cannot drift', ()=>{
  /* Not "SITES.advCost happens to match today". The field must be ABSENT, so
     there is nothing left for a rebalance in game.js to leave behind. This is
     the assertion that would have caught the original mirror. */
  Object.keys(SITES).forEach(id=>{
    assert.ok(!('advCost' in SITES[id]),
      'SITES.' + id + '.advCost exists — the feature is keeping a second copy of the board price');
    assert.ok(!('basicCost' in SITES[id]), 'SITES.' + id + '.basicCost exists');
  });
});

test('the Advanced costs the feature reads are the ones the engine debits', ()=>{
  /* Belt and braces on the seam itself: takeCost() is what actually moves the
     numbers, so the price it removes must be the price the feature prices the
     Rift against. */
  SITE_IDS.forEach(id=>{
    const cost = Engine.tierCost(id, 'advanced');
    const player = {credits: 8, ore: 8, troops: 8};
    const spent = Engine.takeCost(player, cost);
    const advertised = Chaos.advancedCost(id);
    assert.strictEqual(spent.credits, advertised.credits, id + ': Credits debited vs advertised');
    assert.strictEqual(spent.ore, advertised.ore, id + ': Ore debited vs advertised');
    assert.strictEqual(spent.troops, advertised.troops, id + ': Troops debited vs advertised');
  });
});

test('the three consolation tiers are flagged so their printed fallback stays reachable', ()=>{
  /* Outpost / Bazaar / Shrine print "(else +N)". Filling in their real price
     must not have greyed out a choice the rules text promises. */
  ['outpost','bazaar','shrine'].forEach(id=>{
    assert.ok(Engine.tierIsAlwaysTakeable(id, 'advanced'), id + ' lost its consolation flag');
  });
  ['market','quarry','garrison','archive','foundry'].forEach(id=>{
    assert.ok(!Engine.tierIsAlwaysTakeable(id, 'advanced'), id + ' is not a consolation tier and must not claim to be');
  });
});

test('costPhrase names every resource in a multi-resource price', ()=>{
  assert.strictEqual(Engine.costPhrase(Engine.tierCost('outpost','advanced')), '5 Credits + 3 Ore');
  assert.strictEqual(Engine.costPhrase(Engine.tierCost('shrine','advanced')), '2 Credits + 1 Ore');
  assert.strictEqual(Engine.costPhrase(Engine.tierCost('market','advanced')), '1 Ore');
  assert.strictEqual(Engine.costPhrase(Engine.tierCost('shrine','basic')), '');
  /* The feature prints the same sentence from the same numbers. */
  assert.strictEqual(Chaos.costPhrase(Chaos.advancedCost('outpost')), '5 Credits + 3 Ore');
});

/* ------------------------------------------------------- no DOM was needed */

test('the board table was reachable with no document and no window', ()=>{
  assert.strictEqual(typeof document, 'undefined', 'this test is supposed to run DOM-free');
  assert.strictEqual(typeof window, 'undefined', 'this test is supposed to run DOM-free');
  assert.ok(globalThis.OD && globalThis.OD.Board, 'the engine must publish its board table on OD.Board');
  assert.deepStrictEqual(globalThis.OD.Board.siteIds().slice().sort(), SITE_IDS.slice().sort());
});