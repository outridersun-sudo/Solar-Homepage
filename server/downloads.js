const multer = require('multer');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');

const directory = path.join(
  __dirname, '..', 'uploads', 'technical'
);

const categories = ['카탈로그', '매뉴얼', '인증서', '기타'];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, done) => done(null, directory),
    filename: (req, file, done) =>
      done(null, crypto.randomUUID() + '.pdf')
  }),
  limits: {
    files: 1,
    fileSize: 20 * 1024 * 1024,
    fields: 5,
    parts: 6,
    fieldSize: 2000
  }
}).single('file');

const validId = id => /^\d{1,20}$/.test(id);

const pack = row => Object.fromEntries(
  Object.entries(row).map(([key, value]) => [
    key,
    typeof value === 'bigint' ? String(value) : value
  ])
);

function filename(value) {
  if ([...value].every(char => char.charCodeAt(0) <= 255)) {
    const decoded = Buffer.from(value, 'latin1').toString('utf8');
    if (!decoded.includes('\uFFFD')) value = decoded;
  }

  return value
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, 255) || 'document.pdf';
}

function metadata(body, multipart = false) {
  if (!body) return null;

  const keys = ['category', 'product_name', 'title', 'version'];
  const sizes = [30, 150, 200, 50];

  if (keys.some((key, i) =>
    typeof body[key] !== 'string' ||
    !body[key].trim() ||
    body[key].trim().length > sizes[i]
  )) {
    return null;
  }

  const published = multipart
    ? body.is_published === 'true'
      ? true
      : body.is_published === 'false' ? false : null
    : body.is_published;

  if (
    !categories.includes(body.category.trim()) ||
    typeof published !== 'boolean'
  ) {
    return null;
  }

  return [
    ...keys.map(key => body[key].trim()),
    published ? 1 : 0
  ];
}

async function cleanup(req) {
  if (req.file && !req.keepDocumentFile) {
    await fs.rm(req.file.path, { force: true });
  }
}

async function receive(req, res, next) {
  if (!req.is('multipart/form-data')) {
    return res.status(400).json({
      message: 'PDF와 자료 정보를 함께 전송하세요.'
    });
  }

  try {
    await fs.mkdir(directory, { recursive: true });

    upload(req, res, async error => {
      if (error) {
        try {
          await cleanup(req);
        } catch (err) {
          console.error('자료 정리 실패:', err.code);
        }

        return res.status(
          error.code === 'LIMIT_FILE_SIZE' ? 413 : 400
        ).json({
          message: 'PDF 1개, 최대 20MB까지 등록할 수 있습니다.'
        });
      }

      next();
    });
  } catch (error) {
    next(error);
  }
}

async function list(req, res, pool, admin) {
  const page = Number(req.query.page || 1);
  const q = req.query.q === undefined ? '' : req.query.q;
  const category =
    req.query.category === undefined ? '' : req.query.category;

  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1000000 ||
    typeof q !== 'string' ||
    q.length > 200 ||
    typeof category !== 'string' ||
    (category && !categories.includes(category))
  ) {
    return res.status(400).json({
      message: '페이지 또는 검색 조건을 확인하세요.'
    });
  }

  const where = [admin ? '1=1' : 'is_published = 1'];
  const args = [];

  if (q.trim()) {
    where.push(
      '(LOCATE(?, product_name) > 0 OR LOCATE(?, title) > 0)'
    );
    args.push(q.trim(), q.trim());
  }

  if (category) {
    where.push('category = ?');
    args.push(category);
  }

  args.push((page - 1) * 20);

  const rows = await pool.query(
    `SELECT
       id, category, product_name, title, version,
       original_name, file_size, is_published,
       created_at, updated_at
     FROM technical_documents
     WHERE ${where.join(' AND ')}
     ORDER BY id DESC
     LIMIT 21 OFFSET ?`,
    args
  );

  res.set('Cache-Control', 'no-store');

  res.json({
    rows: rows.slice(0, 20).map(pack),
    hasNext: rows.length > 20
  });
}

async function send(req, res, next, pool, admin) {
  try {
    if (
      !validId(req.params.id) ||
      !['view', 'download'].includes(req.params.action)
    ) {
      return res.status(400).json({
        message: '자료 요청을 확인하세요.'
      });
    }

    const rows = await pool.query(
      `SELECT original_name, stored_name
       FROM technical_documents
       WHERE id = ?
       ${admin ? '' : 'AND is_published = 1'}`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({
        message: '자료를 찾을 수 없거나 비공개 자료입니다.'
      });
    }

    const file = rows[0];

    if (!/^[a-f0-9-]{36}\.pdf$/.test(file.stored_name)) {
      throw new Error('Invalid stored name');
    }

    const encoded = encodeURIComponent(
      filename(file.original_name)
    ).replace(/['()*]/g, char =>
      '%' + char.charCodeAt(0).toString(16).toUpperCase()
    );

    const disposition =
      req.params.action === 'view' ? 'inline' : 'attachment';

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition':
        `${disposition}; filename="document.pdf"; ` +
        `filename*=UTF-8''${encoded}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'no-store'
    });

    res.sendFile(
      path.join(directory, file.stored_name),
      error => {
        if (!error) return;
        if (res.headersSent) return next(error);

        res.removeHeader('Content-Disposition');

        res.status(
          error.code === 'ENOENT' ? 404 : 500
        ).json({
          message: '자료 파일을 열 수 없습니다.'
        });
      }
    );
  } catch (error) {
    next(error);
  }
}

function registerPublic(app, pool) {
  app.get('/api/downloads', async (req, res, next) => {
    try {
      await list(req, res, pool, false);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/downloads/:id/:action', (req, res, next) =>
    send(req, res, next, pool, false)
  );

  app.use('/api/downloads', (err, req, res, next) => {
    console.error('기술자료 조회 오류:', err.code || err.name);

    res.status(500).json({
      message: '기술자료 조회에 실패했습니다.'
    });
  });
}

function registerAdmin(app, pool) {
  app.get('/api/admin/downloads', async (req, res, next) => {
    try {
      await list(req, res, pool, true);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/downloads/:id/:action', (req, res, next) =>
    send(req, res, next, pool, true)
  );

  app.post(
    '/api/admin/downloads',
    receive,
    async (req, res, next) => {
      try {
        const data = metadata(req.body, true);

        if (!data || !req.file) {
          return res.status(400).json({
            message: '필수 자료 정보와 PDF를 확인하세요.'
          });
        }

        const original = filename(req.file.originalname);
        const handle = await fs.open(req.file.path, 'r');
        let detected;

        try {
          const buffer = Buffer.alloc(4100);

          const { bytesRead } = await handle.read(
            buffer, 0, buffer.length, 0
          );

          const { fileTypeFromBuffer } = await import('file-type');

          try {
            detected = await fileTypeFromBuffer(
              buffer.subarray(0, bytesRead)
            );
          } catch {
            detected = null;
          }
        } finally {
          await handle.close();
        }

        if (
          !/\.pdf$/i.test(original) ||
          !detected ||
          detected.mime !== 'application/pdf'
        ) {
          return res.status(400).json({
            message: '정상 PDF 파일을 선택하세요.'
          });
        }

        // DB 저장 결과가 불명확한 경우에도 파일은 보존
        req.keepDocumentFile = true;

        const result = await pool.query(
          `INSERT INTO technical_documents (
             category, product_name, title, version,
             is_published, original_name, stored_name, file_size
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ...data,
            original,
            req.file.filename,
            req.file.size
          ]
        );

        res.status(201).json({
          id: String(result.insertId),
          message: '기술자료를 등록했습니다.'
        });
      } catch (error) {
        next(error);
      } finally {
        try {
          await cleanup(req);
        } catch (err) {
          console.error('자료 정리 실패:', err.code);
        }
      }
    }
  );

  app.patch('/api/admin/downloads/:id', async (req, res, next) => {
    try {
      const data = metadata(req.body);

      if (!validId(req.params.id) || !data) {
        return res.status(400).json({
          message: '자료 정보를 확인하세요.'
        });
      }

      const rows = await pool.query(
        'SELECT id FROM technical_documents WHERE id = ?',
        [req.params.id]
      );

      if (!rows.length) {
        return res.status(404).json({
          message: '자료를 찾을 수 없습니다.'
        });
      }

      await pool.query(
        `UPDATE technical_documents
         SET category = ?, product_name = ?, title = ?,
             version = ?, is_published = ?
         WHERE id = ?`,
        [...data, req.params.id]
      );

      res.json({
        message: '자료 정보를 수정했습니다.'
      });
    } catch (error) {
      next(error);
    }
  });
}

module.exports = {
  registerPublic,
  registerAdmin
};