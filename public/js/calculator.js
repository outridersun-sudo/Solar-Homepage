'use strict';

(() => {
let catalog = {};
let INVERTERS = [];
const $ = id => document.getElementById(id);

// CAPACITY_ENGINE_START
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
// CAPACITY_ENGINE_END

let currentChoice = 'B';
let activeCard = 'B';
let toastTimer;
let resultState = null;

const setText = (id, value) => {
  $(id).textContent = value;
};

const asNumber = value => Number(value).toLocaleString(
  'ko-KR',
  {maximumFractionDigits: 3}
);

const selectedModule = () =>
  catalog[$('manufacturer').value]
    ?.[$('series').value]
    ?.find(m => m.name === $('model').value);

function element(tag, text, className) {
  const node = document.createElement(tag);

  if (text !== undefined) {
    node.textContent = text;
  }

  if (className) {
    node.className = className;
  }

  return node;
}

function fillOptions(select, items, value) {
  select.replaceChildren(
    ...items.map(item => {
      const op = element('option', item);
      op.value = item;
      return op;
    })
  );

  if (items.includes(value)) {
    select.value = value;
  }
}

function notify(text) {
  const node = $('toast');
  node.textContent = text;
  node.classList.add('show');

  clearTimeout(toastTimer);

  toastTimer = setTimeout(
    () => node.classList.remove('show'),
    4500
  );
}

function updateManufacturer() {
  fillOptions(
    $('series'),
    Object.keys(catalog[$('manufacturer').value])
  );

  updateSeries();
}

function updateSeries() {
  fillOptions(
    $('model'),
    catalog[$('manufacturer').value][$('series').value]
      .map(m => m.name),
    $('series').value === 'NA 시리즈' ? 'HiC-T645OJ' : null
  );

  updateModule();
}

function updateModule() {
  const m = selectedModule();
  if (!m) return;

  const info = {
    moduleVendor: $('manufacturer').value,
    moduleName: m.name,
    moduleSeries: $('series').value,
    spModel: m.name,
    spType: m.type,
    spCells: m.cells,
    spPower: m.p + 'W / ' + (m.bnpi ? m.bnpi + 'W' : '미등록'),
    spVoc: m.voc.toFixed(2) + 'V',
    spVmp: m.vmp.toFixed(2) + 'V',
    spIsc: m.isc.toFixed(2) + 'A',
    spImp: m.imp.toFixed(2) + 'A',
    spTemp: m.temp,
    spEff: m.eff + '%',
    spWeight: m.weight,
    spMaxV: 'DC ' + asNumber(m.maxV) + 'V',
    spWarranty: m.warranty
  };

  for (const [id, value] of Object.entries(info)) {
    setText(id, value);
  }

  $('modulePower').value = m.p;
  updateCount();
  invalidate();
}

function updateCount() {
  const m = selectedModule();
  if (!m) return;

  const basis = document.querySelector(
    'input[name="basis"]:checked'
  ).value;

  if (basis === 'capacity') {
    const target = Number($('plantCapacity').value);

    $('moduleCount').value =
      Number.isFinite(target) && target > 0
        ? Math.max(1, Math.round(target * 1000 / m.p))
        : '';
  } else {
    const n = Number($('moduleCount').value);

    $('plantCapacity').value =
      Number.isInteger(n) && n > 0
        ? (n * m.p / 1000).toFixed(3)
        : '';
  }

  const n = Number($('moduleCount').value);

  $('actualDcPower').value =
    Number.isInteger(n) && n > 0
      ? (n * m.p / 1000).toFixed(3)
      : '';
}

function voltageControls() {
  const is800 = $('acVoltage').value === '800';

  document.querySelectorAll('.only-800').forEach(node => {
    node.hidden = !is800;
  });

  $('priority').disabled = is800;
  $('priority').title = is800
    ? '800V에서는 350kW 모델만 사용합니다.'
    : '';
}

function readInput() {
  const ids = [
    'plantCapacity', 'moduleCount', 'ratio', 'ratioTolerance',
    'rating350', 'pf350', 'minTemperature', 'maxCellTemperature',
    'vmpCoefficient', 'rearIrradiance', 'vocMargin', 'iscFactor',
    'azimuth', 'tilt'
  ];

  if (ids.some(id => $(id).value.trim() === '')) {
    throw new Error('계산 입력 항목을 모두 입력하세요.');
  }

  const m = selectedModule();
  const cap = Number($('plantCapacity').value);
  const n = Number($('moduleCount').value);

  if (
    !m ||
    !Number.isFinite(cap) ||
    cap <= 0 ||
    cap > 100000 ||
    !Number.isInteger(n) ||
    n < 1
  ) {
    throw new Error(
      '설비용량은 0 초과~100,000kWp, 모듈 수량은 양의 정수로 입력하세요.'
    );
  }

  const input = {
    basis: document.querySelector(
      'input[name="basis"]:checked'
    ).value,

    requestedKWp: cap,
    dcKW: n * m.p / 1000,
    moduleCount: n,
    module: {...m},
    manufacturer: $('manufacturer').value,
    series: $('series').value,

    ratio: Number($('ratio').value),
    tolerance: Number($('ratioTolerance').value) / 100,
    voltage: Number($('acVoltage').value),
    priority: $('priority').value,

    kva350: Number($('rating350').value),
    pf350: Number($('pf350').value),

    minTemperature: Number($('minTemperature').value),
    maxCellTemperature: Number($('maxCellTemperature').value),
    vmpCoefficient: Number($('vmpCoefficient').value),
    rearIrradiance: Number($('rearIrradiance').value),
    vocMargin: Number($('vocMargin').value),
    iscFactor: Number($('iscFactor').value),
    azimuth: Number($('azimuth').value),
    tilt: Number($('tilt').value)
  };

  if (
    !ids.every(id => Number.isFinite(Number($(id).value))) ||
    input.minTemperature < -50 ||
    input.minTemperature > 25 ||
    input.maxCellTemperature < 25 ||
    input.maxCellTemperature > 90 ||
    input.minTemperature >= input.maxCellTemperature ||
    input.vmpCoefficient < -.6 ||
    input.vmpCoefficient > -.1 ||
    input.rearIrradiance < 0 ||
    input.rearIrradiance > 30 ||
    input.vocMargin < 0 ||
    input.vocMargin > 10 ||
    input.iscFactor < 1 ||
    input.iscFactor > 1.5 ||
    input.azimuth < 0 ||
    input.azimuth > 360 ||
    input.tilt < 0 ||
    input.tilt > 90
  ) {
    throw new Error(
      '예비 설계 조건의 온도·계수·후면 일사율·방위·경사 입력 범위를 확인하세요.'
    );
  }

  return input;
}

function signature() {
  const ids = [
    'plantCapacity', 'moduleCount', 'ratio', 'ratioTolerance',
    'acVoltage', 'rating350', 'pf350', 'priority',
    'manufacturer', 'series', 'model',
    'minTemperature', 'maxCellTemperature', 'vmpCoefficient',
    'rearIrradiance', 'vocMargin', 'iscFactor', 'azimuth', 'tilt'
  ];

  return JSON.stringify(
    ids.map(id => $(id).value).concat(
      document.querySelector('input[name="basis"]:checked').value
    )
  );
}

function invalidate() {
  resultState = null;

  $('results').replaceChildren(
    element(
      'p',
      '입력 조건이 변경되었습니다. 자동 계산 실행을 눌러 주세요.',
      'empty-state'
    )
  );

  $('verifyBody').replaceChildren();
  $('unconfirmedList').replaceChildren();
  $('inverterPreview').replaceChildren();
  $('inverterPreview').disabled = true;

  $('mpptGrid').replaceChildren(
    element(
      'p',
      '구성안을 계산하면 인버터별 예비 직렬·병렬 연결 그림을 표시합니다.',
      'empty-state'
    )
  );

  setText('mpptInfo', '계산 대기');
  setText(
    'mpptSummary',
    '제조사 미확인 항목은 최종 접속 승인으로 처리하지 않습니다.'
  );
  setText(
    'inputMessage',
    '모듈 장수는 반올림하며, STC 모듈 합계로 AC/DC 비율을 계산합니다.'
  );
  setText(
    'resultNote',
    '350kW(800V)는 동일 모델끼리만, 150·110·60·36kW(380V)는 서로 조합합니다.'
  );
  setText(
    'assumptionSummary',
    '온도·Vmpp 계수·후면 일사율을 변경한 뒤에는 다시 계산하세요.'
  );
}

function moduleDesignValues(module, input) {
  const rearScale = input.rearIrradiance / 13.5;
  const interpolate = (stc, bnpi) => stc + (bnpi - stc) * rearScale;

  const ref = {
    voc: interpolate(module.voc, module.bnpiVoc),
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

  let previous = new Float64Array(maxTotal + 1);
  previous.fill(Infinity);
  previous[0] = 0;

  const choices = [];

  for (let mppt = 0; mppt < design.inverter.mppt; mppt++) {
    const next = new Float64Array(maxTotal + 1);
    next.fill(Infinity);

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

        if (cost < next[sum]) {
          next[sum] = cost;
          selected[sum] = index;
        }
      });
    }

    previous = next;
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

function allocatePlant(plan, designs, input) {
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

  let remaining = input.moduleCount;
  let remainingAC = plan.acKW;

  for (const unit of units) {
    const quota = remainingAC > 0
      ? remaining * unit.unitAC / remainingAC
      : 0;

    const possible = unit.design.pattern.reachable.filter(
      total => total <= Math.min(
        remaining,
        Math.floor(quota + 1e-10)
      )
    );

    unit.modules = possible[possible.length - 1] || 0;
    remaining -= unit.modules;
    remainingAC -= unit.unitAC;
  }

  for (const unit of units) {
    const possible = unit.design.pattern.reachable.filter(
      total =>
        total >= unit.modules &&
        total <= unit.modules + remaining
    );

    const total = possible[possible.length - 1] ?? unit.modules;
    remaining -= total - unit.modules;
    unit.modules = total;
  }

  // 잔여 모듈을 2대 간 재배분합니다.
  // 모든 조합의 전역 최적해를 보장하지는 않습니다.
  if (remaining > 0) {
    const limit = Math.min(units.length, 100);

    outer:
    for (let i = 0; i < limit; i++) {
      for (let j = i + 1; j < limit; j++) {
        const first = units[i];
        const second = units[j];
        const total = first.modules + second.modules;

        let gain = 0;
        let newFirst = first.modules;
        let newSecond = second.modules;

        const reachableSecond = second.design.pattern.reachable;

        for (const a of first.design.pattern.reachable) {
          const budget = total + remaining - a;

          let lo = 0;
          let hi = reachableSecond.length - 1;
          let found = -1;

          while (lo <= hi) {
            const mid = (lo + hi) >> 1;

            if (reachableSecond[mid] <= budget) {
              found = mid;
              lo = mid + 1;
            } else {
              hi = mid - 1;
            }
          }

          if (found < 0) continue;

          const b = reachableSecond[found];
          const add = a + b - total;

          if (add > gain) {
            gain = add;
            newFirst = a;
            newSecond = b;
          }
        }

        first.modules = newFirst;
        second.modules = newSecond;
        remaining -= gain;

        if (remaining === 0) break outer;
      }
    }
  }

  return {
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

const TITLES = {
  A: 'A안 최소 대수',
  B: 'B안 비율 근접',
  C: 'C안 균형형'
};

function planName(plan) {
  return plan.rows
    .map(row => row.kw + 'kW × ' + row.count)
    .join(' + ');
}

function renderResults() {
  const grid = $('results');
  grid.replaceChildren();

  for (const id of ['A', 'B', 'C']) {
    const plan = resultState.plans[id];

    const button = element('button', undefined, 'result-card');
    button.type = 'button';
    button.dataset.card = id;

    const head = element('div', undefined, 'result-top');

    head.append(
      element('span', id, 'result-id'),
      element('span', TITLES[id]),
      element(
        'span',
        plan ? '총 ' + plan.count + '대' : '조건 미충족',
        'result-count'
      )
    );

    button.append(head);

    if (!plan) {
      button.disabled = true;
      button.setAttribute('aria-pressed', 'false');

      button.append(
        element(
          'div',
          '현재 조건의 예비 구성안 없음',
          'result-name'
        )
      );

      button.append(
        element(
          'p',
          '입력 조건과 예비 제외 사유를 확인하세요.',
          'result-voltage'
        )
      );
    } else {
      button.append(
        element('div', planName(plan), 'result-name')
      );

      button.append(
        element(
          'p',
          plan.voltage + 'V · ' +
          (
            plan.voltage === 800
              ? '350kW 동일 모델 구성'
              : '380V 모델 조합'
          ) +
          (plan.within ? '' : ' · 비율 편차 초과'),
          'result-voltage'
        )
      );

      const stats = element('div', undefined, 'result-stats');

      const values = [
        ['AC 합계', asNumber(plan.acKW) + ' kW'],
        ['계획 AC/DC', plan.actualRatio.toFixed(3)],
        ['비율 편차', (plan.error * 100).toFixed(2) + '%']
      ];

      for (const [label, value] of values) {
        const item = element('div');

        item.append(
          element('small', label),
          element('strong', value)
        );

        stats.append(item);
      }

      button.append(stats);
      button.addEventListener('click', () => selectChoice(id));
    }

    grid.append(button);
  }
}

function selectChoice(id) {
  if (!resultState || !resultState.plans[id]) {
    notify('해당 조건의 구성안이 없습니다.');
    return;
  }

  currentChoice = id;
  activeCard = id;

  document.querySelectorAll('.choice').forEach(node => {
    node.setAttribute(
      'aria-pressed',
      String(node.dataset.choice === id)
    );
  });

  document.querySelectorAll('.result-card').forEach(node => {
    const selected = node.dataset.card === id;

    node.setAttribute('aria-pressed', String(selected));
    node.classList.toggle('selected', selected);
  });

  if (!resultState.allocations[id]) {
    resultState.allocations[id] = allocatePlant(
      resultState.plans[id],
      resultState.designs,
      resultState.input
    );
  }

  const allocation = resultState.allocations[id];
  const select = $('inverterPreview');

  select.replaceChildren(
    ...allocation.units.map((unit, index) => {
      const op = element(
        'option',
        '#' + unit.index + ' · ' +
        unit.model + ' · ' +
        unit.modules + '장'
      );

      op.value = String(index);
      return op;
    })
  );

  select.disabled = false;
  select.value = '0';

  renderVerification();
  renderMppt();
}

function renderVerification() {
  const input = resultState.input;
  const plan = resultState.plans[activeCard];
  const allocation = resultState.allocations[activeCard];
  const m = input.module;
  const values = moduleDesignValues(m, input);

  const fixed = (value, digits = 3) =>
    Number(value).toLocaleString('ko-KR', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });

  const lines = (...items) => items.join('\n');

  const rows = [];

  function add(name, description, kind, label, reason) {
    rows.push({
      name,
      description,
      kind,
      label,
      reason
    });
  }

  /*
   * 같은 모델·직렬 수·병렬 수의 MPPT를 묶습니다.
   * 검토 결과가 인버터 대수만큼 반복되는 것을 줄이되,
   * 실제 사용 중인 모든 연결 형태를 포함합니다.
   */
  const grouped = new Map();

  for (const unit of allocation.units) {
    const inv = resultState.designs[unit.kw].inverter;

    for (const mppt of unit.mppts) {
      if (!mppt.modules) continue;

      const key = [
        unit.kw,
        mppt.series,
        mppt.parallel
      ].join('/');

      if (!grouped.has(key)) {
        grouped.set(key, {
          inv,
          series: mppt.series,
          parallel: mppt.parallel,
          count: 0
        });
      }

      grouped.get(key).count++;
    }
  }

  const groups = [...grouped.values()];
  const hasConnections = groups.length > 0;

  const groupName = group =>
    group.inv.kw + 'kW / ' +
    group.series + '직렬 × ' +
    group.parallel + '병렬 / ' +
    group.count + '개 MPPT';

  /*
   * 1. AC 출력 전압
   */
  const voltageOK = plan.rows.every(
    row => row.voltage === input.voltage
  );

  add(
    'AC 출력 전압',
    lines(
      '선택 전압: ' + input.voltage + 'V',
      '',
      ...plan.rows.map(row =>
        row.model + '\n' +
        '정격 ' + row.voltage + 'V × ' +
        row.count + '대'
      ),
      '',
      '비교 기준: 모든 인버터의 AC 정격전압이 선택 전압과 같아야 합니다.',
      '350kW의 800V 출력과 나머지 모델의 380V 출력은 같은 구성안에서 혼합하지 않습니다.'
    ),
    voltageOK ? 'ok' : 'error',
    voltageOK ? '전압 일치' : '전압 불일치',
    voltageOK
      ? '선택 전압과 모든 모델의 정격전압이 같습니다. 실제 계통·변압기 적합성은 별도 확인해야 합니다.'
      : '선택 전압과 다른 정격전압의 모델이 포함되어 있습니다.'
  );

  /*
   * 2. AC/DC 목표 비율
   */
  add(
    'AC/DC 목표 비교',
    lines(
      '전체 모듈 STC DC 용량:',
      input.moduleCount + '장 × ' + m.p +
      'W ÷ 1,000 = ' + fixed(input.dcKW) + 'kWp',
      '',
      'AC 용량 합계:',
      ...plan.rows.map(row =>
        fixed(row.unitAC) + 'kW/대 × ' +
        row.count + '대 = ' +
        fixed(row.unitAC * row.count) + 'kW'
      ),
      '합계 = ' + fixed(plan.acKW) + 'kW',
      '',
      '계획 AC/DC:',
      fixed(plan.acKW) + ' ÷ ' +
      fixed(input.dcKW) + ' = ' +
      fixed(plan.actualRatio, 6),
      '',
      '입력 목표 AC/DC: ' + fixed(input.ratio, 6),
      '목표 AC 용량: ' +
      fixed(input.dcKW) + ' × ' +
      fixed(input.ratio) + ' = ' +
      fixed(resultState.plans.targetAC) + 'kW',
      '',
      '목표 대비 편차:',
      '|계획 비율 ÷ 목표 비율 − 1| × 100',
      '= |' + fixed(plan.actualRatio, 6) +
      ' ÷ ' + fixed(input.ratio, 6) +
      ' − 1| × 100',
      '= ' + fixed(plan.error * 100) + '%',
      '',
      '비교 기준: 편차 ≤ ' +
      fixed(input.tolerance * 100) + '%',
      '',
      '허용 AC/DC 구간:',
      fixed(input.ratio * (1 - input.tolerance), 6) +
      ' ~ ' +
      fixed(input.ratio * (1 + input.tolerance), 6),
      '',
      '별도 필수 조건 AC/DC > 1.00도 함께 충족해야 합니다.'
    ),
    plan.within ? 'ok' : 'error',
    plan.within ? '허용 범위' : '편차 초과',
    plan.within
      ? '목표 대비 편차가 입력한 허용 편차 이내입니다.'
      : '목표 대비 편차가 허용값을 초과합니다. B안은 최근접 대안으로 표시되더라도 조건 충족안은 아닙니다.'
  );

  /*
   * 3. AC/DC > 1.00 필수 조건
   */
  const aboveUnity = plan.acKW > input.dcKW + 1e-9;

  add(
    '자동 선정 필수 조건',
    lines(
      '계산 기준: 전체 입력 모듈의 STC 용량',
      '',
      'AC 용량: ' + fixed(plan.acKW) + 'kW',
      'DC 용량: ' + fixed(input.dcKW) + 'kWp',
      '',
      'AC/DC = ' +
      fixed(plan.acKW) + ' ÷ ' +
      fixed(input.dcKW) + ' = ' +
      fixed(plan.actualRatio, 6),
      '',
      '비교 기준: AC/DC > 1.00',
      '동일한 1.00 및 1.00 미만 구성은 제외합니다.',
      '',
      '이 조건은 용량 선정 정책입니다. 전압·전류 적합성이나 발전량 우위를 보장하는 기준은 아닙니다.'
    ),
    aboveUnity ? 'ok' : 'error',
    aboveUnity ? '1.00 초과' : '조건 미충족',
    aboveUnity
      ? '인버터 AC 용량이 전체 모듈 STC DC 용량보다 큽니다.'
      : 'AC 용량이 DC 용량보다 크지 않습니다.'
  );

  /*
   * 4. DC 기준
   */
  add(
    'DC 기준',
    lines(
      '모듈: ' + m.name,
      'STC 정격: ' + m.p + 'W/장',
      '입력 수량: ' + input.moduleCount + '장',
      '',
      'DC 합계:',
      input.moduleCount + ' × ' + m.p +
      ' ÷ 1,000 = ' + fixed(input.dcKW) + 'kWp',
      '',
      '비교 기준: 전체 모듈 수량 × STC 정격출력',
      '',
      'AC/DC 분모에는 BNPI 출력이나 고온 보정 출력을 사용하지 않습니다.',
      '양면 시나리오의 출력·전류 검토와 AC/DC 선정 기준은 구분합니다.'
    ),
    'ok',
    '산술 기준',
    '전체 입력 모듈의 STC 용량입니다. 실제 발전량이나 연결 완료 용량을 의미하지는 않습니다.'
  );

  /*
   * 5. 350kW 정격 조건
   */
  if (input.voltage === 800) {
    const ambient = {
      350: 30,
      334: 40,
      300: 50
    }[input.kva350];

    add(
      '350kW 계산 조건',
      lines(
        '선택한 정격 주변온도: ' + ambient + '℃',
        '선택 피상전력: ' + input.kva350 + 'kVA/대',
        '계산 역률: ' + fixed(input.pf350),
        '',
        '대당 유효전력:',
        input.kva350 + 'kVA × ' +
        fixed(input.pf350) + ' = ' +
        fixed(input.kva350 * input.pf350) + 'kW',
        '',
        '이 값을 AC 합계 및 AC/DC 계산에 사용합니다.',
        '',
        '비교·확인 대상: 실제 인버터 주변온도, 적용 역률, 제조사 온도별 출력 저감 조건',
        '모듈 최고 셀온도 ' +
        input.maxCellTemperature +
        '℃와 인버터 주변온도는 서로 다른 조건입니다.'
      ),
      'warning',
      '현장 확인 필요',
      '선택한 정격 조건에 따른 계산입니다. 실제 현장의 연속 출력 가능 여부를 확인해야 합니다.'
    );
  }

  /*
   * 6. 양면 출력 보간 및 전류 온도 보정
   */
  const rearScale = input.rearIrradiance / 13.5;

  let rearMethod;

  if (Math.abs(input.rearIrradiance) < 1e-10) {
    rearMethod = '후면 0%: STC 기준값';
  } else if (
    Math.abs(input.rearIrradiance - 13.5) < 1e-10
  ) {
    rearMethod = '후면 13.5%: 데이터시트 BNPI 기준값';
  } else if (input.rearIrradiance < 13.5) {
    rearMethod = 'STC와 BNPI 사이의 선형 보간 추정';
  } else {
    rearMethod = 'BNPI 범위를 넘는 선형 외삽 추정';
  }

  const currentFactorExplanation =
    m.iscCoefficientUnconfirmed
      ? lines(
          'TW Isc 온도계수 부호는 미확인입니다.',
          '전류가 커지는 쪽으로 다음 계수를 적용합니다.',
          '1 + |Isc 계수 ÷ 100| × 최대 |설계온도 − 25|'
        )
      : lines(
          '두 설계온도에서 다음 값을 계산해 큰 값을 사용합니다.',
          '1 + (Isc 온도계수 ÷ 100) × (설계온도 − 25)'
        );

  add(
    '양면 시나리오',
    lines(
      '자료 근거: ' + m.source,
      '',
      'BNPI 기준 조건:',
      '전면 1,000W/㎡ / 후면 135W/㎡ / 셀온도 25℃',
      '후면 비율 = 135 ÷ 1,000 × 100 = 13.5%',
      '',
      '입력 후면 일사율: ' + input.rearIrradiance + '%',
      '적용 방식: ' + rearMethod,
      '',
      '보간·외삽 비율 r:',
      input.rearIrradiance + ' ÷ 13.5 = ' +
      fixed(rearScale, 6),
      '',
      '일반 계산식:',
      '적용값 = STC값 + (BNPI값 − STC값) × r',
      '',
      '25℃ 기준 출력 시나리오:',
      m.p + ' + (' + m.bnpi + ' − ' + m.p +
      ') × ' + fixed(rearScale, 6),
      '= ' + fixed(values.power) + 'W/장',
      '',
      '25℃ 기준 Imp:',
      fixed(m.imp) + ' + (' +
      fixed(m.bnpiImp) + ' − ' +
      fixed(m.imp) + ') × ' +
      fixed(rearScale, 6),
      '= ' + fixed(values.imp) + 'A',
      '',
      '전류 온도 보정:',
      'Isc 계수: ' + m.alphaIsc + '%/℃',
      '설계온도: ' + input.minTemperature +
      '℃ / ' + input.maxCellTemperature + '℃',
      currentFactorExplanation,
      '적용 온도계수 배율 = ' +
      fixed(values.maximumFactor, 6),
      '',
      '추정 Imp:',
      fixed(values.imp) + ' × ' +
      fixed(values.maximumFactor, 6) +
      ' = ' + fixed(values.impDesign) + 'A',
      '',
      '주의: Imp 온도계수가 없어 Isc 온도계수를 대신 사용합니다.',
      '출력 ' + fixed(values.power) +
      'W는 25℃ 기준 양면 시나리오이며, 온도 보정 Imp와 같은 운전점의 출력이 아닙니다.',
      '',
      '비교 대상: 아래 스트링·MPPT 동작전류 및 단락전류 허용값',
      '이 행 자체는 합격·불합격 판정이 아니라 계산 가정의 설명입니다.'
    ),
    'warning',
    '가정·추정값',
    '현장 후면 일사량과 제조사 Imp 온도계수는 미확인입니다. 실제 생산량을 예측한 결과가 아닙니다.'
  );

  /*
   * 7. 저온 Voc
   */
  const vocDetails = groups.map(group => {
    const stringVoc = group.series * values.vocWithMargin;
    const limit = Math.min(group.inv.dcMax, m.maxV);
    const pass = stringVoc <= limit + 1e-10;

    return lines(
      groupName(group),
      group.series + ' × ' +
      fixed(values.vocWithMargin) +
      ' = ' + fixed(stringVoc) + 'V',
      '인버터 최대 DC: ' + group.inv.dcMax + 'V',
      '모듈 최대 시스템 전압: ' + m.maxV + 'V',
      '적용 상한: 두 값 중 작은 ' + limit + 'V',
      '비교: ' + fixed(stringVoc) +
      (pass ? ' ≤ ' : ' > ') + limit + 'V',
      '결과: ' + (pass ? '가정 내 충족' : '상한 초과')
    );
  });

  const vocOK = hasConnections && groups.every(group =>
    group.series * values.vocWithMargin <=
    Math.min(group.inv.dcMax, m.maxV) + 1e-10
  );

  add(
    '저온 Voc',
    lines(
      '25℃ 기준 양면 보정 Voc:',
      fixed(m.voc) + ' + (' +
      fixed(m.bnpiVoc) + ' − ' +
      fixed(m.voc) + ') × ' +
      fixed(rearScale, 6),
      '= ' + fixed(values.voc) + 'V/장',
      '',
      'Voc 온도계수: ' + m.betaVoc + '%/℃',
      '최저 설계온도: ' + input.minTemperature + '℃',
      '',
      '저온 Voc:',
      fixed(values.voc) +
      ' × [1 + (' + m.betaVoc +
      ' ÷ 100) × (' +
      input.minTemperature + ' − 25)]',
      '= ' + fixed(values.vocCold) + 'V/장',
      '',
      '여유 ' + input.vocMargin + '% 적용:',
      fixed(values.vocCold) +
      ' × (1 + ' + input.vocMargin +
      ' ÷ 100) = ' +
      fixed(values.vocWithMargin) + 'V/장',
      '',
      hasConnections
        ? vocDetails.join('\n\n')
        : '연결된 스트링이 없어 비교할 수 없습니다.',
      '',
      '비교 기준: 스트링 저온 Voc가 인버터·모듈 전압 상한 이하여야 합니다.'
    ),
    vocOK ? 'warning' : 'error',
    vocOK ? '가정 내 충족' : '전압 검토 필요',
    vocOK
      ? '현재 배분 스트링은 설정한 온도·여유 조건에서 상한 이내입니다. 실제 현장 최저온도 확인이 필요합니다.'
      : '연결이 없거나 설정 전압 상한을 초과하는 스트링이 있습니다.'
  );

  /*
   * 8. 고온·저온 Vmpp
   */
  const vmpDetails = groups.map(group => {
    const hot = group.series * values.vmpHot;
    const cold = group.series * values.vmpCold;
    const lower = Math.max(
      group.inv.mppMin,
      group.inv.startV
    );

    const pass =
      hot >= lower - 1e-10 &&
      cold <= group.inv.mppMax + 1e-10;

    return lines(
      groupName(group),
      '고온: ' + group.series + ' × ' +
      fixed(values.vmpHot) +
      ' = ' + fixed(hot) + 'V',
      '저온: ' + group.series + ' × ' +
      fixed(values.vmpCold) +
      ' = ' + fixed(cold) + 'V',
      '現在 프로그램 적용 전압 범위: ' +
      group.inv.mppMin + '~' +
      group.inv.mppMax + 'V',
      '기동전압: ' + group.inv.startV + 'V',
      '고온 비교: ' + fixed(hot) +
      (hot >= lower - 1e-10 ? ' ≥ ' : ' < ') +
      lower + 'V',
      '저온 비교: ' + fixed(cold) +
      (cold <= group.inv.mppMax + 1e-10 ? ' ≤ ' : ' > ') +
      group.inv.mppMax + 'V',
      '결과: ' + (pass ? '가정 내 충족' : '범위 이탈')
    ).replace('現在', '현재');
  });

  const vmpOK = hasConnections && groups.every(group =>
    group.series * values.vmpHot >=
      Math.max(group.inv.mppMin, group.inv.startV) - 1e-10 &&
    group.series * values.vmpCold <=
      group.inv.mppMax + 1e-10
  );

  add(
    '고온·저온 Vmpp',
    lines(
      '25℃ 기준 양면 보정 Vmpp:',
      fixed(m.vmp) + ' + (' +
      fixed(m.bnpiVmp) + ' − ' +
      fixed(m.vmp) + ') × ' +
      fixed(rearScale, 6),
      '= ' + fixed(values.vmp) + 'V/장',
      '',
      '적용 Vmpp 온도계수: ' +
      input.vmpCoefficient + '%/℃',
      '제조사 확정값이 아닌 화면 입력 가정입니다.',
      '',
      '고온 Vmpp:',
      fixed(values.vmp) +
      ' × [1 + (' + input.vmpCoefficient +
      ' ÷ 100) × (' +
      input.maxCellTemperature + ' − 25)]',
      '= ' + fixed(values.vmpHot) + 'V/장',
      '',
      '저온 Vmpp:',
      fixed(values.vmp) +
      ' × [1 + (' + input.vmpCoefficient +
      ' ÷ 100) × (' +
      input.minTemperature + ' − 25)]',
      '= ' + fixed(values.vmpCold) + 'V/장',
      '',
      hasConnections
        ? vmpDetails.join('\n\n')
        : '연결된 스트링이 없어 비교할 수 없습니다.',
      '',
      '중요: 위 전압 범위는 현재 계산기에 적용된 선정 기준입니다.',
      '제조사 자료에서 전체 MPPT 운전 범위와 정격출력 전압 범위를 구분해 재확인해야 합니다.',
      '범위를 벗어났다는 이유만으로 실제 운전 불가를 확정하지 않습니다.',
      '기동전압도 현재는 Vmpp에 함께 대조하는 예비 기준이며 실제 기동 조건 검증을 대신하지 않습니다.'
    ),
    vmpOK ? 'warning' : 'error',
    vmpOK ? '가정 내 충족' : '범위 확인 필요',
    'Vmpp 온도계수와 적용 전압 범위의 의미를 제조사 자료로 확인해야 합니다. 현재 결과는 최종 접속 승인이나 생산량 보장이 아닙니다.'
  );

  /*
   * 9. 스트링 동작전류
   */
  const stringDetails = groups.map(group => {
    const limit =
      group.parallel === 1 && group.inv.singleStringA
        ? group.inv.singleStringA
        : group.inv.stringA;

    const pass = values.impDesign <= limit + 1e-10;

    return lines(
      groupName(group),
      '1스트링 추정 Imp: ' +
      fixed(values.impDesign) + 'A',
      '현재 적용 스트링 허용값: ' + fixed(limit) + 'A',
      group.parallel === 1 && group.inv.singleStringA
        ? '단일 스트링일 때의 별도 허용값을 적용했습니다. 제조사 적용 조건은 미확인입니다.'
        : '일반 스트링 입력전류 허용값을 적용했습니다.',
      '비교: ' + fixed(values.impDesign) +
      (pass ? ' ≤ ' : ' > ') + fixed(limit) + 'A',
      '결과: ' + (pass ? '가정 내 충족' : '전류 초과')
    );
  });

  const stringOK = hasConnections && groups.every(group => {
    const limit =
      group.parallel === 1 && group.inv.singleStringA
        ? group.inv.singleStringA
        : group.inv.stringA;

    return values.impDesign <= limit + 1e-10;
  });

  add(
    '스트링 동작전류',
    lines(
      '직렬 연결에서는 모듈 전압이 합산됩니다.',
      '동일 모듈의 스트링 전류는 직렬 장수를 곱하지 않습니다.',
      '',
      '추정 스트링 전류:',
      fixed(values.imp) + ' × ' +
      fixed(values.maximumFactor, 6) +
      ' = ' + fixed(values.impDesign) + 'A',
      '',
      hasConnections
        ? stringDetails.join('\n\n')
        : '사용 중인 스트링이 없어 비교할 수 없습니다.',
      '',
      '비교 기준: 스트링 추정 Imp ≤ 스트링 허용 입력전류',
      '모든 스트링이 동일 모듈·방위·일사 조건이라는 가정입니다.'
    ),
    stringOK ? 'warning' : 'error',
    stringOK ? '가정 내 충족' : '전류 검토 필요',
    'Imp 온도계수와 단일 스트링 예외 조건, 실제 포트별 허용값은 제조사 확인이 필요합니다.'
  );

  /*
   * 10. MPPT 동작전류
   */
  const mpptCurrentDetails = groups.map(group => {
    const current = group.parallel * values.impDesign;
    const pass = current <= group.inv.mpptA + 1e-10;

    return lines(
      groupName(group),
      'MPPT 전류:',
      group.parallel + '병렬 × ' +
      fixed(values.impDesign) +
      'A = ' + fixed(current) + 'A',
      'MPPT 허용 입력전류: ' +
      fixed(group.inv.mpptA) + 'A',
      '비교: ' + fixed(current) +
      (pass ? ' ≤ ' : ' > ') +
      fixed(group.inv.mpptA) + 'A',
      '결과: ' + (pass ? '가정 내 충족' : '전류 초과')
    );
  });

  const mpptCurrentOK = hasConnections && groups.every(group =>
    group.parallel * values.impDesign <=
    group.inv.mpptA + 1e-10
  );

  add(
    'MPPT 동작전류',
    lines(
      '병렬 연결에서는 스트링 전류가 합산됩니다.',
      '',
      '계산식:',
      'MPPT 추정 Imp = 병렬 스트링 수 × 스트링 추정 Imp',
      '',
      hasConnections
        ? mpptCurrentDetails.join('\n\n')
        : '사용 중인 MPPT가 없어 비교할 수 없습니다.',
      '',
      '비교 기준: MPPT 추정 Imp ≤ MPPT 허용 입력전류',
      '허용값 초과 시 실제 전류 제한 동작 여부와 손실은 제조사 확인이 필요합니다.'
    ),
    mpptCurrentOK ? 'warning' : 'error',
    mpptCurrentOK ? '가정 내 충족' : '전류 초과',
    '현재 프로그램은 이 전류 한도를 넘는 연결을 예비 선정에서 제외합니다. 현장 일사 조건과 제조사 제한 동작은 별도 확인 대상입니다.'
  );

  /*
   * 11. MPPT 단락전류
   */
  const iscDetails = groups.map(group => {
    const current = group.parallel * values.iscDesign;
    const pass = current <= group.inv.mpptIscA + 1e-10;

    return lines(
      groupName(group),
      '병렬 합산 단락전류 검토값:',
      group.parallel + ' × ' +
      fixed(values.iscDesign) +
      ' = ' + fixed(current) + 'A',
      'MPPT 최대 단락전류 표기값: ' +
      fixed(group.inv.mpptIscA) + 'A',
      '비교: ' + fixed(current) +
      (pass ? ' ≤ ' : ' > ') +
      fixed(group.inv.mpptIscA) + 'A',
      '결과: ' + (pass ? '가정 내 충족' : '단락전류 초과')
    );
  });

  const iscOK = hasConnections && groups.every(group =>
    group.parallel * values.iscDesign <=
    group.inv.mpptIscA + 1e-10
  );

  add(
    'MPPT 단락전류',
    lines(
      '25℃ 양면 보정 Isc:',
      fixed(m.isc) + ' + (' +
      fixed(m.bnpiIsc) + ' − ' +
      fixed(m.isc) + ') × ' +
      fixed(rearScale, 6),
      '= ' + fixed(values.isc) + 'A',
      '',
      '온도 보정 Isc:',
      fixed(values.isc) + ' × ' +
      fixed(values.maximumFactor, 6) +
      ' = ' + fixed(values.iscTemperature) + 'A',
      '',
      '화면의 여유계수 적용:',
      fixed(values.iscTemperature) + ' × ' +
      fixed(input.iscFactor) +
      ' = ' + fixed(values.iscDesign) + 'A/스트링',
      '',
      hasConnections
        ? iscDetails.join('\n\n')
        : '사용 중인 MPPT가 없어 비교할 수 없습니다.',
      '',
      '비교 기준: 병렬 합산 단락전류 검토값 ≤ MPPT 최대 단락전류 표기값',
      '',
      '여유계수 ' + input.iscFactor +
      '는 화면에 설정한 예비 검토값입니다.',
      '이 계수를 해당 제조사 한도와 대조하는 방식의 적정성 및 규정 적용은 아직 확인되지 않았습니다.',
      '퓨즈 정격이나 실제 차단전류를 계산한 결과가 아닙니다.'
    ),
    iscOK ? 'warning' : 'error',
    iscOK ? '가정 내 충족' : '단락전류 검토 필요',
    '제조사 입력별 단락전류 조건, 적용 규정, 실제 후면 일사 및 보호설계를 확인해야 합니다.'
  );

  /*
   * 12. 모듈 배분
   */
  const allocatedFromMppts = allocation.units.reduce(
    (sum, unit) =>
      sum + unit.mppts.reduce(
        (unitSum, mppt) =>
          unitSum + mppt.series * mppt.parallel,
        0
      ),
    0
  );

  const conserved =
    allocatedFromMppts === allocation.allocated &&
    allocation.allocated + allocation.unallocated ===
      input.moduleCount;

  const allocationComplete =
    conserved && allocation.unallocated === 0;

  add(
    '모듈 배분',
    lines(
      '전체 입력: ' + input.moduleCount + '장',
      '',
      '사용 중인 연결 형태:',
      hasConnections
        ? groups.map(group =>
            group.inv.kw + 'kW: ' +
            group.series + '직렬 × ' +
            group.parallel + '병렬 × ' +
            group.count + '개 MPPT = ' +
            (
              group.series *
              group.parallel *
              group.count
            ) + '장'
          ).join('\n')
        : '연결 없음',
      '',
      'MPPT별 직렬 × 병렬 합계: ' +
      allocatedFromMppts + '장',
      '연결 수량: ' + allocation.allocated + '장',
      '미배분 수량: ' + allocation.unallocated + '장',
      '',
      '수량 검산:',
      allocation.allocated + ' + ' +
      allocation.unallocated + ' = ' +
      (
        allocation.allocated +
        allocation.unallocated
      ) + '장',
      '',
      '비교 기준:',
      '① MPPT별 모듈 합계 = 연결 수량',
      '② 연결 수량 + 미배분 수량 = 입력 수량',
      '③ 전체 배분 완료 조건: 미배분 0장',
      '',
      '미배분이 남으면 현재 구성·전압·전류 가정에서 전체 모듈이 연결되지 않은 것입니다.',
      '배분 탐색이 모든 가능한 조합의 최적해를 보장하지는 않습니다.'
    ),
    allocationComplete ? 'ok' : 'error',
    allocationComplete
      ? '수량 배분 완료'
      : conserved ? '미배분 발생' : '수량 검산 오류',
    allocationComplete
      ? '입력한 전체 모듈을 배분했습니다. 실제 포트·배선·퓨즈와 최종 출력 적합성은 별도 확인 대상입니다.'
      : conserved
        ? allocation.unallocated +
          '장이 남았습니다. 전체 모듈을 사용하는 구성은 아닙니다.'
        : '배분 수량과 입력 수량이 일치하지 않습니다.'
  );

  /*
   * 13. 실제 연결 모듈 기준 AC/DC
   */
  const connectedDC =
    allocation.allocated * m.p / 1000;

  const connectedRatio = connectedDC > 0
    ? plan.acKW / connectedDC
    : null;

  const connectedError = connectedRatio === null
    ? null
    : Math.abs(connectedRatio / input.ratio - 1);

  const connectedWithin =
    connectedError !== null &&
    connectedError <= input.tolerance + 1e-10;

  add(
    '연결 모듈 기준 AC/DC',
    connectedRatio === null
      ? lines(
          '연결 모듈: 0장',
          '연결 DC 용량이 0이므로 AC/DC를 계산할 수 없습니다.'
        )
      : lines(
          '연결 모듈 STC DC:',
          allocation.allocated + '장 × ' +
          m.p + 'W ÷ 1,000 = ' +
          fixed(connectedDC) + 'kWp',
          '',
          '연결 기준 AC/DC:',
          fixed(plan.acKW) + ' ÷ ' +
          fixed(connectedDC) + ' = ' +
          fixed(connectedRatio, 6),
          '',
          '목표 대비 편차:',
          '|연결 기준 비율 ÷ 목표 비율 − 1| × 100',
          '= ' + fixed(connectedError * 100) + '%',
          '',
          '비교 기준: 편차 ≤ ' +
          fixed(input.tolerance * 100) + '%',
          '',
          '전체 입력 기준 AC/DC: ' +
          fixed(plan.actualRatio, 6),
          '연결 모듈 기준 AC/DC: ' +
          fixed(connectedRatio, 6),
          '',
          '미배분 모듈은 연결 DC 분모에서 제외합니다.',
          '이 값은 전체 설비 합계 비율이며 개별 인버터의 입력 활용률이나 효율을 의미하지 않습니다.'
        ),
    connectedWithin ? 'ok' : 'error',
    connectedRatio === null
      ? '계산 불가'
      : connectedWithin ? '허용 범위' : '편차 초과',
    connectedRatio === null
      ? '연결된 모듈이 없습니다.'
      : connectedWithin
        ? '연결된 모듈만 기준으로 계산해도 입력한 허용 편차 이내입니다.'
        : '연결된 모듈 기준으로는 목표 대비 허용 편차를 초과합니다.'
  );

  /*
   * 14. 미확인 자료
   */
  add(
    '제조사·현장 확인',
    lines(
      '현재 계산 근거:',
      '제공 모듈 데이터시트 및 계산기에 입력된 인버터 사양',
      '',
      '아직 확보·확정하지 못한 비교 자료:',
      '① Solis 설치매뉴얼과 실제 DC 결선도',
      '② 전체 MPPT 운전 범위와 정격출력 전압 범위의 구분',
      '③ 입력전압·온도별 출력 제한 및 효율 곡선',
      '④ MPPT별 실제 포트 배치와 단일 스트링 예외 조건',
      '⑤ MPPT별 DC 전력 한도 및 허용 과대설계 조건',
      '⑥ 제조사 Vmpp·Imp 온도계수',
      '⑦ 실제 후면 일사량·음영·설치 방향별 조건',
      '⑧ 케이블·커넥터·퓨즈·역전류 보호설계',
      '',
      '모듈 최대 직렬 퓨즈 표기: ' +
      m.maxSeriesFuse + 'A',
      '이는 현재 설치할 퓨즈의 정격을 자동으로 결정한 값이 아닙니다.',
      '',
      '비교 자료가 없는 항목은 정상으로 확정하지 않고 미확인으로 남깁니다.',
      '연간 생산량과 실제 변환효율은 현재 계산하지 않습니다.'
    ),
    'warning',
    '미확인',
    '가정 내 전압·전류 조건 충족과 최종 설계 적합성은 다릅니다. 제조사 자료와 현장 조건의 추가 확인이 필요합니다.'
  );

  // Short results are composed from the same values used by the original
  // detailed review. The checkbox never changes model selection or math.
  const showDetails = $('showVerificationDetails').checked;
  const groupedResult = formatter => hasConnections
    ? groups.map(group => groupName(group) + '\n' + formatter(group)).join('\n\n')
    : '연결 없음';
  const summaryByName = {
    'AC 출력 전압': lines(
      '선택 전압: ' + input.voltage + 'V',
      ...plan.rows.map(row => row.kw + 'kW · ' + row.voltage + 'V · ' + row.count + '대')
    ),
    'AC/DC 목표 비교': lines(
      'AC 합계: ' + fixed(plan.acKW) + 'kW',
      'DC 합계: ' + fixed(input.dcKW) + 'kWp',
      '계획 AC/DC: ' + fixed(plan.actualRatio, 6),
      '목표 AC/DC: ' + fixed(input.ratio, 6),
      '목표 대비 편차: ' + fixed(plan.error * 100) + '%'
    ),
    '자동 선정 필수 조건': 'AC/DC: ' + fixed(plan.actualRatio, 6),
    'DC 기준': lines(
      m.name + ' · ' + m.p + 'W/장',
      '전체 모듈: ' + input.moduleCount + '장',
      'STC DC 합계: ' + fixed(input.dcKW) + 'kWp'
    ),
    '350kW 계산 조건': lines(
      '정격 주변온도: ' + ({350: 30, 334: 40, 300: 50}[input.kva350]) + '℃',
      '피상전력: ' + input.kva350 + 'kVA/대',
      '역률: ' + fixed(input.pf350),
      '유효전력: ' + fixed(input.kva350 * input.pf350) + 'kW/대'
    ),
    '양면 시나리오': lines(
      '후면 일사율: ' + input.rearIrradiance + '%',
      '25℃ 출력 추정: ' + fixed(values.power) + 'W/장',
      '25℃ Imp 추정: ' + fixed(values.imp) + 'A',
      '온도 보정 Imp 추정: ' + fixed(values.impDesign) + 'A'
    ),
    '저온 Voc': groupedResult(group =>
      '저온 Voc (여유 포함): ' + fixed(group.series * values.vocWithMargin) + 'V'
    ),
    '고온·저온 Vmpp': groupedResult(group => lines(
      '고온 Vmpp: ' + fixed(group.series * values.vmpHot) + 'V',
      '저온 Vmpp: ' + fixed(group.series * values.vmpCold) + 'V'
    )),
    '스트링 동작전류': hasConnections
      ? '스트링 Imp 추정: ' + fixed(values.impDesign) + 'A'
      : '연결 없음',
    'MPPT 동작전류': groupedResult(group =>
      'MPPT Imp 추정: ' + fixed(group.parallel * values.impDesign) + 'A'
    ),
    'MPPT 단락전류': groupedResult(group =>
      'MPPT Isc 검토값: ' + fixed(group.parallel * values.iscDesign) + 'A'
    ),
    '모듈 배분': lines(
      '전체 입력: ' + input.moduleCount + '장',
      '연결 수량: ' + allocation.allocated + '장',
      '미배분 수량: ' + allocation.unallocated + '장'
    ),
    '연결 모듈 기준 AC/DC': connectedRatio === null
      ? '연결 모듈 0장 · AC/DC 계산 불가'
      : lines(
          '연결 DC: ' + fixed(connectedDC) + 'kWp',
          '연결 기준 AC/DC: ' + fixed(connectedRatio, 6),
          '목표 대비 편차: ' + fixed(connectedError * 100) + '%'
        ),
    '제조사·현장 확인': lines(
      '제조사·현장 자료: 미확인',
      '모듈 최대 직렬 퓨즈 표기: ' + m.maxSeriesFuse + 'A'
    )
  };

  /*
   * 표 출력
   * 계산 설명은 검토 결과 칸에서 줄바꿈해 표시합니다.
   */
  $('verifyBody').replaceChildren(
    ...rows.map(row => {
      const tr = element('tr');

      if (row.kind !== 'ok') {
        tr.className = row.kind === 'error'
          ? 'verification-error'
          : 'caution';
      }

      const nameCell = element('td', row.name);
      const descriptionCell = element(
        'td',
        showDetails ? row.description : summaryByName[row.name]
      );

      descriptionCell.className = 'verification-result';
      descriptionCell.style.whiteSpace = 'pre-line';
      descriptionCell.style.lineHeight = showDetails ? '1.8' : '1.55';

      if (showDetails) {
        descriptionCell.append(element('span', row.reason, 'verification-reason'));
      }

      const statusCell = element(
        'td',
        undefined,
        'verification-status'
      );

      const icon = element(
        'span',
        row.kind === 'ok' ? '✓' : '!',
        row.kind === 'ok'
          ? 'status'
          : row.kind === 'error'
            ? 'status error'
            : 'status warn'
      );

      icon.setAttribute('aria-hidden', 'true');

      statusCell.append(
        icon,
        element(
          'strong',
          row.label,
          'verification-label'
        )
      );

      tr.append(
        nameCell,
        descriptionCell,
        statusCell
      );

      return tr;
    })
  );

  /*
   * 설명용 임시 열 너비:
   * 항목 16% / 검토 결과 56% / 상태 28%
   */
  const table = $('verifyBody').closest('table');

  if (table) {
    const widths = ['16%', '56%', '28%'];

    for (const tr of table.rows) {
      [...tr.cells].forEach((cell, index) => {
        cell.style.width = widths[index];
        cell.style.verticalAlign = 'top';
        cell.style.textAlign = 'left';
      });
    }
  }
}

function renderMppt() {
  if (!resultState || !resultState.plans[activeCard]) return;

  const input = resultState.input;
  const plan = resultState.plans[activeCard];
  const allocation = resultState.allocations[activeCard];

  const index = Number($('inverterPreview').value) || 0;
  const unit = allocation.units[index];
  const design = resultState.designs[unit.kw];
  const grid = $('mpptGrid');

  grid.replaceChildren();

  for (const mppt of unit.mppts) {
    const card = element('article', undefined, 'mppt-card');

    card.append(
      element('h3', 'MPPT ' + mppt.mppt, 'summary-title')
    );

    if (!mppt.modules) {
      card.append(
        element('p', '미사용 입력', 'summary-line')
      );
      grid.append(card);
      continue;
    }

    const wrap = element(
      'div',
      undefined,
      'connection-scroll'
    );

    wrap.append(connectionSvg(mppt));
    card.append(wrap);

    const v = design.values;

    const descriptions = [
      mppt.series + '직렬 × ' + mppt.parallel +
      '병렬 = ' + mppt.modules + '장 / STC ' +
      asNumber(mppt.modules * input.module.p / 1000) + 'kWp',

      '저온 Voc(여유 포함) ' +
      (mppt.series * v.vocWithMargin).toFixed(1) +
      'V / 인버터 최대 ' + design.inverter.dcMax + 'V',

      '고온~저온 Vmpp ' +
      (mppt.series * v.vmpHot).toFixed(1) + '~' +
      (mppt.series * v.vmpCold).toFixed(1) +
      'V / 범위 ' +
      design.inverter.mppMin + '~' +
      design.inverter.mppMax + 'V',

      'MPPT 동작전류 추정 ' +
      (mppt.parallel * v.impDesign).toFixed(2) +
      'A / 한도 ' + design.inverter.mpptA + 'A',

      'MPPT 단락전류 검토 ' +
      (mppt.parallel * v.iscDesign).toFixed(2) +
      'A / 표기 ' + design.inverter.mpptIscA + 'A',

      '예비 연결 개념도 · 실제 포트·퓨즈 배치는 미확인'
    ];

    for (const text of descriptions) {
      card.append(
        element('p', text, 'summary-line')
      );
    }

    grid.append(card);
  }

  setText(
    'mpptInfo',
    '#' + unit.index + ' ' + unit.model +
    ' / ' + unit.modules + '장 / DC ' +
    asNumber(unit.stcKW) + 'kWp / AC ' +
    asNumber(unit.unitAC) + 'kW'
  );

  setText(
    'mpptSummary',
    '전체 ' + plan.count + '대 · 연결 ' +
    allocation.allocated + '장 / 미배분 ' +
    allocation.unallocated +
    '장. 현재 선택한 1대의 그림만 표시·인쇄합니다. JSON에는 전체 배분을 저장합니다.'
  );
}

function runCalculation(scroll = true) {
  try {
    updateCount();

    const input = readInput();
    const designs = {};

    for (const inverter of INVERTERS) {
      designs[inverter.kw] = preliminaryDesign(
        inverter,
        input.module,
        input
      );
    }

    input.eligibleKw = INVERTERS
      .filter(inv => designs[inv.kw].eligible)
      .map(inv => inv.kw);

    const plans = capacityPlans(input);

    resultState = {
      input,
      plans,
      designs,
      allocations: {},
      signature: signature(),
      calculatedAt: new Date().toISOString()
    };

    renderResults();
    renderAssumptions();

    const chosen = plans[currentChoice] ? currentChoice : 'B';

    if (plans[chosen]) {
      selectChoice(chosen);
    } else {
      document.querySelectorAll('.choice').forEach(node => {
        node.setAttribute('aria-pressed', 'false');
      });

      $('verifyBody').replaceChildren();
      $('inverterPreview').replaceChildren();
      $('inverterPreview').disabled = true;

      $('mpptGrid').replaceChildren(
        element(
          'p',
          '선택한 전압에서 예비 전압·전류 조건을 만족하는 모델이 없습니다. 조건과 제외 사유를 확인하세요.',
          'empty-state'
        )
      );

      setText('mpptInfo', '예비 배선 생성 안 됨');
      setText(
        'mpptSummary',
        '현재 가정에서의 예비 제외이며 제조사 최종 접속 불가 판정은 아닙니다.'
      );
    }

    const excluded = INVERTERS
      .filter(inv =>
        inv.voltage === input.voltage &&
        !designs[inv.kw].eligible
      )
      .map(inv =>
        inv.kw + 'kW: ' + designs[inv.kw].reasons.join(', ')
      );

    setText(
      'excludedModels',
      excluded.length
        ? '예비 선정 제외 — ' + excluded.join(' / ')
        : '선택 전압의 모델에 대한 예비 전압·전류 범위 계산을 수행했습니다. 최종 접속 승인은 아닙니다.'
    );

    setText(
      'inputMessage',
      '실제 DC(STC) ' + asNumber(input.dcKW) +
      'kWp / 목표 AC ' + asNumber(plans.targetAC) +
      'kW / AC/DC 목표 ' + input.ratio.toFixed(3) +
      ' / ' + input.voltage + 'V'
    );

    setText(
      'resultNote',
      '공통 필수 조건: 전체 모듈 STC 기준 AC/DC > 1.00(동일값 제외). ' +
      'A: 허용 편차 내 최소 대수 / ' +
      'B: 목표 AC/DC 최근접(편차 초과 시 경고) / ' +
      'C: 비율 오차·대수 종합. ' +
      '예비 전압·전류 조건을 통과한 모델만 비교합니다. ' +
      'A~C가 같을 수 있습니다. ' +
      '카드의 계획 AC/DC는 전체 모듈 기준입니다. ' +
      '미배분이 있으면 연결 기준 비율을 사전검토 표에서 별도로 확인하세요.'
    );

    if (scroll) {
      $('resultSection').scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }
  } catch (error) {
    invalidate();
    setText('inputMessage', error.message);
    notify(error.message);
  }
}

function freshResult() {
  if (
    !resultState ||
    resultState.signature !== signature()
  ) {
    notify('현재 입력 조건으로 자동 계산을 먼저 실행하세요.');
    return false;
  }

  return true;
}

function downloadJSON() {
  if (!freshResult()) return;

  const plan = resultState.plans[activeCard] || null;

  const payload = {
    type: 'calculator-acdc-preliminary-mppt-v3',
    createdAt: resultState.calculatedAt,

    ratioDefinition: 'AC kW / STC DC kWp',

    selectionConstraint:
      'AC/DC > 1.00; equality excluded; all input STC modules',

    bifacialDefinition:
      '후면/전면 일사율 %, BNPI 전면1000·후면135W/㎡에서 STC↔BNPI 선형 보간/외삽',

    notice:
      '가정에 의한 예비 연결 개념도. 설치매뉴얼·Vmpp 계수·Imp 온도보정·포트·퓨즈·DC 전력 한도·실제 현장 조건은 미확정입니다.',

    input: resultState.input,
    selectedChoice: plan ? activeCard : null,
    selectedPlan: plan,
    plans: resultState.plans,

    selectedAllocation: plan
      ? resultState.allocations[activeCard]
      : null,

    unresolvedIssues: unresolvedIssues(resultState.input),
    electricalValidation: 'preliminary-unconfirmed'
  };

  const blob = new Blob(
    [JSON.stringify(payload, null, 2)],
    {type: 'application/json;charset=utf-8'}
  );

  const url = URL.createObjectURL(blob);
  const link = element('a');

  link.href = url;
  link.download = 'solar-calculator-acdc-mppt.json';

  document.body.append(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);

  notify(
    '입력 가정·전체 예비 배분·미확인 항목을 JSON으로 저장했습니다.'
  );
}

function unresolvedIssues(input) {
  const issues = [
    'Vmpp 온도계수 ' + input.vmpCoefficient +
    '%/℃는 제조사 확정값이 아닌 예비 가정입니다.',

    'Imp 온도계수는 미제공으로 Isc 계수를 대신 사용한 예비 추정입니다.',

    'Solis 설치매뉴얼·DC 결선도가 미제공입니다. MPPT별 포트 배치·단일 스트링 예외·포트별 단락전류는 미확인입니다.',

    'MPPT별 DC 전력 한도·허용 과대설계·실제 퓨즈·케이블·커넥터·보호설계는 미확인입니다. 모듈 최대 직렬 퓨즈 ' +
    input.module.maxSeriesFuse + 'A와 대조해야 합니다.',

    '모든 모듈은 동일 방위 ' + input.azimuth +
    '°·경사 ' + input.tilt +
    '°·음영 없음으로 가정합니다. 방향별 일사량이나 음영 손실을 계산한 값은 아닙니다.',

    '후면 일사율 ' + input.rearIrradiance +
    '%는 BNPI 후면 13.5%를 기준으로 STC↔BNPI를 선형 보간' +
    (input.rearIrradiance > 13.5 ? '·외삽' : '') +
    '한 시나리오이며 현장 최대 일사 조건을 보장하지 않습니다.',

    'Voc 여유 ' + input.vocMargin +
    '%와 단락전류 계수 ' + input.iscFactor +
    '는 화면에 설정한 예비 검토값입니다. 법규·제조사별 적용 기준의 검증을 대신하지 않습니다.',

    '배분은 예비 탐색 방식입니다. 미배분 모듈이 남아도 다른 구성까지 포함한 접속 불가를 확정하는 것은 아닙니다.'
  ];

  if (input.voltage === 800) {
    const ambient = {
      350: 30,
      334: 40,
      300: 50
    }[input.kva350];

    issues.push(
      '350kW 정격 주변온도 조건은 ' + ambient +
      '℃를 선택했습니다. 모듈 최고 셀온도와 별개이며 현장 인버터 주변온도는 미확인입니다.'
    );
  }

  if (input.module.iscCoefficientUnconfirmed) {
    issues.push(
      'TW Isc 온도계수 부호(-0.046%/℃)는 미확인입니다. ±0.046 범위 중 전류가 커지는 쪽으로 보수 추정했습니다.'
    );
  }

  return issues;
}

function renderAssumptions() {
  const input = resultState.input;

  setText(
    'assumptionSummary',
    '저온 셀온도 ' + input.minTemperature +
    '℃(최저 외기온도와 같다고 가정) / 최고 셀온도 ' +
    input.maxCellTemperature +
    '℃ / Vmpp ' + input.vmpCoefficient +
    '%/℃(가정) / 후면 일사율 ' + input.rearIrradiance +
    '% / 방위 ' + input.azimuth +
    '°·경사 ' + input.tilt + '°·음영 없음'
  );

  $('unconfirmedList').replaceChildren(
    ...unresolvedIssues(input).map(
      text => element('li', text)
    )
  );
}

function svgElement(tag, attributes = {}, text) {
  const node = document.createElementNS(
    'http://www.w3.org/2000/svg',
    tag
  );

  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }

  if (text !== undefined) {
    node.textContent = text;
  }

  return node;
}

function connectionSvg(mppt) {
  const width = 620;
  const rowHeight = 38;
  const height = mppt.parallel * rowHeight + 40;

  const svg = svgElement('svg', {
    viewBox: '0 0 ' + width + ' ' + height,
    role: 'img',
    'aria-label':
      mppt.series + '직렬 ' +
      mppt.parallel + '병렬 연결 개념도',
    class: 'connection-svg'
  });

  svg.append(
    svgElement('rect', {
      x: 4,
      y: 8,
      width: 64,
      height: height - 16,
      rx: 5,
      fill: '#e8f2ff',
      stroke: '#6e9ec6'
    })
  );

  svg.append(
    svgElement(
      'text',
      {
        x: 36,
        y: height / 2,
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
        fill: '#164c90',
        'font-size': 12
      },
      'MPPT ' + mppt.mppt
    )
  );

  for (let p = 0; p < mppt.parallel; p++) {
    const y = 24 + p * rowHeight;
    const begin = 105;
    const space = 480 / mppt.series;

    svg.append(
      svgElement('line', {
        x1: 68,
        y1: height / 2,
        x2: 88,
        y2: height / 2,
        stroke: '#2677ab',
        'stroke-width': 2
      })
    );

    svg.append(
      svgElement('line', {
        x1: 88,
        y1: height / 2,
        x2: 88,
        y2: y + 8,
        stroke: '#2677ab',
        'stroke-width': 2
      })
    );

    svg.append(
      svgElement('line', {
        x1: 88,
        y1: y + 8,
        x2: begin + 480,
        y2: y + 8,
        stroke: '#2677ab',
        'stroke-width': 2
      })
    );

    for (let n = 0; n < mppt.series; n++) {
      svg.append(
        svgElement('rect', {
          x: begin + n * space,
          y,
          width: Math.max(3, space - 3),
          height: 16,
          rx: 1,
          fill: '#2069b0',
          stroke: '#134579'
        })
      );
    }

    svg.append(
      svgElement(
        'text',
        {
          x: begin,
          y: y + 30,
          fill: '#375c86',
          'font-size': 11
        },
        '스트링 ' + (p + 1) + ' · ' +
        mppt.series + '장 직렬'
      )
    );
  }

  return svg;
}

function init() {
  const detailToggle = $('showVerificationDetails');
  detailToggle.checked = false;
  detailToggle.addEventListener('change', () => {
    if (resultState && resultState.signature === signature() &&
        resultState.plans[activeCard] && resultState.allocations[activeCard]) {
      renderVerification();
    }
  });
  for (let i = 0; i < 54; i++) {
    $('moduleIcon').append(element('span'));
  }

  fillOptions(
    $('manufacturer'),
    Object.keys(catalog),
    'HD현대에너지솔루션'
  );

  updateManufacturer();

  $('manufacturer').addEventListener(
    'change',
    updateManufacturer
  );

  $('series').addEventListener(
    'change',
    updateSeries
  );

  $('model').addEventListener(
    'change',
    updateModule
  );

  for (const id of ['plantCapacity', 'moduleCount']) {
    $(id).addEventListener('input', () => {
      updateCount();
      invalidate();
    });
  }

  for (
    const id of [
      'ratio',
      'ratioTolerance',
      'rating350',
      'pf350'
    ]
  ) {
    $(id).addEventListener('input', invalidate);
  }

  $('priority').addEventListener('change', invalidate);

  $('acVoltage').addEventListener('change', () => {
    voltageControls();
    invalidate();
  });

  document.querySelectorAll('input[name="basis"]').forEach(
    node => node.addEventListener('change', () => {
      const byModules = document.querySelector(
        'input[name="basis"]:checked'
      ).value === 'modules';

      $('moduleCount').readOnly = !byModules;
      $('plantCapacity').readOnly = byModules;

      updateCount();
      invalidate();
    })
  );

  document.querySelectorAll('.choice').forEach(node => {
    node.addEventListener(
      'click',
      () => selectChoice(node.dataset.choice)
    );
  });

  $('runBtn').addEventListener(
    'click',
    () => runCalculation()
  );

  $('printBtn').addEventListener('click', () => {
    if (freshResult()) window.print();
  });

  $('saveBtn').addEventListener('click', downloadJSON);

  window.addEventListener('beforeprint', () => {
    if (
      !resultState ||
      resultState.signature !== signature()
    ) {
      invalidate();
    }
  });

  const query = new URLSearchParams(location.search);
  const model = query.get('module') || query.get('model');

  if (model) {
    outer:
    for (const [mf, series] of Object.entries(catalog)) {
      for (const [ser, models] of Object.entries(series)) {
        if (models.some(m => m.name === model)) {
          $('manufacturer').value = mf;
          updateManufacturer();

          $('series').value = ser;
          updateSeries();

          $('model').value = model;
          updateModule();

          break outer;
        }
      }
    }
  }

  for (
    const id of [
      'minTemperature',
      'maxCellTemperature',
      'vmpCoefficient',
      'rearIrradiance',
      'vocMargin',
      'iscFactor',
      'azimuth',
      'tilt'
    ]
  ) {
    $(id).addEventListener('input', invalidate);
  }

  $('inverterPreview').addEventListener(
    'change',
    renderMppt
  );

  voltageControls();
  runCalculation(false);
}



function validateProductData(modules, inverters) {
  if (!modules || typeof modules !== 'object' || Array.isArray(modules) || !Object.keys(modules).length) {
    throw new Error('modules.json의 제조사·시리즈 구조를 확인하세요.');
  }
  const modelNames = new Set();
  const modulePositive = ['p', 'bnpi', 'voc', 'vmp', 'isc', 'imp', 'bnpiVoc', 'bnpiVmp', 'bnpiIsc', 'bnpiImp', 'eff', 'maxV', 'maxSeriesFuse'];
  for (const series of Object.values(modules)) {
    if (!series || typeof series !== 'object' || Array.isArray(series) || !Object.keys(series).length) {
      throw new Error('modules.json의 시리즈 목록이 올바르지 않습니다.');
    }
    for (const models of Object.values(series)) {
      if (!Array.isArray(models) || !models.length) throw new Error('modules.json의 모델 목록이 비어 있습니다.');
      for (const m of models) {
        if (!m || typeof m.name !== 'string' || !m.name || modelNames.has(m.name) ||
            modulePositive.some(key => !Number.isFinite(m[key]) || m[key] <= 0) ||
            ['betaVoc', 'alphaIsc', 'gammaPower'].some(key => !Number.isFinite(m[key]))) {
          throw new Error('modules.json의 모델명 또는 숫자 사양을 확인하세요.');
        }
        modelNames.add(m.name);
      }
    }
  }
  if (!Array.isArray(inverters) || !inverters.length) throw new Error('inverters.json의 인버터 목록이 비어 있습니다.');
  const capacities = new Set();
  const inverterPositive = ['kw','voltage','mppt','strings','portsPerMppt','stringA','mpptA','mpptIscA','dcMax','mppMin','mppMax','startV'];
  for (const inv of inverters) {
    if (!inv || typeof inv.model !== 'string' || !inv.model ||
        inverterPositive.some(key => !Number.isFinite(inv[key]) || inv[key] <= 0) ||
        ![36,60,110,150,350].includes(inv.kw) || capacities.has(inv.kw) ||
        inv.voltage !== (inv.kw === 350 ? 800 : 380) ||
        ![inv.mppt,inv.strings,inv.portsPerMppt].every(Number.isInteger) ||
        inv.mppt * inv.portsPerMppt !== inv.strings || inv.mppMin > inv.mppMax ||
        inv.mppMax > inv.dcMax ||
        (inv.singleStringA !== undefined && (!Number.isFinite(inv.singleStringA) || inv.singleStringA <= 0))) {
      throw new Error('inverters.json의 용량·전압·MPPT·전류 사양을 확인하세요.');
    }
    capacities.add(inv.kw);
  }
}

async function loadProductData() {
  const root = new URL('./data/', document.baseURI);
  const load = async name => {
    const response = await fetch(new URL(name, root), {cache:'no-cache'});
    if (!response.ok) throw new Error(name + '을 읽지 못했습니다. HTTP ' + response.status);
    return response.json();
  };
  const [modules, inverters] = await Promise.all([load('modules.json'), load('inverters.json')]);
  validateProductData(modules, inverters);
  return {modules, inverters};
}

async function startCalculator() {
  const status = $('dataLoadStatus');
  const retry = $('retryDataBtn');
  document.querySelectorAll('main input, main select, main button, .hero-actions button').forEach(node => node.disabled = true);
  retry.hidden = true;
  status.hidden = false;
  status.classList.remove('load-error');
  status.textContent = '인버터와 모듈 자료를 불러오는 중입니다.';
  try {
    const data = await loadProductData();
    catalog = data.modules;
    INVERTERS = data.inverters;
    document.querySelectorAll('main input, main select, main button, .hero-actions button').forEach(node => node.disabled = false);
    $('inverterPreview').disabled = true;
    init();
    status.hidden = true;
  } catch (error) {
    status.classList.add('load-error');
    status.textContent = location.protocol === 'file:'
      ? '제품 자료를 읽으려면 웹서버 주소로 열어 주세요. 파일을 직접 더블클릭하면 JSON 자료를 불러올 수 없습니다. ZIP의 적용안내.md를 참고하세요.'
      : '계산기를 시작하지 못했습니다. ' + error.message;
    setText('inputMessage', '제품 자료가 준비되면 계산할 수 있습니다.');
    retry.hidden = false;
  }
}

function bootCalculator() {
  $('retryDataBtn').addEventListener('click', startCalculator);
  startCalculator();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootCalculator, {once:true});
else bootCalculator();

})();
