"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  let csrf = "",
    revision = 0,
    fields = [],
    records = [],
    catalog = {},
    candidates = [],
    selected = 0,
    editing = null,
    pdfId = null,
    busy = false;
  const textKeys = ["name", "cells", "weight", "type", "warranty"];
  const element = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const message = (text) => {
    $("message").textContent = text;
  };
  function setBusy(value) {
    busy = value;
    for (const node of document.querySelectorAll("#management button"))
      node.disabled = value;
    for (const id of ["candidate", "pdfFile"]) $(id).disabled = value;
    validate();
  }
  async function api(url, options = {}) {
    const headers = { "X-CSRF-Token": csrf };
    if (options.body && !(options.body instanceof FormData))
      headers["Content-Type"] = "application/json";
    const response = await fetch("/api/admin" + url, {
      ...options,
      headers,
      cache: "no-store",
    });
    const data = await response
      .json()
      .catch(() => ({
        message: "서버 응답을 확인하지 못했습니다. 저장 전 목록을 확인하세요.",
      }));
    if (!response.ok) {
      if (response.status === 401) {
        csrf = "";
        $("management").hidden = true;
        $("login").hidden = false;
        $("pdfPreview").removeAttribute("src");
      }
      if (data.fields)
        for (const [key, error] of Object.entries(data.fields)) {
          if ($(key)) {
            $(key).setAttribute("aria-invalid", "true");
            $(key).title = error;
          }
        }
      throw new Error(data.message || "요청을 처리하지 못했습니다.");
    }
    return data;
  }
  async function run(fn) {
    if (busy) return;
    setBusy(true);
    message("");
    try {
      await fn();
    } catch (error) {
      message(error.message);
    } finally {
      setBusy(false);
    }
  }
  function readDraft() {
    const module = {};
    for (const key of textKeys) module[key] = $(key).value.trim();
    for (const [key] of fields)
      module[key] = $(key).value === "" ? null : Number($(key).value);
    module.iscCoefficientUnconfirmed = $("iscCoefficientUnconfirmed").checked;
    return {
      manufacturer: $("manufacturer").value.trim(),
      series: $("series").value.trim(),
      module,
      pdfId,
      sourcePage: Number($("sourcePage").value) || 1,
    };
  }
  function validate() {
    const errors = [];
    for (const key of ["manufacturer", "series", "name"]) {
      const empty = !$(key).value.trim();
      $(key).setAttribute("aria-invalid", String(empty));
      if (empty)
        errors.push(
          { manufacturer: "제조사", series: "시리즈", name: "모델명" }[key],
        );
    }
    for (const [key, label, min, max] of fields) {
      const value = $(key).value;
      const invalid =
        value === "" ||
        !Number.isFinite(Number(value)) ||
        Number(value) < min ||
        Number(value) > max;
      $(key).setAttribute("aria-invalid", String(invalid));
      if (invalid) errors.push(label);
    }
    const exists = Object.values(catalog).some((groups) =>
      Object.values(groups).some((models) =>
        models.some((m) => m.name === $("name").value.trim()),
      ),
    );
    $("replaceWrap").hidden = !exists || Boolean(editing?.published);
    $("validationSummary").hidden = !errors.length;
    $("validationSummary").textContent = errors.length
      ? "확인 필요: " + errors.join(", ") + ". 임시 저장 후 수정할 수 있습니다."
      : "";
    $("vmpNote").textContent =
      "Vmpp 온도계수: Voc 계수 " +
      ($("betaVoc").value || "미입력") +
      " %/℃ 임시 적용";
    $("publishBtn").disabled =
      busy ||
      !$("confirmed").checked ||
      errors.length > 0 ||
      (!$("replaceWrap").hidden && !$("replaceExisting").checked);
  }
  function preview(id, page = 1, name = "업로드된 PDF") {
    pdfId = id;
    $("previewViewport").hidden = !id;
    $("previewEmpty").hidden = Boolean(id);
    $("pdfLink").hidden = !id;
    $("zoomPreview").hidden = !id;
    if (id) {
      const url = "/api/admin/modules/documents/" + encodeURIComponent(id);
      $("pdfPreview").src = url + "/pages/" + page;
      $("pdfLink").href = url + "/pdf";
      $("pdfName").textContent = name;
    } else {
      $("pdfPreview").removeAttribute("src");
      $("pdfLink").removeAttribute("href");
      $("pdfName").textContent = "PDF를 올리면 원본이 표시됩니다.";
    }
  }
  function fill(draft, record = null) {
    editing = record;
    $("manufacturer").value = draft.manufacturer || "";
    $("series").value = draft.series || "";
    for (const key of [...textKeys, ...fields.map((f) => f[0])]) {
      $(key).value = draft.module?.[key] ?? "";
      const source = draft.sources?.[key];
      $(key).title = source ? `PDF ${source.page}페이지: ${source.text}` : "";
    }
    $("sourcePage").value = draft.sourcePage || 1;
    $("iscCoefficientUnconfirmed").checked = Boolean(
      draft.module?.iscCoefficientUnconfirmed,
    );
    for (const node of document.querySelectorAll("[data-identity]"))
      node.readOnly = Boolean(record?.published);
    $("confirmed").checked = false;
    $("replaceExisting").checked = false;
    $("editorStatus").textContent = record
      ? record.published
        ? record.enabled
          ? "적용 중 · 수정"
          : "사용 중지 · 수정"
        : "임시 저장"
      : "새 모듈";
    preview(
      draft.pdfId || pdfId,
      draft.sourcePage || 1,
      draft.originalName || "업로드된 PDF",
    );
    validate();
  }
  function fresh() {
    editing = null;
    pdfId = null;
    candidates = [{ manufacturer: "", series: "", module: {}, sourcePage: 1 }];
    selected = 0;
    renderCandidates();
    fill(candidates[0]);
    $("pdfFile").value = "";
    $("rawText").textContent = "추출된 내용이 없습니다.";
    $("uploadStatus").textContent =
      "PDF에서 추출한 사양을 원본과 비교하고 수정한 뒤 등록하세요.";
  }
  function renderCandidates() {
    $("candidate").replaceChildren(
      ...candidates.map((c, index) => {
        const op = element(
          "option",
          (c.module.name || "모델명 확인 필요") +
            (c.module.p ? " · " + c.module.p + "W" : ""),
        );
        op.value = String(index);
        return op;
      }),
    );
    $("candidate").value = String(selected);
  }
  function renderRecords() {
    $("moduleRows").replaceChildren();
    if (!records.length) {
      const row = element("tr"),
        cell = element(
          "td",
          "등록 기록이 없습니다. PDF를 올리거나 사양을 직접 입력하세요.",
        );
      cell.colSpan = 5;
      row.append(cell);
      $("moduleRows").append(row);
      return;
    }
    for (const record of records.slice().reverse()) {
      const row = element("tr"),
        d = record.draft;
      for (const value of [
        d.manufacturer + " / " + d.series,
        d.module.name || "모델명 미입력",
        d.module.p ? d.module.p + "W" : "—",
        record.published
          ? record.enabled
            ? "적용 중"
            : "사용 중지"
          : "임시 저장",
      ])
        row.append(element("td", value));
      const actions = element("td"),
        edit = element("button", "수정");
      edit.type = "button";
      edit.onclick = () => {
        if (busy) return;
        pdfId = null;
        candidates = [{ ...structuredClone(record.draft), record }];
        selected = 0;
        renderCandidates();
        fill(candidates[0], record);
        $("editor").scrollIntoView({ behavior: "smooth" });
      };
      actions.append(edit);
      if (record.published) {
        const toggle = element(
          "button",
          record.enabled ? "사용 중지" : "다시 적용",
        );
        toggle.type = "button";
        toggle.onclick = () =>
          run(async () => {
            const data = await api("/modules/" + record.id, {
              method: "PATCH",
              body: JSON.stringify({ revision, enabled: !record.enabled }),
            });
            revision = data.revision;
            await loadList();
            message(
              record.enabled
                ? "계산기에서 사용을 중지했습니다."
                : "계산기에 다시 적용했습니다.",
            );
          });
        actions.append(toggle);
      }
      row.append(actions);
      $("moduleRows").append(row);
    }
  }
  async function loadList() {
    const data = await api("/modules");
    revision = data.revision;
    fields = data.fields;
    records = data.records;
    catalog = data.catalog;
    renderRecords();
    if (editing) editing = records.find((r) => r.id === editing.id) || editing;
    validate();
  }
  async function save(action) {
    const data = await api("/modules", {
      method: "POST",
      body: JSON.stringify({
        id: editing?.id,
        revision,
        action,
        draft: readDraft(),
        confirmed: $("confirmed").checked,
        replaceExisting: $("replaceExisting").checked,
      }),
    });
    revision = data.revision;
    editing = data.record;
    candidates[selected] = {
      ...structuredClone(data.record.draft),
      record: data.record,
    };
    await loadList();
    fill(data.record.draft, data.record);
    message(
      action === "publish"
        ? "모듈을 등록하고 계산기에 적용했습니다. 계산기 화면을 새로고침하면 새 사양을 사용할 수 있습니다."
        : "임시 저장했습니다. 계산기에 적용된 사양은 변경되지 않았습니다.",
    );
  }
  $("loginForm").addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      const data = await api("/login", {
        method: "POST",
        body: JSON.stringify({
          username: $("username").value,
          password: $("password").value,
        }),
      });
      csrf = data.csrf;
      $("password").value = "";
      $("login").hidden = true;
      $("management").hidden = false;
      await loadList();
      fresh();
    });
  });
  $("uploadForm").addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      const file = $("pdfFile").files[0];
      if (
        !file ||
        file.size > 20 * 1024 * 1024 ||
        !file.name.toLowerCase().endsWith(".pdf")
      )
        throw new Error("PDF 1개, 최대 20MB까지 선택하세요.");
      const data = new FormData();
      data.append("file", file);
      $("uploadStatus").textContent =
        "PDF 사양을 읽고 있습니다. 스캔 문서는 시간이 더 걸릴 수 있습니다.";
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 170000);
      let result;
      try {
        result = await api("/modules/extract", {
          method: "POST",
          body: data,
          signal: controller.signal,
        });
      } catch (error) {
        $("uploadStatus").textContent =
          "PDF를 읽지 못했습니다. 파일을 확인하거나 사양을 직접 입력하세요.";
        throw error;
      } finally {
        clearTimeout(timer);
      }
      pdfId = result.document.id;
      editing = null;
      selected = 0;
      candidates = result.candidates.map((c) => ({
        ...c,
        pdfId,
        originalName: result.document.originalName,
      }));
      renderCandidates();
      fill(candidates[0]);
      $("rawText").textContent =
        result.text || "읽을 수 있는 텍스트가 없습니다.";
      $("uploadStatus").textContent =
        `${result.document.originalName} · ${result.pages}페이지 · ${candidates.length}개 모델 후보\n` +
        (result.warnings.length
          ? result.warnings.join("\n")
          : "추출된 값과 원본을 확인하세요. 빠진 값은 직접 입력할 수 있습니다.");
    });
  });
  $("candidate").addEventListener("change", () => {
    candidates[selected] = {
      ...candidates[selected],
      ...readDraft(),
      record: editing,
    };
    selected = Number($("candidate").value);
    fill(candidates[selected], candidates[selected].record || null);
  });
  $("editor").addEventListener("input", (event) => {
    if (!["confirmed", "replaceExisting"].includes(event.target.id))
      $("confirmed").checked = false;
    validate();
  });
  $("sourcePage").addEventListener("change", () => {
    if (pdfId)
      preview(pdfId, Number($("sourcePage").value), $("pdfName").textContent);
  });
  $("zoomPreview").onclick = () => {
    const zoomed = $("pdfPreview").classList.toggle("zoomed");
    $("zoomPreview").textContent = zoomed ? "축소" : "확대";
  };
  $("pdfPreview").onerror = () => {
    $("previewViewport").hidden = true;
    $("previewEmpty").hidden = false;
    $("previewEmpty").textContent =
      "미리보기를 읽지 못했습니다. 원본 PDF를 내려받아 확인하세요.";
  };
  $("editor").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!$("publishBtn").disabled) run(() => save("publish"));
  });
  $("draftBtn").onclick = () => run(() => save("draft"));
  $("refreshBtn").onclick = () => run(() => loadList());
  $("cancelBtn").onclick = () => fresh();
  $("manualBtn").onclick = () => fresh();
  (async () => {
    try {
      const data = await api("/session");
      csrf = data.csrf;
      $("management").hidden = false;
      $("login").hidden = true;
      await loadList();
      fresh();
      message("");
    } catch (error) {
      $("login").hidden = false;
      message(error.message);
    }
  })();
})();
