"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("node:worker_threads");
const { fields } = require("./module-spec");
const exec = promisify(execFile);
const compact = (text) =>
  text.normalize("NFKC").replace(/[−–]/g, "-").replace(/\s+/g, "");
function numeric(text) {
  const value = compact(text)
    .replace(/,/g, "")
    .replace(/^DC/i, "")
    .match(/^([+-]?\d+(?:\.\d+)?)(?:%.*|[WVA](?:DC)?|kg)?$/i);
  return value ? Number(value[1]) : null;
}
const tag = (text) => {
  const s = compact(text);
  if (/온도|coefficient|tolerance|공차/i.test(s)) return null;
  if (/\(Pmax\)|\(Pmpp\)|maximum.?power|최대출력|정격출력/i.test(s)) return "p";
  if (/\(Voc\)|개방전압|open.?circuit.?voltage/i.test(s)) return "voc";
  if (/\(Vmpp?\)|동작전압|maximum.?power.?voltage/i.test(s)) return "vmp";
  if (/\(Isc\)|단락전류|short.?circuit.?current/i.test(s)) return "isc";
  if (/\(Impp?\)|동작전류|maximum.?power.?current/i.test(s)) return "imp";
  if (/모듈효율|moduleefficiency/i.test(s)) return "eff";
  return null;
};
function parsePages(pages, originalName) {
  const text = pages
    .map((page) => page.items.map((i) => i.text).join(" "))
    .join("\n");
  const all = compact(text);
  const manufacturer = /HD현대|hd-hyundaies/i.test(all)
    ? "HD현대에너지솔루션"
    : /TWSolar|TWMNF/i.test(all)
      ? "TW Solar"
      : "";
  const models = [
    ...new Set(text.match(/Hi[CS]-T\d{3,4}[A-Z]+(?:-ES)?/g) || []),
  ];
  const tables = [];
  for (const page of pages) {
    const powers = page.items.filter((i) => tag(i.text) === "p");
    for (const power of powers) {
      const right =
        powers
          .filter((i) => i.x > power.x + 100 && Math.abs(i.y - power.y) < 60)
          .sort((a, b) => a.x - b.x)[0]?.x ?? Infinity;
      const heading = page.items
        .filter(
          (i) =>
            i.y < power.y &&
            power.y - i.y < 120 &&
            Math.abs(i.x - power.x) < 70 &&
            i.text.length < 80 &&
            /BNPI|STC|NOCT|NMOT|전기.?사양/i.test(i.text),
        )
        .sort((a, b) => b.y - a.y)[0];
      if (heading && /NOCT|NMOT/i.test(heading.text)) continue;
      const tolerance = page.ocr ? 5 : 3;
      const numbers = page.items
        .filter(
          (i) =>
            Math.abs(i.y - power.y) < tolerance &&
            i.x > power.x + power.w - 2 &&
            i.x < right &&
            numeric(i.text) > 0,
        )
        .sort((a, b) => a.x - b.x);
      if (!numbers.length || numbers.length > 20) continue;
      const row = {
        page: page.number,
        kind: heading && /BNPI/i.test(heading.text) ? "bnpi" : "stc",
        values: numbers.map((i) => ({ p: numeric(i.text) })),
        evidence: { p: power.text },
        x: power.x,
      };
      for (const item of page.items) {
        const key = tag(item.text);
        if (
          !key ||
          key === "p" ||
          item.y <= power.y ||
          item.y - power.y > 130 ||
          Math.abs(item.x - power.x) > 60
        )
          continue;
        if (
          powers.some(
            (other) =>
              Math.abs(other.x - power.x) < 60 &&
              other.y > power.y &&
              other.y <= item.y,
          )
        )
          continue;
        const values = page.items
          .filter(
            (i) =>
              Math.abs(i.y - item.y) < tolerance &&
              i.x > item.x + item.w - 2 &&
              i.x < right &&
              numeric(i.text) !== null,
          )
          .sort((a, b) => a.x - b.x);
        if (values.length !== numbers.length) continue;
        row.evidence[key] =
          item.text + " " + values.map((i) => i.text).join(" / ");
        values.forEach(
          (v, index) => (row.values[index][key] = numeric(v.text)),
        );
      }
      // Avoid promotional power rows; require at least a voltage or current row.
      if (row.values.some((v) => v.voc || v.isc || v.vmp || v.imp))
        tables.push(row);
    }
  }
  const common = {},
    evidence = {};
  const assign = (key, value, page, text) => {
    if (value !== null && value !== undefined && common[key] === undefined) {
      common[key] = value;
      evidence[key] = { page, text };
    }
  };
  for (const page of pages)
    for (const item of page.items) {
      const s = compact(item.text);
      let key;
      if (/온도계수|temperaturecoefficient/i.test(s)) {
        if (/개방전압|Voc/i.test(s)) key = "betaVoc";
        else if (/단락전류|Isc/i.test(s)) key = "alphaIsc";
        else if (/최대출력|Pmax|Pmpp/i.test(s)) key = "gammaPower";
      } else if (/최대시스템전압|maximumsystemvoltage/i.test(s)) key = "maxV";
      else if (/최대직렬퓨즈|maximumseriesfuse/i.test(s)) key = "maxSeriesFuse";
      if (key) {
        const values = page.items
          .filter(
            (i) =>
              Math.abs(i.y - item.y) < 3 &&
              i.x > item.x + item.w - 2 &&
              numeric(i.text) !== null,
          )
          .sort((a, b) => a.x - b.x);
        if (values.length)
          assign(
            key,
            numeric(values[0].text),
            page.number,
            item.text + " " + values[0].text,
          );
        else {
          const number = s.match(/([+-]?\d+(?:\.\d+)?)%/);
          if (number) assign(key, Number(number[1]), page.number, item.text);
        }
      }
    }
  const rear = all.match(/후면(?:광량)?(\d+(?:\.\d+)?)W/);
  const front = all.match(/전면(?:광량)?(\d+(?:\.\d+)?)W/);
  if (rear && front)
    common.bnpiRearIrradiance = (Number(rear[1]) / Number(front[1])) * 100;
  const weight = text.match(/(\d+(?:\.\d+)?)\s*[kK][gG]/);
  const cells = text.match(/(\d{2,3})\s*[([（]\s*6\s*[x×*]\s*(\d{2})/i);
  common.weight = weight ? weight[1] + "kg" : "";
  common.cells = cells ? `${cells[1]}셀 (6×${cells[2]})` : "";
  common.type = /TOPCon/i.test(text) ? "N-Type TOPCon 양면 모듈" : "";
  common.warranty = "";
  common.iscCoefficientUnconfirmed = common.alphaIsc < 0;
  const candidates = [];
  for (const table of tables.filter((t) => t.kind === "stc")) {
    const bnpi = tables.filter(
      (t) =>
        t.kind === "bnpi" &&
        t.page === table.page &&
        t.values.length === table.values.length,
    );
    table.values.forEach((values, index) => {
      const power = values.p;
      const names = models.filter((name) => name.includes(String(power)));
      const name =
        names.length === 1
          ? names[0]
          : /TWMNF\s*66HD/.test(text)
            ? "TWMNF66HD" + power
            : "";
      const series = name.includes("NJ-ES")
        ? "NJ-ES 시리즈"
        : name.includes("NR-ES")
          ? "NR-ES 시리즈"
          : name.endsWith("OJ")
            ? "NA 시리즈"
            : name.startsWith("TWMNF66HD")
              ? "TWMNF66HD 시리즈"
              : "";
      const module = Object.fromEntries(fields.map(([key]) => [key, null]));
      Object.assign(module, common, values, { name });
      const sources = { ...evidence };
      for (const key of Object.keys(values))
        sources[key] = {
          page: table.page,
          text: table.evidence[key] || String(values[key]),
        };
      if (bnpi.length === 1)
        for (const [key, target] of Object.entries({
          p: "bnpi",
          voc: "bnpiVoc",
          vmp: "bnpiVmp",
          isc: "bnpiIsc",
          imp: "bnpiImp",
        })) {
          module[target] = bnpi[0].values[index][key] ?? null;
          sources[target] = {
            page: bnpi[0].page,
            text: bnpi[0].evidence[key] || "",
          };
        }
      candidates.push({
        manufacturer,
        series,
        module,
        sourcePage: table.page,
        sources,
      });
    });
  }
  if (!candidates.length)
    candidates.push({
      manufacturer,
      series: "",
      module: {
        ...Object.fromEntries(fields.map(([key]) => [key, null])),
        ...common,
        name: models[0] || "",
      },
      sourcePage: 1,
      sources: evidence,
    });
  return {
    candidates: candidates.slice(0, 40),
    text: text.slice(0, 80000),
    originalName,
  };
}

async function ocrPage(page, directory) {
  const { createCanvas } = require("@napi-rs/canvas");
  const size = page.getViewport({ scale: 1 });
  const scale = Math.min(
    3.3,
    2100 / size.width,
    Math.sqrt(6500000 / (size.width * size.height)),
  );
  const viewport = page.getViewport({ scale });
  if (viewport.width * viewport.height > 6500000)
    throw new Error("OCR page too large");
  const canvas = createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );
  await page.render({ canvasContext: canvas.getContext("2d"), viewport })
    .promise;
  const image = path.join(directory, "page.png");
  await fs.writeFile(image, canvas.toBuffer("image/png"));
  const { stdout } = await exec(
    process.env.TESSERACT_PATH || "tesseract",
    [
      image,
      "stdout",
      "-l",
      "kor+eng",
      "--psm",
      "3",
      "-c",
      "tessedit_create_tsv=1",
    ],
    { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  if (!stdout.startsWith("level\t")) throw new Error("OCR output is not TSV");
  return stdout
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t"))
    .filter((row) => row[0] === "5" && row[11]?.trim())
    .map((row) => ({
      x: Number(row[6]) / scale,
      y: (Number(row[7]) + Number(row[9])) / scale,
      w: Number(row[8]) / scale,
      text: row.slice(11).join("\t").trim(),
    }));
}
function mergeWords(items) {
  const ordered = items.sort((a, b) => a.y - b.y || a.x - b.x),
    rows = [];
  for (const item of ordered) {
    let row = rows.find((r) => Math.abs(r.y - item.y) < 3);
    if (!row) {
      row = { y: item.y, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }
  return rows.flatMap((row) => {
    const out = [];
    for (const item of row.items.sort((a, b) => a.x - b.x)) {
      const last = out.at(-1);
      if (
        last &&
        numeric(last.text) === null &&
        numeric(item.text) === null &&
        item.x - last.x - last.w < 12
      ) {
        last.text += " " + item.text;
        last.w = item.x + item.w - last.x;
      } else out.push({ ...item });
    }
    return out;
  });
}
async function extract(filename, originalName, previewDirectory) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const root = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const data = await fs.readFile(filename);
  if (!data.subarray(0, 1024).includes(Buffer.from("%PDF-")))
    throw new Error("PDF 파일을 확인하세요.");
  const task = getDocument({
    data: new Uint8Array(data),
    cMapUrl: path.join(root, "cmaps") + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(root, "standard_fonts") + path.sep,
    wasmUrl: path.join(root, "wasm") + path.sep,
    maxImageSize: 16000000,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "solar-pdf-"));
  const pages = [],
    warnings = [],
    previews = [];
  let ocrCount = 0;
  try {
    const doc = await task.promise;
    if (doc.numPages > 16)
      throw new Error("사양서 PDF는 16페이지 이하로 올려주세요.");
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number),
        content = await page.getTextContent();
      let items = content.items
        .filter((i) => i.str?.trim())
        .map((i) => ({
          x: i.transform[4],
          y: page.view[3] - i.transform[5],
          w: i.width,
          text: i.str.trim(),
        }));
      const needsOcr = items.length < 12;
      if (items.length < 12) {
        if (ocrCount++ < 4)
          try {
            items = mergeWords(await ocrPage(page, temp));
            warnings.push(
              items.length
                ? `${number}페이지는 OCR로 읽었습니다. 숫자·소수점·부호를 확인하세요.`
                : `${number}페이지에서 글자를 인식하지 못했습니다. 원본을 보고 직접 입력하세요.`,
            );
          } catch {
            warnings.push(
              `${number}페이지의 글자를 읽지 못했습니다. OCR 도구(Tesseract 한국어·영어)를 설치하거나 원본을 보고 직접 입력하세요.`,
            );
          }
        else
          warnings.push(
            `${number}페이지: OCR은 앞쪽 스캔 4페이지까지 지원합니다. 필요한 사양 페이지만 다시 올리거나 직접 입력하세요.`,
          );
      }
      if (previewDirectory) {
        try {
          const { createCanvas } = require("@napi-rs/canvas");
          const viewport = page.getViewport({
            scale: Math.min(2, 1400 / page.getViewport({ scale: 1 }).width),
          });
          if (viewport.width * viewport.height > 6500000)
            throw new Error("Preview too large");
          const canvas = createCanvas(
            Math.ceil(viewport.width),
            Math.ceil(viewport.height),
          );
          await page.render({
            canvasContext: canvas.getContext("2d"),
            viewport,
          }).promise;
          await fs.writeFile(
            path.join(
              previewDirectory,
              path.basename(filename, ".pdf") + "-page-" + number + ".png",
            ),
            canvas.toBuffer("image/png"),
            { mode: 0o600 },
          );
          previews.push(number);
        } catch {
          warnings.push(
            `${number}페이지 미리보기를 만들지 못했습니다. 원본 PDF를 내려받아 확인하세요.`,
          );
        }
      }
      pages.push({ number, items, ocr: needsOcr });
      page.cleanup();
    }
    return {
      ...parsePages(pages, originalName),
      pages: doc.numPages,
      warnings,
      previews,
    };
  } finally {
    await task.destroy();
    await fs.rm(temp, { recursive: true, force: true });
  }
}
function extractInWorker(filename, originalName, previewDirectory) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { filename, originalName, previewDirectory },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let received = false;
    const timer = setTimeout(() => {
      worker.terminate();
      reject(
        new Error(
          "PDF 분석 시간이 초과되었습니다. 사양 페이지만 올리거나 직접 입력하세요.",
        ),
      );
    }, 150000);
    worker.once("message", (message) => {
      received = true;
      clearTimeout(timer);
      worker.terminate();
      message.error
        ? reject(new Error(message.error))
        : resolve(message.result);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", () => {
      clearTimeout(timer);
      if (!received)
        reject(new Error("PDF 분석이 중단되었습니다. 파일을 확인하세요."));
    });
  });
}
if (!isMainThread && workerData?.filename)
  extract(
    workerData.filename,
    workerData.originalName,
    workerData.previewDirectory,
  )
    .then((result) => parentPort.postMessage({ result }))
    .catch((error) =>
      parentPort.postMessage({
        error: /password/i.test(error.message)
          ? "암호가 없는 PDF를 올려주세요."
          : error.message,
      }),
    );
module.exports = { parsePages, extract, extractInWorker };
