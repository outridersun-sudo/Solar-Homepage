"use strict";

const fields = [
  ["p", "정격 출력 (W)", 1, 2000],
  ["voc", "Voc (V)", 1, 200],
  ["vmp", "Vmpp (V)", 1, 200],
  ["isc", "Isc (A)", 0.1, 100],
  ["imp", "Impp (A)", 0.1, 100],
  ["bnpi", "BNPI 출력 (W)", 1, 3000],
  ["bnpiVoc", "BNPI Voc (V)", 1, 200],
  ["bnpiVmp", "BNPI Vmpp (V)", 1, 200],
  ["bnpiIsc", "BNPI Isc (A)", 0.1, 100],
  ["bnpiImp", "BNPI Impp (A)", 0.1, 100],
  ["bnpiRearIrradiance", "BNPI 후면 일사율 (%)", 0.1, 30],
  ["betaVoc", "Voc 온도계수 (%/℃)", -0.6, -0.1],
  ["alphaIsc", "Isc 온도계수 (%/℃)", -0.2, 0.2],
  ["gammaPower", "Pmax 온도계수 (%/℃)", -1, 0],
  ["maxV", "최대 시스템 전압 (V)", 1, 2000],
  ["maxSeriesFuse", "최대 직렬 퓨즈 (A)", 1, 100],
  ["eff", "모듈 효율 (%)", 1, 50],
];
const strings = ["name", "cells", "weight", "type", "warranty"];
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
function cleanText(value, max = 150) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    forbidden.has(value.trim())
  )
    throw fail("문자 항목의 형식과 길이를 확인하세요.");
  return value.trim();
}
function normalizeDraft(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw fail("모듈 사양을 확인하세요.");
  const module = {};
  for (const key of strings) module[key] = cleanText(body.module?.[key] ?? "");
  for (const [key] of fields) {
    const value = body.module?.[key];
    if (
      value !== null &&
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value))
    )
      throw fail("숫자 항목을 확인하세요.");
    module[key] = value ?? null;
  }
  module.iscCoefficientUnconfirmed =
    body.module?.iscCoefficientUnconfirmed === true;
  return {
    manufacturer: cleanText(body.manufacturer ?? ""),
    series: cleanText(body.series ?? ""),
    module,
    pdfId: body.pdfId ? cleanText(body.pdfId, 36) : null,
    sourcePage:
      Number.isInteger(body.sourcePage) &&
      body.sourcePage > 0 &&
      body.sourcePage <= 16
        ? body.sourcePage
        : 1,
  };
}
function problems(draft) {
  const errors = {};
  for (const [key, label] of [
    ["manufacturer", "제조사"],
    ["series", "시리즈"],
  ])
    if (!draft[key]) errors[key] = label + "를 입력하세요.";
  if (!draft.module.name) errors.name = "모델명을 입력하세요.";
  for (const [key, label, min, max] of fields) {
    const value = draft.module[key];
    if (typeof value !== "number" || value < min || value > max)
      errors[key] = `${label}: ${min}~${max} 범위의 값을 확인하세요.`;
  }
  const m = draft.module;
  for (const [power, vmp, voc, imp, isc] of [
    ["p", "vmp", "voc", "imp", "isc"],
    ["bnpi", "bnpiVmp", "bnpiVoc", "bnpiImp", "bnpiIsc"],
  ]) {
    if (m[vmp] && m[voc] && m[vmp] >= m[voc])
      errors[vmp] = "동작전압은 개방전압보다 작아야 합니다.";
    if (m[imp] && m[isc] && m[imp] > m[isc])
      errors[imp] = "동작전류는 단락전류 이하여야 합니다.";
    if (
      m[power] &&
      m[vmp] &&
      m[imp] &&
      Math.abs((m[vmp] * m[imp]) / m[power] - 1) > 0.1
    )
      errors[power] = "출력과 동작전압 × 동작전류의 차이가 10%를 초과합니다.";
  }
  return errors;
}
function asCalculatorModule(draft, source) {
  const m = { ...draft.module };
  m.temp = `${m.gammaPower} | ${m.betaVoc} | ${m.alphaIsc} %/℃`;
  m.source = source;
  return m;
}
module.exports = { fields, normalizeDraft, problems, asCalculatorModule, fail };
