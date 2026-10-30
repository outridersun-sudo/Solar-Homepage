'use strict';
// 서버 전용: public 폴더 안에 넣지 마세요.
const catalog = require('./calculator-data/modules.json');
const {store:moduleStore} = require('./module-store');
const INVERTERS = require('./calculator-data/inverters.json');
function capacityPlans(input) {
  const {
    dcKW, ratio, tolerance, voltage,
    priority, kva350, pf350
  } = input;

  if (
    ![dcKW, ratio, tolerance, voltage, kva350, pf350]
      .every(Number.isFinite) ||
    dcKW <= 0 ||
    dcKW > 100001 ||
    ratio < .5 ||
    ratio > 1.5 ||
    tolerance < 0 ||
    tolerance > .3 ||
    ![380, 800].includes(voltage) ||
    ![350, 334, 300].includes(kva350) ||
    pf350 < .8 ||
    pf350 > 1
  ) {
    throw new Error(
      '입력 범위를 확인하세요. 지원 설비용량은 최대 100,000kWp입니다.'
    );
  }

  const targetAC = dcKW * ratio;

  const make = (acKW, counts) => {
    const rows = INVERTERS
      .filter(inv => counts[inv.kw] > 0)
      .map(inv => ({
        ...inv,
        count: counts[inv.kw],
        unitAC: inv.kw === 350 ? kva350 * pf350 : inv.kw
      }));

    const count = rows.reduce((sum, row) => sum + row.count, 0);
    const actualRatio = acKW / dcKW;
    const error = Math.abs(actualRatio / ratio - 1);

    return {
      acKW,
      count,
      actualRatio,
      error,
      within: error <= tolerance + 1e-10,
      voltage,
      rows
    };
  };

  const eligibleModels = input.eligibleKw
    ? INVERTERS.filter(inv => input.eligibleKw.includes(inv.kw))
    : INVERTERS;

  const candidates = [];
  let reconstruct;

  if (voltage === 800) {
    const unit = kva350 * pf350;
    const near = targetAC / unit;
    const low = targetAC * (1 - tolerance) / unit;
    const high = targetAC * (1 + tolerance) / unit;

    const counts = new Set([
      1,
      Math.floor(near),
      Math.ceil(near),
      Math.floor(dcKW / unit) + 1,
      Math.ceil(low - 1e-10),
      Math.floor(high + 1e-10)
    ]);

    for (const n of counts) {
      if (
        n >= 1 &&
        eligibleModels.some(inv => inv.kw === 350)
      ) {
        candidates.push({
          acKW: n * unit,
          count: n,
          n
        });
      }
    }

    reconstruct = item => make(item.acKW, {350: item.n});
  } else {
    const coins = eligibleModels
      .filter(inv => inv.voltage === 380)
      .sort((a, b) =>
        priority === 'asc' ? a.kw - b.kw : b.kw - a.kw
      );

    const maxUnits = Math.ceil(
      (Math.max(dcKW, targetAC * (1 + tolerance)) + 150) / 2
    );

    const count = new Uint32Array(maxUnits + 1);
    const parent = new Uint8Array(maxUnits + 1);

    count.fill(0xffffffff);
    parent.fill(255);
    count[0] = 0;

    for (let u = 1; u <= maxUnits; u++) {
      for (let j = 0; j < coins.length; j++) {
        const previous = u - coins[j].kw / 2;

        if (
          previous >= 0 &&
          count[previous] !== 0xffffffff &&
          count[previous] + 1 < count[u]
        ) {
          count[u] = count[previous] + 1;
          parent[u] = j;
        }
      }

      if (count[u] !== 0xffffffff) {
        candidates.push({
          acKW: u * 2,
          count: count[u],
          u
        });
      }
    }

    reconstruct = item => {
      let u = item.u;
      const counts = {};

      while (u > 0) {
        const kw = coins[parent[u]].kw;
        counts[kw] = (counts[kw] || 0) + 1;
        u -= kw / 2;
      }

      return make(item.acKW, counts);
    };
  }

  for (const item of candidates) {
    item.error = Math.abs((item.acKW / dcKW) / ratio - 1);
    item.within = item.error <= tolerance + 1e-10;
  }

  // 필수 조건: AC/DC > 1.00
  // 전체 입력 모듈의 STC DC 용량을 기준으로 하며 동일값도 제외합니다.
  const aboveUnity = candidates.filter(
    item => item.acKW > dcKW + 1e-9
  );

  const feasible = aboveUnity.filter(item => item.within);

  const best = (items, compare) => items.reduce(
    (a, b) => !a || compare(b, a) < 0 ? b : a,
    null
  );

  const nearCompare = (a, b) =>
    a.error - b.error ||
    a.count - b.count ||
    a.acKW - b.acKW;

  const a = best(
    feasible,
    (a, b) => a.count - b.count || nearCompare(a, b)
  );

  const b = best(aboveUnity, nearCompare);
  const minCount = a ? a.count : 1;

  const score = item =>
    .5 * item.error / (tolerance || .1) +
    .5 * (item.count / minCount - 1);

  const c = best(
    feasible,
    (a, b) => score(a) - score(b) || nearCompare(a, b)
  );

  return {
    A: a ? reconstruct(a) : null,
    B: b ? reconstruct(b) : null,
    C: c ? reconstruct(c) : null,
    targetAC
  };
}

// Compare inverter compositions as well as their actual string allocations.
function selectStringPlans(input, designs) {
  const seeds = capacityPlans(input);
  const models = INVERTERS.filter(inv => inv.voltage === input.voltage && designs[inv.kw].eligible)
    .sort((a, b) => input.priority === 'asc' ? a.kw - b.kw : b.kw - a.kw);
  const upper = seeds.targetAC * (1 + input.tolerance);
  const lower = Math.max(input.dcKW + 1e-8, seeds.targetAC * (1 - input.tolerance));
  const pool = new Map();
  const make = counts => {
    const rows = INVERTERS.filter(inv => counts[inv.kw]).map(inv => ({
      ...inv, count: counts[inv.kw], unitAC: inv.kw === 350 ? input.kva350 * input.pf350 : inv.kw
    }));
    const acKW = rows.reduce((sum, row) => sum + row.count * row.unitAC, 0);
    const actualRatio = acKW / input.dcKW;
    const error = Math.abs(actualRatio / input.ratio - 1);
    return {rows, acKW, actualRatio, error, within: error <= input.tolerance + 1e-10,
      count: rows.reduce((sum, row) => sum + row.count, 0), voltage: input.voltage};
  };
  const add = (plan, retainIncomplete = false) => {
    if (plan && !retainIncomplete) {
      const capacity = plan.rows.reduce((sum, row) => {
        const reachable = preparePattern(designs[row.kw]).reachable;
        const cap = Math.floor(row.unitAC * 1000 / input.module.p + 1e-10);
        const maximum = reachable.filter(n => n <= cap).at(-1) || 0;
        return sum + row.count * maximum;
      }, 0);
      if (capacity < input.moduleCount) return;
    }
    if (plan) pool.set(plan.rows.map(row => row.kw + ':' + row.count).join(','), plan);
  };
  for (const id of ['A', 'B', 'C']) add(seeds[id], true);
  let visited = 0;
  let truncated = false;
  const maxCandidates = input.dcKW > 3000 ? 12 : 128;
  // Enumerate by inverter count so small/minimum-count alternatives are never
  // displaced by many large-count combinations. Bound work for large plants.
  const powers = models.map(inv => inv.kw === 350 ? input.kva350 * input.pf350 : inv.kw);
  const minCount = models.length ? Math.max(1, Math.ceil(lower / Math.max(...powers) - 1e-10)) : 1;
  const maxCount = models.length ? Math.floor(upper / Math.min(...powers) + 1e-10) : 0;
  function enumerate(index, left, ac, counts) {
    if (pool.size >= maxCandidates || ++visited > 20000) { truncated = true; return; }
    if (index === models.length) {
      if (!left && ac >= lower - 1e-9 && ac <= upper + 1e-9) add(make(counts));
      return;
    }
    const remainingPowers = powers.slice(index);
    if (ac + left * Math.max(...remainingPowers) < lower - 1e-9 ||
        ac + left * Math.min(...remainingPowers) > upper + 1e-9) return;
    for (let n = left; n >= 0; n--) {
      enumerate(index + 1, left - n, ac + n * powers[index], {...counts, [models[index].kw]: n});
      if (truncated) return;
    }
  }
  for (let count = minCount; count <= maxCount && !truncated; count++) enumerate(0, count, 0, {});

  const cache = new Map();
  let exactWorkRemaining = 40000000;
  const evaluated = [...pool.values()].sort((a,b) => a.count-b.count || a.error-b.error).map(plan => {
    const allocation = allocatePlant(plan, designs, input, Math.min(20000000, exactWorkRemaining));
    // Budget subsequent full-composition searches, independent of machine speed.
    exactWorkRemaining -= allocation.searchWork;
    delete allocation.searchWork;
    const strings = {};
    let shortfall = 0;
    for (const unit of allocation.units) for (const mppt of unit.mppts) {
      if (!mppt.parallel) continue;
      strings[mppt.series] = (strings[mppt.series] || 0) + mppt.parallel;
      shortfall += mppt.parallel * (designs[unit.kw].maxSeries - mppt.series);
    }
    const totalStrings = Object.values(strings).reduce((sum, n) => sum + n, 0);
    const utilization = allocation.units.map(unit => unit.stcKW / unit.unitAC);
    const balance = utilization.length ? Math.max(...utilization) - Math.min(...utilization) : 0;
    const result = {...plan, metrics: {strings, totalStrings, shortfall, balance,
      allocated: allocation.allocated, unallocated: allocation.unallocated}};
    cache.set(result, allocation);
    return result;
  });
  const full = evaluated.filter(plan => plan.within && !plan.metrics.unallocated);
  const choose = (items, compare) => items.reduce((best, item) => !best || compare(item,best)<0 ? item : best, null);
  const stringsFirst = (a,b) => a.metrics.shortfall-b.metrics.shortfall ||
    a.metrics.totalStrings-b.metrics.totalStrings || a.metrics.balance-b.metrics.balance ||
    a.error-b.error || a.acKW-b.acKW;
  const A = choose(full, (a,b) => a.count-b.count || stringsFirst(a,b));
  // A close AC rating must never hide a shortfall in connected module capacity.
  // All proposals require full allocation and the requested ratio tolerance.
  const B = choose(full, (a,b) => a.error-b.error || a.count-b.count || stringsFirst(a,b));
  const minFullCount = A?.count || 1;
  const minStrings = full.length ? Math.min(...full.map(plan => plan.metrics.totalStrings)) : 1;
  const balancedScore = plan => .4 * plan.error / (input.tolerance || .1) +
    .3 * (plan.count / minFullCount - 1) +
    .3 * (plan.metrics.totalStrings / (minStrings || 1) - 1);
  const C = choose(full, (a,b) => balancedScore(a)-balancedScore(b) || stringsFirst(a,b));
  const searchComplete = !truncated && evaluated.every(plan => cache.get(plan).optimization === 'global');
  const reasons = {
    A: A && `전체 ${input.moduleCount}장 연결 후보 중 최소 ${A.count}대, 긴 직렬 활용·스트링 수(${A.metrics.totalStrings}개)·부하 균형 순으로 선정했습니다.`,
    B: B && `전체 ${input.moduleCount}장 연결·허용 편차 충족 후보 중 목표 AC/DC 오차 ${(B.error*100).toFixed(2)}%의 최근접 조합입니다. 미배분 0장입니다.`,
    C: '전량 연결·허용 편차 충족 후보에서 용량 오차 40% + 대수 30% + 스트링 수 30%의 정규화 점수가 가장 낮은 조합입니다.'
  };
  const plans = {targetAC:seeds.targetAC};
  const allocations = {};
  for (const [id,plan] of Object.entries({A,B,C})) {
    plans[id] = plan ? {...plan, reason: reasons[id] + (searchComplete ? '' :
      ' 제한된 후보/재배분 탐색 결과이며 전체 조합의 최적해를 보장하지 않습니다.')} : null;
    if (plan) allocations[id] = cache.get(plan);
  }
  return {plans, allocations, selection: {requiresFullAllocation: true, complete: searchComplete, evaluated: evaluated.length,
    note: searchComplete ? '전량 연결 가능성이 있는 허용 범위 후보 조합과 배분을 모두 비교했습니다.' : '계산량 제한으로 후보 또는 배분 탐색을 제한했습니다. 전역 최적해는 보장하지 않습니다.'}};
}

function moduleDesignValues(module, input) {
  const rearScale = input.rearIrradiance / (module.bnpiRearIrradiance || 13.5);
  const interpolate = (stc, bnpi) => stc + (bnpi - stc) * rearScale;

  const ref = {
    voc: input.designMode === 'document' ? module.voc : interpolate(module.voc, module.bnpiVoc),
    vmp: interpolate(module.vmp, module.bnpiVmp),
    imp: interpolate(module.imp, module.bnpiImp),
    isc: interpolate(module.isc, module.bnpiIsc),
    power: interpolate(module.p, module.bnpi)
  };

  const betaVoc = module.betaVoc / 100;
  const betaVmp = input.vmpCoefficient / 100;

  const temperatures = [
    input.minTemperature,
    input.maxCellTemperature
  ];

  const maximumFactor = module.iscCoefficientUnconfirmed
    ? 1 + Math.abs(module.alphaIsc / 100) *
      Math.max(...temperatures.map(t => Math.abs(t - 25)))
    : Math.max(
        ...temperatures.map(
          t => 1 + module.alphaIsc / 100 * (t - 25)
        )
      );

  return {
    ...ref,

    vocCold:
      ref.voc * (1 + betaVoc * (input.minTemperature - 25)),

    vocWithMargin:
      ref.voc *
      (1 + betaVoc * (input.minTemperature - 25)) *
      (1 + input.vocMargin / 100),

    vmpHot:
      ref.vmp * (1 + betaVmp * (input.maxCellTemperature - 25)),

    vmpCold:
      ref.vmp * (1 + betaVmp * (input.minTemperature - 25)),

    // Imp 계수 미제공: Isc 계수로 예비 추정합니다.
    impDesign: ref.imp * maximumFactor,
    iscTemperature: ref.isc * maximumFactor,
    iscDesign: ref.isc * maximumFactor * input.iscFactor,

    rearScale,
    maximumFactor
  };
}

// 사용자 지정 참고 조건: 1개 스트링의 양면·온도 보정 Isc를 기준으로 한다.
// MPPT 병렬 합산 전류 및 별도 iscFactor를 중복 적용하지 않는다.
function selectStringFuse(inverter, module, values) {
  const isc = values.iscTemperature;
  const moduleLimitA = module.maxSeriesFuse;
  const minimumA = isc * 1.5;
  const maximumA = isc * 2.4;
  const base = {
    basis: 'iscTemperature', isc, minimumA, maximumA, moduleLimitA,
    productModel: inverter.model || null, selectionLabel: null,
    multiplierMin: 1.5, multiplierMax: 2.4,
    candidates: [], selected: null, status: 'unconfirmed',
    reason: 'MISSING_PRODUCT_DATA'
  };
  const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (!positive(isc) || !positive(moduleLimitA)) return base;

  const options = inverter.stringFuseOptions;
  if (!Array.isArray(options) || !options.length || options.some(option =>
    !option || !positive(option.currentA) || !positive(option.voltageV)
  )) return base;

  const epsilon = 1e-9;
  const candidates = options.map(option => {
    const belowRange = option.currentA < minimumA - epsilon;
    const aboveRange = option.currentA > maximumA + epsilon;
    const moduleLimitExceeded = option.currentA > moduleLimitA + epsilon;
    return {
      currentA: option.currentA, voltageV: option.voltageV,
      rangeStatus: belowRange ? 'below' : aboveRange ? 'above' : 'within',
      moduleLimitExceeded,
      eligible: !belowRange && !aboveRange && !moduleLimitExceeded
    };
  }).sort((a, b) => a.currentA - b.currentA || a.voltageV - b.voltageV);
  const selected = candidates.find(option => option.eligible) || null;
  const reason = selected ? 'SELECTED'
    : minimumA > moduleLimitA + epsilon ? 'MODULE_LIMIT_BELOW_RANGE'
    : candidates.some(option => option.rangeStatus === 'within')
      ? 'NO_CANDIDATE_WITHIN_MODULE_LIMIT'
      : 'NO_CANDIDATE_IN_RANGE';
  return {
    ...base, candidates, selected,
    // 사용자 요청 표시명. 실제 제조사 모델이나 제품 카탈로그 키는 변경하지 않는다.
    selectionLabel: selected && typeof inverter.model === 'string'
      ? inverter.model.replace(/-K\d+(?:A)?$/, '') + '-K' + selected.currentA + 'A'
      : null,
    status: selected ? 'selected' : 'unavailable', reason
  };
}


function preliminaryDesign(inverter, module, input) {
  const values = moduleDesignValues(module, input);

  const minSeries = Math.max(
    1,
    Math.ceil(
      Math.max(inverter.mppMin, inverter.startV) /
      values.vmpHot - 1e-10
    )
  );

  const maxSeries = Math.min(
    Math.floor(
      Math.min(inverter.dcMax, module.maxV) /
      values.vocWithMargin + 1e-10
    ),
    Math.floor(
      inverter.mppMax / values.vmpCold + 1e-10
    )
  );

  const options = [];

  for (
    let parallel = 1;
    parallel <= inverter.portsPerMppt;
    parallel++
  ) {
    const stringLimit =
      parallel === 1 && inverter.singleStringA
        ? inverter.singleStringA
        : inverter.stringA;

    if (
      values.impDesign > stringLimit + 1e-10 ||
      parallel * values.impDesign > inverter.mpptA + 1e-10 ||
      parallel * values.iscDesign > inverter.mpptIscA + 1e-10
    ) {
      continue;
    }

    for (let series = minSeries; series <= maxSeries; series++) {
      options.push({
        series,
        parallel,
        modules: series * parallel
      });
    }
  }

  const reasons = [];

  if (minSeries > maxSeries) {
    reasons.push(
      '온도·전압 가정에서 직렬 수 범위가 겹치지 않음'
    );
  }

  if (minSeries <= maxSeries && !options.length) {
    reasons.push(
      '온도·양면·전류 여유를 반영하면 브로슈어 표기 전류 범위를 초과함'
    );
  }

  return {
    inverter,
    values,
    fuseReview: selectStringFuse(inverter, module, values),
    minSeries,
    maxSeries,
    options,
    eligible: options.length > 0,
    reasons,
    pattern: null
  };
}

function preparePattern(design) {
  if (design.pattern) return design.pattern;

  const options = [
    {series: 0, parallel: 0, modules: 0},
    ...design.options
  ];

  const maxPerMppt = Math.max(
    ...options.map(option => option.modules)
  );

  const maxTotal = maxPerMppt * design.inverter.mppt;

  let deficits = new Float64Array(maxTotal + 1);
  deficits.fill(Infinity);
  deficits[0] = 0;
  let previous = new Float64Array(maxTotal + 1);
  previous.fill(Infinity);
  previous[0] = 0;

  const choices = [];

  for (let mppt = 0; mppt < design.inverter.mppt; mppt++) {
    const next = new Float64Array(maxTotal + 1);
    next.fill(Infinity);

    const nextDeficits = new Float64Array(maxTotal + 1);
    nextDeficits.fill(Infinity);
    const selected = new Uint8Array(maxTotal + 1);
    selected.fill(255);

    for (let total = 0; total <= maxTotal; total++) {
      if (!Number.isFinite(previous[total])) continue;

      options.forEach((option, index) => {
        const sum = total + option.modules;
        if (sum > maxTotal) return;

        const cost =
          previous[total] +
          option.modules * option.modules +
          option.parallel * .001;

        // Prefer the longest safe strings, then balance MPPT loading.
        const deficit = deficits[total] + option.parallel * (design.maxSeries - option.series);
        if (deficit < nextDeficits[sum] ||
            (deficit === nextDeficits[sum] && cost < next[sum])) {
          nextDeficits[sum] = deficit;
          next[sum] = cost;
          selected[sum] = index;
        }
      });
    }

    previous = next;
    deficits = nextDeficits;
    choices.push(selected);
  }

  const reachable = [];

  for (let total = 0; total <= maxTotal; total++) {
    if (Number.isFinite(previous[total])) {
      reachable.push(total);
    }
  }

  design.pattern = {
    options,
    choices,
    reachable,
    deficits,
    costs: previous,
    maxTotal
  };

  return design.pattern;
}

function mpptAllocation(design, total) {
  const pattern = preparePattern(design);
  const mppts = [];
  let remaining = total;

  for (let index = design.inverter.mppt - 1; index >= 0; index--) {
    const option = pattern.options[
      pattern.choices[index][remaining]
    ];

    if (!option) {
      throw new Error('예비 배분 복원에 실패했습니다.');
    }

    mppts.push({
      mppt: index + 1,
      series: option.series,
      parallel: option.parallel,
      modules: option.modules
    });

    remaining -= option.modules;
  }

  return mppts.reverse();
}

function allocatePlant(plan, designs, input, exactWorkLimit = 20000000) {
  const units = [];

  for (const row of plan.rows) {
    const design = designs[row.kw];
    preparePattern(design);

    for (let index = 0; index < row.count; index++) {
      units.push({
        kw: row.kw,
        model: row.model,
        voltage: row.voltage,
        unitAC: row.unitAC,
        modelUnit: index + 1,
        modules: 0,
        design
      });
    }
  }

  // The uploaded design caps STC DC power at each inverter's AC rating.
  // This is a conservative allocation policy, not a manufacturer DC-input limit.
  for (const unit of units) {
    unit.possible = unit.design.pattern.reachable.filter(total =>
      total <= Math.floor(unit.unitAC * 1000 / input.module.p + 1e-10));
  }
  const target = Math.min(input.moduleCount,
    units.reduce((sum, unit) => sum + unit.possible.at(-1), 0));
  const work = (target + 1) * units.reduce((sum, unit) => sum + unit.possible.length, 0);
  const exact = work <= exactWorkLimit;
  const score = (unit, total) => [
    unit.design.pattern.deficits[total],
    total * total / unit.unitAC,
    unit.design.pattern.costs[total]
  ];
  const better = (a, b) => {
    for (let k = 0; k < a.length; k++) {
      if (Math.abs(a[k] - b[k]) > 1e-7) return a[k] < b[k];
    }
    return false;
  };
  let remaining = input.moduleCount;
  if (exact) {
    // Lexicographic objectives: use all possible panels, minimize short strings,
    // balance DC/AC ratios, then balance MPPT loads. Backtrack across all units.
    let previous = [new Float64Array(target + 1), new Float64Array(target + 1), new Float64Array(target + 1)];
    previous.forEach(row => row.fill(Infinity));
    previous.forEach(row => { row[0] = 0; });
    const choices = [];
    for (const unit of units) {
      const next = previous.map(() => new Float64Array(target + 1).fill(Infinity));
      const selected = new Int32Array(target + 1).fill(-1);
      for (let total = 0; total <= target; total++) {
        if (!Number.isFinite(previous[0][total])) continue;
        for (const amount of unit.possible) {
          const sum = total + amount;
          if (sum > target) break;
          const value = score(unit, amount).map((v, k) => v + previous[k][total]);
          if (better(value, next.map(row => row[sum]))) {
            value.forEach((v, k) => { next[k][sum] = v; });
            selected[sum] = amount;
          }
        }
      }
      choices.push(selected);
      previous = next;
    }
    let total = target;
    while (total > 0 && !Number.isFinite(previous[0][total])) total--;
    remaining -= total;
    for (let i = units.length - 1; i >= 0; i--) {
      units[i].modules = choices[i][total];
      total -= units[i].modules;
    }
  } else {
    // Bound large-plant runtime. Seed proportional allocation, then improve
    // pairs without sacrificing panel count. This path is a local optimum only.
    let remainingAC = plan.acKW;
    for (const unit of units) {
      const quota = remaining * unit.unitAC / remainingAC;
      unit.modules = unit.possible.filter(n => n <= quota).at(-1) || 0;
      remaining -= unit.modules;
      remainingAC -= unit.unitAC;
    }
    for (const unit of units) {
      const total = unit.possible.filter(n => n <= unit.modules + remaining).at(-1);
      remaining -= total - unit.modules;
      unit.modules = total;
    }
    const limit = units.length;
    // Visit every unit; bound the number of partners for large installations.
    const neighbors = limit > 100 ? 8 : limit;
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (let i = 0; i < limit; i++) for (let j = i + 1; j < Math.min(limit, i + neighbors + 1); j++) {
        const first = units[i], second = units[j];
        const total = first.modules + second.modules;
        let best = [-total, ...score(first, first.modules).map((v,k) => v + score(second,second.modules)[k])];
        let pair = [first.modules, second.modules];
        for (const a of first.possible) {
          const budget = total + remaining - a;
          let lo = 0, hi = second.possible.length;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (second.possible[mid] <= budget) lo = mid + 1; else hi = mid;
          }
          if (!lo) continue;
          const b = second.possible[lo - 1];
          const value = [-(a+b), ...score(first,a).map((v,k) => v + score(second,b)[k])];
          if (better(value,best)) { best=value; pair=[a,b]; }
        }
        if (pair[0] !== first.modules || pair[1] !== second.modules) {
          remaining -= pair[0] + pair[1] - total;
          [first.modules,second.modules] = pair;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  return {
    optimization: exact ? 'global' : 'bounded-pairwise',
    searchWork: exact ? work : 0,
    allocated: input.moduleCount - remaining,
    unallocated: remaining,

    units: units.map((unit, index) => ({
      index: index + 1,
      kw: unit.kw,
      model: unit.model,
      voltage: unit.voltage,
      unitAC: unit.unitAC,
      modelUnit: unit.modelUnit,
      modules: unit.modules,
      stcKW: unit.modules * input.module.p / 1000,
      mppts: mpptAllocation(unit.design, unit.modules)
    }))
  };
}


function normalizeInput(body, currentCatalog = moduleStore.catalog()) {
  const fail = () => { throw new Error('계산 입력값이나 제품 선택을 확인하세요.'); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail();
  const text = key => {
    if (typeof body[key] !== 'string' || body[key].length > 150) fail();
    return body[key];
  };
  const manufacturer = text('manufacturer');
  const series = text('series');
  const model = text('model');
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  if (!own(currentCatalog, manufacturer) || !own(currentCatalog[manufacturer], series)) fail();
  const module = currentCatalog[manufacturer][series].find(item => item.name === model);
  if (!module) fail();
  const num = (key, min, max) => {
    const value = body[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail();
    return value;
  };
  const basis = text('basis');
  const priority = text('priority');
  if (!['capacity', 'modules'].includes(basis) || !['asc','desc'].includes(priority)) fail();
  const requestedKWp = num('requestedKWp', Number.MIN_VALUE, 100000);
  let moduleCount = num('moduleCount', 1, 50000000);
  if (!Number.isInteger(moduleCount)) fail();
  if (basis === 'capacity') moduleCount = Math.max(1, Math.floor(requestedKWp * 1000 / module.p + 1e-10));
  const dcKW = moduleCount * module.p / 1000;
  if (dcKW > 100001) fail();
  const designMode = body.designMode || 'standard';
  if (!['standard','document'].includes(designMode)) fail();
  const input = {
    designMode, basis, priority, requestedKWp, moduleCount, dcKW, module: {...module}, manufacturer, series,
    ratio:num('ratio', .5, 1.5), tolerance:num('tolerance', 0, .3),
    voltage:num('voltage',380,800), kva350:num('kva350',300,350), pf350:num('pf350',.8,1),
    minTemperature:num('minTemperature',-50,25), maxCellTemperature:num('maxCellTemperature',25,90),
    vmpCoefficient:module.betaVoc, vmpCoefficientSource:'Voc', rearIrradiance:num('rearIrradiance',0,30),
    vocMargin:num('vocMargin',0,10), iscFactor:num('iscFactor',1,1.5),
    azimuth:num('azimuth',0,360), tilt:num('tilt',0,90)
  };
  if (![380,800].includes(input.voltage) || ![350,334,300].includes(input.kva350) ||
      input.minTemperature >= input.maxCellTemperature) fail();
  return input;
}

function calculate(body, currentCatalog) {
  const input = normalizeInput(body, currentCatalog);
  const designs = {};
  for (const inverter of INVERTERS) designs[inverter.kw] = preliminaryDesign(inverter, input.module, input);
  input.eligibleKw = INVERTERS.filter(inv => designs[inv.kw].eligible).map(inv => inv.kw);
  const {plans, allocations, selection} = selectStringPlans(input, designs);
  // DP 복원용 내부 배열은 클라이언트에 보내지 않습니다.
  const visibleDesigns = Object.fromEntries(Object.entries(designs).map(([key, d]) => {
    const {pattern, options, ...visible} = d;
    return [key, visible];
  }));
  return {input, plans, designs:visibleDesigns, allocations, selection,
    values:moduleDesignValues(input.module, input), calculatedAt:new Date().toISOString()};
}
module.exports = {calculate, normalizeInput, catalog, INVERTERS, selectStringFuse};

const {isMainThread, parentPort, workerData} = require('node:worker_threads');
if (!isMainThread && workerData?.calculatorJob) {
  try { parentPort.postMessage({result:calculate(workerData.input,workerData.catalog)}); }
  catch (error) { parentPort.postMessage({error:error.message}); }
}
