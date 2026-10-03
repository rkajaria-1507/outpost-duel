/* ---------------------------------------------------------------------
   BALANCE HARNESS — self-tests.

   WHAT THIS FILE IS FOR
   --------------------
   test/balance.sim.js is an instrument, and an instrument that silently stops
   measuring is worse than no instrument: the next engineer retunes site values
   and the Collapse clock against a number that was quietly computed from three
   games, or from a ledger that stopped crediting the Surge, and the retune
   makes the game worse while the report says it got better.

   So this file tests the HARNESS, not the game. It does not assert that
   Outpost is too strong or that combat should pay more - those are design
   questions with answers that are allowed to change. It asserts only things
   that must be true of the measurement apparatus for its output to mean
   anything:

     1. the harness loads the engine in index.html's order, and nothing else;
     2. a batch of real games runs to completion without error or hang;
     3. every game passed the per-game invariants;
     4. the Influence attribution reconciles EXACTLY, per game, to the two
        seats' final Influence - this is the load-bearing assertion in the
        whole file. A ledger that loses a point is a ledger that will happily
        report 44% when the truth is 40%;
     5. the seeded RNG really is seeded: the same seed replays identically;
     6. the aggregate block and the headline map have the shape the report and
        `--check` assume, and their shares add up;
     7. test/balance.baseline.json on disk has the shape `--check` reads, so a
        stale or hand-edited baseline is caught here rather than silently
        gating nothing;
     8. the intervention list is well formed and `--check` rejects an unknown
        name.

   WHY IT IS FAST
   --------------
   58 real games is about a second. Everything expensive - the 4,500-game
   report, the noise floor, the full runAll - is behind OD_SIM=1, matching the
   convention test/skirmish-odds.test.js already established. `npm test` stays
   around a second and a half; `npm run balance` is the heavy one.

   Note what is NOT asserted here: that a headline number lands inside its
   tolerance band. That is `--check`'s job, it needs the recorded baseline, and
   a test that only fails when somebody has already re-baselined it is not a
   test. What IS asserted is that the machinery which produces those numbers
   is intact.
   --------------------------------------------------------------------- */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* Requiring the simulator installs the fake DOM, the seeded PRNG, the
   synchronous timer queue and the OD.Ext hooks, and loads js/*.js in
   index.html order. Its `main()` is guarded by `require.main === module`, so
   nothing runs until this file asks for it. */
const Sim = require('./balance.sim.js');

const N_BASE = 50;
const N_SEAT = 2;
const SIM_SEED = 424242;

/* One shared batch per configuration, built once at module scope and asserted
   from several tests. Playing 58 games once instead of three times is the
   difference between this file costing a second and costing three. */
const BASE_RECORDS = Sim.runBatch({
  games:N_BASE, seed:SIM_SEED, difficulty:'normal', mode:'local', seats:null,
  label:'self-test baseline',
});
const HUMAN_RECORDS = Sim.runBatch({
  games:N_SEAT, seed:SIM_SEED + 1, difficulty:'hard', mode:'local',
  seats:['human','bot'], label:'self-test human vs bot',
});
const HOTSEAT_RECORDS = Sim.runBatch({
  games:N_SEAT, seed:SIM_SEED + 2, difficulty:'easy', mode:'local',
  seats:['human','human'], label:'self-test hotseat',
});
const ALL_RECORDS = BASE_RECORDS.concat(HUMAN_RECORDS, HOTSEAT_RECORDS);

/* ==================================================================
   1. The engine the harness measures
   ================================================================== */

test('the harness measures index.html\'s game and nothing else', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const tags = [];
  const re = /<script[^>]*\ssrc="js\/([^"]+)"/g;
  let m;
  while((m = re.exec(html)) !== null) tags.push(m[1]);
  assert.deepStrictEqual(tags,
    ['ext.js','audio.js','fx.js','rules.js','feature-wagers.js','feature-chaos.js','game.js'],
    'index.html\'s script list changed; the harness must measure what the page ships');
  /* And both features really are installed - a missing feature-chaos.js would
     silently remove the Rift, the Bounties and the Collapse, and the report
     would then be a description of a game nobody plays. */
  assert.ok(globalThis.OD, 'OD must exist');
  assert.ok(globalThis.OD.Chaos, 'feature-chaos.js must be installed');
  assert.ok(globalThis.OD.Wagers, 'feature-wagers.js must be installed');
  assert.ok(globalThis.OD.Rules, 'rules.js must be installed');
  assert.strictEqual(Sim.ALL_SITES.length, 9,
    'eight sites plus the Rift - the harness must be told about all nine');
  /* The attribution is only as good as the hook windows it diffs across, so the
     harness has to be holding registrations for all of them. Losing one is
     silent: the ledger just stops growing for that source. */
  assert.ok(Sim.installedHooks() >= 8,
    'only ' + Sim.installedHooks() + ' OD.Ext hooks are registered; the attribution needs one per window');
});

/* ==================================================================
   2. Games complete, and the attribution reconciles
   ================================================================== */

test('58 games complete without error, deadlock or stall', () => {
  /* runBatch() THROWS on the first game with any recorded error, so reaching
     this line at all is the assertion. It is asserted again explicitly so the
     failure message names the count rather than surfacing as a stack trace. */
  assert.strictEqual(ALL_RECORDS.length, N_BASE + 2 * N_SEAT);
  ALL_RECORDS.forEach(r=>{
    assert.strictEqual(r.errors.length, 0,
      'seed ' + r.seed + ' reported: ' + r.errors.join('; '));
    assert.strictEqual(r.phase, 'ended', 'seed ' + r.seed + ' never reached "ended"');
    assert.strictEqual(r.rounds, 6, 'seed ' + r.seed + ' did not play 6 rounds');
    assert.strictEqual(r.skirmishRounds > 0, true,
      'seed ' + r.seed + ' played no Skirmish at all - the harness is not driving combat');
  });
});

test('the attribution reconciles EXACTLY to the final Influence of both seats', () => {
  /* THE assertion. Influence is never capped - applyCaps() only touches
     Credits, Ore and Troops - so no hook window can lose a point or invent
     one, and the ledger must therefore sum to the seats' final totals to the
     point. Anything else means a window is missing an Influence write, and
     every share in the report is then wrong in a way nothing downstream can
     detect. Tolerance here is zero, not "small". */
  ALL_RECORDS.forEach(r=>{
    const attributed = Object.keys(r.ledger).reduce((s,k)=> s + r.ledger[k].points, 0);
    const final = r.influence[0] + r.influence[1];
    assert.strictEqual(attributed, final,
      'seed ' + r.seed + ': attributed ' + attributed + ' != final ' + final
      + ' (unattributed ' + r.ledger.unattributed.points + ')');
    assert.strictEqual(r.ledger.unattributed.points, 0,
      'seed ' + r.seed + ' left Influence unattributed');
    /* And per seat, not just in total: a window that credited seat 1 for
       seat 2's point and cancelled out is still a broken instrument. */
    for(let i = 0; i < 2; i++){
      const bySeat = Object.keys(r.ledger).reduce((s,k)=> s + r.ledger[k].bySeat[i], 0);
      assert.strictEqual(bySeat, r.influence[i],
        'seed ' + r.seed + ', seat ' + i + ': attributed ' + bySeat + ' != ' + r.influence[i]);
    }
  });
});

test('every scoring source actually fires, and no source is a silent zero', () => {
  /* A source that is listed but never credited is either a dead ledger entry
     or a window that stopped running. Either way the report would print a
     confident 0.0% for a system nobody has looked at. */
  const firing = {};
  BASE_RECORDS.forEach(r=>{
    Sim.SOURCES.forEach(k=>{ if(r.ledger[k].events > 0) firing[k] = (firing[k] || 0) + 1; });
  });
  ['skirmish','surge','objective','bounty','collapse','intrigue','rift','site:outpost','site:shrine']
    .forEach(k=>{
      assert.ok(firing[k] > N_BASE * 0.3,
        k + ' fired in only ' + (firing[k] || 0) + ' of ' + N_BASE + ' games - the window may be dead');
    });
  /* The Collapse is a TRANSFER, so its net is 0 by construction. It must still
     have moved Influence, or the tick is not running. */
  const collapseMoved = BASE_RECORDS.reduce((s,r)=> s + r.ledger.collapse.gross, 0);
  assert.ok(collapseMoved > 0,
    'the Collapse window recorded no movement at all - tickDread is not running');
});

/* ==================================================================
   3. Determinism - the property `--check` is built on
   ================================================================== */

test('the same seed replays to identical numbers', () => {
  /* `--check` is only a gate because unchanged code + unchanged seed produces
     unchanged figures. If this drifts, `--check` fails on nothing and a real
     rebalance could hide inside it.

     The replay is compared against a record the batch above already computed,
     so this costs ONE extra game rather than three: the second half of the
     assertion - that two DIFFERENT seeds really do produce different games -
     is answered for free by two records that already exist. */
  const a = BASE_RECORDS[0];
  const b = Sim.playGame({
    seed:a.seed, mode:'local', seats:null, difficulty:'normal', label:'determinism replay',
  });
  assert.deepStrictEqual(b.influence, a.influence, 'the same seed scored differently');
  assert.deepStrictEqual(b.picks, a.picks, 'the same seed drafted differently');
  assert.deepStrictEqual(b.objectiveId, a.objectiveId, 'the same seed dealt different objectives');
  Sim.SOURCES.forEach(k=>{
    assert.strictEqual(b.ledger[k].points, a.ledger[k].points,
      'source ' + k + ' moved between two identical seeds');
  });
  /* And two records from the same batch, different seeds, must NOT be
     identical - or the "determinism" above would just be a frozen constant. */
  const c = BASE_RECORDS[1];
  assert.ok(a.seed !== c.seed, 'the batch reused one seed');
  assert.ok(JSON.stringify(a.influence) !== JSON.stringify(c.influence)
    || JSON.stringify(a.picks) !== JSON.stringify(c.picks),
    'two different seeds produced byte-identical games - the PRNG is not seeded');
});

/* ==================================================================
   4. The report's own arithmetic
   ================================================================== */

test('the aggregate block has the shape the report and --check assume', () => {
  const b = Sim.block(BASE_RECORDS, 'self-test');
  assert.strictEqual(b.games, N_BASE);
  assert.strictEqual(b.sites.length, 9);
  assert.strictEqual(b.sources.length, 7 + 8,
    'seven non-site sources (Skirmish, Rift, Surge, Objectives, Collapse, Bounties, Intrigue) plus the eight sites');
  assert.strictEqual(b.objectives.length, 6);
  assert.ok(b.leaders.length >= 1);

  /* Shares are computed against the ledger, so they must add to 100%. */
  const sum = b.sources.reduce((s,x)=> s + x.sharePct, 0);
  const unattributedPct = b.unattributedPoints / b.totalPoints * 100;
  assert.ok(Math.abs(sum + unattributedPct - 100) < 0.01,
    'source shares sum to ' + (sum + unattributedPct) + '%, not 100%');
  assert.strictEqual(b.reconcile.unattributed, 0);
  assert.strictEqual(b.totalPoints, b.totalInfluence);

  /* "Top site" has to be a fact about the run, not about the LOCATIONS table's
     order - so it is asserted to be the maximum. */
  const max = b.sites.reduce((s,x)=> Math.max(s, x.points), -1);
  assert.strictEqual(b.topSite.points, max);
  b.sites.forEach(s=>{
    assert.ok(Number.isFinite(s.influencePerPick), s.id + ' influencePerPick is not finite');
    assert.ok(s.picks > 0, s.id + ' was never drafted in ' + b.games + ' games');
    assert.ok(s.advancedPicks <= s.picks, s.id + ' has more advanced picks than picks');
  });
  /* Influence per pick can legitimately be 0 (a site that pays Credits), but it
     can never be NaN, which is what a divide-by-zero would look like. */
  assert.ok(Number.isFinite(b.combat.sharePct));
  assert.ok(Number.isFinite(b.combat.pointsPerFight));
  assert.ok(Number.isFinite(b.economy.capDiscardEventsPerGame));
  assert.ok(Number.isFinite(b.economy.unitsDestroyedPerGame));
  [0,1].forEach(i=>{
    assert.ok(Number.isFinite(b.economy.finalPools[i].credits), 'final pool ' + i + ' is not finite');
  });
});

test('the headline map covers every gated dimension and every key has a tolerance', () => {
  /* A miniature report is built here rather than a real one, because what is
     under test is the KEY SET - the names --check looks up - and not the
     values, which the OD_SIM run and the baseline already cover. */
  const block = Sim.block(BASE_RECORDS, 'self-test');
  const h = Sim.headline({
    baseline:block,
    difficulty:[
      {id:'easy',meanInfluencePerSeat:1},
      {id:'normal',meanInfluencePerSeat:1},
      {id:'hard',meanInfluencePerSeat:1},
    ],
    difficultySeparation:{pts:0},
    systems:[{id:'no-combat',deletable:true,winnerChangedPct:1}],
    seats:[{id:'human-bot',meanInfluencePerSeat:1}],
  });
  ['attribution.reconcileMax','attribution.totalPointsPerGame','topSite.id','topSite.sharePct',
   'combat.sharePct','combat.fightsPerGame','difficulty.separationPts',
   'economy.capDiscardEventsPerGame','economy.unitsDestroyedPerGame','economy.drawsRefusedPerGame']
    .forEach(k=>{ assert.ok(k in h, 'headline is missing ' + k); });
  assert.ok('sites.outpost.sharePct' in h);
  assert.ok('sites.rift.sharePct' in h);
  assert.ok('objectives.archivist.ratePct' in h);
  assert.ok('leaders.diplomat.meanInfluence' in h);
  assert.strictEqual(h['systems.no-combat.winnerChangedPct'], 1);
  assert.strictEqual(h['difficulty.easy.meanInfluencePerSeat'], 1);
  assert.strictEqual(h['seats.human-bot.meanInfluencePerSeat'], 1);
  /* And the top site is recorded by ID, so a change of dominance can be
     detected exactly rather than as "some share moved". */
  assert.strictEqual(h['topSite.id'], block.topSite.id);

  /* Every headline key must resolve to a BOUNDED tolerance. An ungated metric
     is a metric someone will trust without checking, so the harness refuses to
     build one silently. */
  Object.keys(h).forEach(k=>{
    const t = Sim.toleranceFor(k);
    assert.ok(t !== undefined, k + ' has no tolerance rule');
    assert.ok(Number.isFinite(t.abs),
      k + ' resolves to an UNBOUNDED tolerance - reported but not gated');
  });
});

/* ==================================================================
   5. The intervention list - the extensibility claim
   ================================================================== */

test('the intervention list is well formed, and an unknown name is refused', () => {
  const ids = Sim.INTERVENTIONS.map(i=>i.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate intervention id');
  Sim.INTERVENTIONS.forEach(i=>{
    assert.ok(typeof i.id === 'string' && i.id.length, 'an intervention has no id');
    assert.ok(typeof i.label === 'string' && i.label.length > 8,
      i.id + ' has no human-readable label');
    assert.strictEqual(typeof i.deletable, 'boolean', i.id + ' does not say whether it is quotable');
  });
  assert.ok(ids.includes('none'), 'there must be an explicit baseline entry');
  assert.ok(Sim.INTERVENTIONS.some(i=>i.deletable),
    'at least one intervention has to be a real delete-a-system counterfactual');
  /* Dots in an id would break the dotted tolerance path (systems.*.<id>). */
  ids.forEach(id=>{ assert.strictEqual(id.indexOf('.'), -1, 'intervention id "' + id + '" contains a dot'); });

  assert.strictEqual(Sim.intervention('no-combat').noCombat, true);
  assert.throws(()=>Sim.intervention('no-such-thing'), /no intervention called/,
    'an unknown intervention name must be refused loudly');
});

test('--check argument parsing cannot be talked into skipping the gate', () => {
  assert.strictEqual(Sim.parseArgs([]).check, false);
  assert.strictEqual(Sim.parseArgs([]).write, true, 'a plain run must write the baseline');
  assert.strictEqual(Sim.parseArgs(['--check']).check, true);
  assert.strictEqual(Sim.parseArgs(['--check']).write, false,
    '--check must never rewrite the baseline it is checking against');
  assert.strictEqual(Sim.parseArgs(['--no-write']).write, false);
  assert.strictEqual(Sim.parseArgs(['--seed','7']).seed, 7);
  assert.throws(()=>Sim.parseArgs(['--wat']), /unknown argument/);
});

/* ==================================================================
   6. The baseline file on disk
   ================================================================== */

test('test/balance.baseline.json has the shape --check reads', () => {
  assert.ok(fs.existsSync(Sim.BASELINE_PATH),
    'no baseline at ' + Sim.BASELINE_PATH + ' - run `npm run balance`');
  const doc = JSON.parse(fs.readFileSync(Sim.BASELINE_PATH, 'utf8'));
  assert.strictEqual(doc.version, Sim.BASELINE_VERSION,
    'the baseline is a different version; --check refuses it by design');
  assert.ok(Array.isArray(doc.engine.scriptOrder) && doc.engine.scriptOrder.length === 7);
  assert.strictEqual(typeof doc.config.seed, 'number');
  assert.ok(doc.config.games >= 100, 'a baseline from fewer than 100 games is not a baseline');
  assert.ok(doc.tolerances && Object.keys(doc.tolerances).length >= 10);
  /* Every tolerance rule needs a REASON. A bare number in a tolerance table is
     an arbitrary number, and the next engineer cannot argue with it. */
  Object.keys(doc.tolerances).forEach(k=>{
    assert.strictEqual(typeof doc.tolerances[k].abs, 'number', k + ' has no numeric tolerance');
    assert.ok(typeof doc.tolerances[k].why === 'string' && doc.tolerances[k].why.length > 10,
      k + ' has no stated reason');
  });
  assert.ok(doc.headline && Object.keys(doc.headline).length >= 30,
    'the recorded headline set is too small to be a gate');
  /* Only the residual is pinned to an exact value, because it is the one
     headline that is an ASSERTION rather than a measurement: a baseline written
     from a run whose ledger lost a point would otherwise be recorded as the
     truth and quietly re-agreed with forever. The rest must simply be real
     numbers inside a plausible range. */
  assert.strictEqual(doc.headline['attribution.reconcileMax'], 0,
    'the recorded run left Influence unattributed - never baseline a broken run');
  ['topSite.sharePct','combat.sharePct','difficulty.separationPts','economy.capDiscardEventsPerGame']
    .forEach(k=>{
      const v = doc.headline[k];
      assert.ok(typeof v === 'number' && isFinite(v) && v > 0,
        k + ' is recorded as ' + v + ' - the baseline looks corrupt');
    });
  assert.ok(doc.headline['topSite.sharePct'] <= 100);
  assert.ok(doc.headline['combat.sharePct'] <= 100);
  assert.strictEqual(typeof doc.topSiteId, 'string');
  assert.ok(doc.full && doc.full.baseline && doc.full.systems && doc.full.difficulty,
    'the baseline must carry the whole report, not only the headline set');
  assert.ok(doc.full.baseline.games > 0);
  /* Six objectives, every one measured, none of them outside its own interval -
     the same property the report prints in section 5. */
  assert.strictEqual(doc.full.baseline.objectives.length, 6);
  doc.full.baseline.objectives.forEach(o=>{
    assert.ok(o.n > 0, o.id + ' has no observations in the recorded run');
    assert.ok(o.ratePct >= 0 && o.ratePct <= 100, o.id + ' rate is out of range');
    assert.ok(o.wilsonLoPct <= o.ratePct + 0.001 && o.ratePct <= o.wilsonHiPct + 0.001,
      o.id + ' rate sits outside its own Wilson interval');
  });
});

/* ==================================================================
   7. The heavy run, gated
   ================================================================== */

test('the full report runs end to end and every headline metric is gated', {
  skip: process.env.OD_SIM ? false
    : 'set OD_SIM=1 to run the whole report (4,500 games, a couple of minutes)',
}, ()=>{
  /* Deliberately small counts: this is a SHAPE test over the real
     runAll(), not a second copy of the numbers in the baseline. */
  const rep = Sim.runAll({seed:5150, games:60, seatGames:10, diffGames:20, ivGames:15});
  assert.strictEqual(rep.baseline.games, 60);
  assert.strictEqual(rep.seats.length, 2);
  assert.strictEqual(rep.difficulty.length, 3);
  assert.strictEqual(rep.systems.length, Sim.INTERVENTIONS.length - 1,
    'every intervention except the baseline must have been measured');
  rep.systems.forEach(s=>{
    assert.ok(s.games > 0, s.id + ' ran no games');
    assert.ok(s.decided + s.stillUndecided + s.newlyDecided > 0, s.id + ' decided nothing');
    assert.ok(s.winnerChangedPct >= 0 && s.winnerChangedPct <= 100, s.id + ' flip rate is out of range');
  });
  const h = Sim.headline(rep);
  Object.keys(h).forEach(k=>{
    assert.ok(Number.isFinite(Sim.toleranceFor(k).abs),
      k + ' is reported but has no tolerance rule');
  });
  /* And the delete-a-system table has to be paired against the baseline batch,
     not against an unrelated sample. */
  assert.ok(rep.systems.filter(s=>s.deletable).length >= 5,
    'the delete-a-system table lost entries');
  assert.ok(rep.difficultySeparation.se >= 0);
});