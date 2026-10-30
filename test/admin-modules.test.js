"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../server/module-store");
const { extract } = require("../server/module-pdf");
const { problems } = require("../server/module-spec");
const { calculate, catalog } = require("../server/calculator-engine");
const example = () => ({
  manufacturer: "테스트 제조사",
  series: "테스트 시리즈",
  sourcePage: 1,
  module: {
    ...catalog["HD현대에너지솔루션"]["NA 시리즈"].find(
      (m) => m.name === "HiC-T645OJ",
    ),
    name: "TEST-645",
    bnpiRearIrradiance: 13.5,
  },
});
const input = {
  manufacturer: "테스트 제조사",
  series: "테스트 시리즈",
  model: "TEST-645",
  basis: "capacity",
  priority: "desc",
  requestedKWp: 400,
  moduleCount: 620,
  ratio: 1,
  tolerance: 0.1,
  voltage: 380,
  kva350: 350,
  pf350: 1,
  minTemperature: -20,
  maxCellTemperature: 40,
  rearIrradiance: 13.5,
  vocMargin: 0,
  iscFactor: 1.25,
  azimuth: 180,
  tilt: 30,
  designMode: "document",
};
test("real manufacturer PDFs extract model columns, STC/BNPI and common limits", async () => {
  const cases = [
    ["HD현대_NA시리즈_데이터시트.pdf", 3, "HiC-T645OJ", 56.81, 709.2],
    ["HD현대_NJ-ES시리즈_데이터시트.pdf", 2, "HiS-T645NJ-ES", 57.61, 710],
    ["HD현대_NR시리즈_데이터시트.pdf", 1, "HiS-T500NR-ES", 44.44, 550],
    [
      "TW_Solar_TWMNF66HD730-750_데이터시트.pdf",
      5,
      "TWMNF66HD750",
      50.1,
      828.2,
    ],
  ];
  for (const [file, count, model, voc, bnpi] of cases) {
    const r = await extract(
      path.join(__dirname, "../public/assets/docs", file),
      file,
    );
    assert.equal(r.candidates.length, count);
    assert.equal(r.pages, 2);
    const selected = r.candidates.find((c) => c.module.name === model);
    assert.equal(selected.module.voc, voc);
    assert.equal(selected.module.bnpi, bnpi);
    assert.equal(selected.module.maxV, 1500);
    assert.equal(selected.module.bnpiRearIrradiance, 13.5);
    assert.deepEqual(problems(selected), {});
    for (const c of r.candidates) {
      assert.equal(c.module.name.includes(String(c.module.p)), true);
      assert.ok(c.sources.voc.page === 2);
    }
  }
});
test("draft/publish/restart/disable preserve independent durable module state and calculator snapshots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solar-module-test-"));
  try {
    const s = createStore(dir),
      draft = example();
    const saved = s.save({ revision: 0, action: "draft", draft });
    assert.equal(s.catalog()["테스트 제조사"], undefined);
    assert.throws(() => calculate(input, s.catalog()));
    assert.throws(
      () =>
        s.save({ id: saved.record.id, revision: 1, action: "publish", draft }),
      /확인/,
    );
    const active = s.save({
      id: saved.record.id,
      revision: 1,
      action: "publish",
      draft,
      confirmed: true,
    });
    const snapshot = s.catalog();
    const result = calculate(input, snapshot);
    assert.equal(result.allocations.B.unallocated, 0);
    assert.equal(result.plans.B.acKW, 408);
    const changed = structuredClone(draft);
    changed.module.bnpiRearIrradiance = 10;
    const pending = s.save({
      id: active.record.id,
      revision: 2,
      action: "draft",
      draft: changed,
    });
    assert.equal(
      createStore(dir).catalog()["테스트 제조사"]["테스트 시리즈"][0]
        .bnpiRearIrradiance,
      13.5,
    );
    s.save({
      id: pending.record.id,
      revision: 3,
      action: "publish",
      draft: changed,
      confirmed: true,
    });
    assert.equal(
      calculate({ ...input, rearIrradiance: 10 }, s.catalog()).values.imp,
      draft.module.bnpiImp,
    );
    assert.equal(calculate(input, snapshot).values.imp, draft.module.bnpiImp);
    assert.throws(
      () =>
        s.save({ id: active.record.id, revision: 3, action: "draft", draft }),
      (error) => error.status === 409,
    );
    s.setEnabled(active.record.id, 4, false);
    assert.equal(s.catalog()["테스트 제조사"], undefined);
    s.setEnabled(active.record.id, 5, true);
    assert.ok(s.catalog()["테스트 제조사"]);
    assert.ok(fs.readdirSync(path.join(dir, "backups")).length >= 5);
    fs.writeFileSync(path.join(dir, "catalog.lock"), "test");
    assert.throws(
      () => s.setEnabled(active.record.id, 6, false),
      (error) => error.status === 409,
    );
    fs.unlinkSync(path.join(dir, "catalog.lock"));
    const stored = createStore(dir).read();
    assert.equal(stored.revision, 6);
    fs.writeFileSync(path.join(dir, "catalog.json"), "broken");
    assert.throws(
      () => s.catalog(),
      (error) => error.status === 503,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("publishing rejects missing or inconsistent specs, unsafe identities, duplicate names and unconfirmed overrides", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "solar-module-validation-"),
  );
  try {
    const s = createStore(dir),
      draft = example();
    const invalid = structuredClone(draft);
    invalid.module.vmp = 100;
    assert.throws(
      () =>
        s.save({
          revision: 0,
          action: "publish",
          draft: invalid,
          confirmed: true,
        }),
      (error) => Boolean(error.fields.vmp),
    );
    invalid.module.vmp = null;
    assert.throws(() =>
      s.save({
        revision: 0,
        action: "publish",
        draft: invalid,
        confirmed: true,
      }),
    );
    assert.throws(() =>
      s.save({
        revision: 0,
        action: "draft",
        draft: { ...draft, manufacturer: "__proto__" },
      }),
    );
    assert.throws(() =>
      s.save({
        revision: 0,
        action: "draft",
        draft: { ...draft, series: "constructor" },
      }),
    );
    const saved = s.save({
      revision: 0,
      action: "publish",
      draft,
      confirmed: true,
    });
    assert.throws(
      () => s.save({ revision: 1, action: "draft", draft }),
      (error) => error.status === 409,
    );
    assert.throws(
      () =>
        s.save({
          revision: 1,
          id: saved.record.id,
          action: "draft",
          draft: { ...draft, manufacturer: "changed" },
        }),
      /변경할 수 없습니다/,
    );
    const override = example();
    override.manufacturer = "HD현대에너지솔루션";
    override.series = "NA 시리즈";
    override.module.name = "HiC-T645OJ";
    assert.throws(
      () =>
        s.save({
          revision: 1,
          action: "publish",
          draft: override,
          confirmed: true,
        }),
      (error) => error.status === 409,
    );
    const updated = s.save({
      revision: 1,
      action: "publish",
      draft: override,
      confirmed: true,
      replaceExisting: true,
    });
    s.setEnabled(updated.record.id, 2, false);
    assert.equal(
      s
        .catalog()
        [
          "HD현대에너지솔루션"
        ]["NA 시리즈"].some((m) => m.name === "HiC-T645OJ"),
      false,
    );
    assert.equal({}.polluted, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("malformed files fail PDF parsing without creating module records", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solar-invalid-pdf-"));
  try {
    const file = path.join(dir, "fake.pdf");
    fs.writeFileSync(file, "<html>not PDF</html>");
    await assert.rejects(extract(file, "fake.pdf"), /PDF/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
