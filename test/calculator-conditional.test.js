'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test, after} = require('node:test');

const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solar-conditional-test-'));
const previousCatalogDir = process.env.MODULE_DATA_DIR;
process.env.MODULE_DATA_DIR = catalogDir;
const {calculate, catalog} = require('../server/calculator-engine');
after(() => {
  fs.rmSync(catalogDir, {recursive:true, force:true});
  if (previousCatalogDir === undefined) delete process.env.MODULE_DATA_DIR;
  else process.env.MODULE_DATA_DIR = previousCatalogDir;
});

const model = 'S6-GC150K-K30';
const input = {
  manufacturer:'통웨이 TW Solar', series:'TWMNF 66HD', model:'TWMNF-66HD750',
  basis:'modules', priority:'desc', requestedKWp:139.5, moduleCount:186,
  ratio:1, tolerance:0.1, voltage:380, kva350:350, pf350:1,
  minTemperature:-20, maxCellTemperature:40, rearIrradiance:13.5, vocMargin:0,
  iscFactor:1.25, azimuth:180, tilt:30, designMode:'document'
};
const original = catalog[input.manufacturer][input.series].find(module => module.name === input.model);

function calculateFixture(overrides, conditions = {}) {
  const module = {...original, name:'Conditional-test', ...overrides};
  fs.writeFileSync(path.join(catalogDir, 'catalog.json'), JSON.stringify([
    {manufacturer:'Test', series:'Test', module}
  ]));
  return calculate({...input, manufacturer:'Test', series:'Test', model:module.name, ...conditions});
}

test('20.90A module selects the 35A variant in the normal A/B/C results', () => {
  const result = calculate(input);
  for (const id of ['A', 'B', 'C']) {
    const plan = result.plans[id];
    const allocation = result.allocations[id];
    assert.equal(plan.rows.find(row => row.model === model).selectionBasis.fuseA, 35);
    assert.equal(plan.rows.find(row => row.model === model).selectionBasis.bnpiIsc, 20.9);
    assert.equal(allocation.allocated, input.moduleCount);
    assert.equal(allocation.unallocated, 0);
    assert.ok(plan.within && plan.actualRatio > 1);
    assert.ok(allocation.units.filter(unit => unit.model === model)
      .every(unit => unit.mppts.every(mppt => !mppt.modules || [1, 2].includes(mppt.parallel))));
  }
  assert.ok(!Object.hasOwn(result, 'conditionalProposal'));
  const design = result.designs[model];
  assert.equal(design.eligible, true);
  assert.equal(design.currentChecks[1].stringLimit, 18);
  assert.equal(design.currentChecks[1].passed, false);
  assert.equal(design.currentChecks[1].mpptPassed, true);
  assert.equal(design.currentChecks[1].shortCircuitPassed, true);
  assert.ok(Object.entries(result.designs).every(([key, item]) => key === model || !item.selectionBasis));
});

test('21A is inclusive and the rule uses the original BNPI Isc', () => {
  for (const [bnpiIsc, selected] of [[20.999,true],[21,true],[21.001,false]]) {
    const result = calculateFixture({bnpiIsc});
    assert.equal(!!result.plans.A?.rows.some(row => row.selectionBasis), selected);
    if (selected) assert.equal(result.designs[model].selectionBasis.bnpiIsc, bnpiIsc);
  }
  const changed = calculateFixture({bnpiIsc:21}, {rearIrradiance:5, maxCellTemperature:55});
  assert.equal(changed.designs[model].selectionBasis.bnpiIsc, 21);
  assert.notEqual(changed.designs[model].values.isc, 21);
  const over = calculateFixture({bnpiIsc:21, alphaIsc:0.15}, {
    rearIrradiance:30, maxCellTemperature:90, iscFactor:1.5
  });
  assert.deepEqual(over.designs[model].selectionBasis?.parallels, [1]);
  assert.equal(over.designs[model].currentChecks[1].shortCircuitPassed, false);
});

test('provenance, compatible fuse and existing plant limits are required', () => {
  for (const overrides of [{source:''},{bnpiIsc:null},{rearSpecMode:'bstc'},{rearSpecMode:'gain10'},{maxSeriesFuse:30}]) {
    assert.equal(calculateFixture(overrides).designs[model].selectionBasis, undefined);
  }
  for (const conditions of [{moduleCount:2},{voltage:800}]) {
    const result = calculateFixture({}, conditions);
    assert.ok(['A','B','C'].every(id => !result.plans[id]?.rows.some(row => row.selectionBasis)));
  }
});

test('an odd module count can be selected with single-string MPPTs', () => {
  const result = calculate({...input, moduleCount:187});
  for (const id of ['A', 'B', 'C']) {
    const row = result.plans[id].rows.find(row => row.model === model);
    const allocation = result.allocations[id];
    const used = allocation.units.filter(unit => unit.model === model)
      .flatMap(unit => unit.mppts.filter(mppt => mppt.modules > 0).map(mppt => mppt.parallel));
    assert.equal(allocation.unallocated, 0);
    assert.ok(used.includes(1));
    assert.ok(used.every(parallel => parallel === 1 || parallel === 2));
    assert.deepEqual(row.selectionBasis.parallels, [...new Set(used)].sort());
  }
});
