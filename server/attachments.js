const multer = require('multer');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');

const root = path.join(__dirname, '..', 'uploads');
const staging = path.join(root, 'tmp');
const storage = path.join(root, 'files');

const maxSize = 10 * 1024 * 1024;

const types = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf'
};

const parser = multer({
  storage: multer.diskStorage({
    destination: (req, file, done) => {
      done(null, req.uploadDirectory);
    },
    filename: (req, file, done) => {
      done(null, crypto.randomUUID());
    }
  }),
  limits: {
    fileSize: maxSize,
    files: 5,
    fields: 20,
    parts: 25,
    fieldSize: 40000
  }
}).array('attachments', 5);

function originalName(value) {
  // 한글 파일명 인코딩 복원
  if ([...value].every(char => char.charCodeAt(0) <= 255)) {
    const decoded = Buffer.from(value, 'latin1').toString('utf8');

    if (!decoded.includes('\uFFFD')) {
      value = decoded;
    }
  }

  return value
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, 255) || 'attachment';
}

async function cleanup(req) {
  // 저장됐거나 저장 여부가 불명확한 파일은 보존
  if (req.keepUploadFiles) return;

  for (const file of req.files || []) {
    await fs.rm(file.path, { force: true });
  }

  if (req.uploadDirectory) {
    await fs.rm(req.uploadDirectory, {
      recursive: true,
      force: true
    });
  }
}

async function receive(req, res, next) {
  if (!req.is('multipart/form-data')) {
    req.files = [];
    return next();
  }

  try {
    await fs.mkdir(staging, { recursive: true });
    await fs.mkdir(storage, { recursive: true });

    req.uploadDirectory = await fs.mkdtemp(
      path.join(staging, 'request-')
    );

    parser(req, res, async err => {
      if (err) {
        try {
          await cleanup(req);
        } catch (error) {
          console.error('첨부 정리 실패:', error.code);
        }

        const tooLarge = err.code === 'LIMIT_FILE_SIZE';

        return res.status(tooLarge ? 413 : 400).json({
          message: tooLarge
            ? '파일당 최대 10MB입니다.'
            : '첨부는 최대 5개이며, 파일 및 입력 항목을 확인해 주세요.'
        });
      }

      try {
        const { fileTypeFromBuffer } = await import('file-type');

        for (const file of req.files || []) {
          const handle = await fs.open(file.path, 'r');
          let signature;

          try {
            const buffer = Buffer.alloc(4100);
            const result = await handle.read(
              buffer, 0, buffer.length, 0
            );

            try {
              signature = await fileTypeFromBuffer(
                buffer.subarray(0, result.bytesRead)
              );
            } catch {
              const error = new Error(
                '파일 형식을 확인할 수 없습니다. 정상 JPG·PNG·WebP·PDF 파일을 선택하세요.'
              );
              error.status = 400;
              throw error;
            }
          } finally {
            await handle.close();
          }

          const name = originalName(file.originalname);
          const ext = path.extname(name).toLowerCase().slice(1);
          const expected = ext === 'jpeg' ? 'jpg' : ext;

          if (
            !file.size ||
            !signature ||
            !types[signature.ext] ||
            signature.ext !== expected ||
            signature.mime !== types[signature.ext]
          ) {
            const error = new Error(
              'JPG·PNG·WebP·PDF만 첨부할 수 있습니다. 파일 내용과 확장자를 확인하세요.'
            );
            error.status = 400;
            throw error;
          }

          file.originalName = name;
          file.mimeType = signature.mime;
          file.storedName =
            crypto.randomUUID() + '.' + signature.ext;
        }

        // 전체 파일 검증 후 보관 폴더로 이동
        for (const file of req.files || []) {
          const destination = path.join(
            storage, file.storedName
          );

          await fs.rename(file.path, destination);
          file.path = destination;
        }

        await fs.rm(req.uploadDirectory, {
          recursive: true,
          force: true
        });

        next();
      } catch (error) {
        try {
          await cleanup(req);
        } catch (cleanupError) {
          console.error('첨부 정리 실패:', cleanupError.code);
        }

        if (!error.status) {
          console.error(
            '첨부 처리 실패:',
            error.code || error.name
          );
        }

        res.status(error.status || 500).json({
          message: error.status
            ? error.message
            : '첨부파일 처리에 실패했습니다.'
        });
      }
    });
  } catch (error) {
    console.error('첨부 저장 폴더 오류:', error.code);

    res.status(500).json({
      message: '첨부 저장 폴더를 준비하지 못했습니다.'
    });
  }
}

function registerAdmin(app, pool) {
  // 관리자용 첨부 목록
  app.get(
    '/api/admin/requests/:id/attachments',
    async (req, res, next) => {
      try {
        if (!/^\d{1,20}$/.test(req.params.id)) {
          return res.status(400).json({
            message: '신청 ID를 확인하세요.'
          });
        }

        const rows = await pool.query(
          `SELECT
             id, original_name, mime_type,
             file_size, created_at
           FROM as_request_attachments
           WHERE request_id = ?
           ORDER BY id`,
          [req.params.id]
        );

        res.json({
          files: rows.map(row => ({
            ...row,
            id: String(row.id),
            file_size: Number(row.file_size)
          }))
        });
      } catch (error) {
        next(error);
      }
    }
  );

  // 관리자용 보기·다운로드
  app.get(
    '/api/admin/attachments/:id/:action',
    async (req, res, next) => {
      try {
        if (
          !/^\d{1,20}$/.test(req.params.id) ||
          !['view', 'download'].includes(req.params.action)
        ) {
          return res.status(400).json({
            message: '첨부 요청을 확인하세요.'
          });
        }

        const rows = await pool.query(
          `SELECT stored_name, original_name, mime_type
           FROM as_request_attachments
           WHERE id = ?`,
          [req.params.id]
        );

        if (!rows.length) {
          return res.status(404).json({
            message: '첨부파일을 찾을 수 없습니다.'
          });
        }

        const file = rows[0];

        if (
          !/^[a-f0-9-]{36}\.(jpg|png|webp|pdf)$/
            .test(file.stored_name) ||
          !Object.values(types).includes(file.mime_type)
        ) {
          return res.status(500).json({
            message: '첨부 저장 정보를 확인하세요.'
          });
        }

        const filename = originalName(file.original_name);

        const disposition =
          req.params.action === 'view'
            ? 'inline'
            : 'attachment';

        const encoded = encodeURIComponent(filename)
          .replace(/['()*]/g, char =>
            '%' + char.charCodeAt(0)
              .toString(16).toUpperCase()
          );

        res.set({
          'Content-Type': file.mime_type,
          'Content-Disposition':
            `${disposition}; filename="attachment"; ` +
            `filename*=UTF-8''${encoded}`,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy':
            "sandbox; default-src 'none'",
          'Cache-Control': 'no-store'
        });

        res.sendFile(
          path.join(storage, file.stored_name),
          error => {
            if (!error) return;
            if (res.headersSent) return next(error);

            res.removeHeader('Content-Disposition');

            res.status(
              error.code === 'ENOENT' ? 404 : 500
            ).json({
              message:
                '파일을 열 수 없습니다. 업로드 폴더를 확인하세요.'
            });
          }
        );
      } catch (error) {
        next(error);
      }
    }
  );
}

module.exports = {
  receive,
  cleanup,
  registerAdmin
};