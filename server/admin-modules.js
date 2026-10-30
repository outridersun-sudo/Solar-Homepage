"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const multer = require("multer");
const { store: defaultStore, uuid } = require("./module-store");
const { fields, fail } = require("./module-spec");
const { extractInWorker } = require("./module-pdf");

module.exports = function registerModules(
  app,
  { store = defaultStore, extract = extractInWorker } = {},
) {
  const documents = path.join(store.directory, "documents");
  let extracting = false;
  const receive = multer({
    storage: multer.diskStorage({
      destination: documents,
      filename: (req, file, done) => done(null, crypto.randomUUID() + ".pdf"),
    }),
    limits: { files: 1, fileSize: 20 * 1024 * 1024, fields: 0, parts: 1 },
  }).single("file");
  const route = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error.status)
        res
          .status(error.status)
          .json({ message: error.message, fields: error.fields });
      else next(error);
    }
  };
  app.get(
    "/api/admin/modules",
    route(async (req, res) => {
      res.json({ ...store.read(), fields, catalog: store.catalog() });
    }),
  );
  app.post(
    "/api/admin/modules/extract",
    route(async (req, res) => {
      if (extracting)
        throw fail("다른 PDF를 분석 중입니다. 잠시 후 다시 시도하세요.", 429);
      if (!req.is("multipart/form-data")) throw fail("PDF 파일을 선택하세요.");
      extracting = true;
      try {
        await fs.mkdir(documents, { recursive: true, mode: 0o700 });
        await new Promise((resolve, reject) =>
          receive(req, res, (error) =>
            error
              ? reject(
                  fail(
                    "PDF 1개, 최대 20MB까지 올릴 수 있습니다.",
                    error.code === "LIMIT_FILE_SIZE" ? 413 : 400,
                  ),
                )
              : resolve(),
          ),
        );
        if (!req.file) throw fail("PDF 파일을 선택하세요.");
        const handle = await fs.open(req.file.path, "r");
        let header;
        try {
          header = Buffer.alloc(1024);
          await handle.read(header, 0, 1024, 0);
        } finally {
          await handle.close();
        }
        if (!header.includes(Buffer.from("%PDF-")))
          throw fail("올바른 PDF 파일을 선택하세요.");
        let originalName = req.file.originalname;
        if ([...originalName].every((c) => c.charCodeAt(0) <= 255)) {
          const decoded = Buffer.from(originalName, "latin1").toString("utf8");
          if (!decoded.includes("\uFFFD")) originalName = decoded;
        }
        originalName =
          originalName
            .replaceAll("\\", "/")
            .split("/")
            .pop()
            .replace(/[\u0000-\u001f\u007f]/g, "")
            .slice(0, 180) || "module.pdf";
        let result;
        try {
          result = await extract(req.file.path, originalName, documents);
        } catch (error) {
          throw fail(error.message);
        }
        const id = path.basename(req.file.filename, ".pdf");
        const metadata = {
          id,
          originalName,
          pages: result.pages,
          previews: result.previews || [],
          size: req.file.size,
          createdAt: new Date().toISOString(),
        };
        await fs.chmod(req.file.path, 0o600);
        await fs.writeFile(
          path.join(documents, id + ".json"),
          JSON.stringify(metadata),
          { mode: 0o600, flag: "wx" },
        );
        req.keepModulePdf = true;
        res.json({ ...result, document: metadata });
      } finally {
        extracting = false;
        if (req.file && !req.keepModulePdf) {
          await fs.rm(req.file.path, { force: true });
          const prefix = path.basename(req.file.filename, ".pdf");
          for (const name of await fs.readdir(documents))
            if (name.startsWith(prefix + "-page-") || name === prefix + ".json")
              await fs.rm(path.join(documents, name), { force: true });
        }
      }
    }),
  );
  app.get(
    "/api/admin/modules/documents/:id/pdf",
    route(async (req, res) => {
      if (!uuid(req.params.id)) throw fail("PDF를 찾지 못했습니다.", 404);
      store.document(req.params.id);
      // PDF is private and cannot execute same-origin scripts.
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="module.pdf"',
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "sandbox; default-src 'none'; frame-ancestors 'self'",
      });
      await new Promise((resolve, reject) =>
        res.sendFile(path.join(documents, req.params.id + ".pdf"), (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    }),
  );
  app.get(
    "/api/admin/modules/documents/:id/pages/:page",
    route(async (req, res) => {
      if (!uuid(req.params.id) || !/^\d{1,2}$/.test(req.params.page))
        throw fail("미리보기를 찾지 못했습니다.", 404);
      const doc = store.document(req.params.id),
        page = Number(req.params.page);
      if (!doc.previews?.includes(page))
        throw fail("원본 PDF를 내려받아 확인하세요.", 404);
      res.set({
        "Content-Type": "image/png",
        "X-Content-Type-Options": "nosniff",
      });
      await new Promise((resolve, reject) =>
        res.sendFile(
          path.join(documents, req.params.id + "-page-" + page + ".png"),
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    }),
  );
  app.post(
    "/api/admin/modules",
    route(async (req, res) => res.json(store.save(req.body || {}))),
  );
  app.patch(
    "/api/admin/modules/:id",
    route(async (req, res) =>
      res.json(
        store.setEnabled(req.params.id, req.body?.revision, req.body?.enabled),
      ),
    ),
  );
};
