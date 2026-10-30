"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const base = require("./calculator-data/modules.json");
const {
  normalizeDraft,
  problems,
  asCalculatorModule,
  fail,
} = require("./module-spec");
const defaultDirectory = path.resolve(
  process.env.MODULE_DATA_DIR ||
    path.join(__dirname, "..", "uploads", "module-catalog"),
);
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );

function createStore(directory = defaultDirectory) {
  const filename = path.join(directory, "catalog.json");
  function read() {
    try {
      const contents = fs.readFileSync(filename, "utf8");
      if (contents.length > 5 * 1024 * 1024)
        throw new Error("Catalog too large");
      const data = JSON.parse(contents);
      if (
        data.version !== 1 ||
        !Number.isSafeInteger(data.revision) ||
        !Array.isArray(data.records) ||
        data.records.length > 1000
      )
        throw new Error("Invalid catalog");
      return data;
    } catch (error) {
      if (error.code === "ENOENT")
        return { version: 1, revision: 0, records: [] };
      throw fail(
        "등록 모듈 파일을 읽지 못했습니다. 관리자에게 확인해 주세요.",
        503,
      );
    }
  }
  function document(id) {
    if (!uuid(id)) throw fail("PDF를 확인하세요.");
    try {
      return JSON.parse(
        fs.readFileSync(
          path.join(directory, "documents", id + ".json"),
          "utf8",
        ),
      );
    } catch {
      throw fail("업로드된 PDF를 찾지 못했습니다.", 404);
    }
  }
  function transact(revision, change) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = path.join(directory, "catalog.lock");
    let handle;
    try {
      handle = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST")
        throw fail("다른 저장이 진행 중입니다. 잠시 후 다시 시도하세요.", 409);
      throw error;
    }
    const temp = filename + "." + crypto.randomUUID() + ".tmp";
    try {
      fs.writeSync(handle, String(process.pid));
      const state = read();
      if (revision !== state.revision)
        throw fail(
          "다른 관리자가 변경했습니다. 목록을 새로고침한 후 다시 저장하세요.",
          409,
        );
      const result = change(state);
      state.revision++;
      const serialized = JSON.stringify(state, null, 2);
      if (serialized.length > 5 * 1024 * 1024)
        throw fail("등록 사양 파일의 최대 크기를 초과했습니다.");
      const backups = path.join(directory, "backups");
      fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
      if (fs.existsSync(filename))
        fs.copyFileSync(
          filename,
          path.join(backups, `${state.revision}-${crypto.randomUUID()}.json`),
        );
      fs.writeFileSync(temp, serialized, { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, filename);
      // Backups are independent of GitHub source deployments.
      const old = fs
        .readdirSync(backups)
        .filter((n) => /^\d+-[a-f0-9-]+\.json$/.test(n))
        .sort((a, b) => Number(b.split("-")[0]) - Number(a.split("-")[0]));
      for (const name of old.slice(30))
        try {
          fs.unlinkSync(path.join(backups, name));
        } catch {}
      return { record: result, revision: state.revision };
    } finally {
      fs.closeSync(handle);
      fs.rmSync(temp, { force: true });
      fs.rmSync(lock, { force: true });
    }
  }
  function save(body) {
    const draft = normalizeDraft(body.draft);
    const publish = body.action === "publish";
    if (!["draft", "publish"].includes(body.action))
      throw fail("저장 동작을 확인하세요.");
    let source = "관리자 직접 입력";
    if (draft.pdfId) {
      const doc = document(draft.pdfId);
      if (draft.sourcePage > doc.pages) throw fail("PDF 페이지를 확인하세요.");
      source = `${doc.originalName} ${draft.sourcePage}페이지`;
    }
    if (publish) {
      const errors = problems(draft);
      if (Object.keys(errors).length)
        throw Object.assign(fail("필수 사양을 확인한 후 적용하세요."), {
          fields: errors,
        });
      if (body.confirmed !== true)
        throw fail("원본과 입력 사양 확인에 체크하세요.");
    }
    return transact(body.revision, (state) => {
      let record = body.id && state.records.find((r) => r.id === body.id);
      if (body.id && !record) throw fail("등록 기록을 찾지 못했습니다.", 404);
      if (
        (record?.published &&
          ["manufacturer", "series"].some(
            (key) => draft[key] !== record.published[key],
          )) ||
        (record?.published &&
          draft.module.name !== record.published.module.name)
      )
        throw fail(
          "적용한 모듈의 제조사·시리즈·모델명은 변경할 수 없습니다. 새 모듈로 등록하세요.",
        );
      if (
        draft.module.name &&
        state.records.some(
          (r) =>
            r.id !== record?.id && r.draft.module.name === draft.module.name,
        )
      )
        throw fail(
          "같은 모델의 등록 기록이 있습니다. 목록에서 수정하세요.",
          409,
        );
      const exists = Object.values(base).some((series) =>
        Object.values(series).some((models) =>
          models.some((m) => m.name === draft.module.name),
        ),
      );
      if (
        publish &&
        exists &&
        !record?.published &&
        body.replaceExisting !== true
      )
        throw fail(
          "기본 목록에 같은 모델이 있습니다. 기존 사양 갱신 확인에 체크하세요.",
          409,
        );
      if (!record) {
        if (state.records.length >= 1000)
          throw fail("등록 가능 수량을 초과했습니다.");
        record = { id: crypto.randomUUID(), published: null, enabled: false };
        state.records.push(record);
      }
      record.draft = draft;
      record.updatedAt = new Date().toISOString();
      if (publish) {
        record.published = {
          ...draft,
          module: asCalculatorModule(draft, source),
        };
        record.enabled = true;
        record.publishedAt = record.updatedAt;
      }
      return record;
    });
  }
  function setEnabled(id, revision, enabled) {
    if (typeof enabled !== "boolean") throw fail("적용 상태를 확인하세요.");
    return transact(revision, (state) => {
      const record = state.records.find((r) => r.id === id);
      if (!record?.published)
        throw fail("먼저 사양을 확인하고 등록하세요.", 400);
      record.enabled = enabled;
      record.updatedAt = new Date().toISOString();
      return record;
    });
  }
  function catalog() {
    const result = structuredClone(base);
    for (const record of read().records) {
      if (!record.published) continue;
      const { manufacturer, series, module } = record.published;
      // Published identities are immutable; inactive records hide their base equivalent.
      for (const [mf, groups] of Object.entries(result))
        for (const [group, models] of Object.entries(groups))
          result[mf][group] = models.filter((m) => m.name !== module.name);
      if (record.enabled) {
        if (!Object.hasOwn(result, manufacturer)) result[manufacturer] = {};
        if (!Object.hasOwn(result[manufacturer], series))
          result[manufacturer][series] = [];
        result[manufacturer][series].push(module);
      }
    }
    for (const [mf, groups] of Object.entries(result)) {
      for (const [group, models] of Object.entries(groups))
        if (!models.length) delete groups[group];
      if (!Object.keys(groups).length) delete result[mf];
    }
    return result;
  }
  return { directory, read, document, save, setEnabled, catalog };
}
module.exports = { createStore, store: createStore(), uuid };
