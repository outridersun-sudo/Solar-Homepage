"use strict";
// Optional integration check: Tesseract with kor+eng language data is required.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const assert = require("node:assert/strict");
const { createCanvas } = require("@napi-rs/canvas");
const { extract } = require("../server/module-pdf");
function imagePdf(jpeg, width, height) {
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      Buffer.from("\nendstream"),
    ]),
  ];
  const content = Buffer.from("q 595 0 0 842 0 0 cm /Im0 Do Q");
  objects.push(
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from("\nendstream"),
    ]),
  );
  const chunks = [Buffer.from("%PDF-1.4\n")],
    offsets = [0];
  let length = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(chunk);
    length += chunk.length;
  });
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
        offsets
          .slice(1)
          .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
          .join("") +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`,
    ),
  );
  return Buffer.concat(chunks);
}
(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "solar-scan-test-"));
  try {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const root = path.dirname(require.resolve("pdfjs-dist/package.json"));
    const task = getDocument({
      data: new Uint8Array(
        await fs.readFile(
          path.join(
            __dirname,
            "../public/assets/docs/HD현대_NA시리즈_데이터시트.pdf",
          ),
        ),
      ),
      cMapUrl: root + "/cmaps/",
      cMapPacked: true,
      isEvalSupported: false,
      verbosity: 0,
    });
    const doc = await task.promise,
      page = await doc.getPage(2),
      viewport = page.getViewport({ scale: 3.3 });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    await page.render({ canvasContext: canvas.getContext("2d"), viewport })
      .promise;
    const file = path.join(dir, "scanned.pdf");
    await fs.writeFile(
      file,
      imagePdf(canvas.toBuffer("image/jpeg"), canvas.width, canvas.height),
    );
    await task.destroy();
    const result = await extract(file, "scanned.pdf");
    assert.ok(
      result.warnings.some((w) => w.includes("OCR로 읽었습니다")),
      JSON.stringify(result.warnings),
    );
    assert.ok(result.text.length > 1000, JSON.stringify(result));
    assert.ok(
      result.candidates.some((c) => c.module.p === 645),
      "645W column is recognized from the scanned image: " +
        JSON.stringify(result),
    );
    console.log(
      "PASS: image-only PDF -> Korean/English OCR -> editable 645W spec candidate with review warning",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
