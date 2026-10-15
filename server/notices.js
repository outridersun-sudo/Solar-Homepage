function serialize(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? String(value) : value
    ])
  );
}

function pageNumber(req) {
  const page = Number(req.query.page || 1);

  return Number.isSafeInteger(page) &&
    page >= 1 &&
    page <= 1000000
    ? page
    : null;
}

function validId(id) {
  return /^\d{1,20}$/.test(id);
}

function noticeData(body) {
  if (
    !body ||
    typeof body.title !== 'string' ||
    typeof body.content !== 'string' ||
    typeof body.is_published !== 'boolean'
  ) {
    return null;
  }

  const title = body.title.trim();
  const content = body.content.trim();

  if (
    !title ||
    title.length > 200 ||
    !content ||
    content.length > 10000
  ) {
    return null;
  }

  return [
    title,
    content,
    body.is_published ? 1 : 0
  ];
}

function registerPublic(app, pool) {
  app.get('/api/notices', async (req, res, next) => {
    try {
      const page = pageNumber(req);

      if (!page) {
        return res.status(400).json({
          message: '페이지 번호를 확인하세요.'
        });
      }

      const rows = await pool.query(
        `SELECT id, title, created_at, updated_at
         FROM notices
         WHERE is_published = 1
         ORDER BY id DESC
         LIMIT 21 OFFSET ?`,
        [(page - 1) * 20]
      );

      res.set('Cache-Control', 'no-store');

      res.json({
        rows: rows.slice(0, 20).map(serialize),
        hasNext: rows.length > 20
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/notices/:id', async (req, res, next) => {
    try {
      if (!validId(req.params.id)) {
        return res.status(400).json({
          message: '공지 번호를 확인하세요.'
        });
      }

      const rows = await pool.query(
        `SELECT id, title, content, created_at, updated_at
         FROM notices
         WHERE id = ? AND is_published = 1`,
        [req.params.id]
      );

      if (!rows.length) {
        return res.status(404).json({
          message: '공개된 공지를 찾을 수 없습니다.'
        });
      }

      res.set('Cache-Control', 'no-store');
      res.json(serialize(rows[0]));
    } catch (err) {
      next(err);
    }
  });

  app.use('/api/notices', (err, req, res, next) => {
    console.error('공지 조회 실패:', err.code || err.name);

    res.status(500).json({
      message: '공지 조회에 실패했습니다.'
    });
  });
}

function registerAdmin(app, pool) {
  app.get('/api/admin/notices', async (req, res, next) => {
    try {
      const page = pageNumber(req);

      if (!page) {
        return res.status(400).json({
          message: '페이지 번호를 확인하세요.'
        });
      }

      const rows = await pool.query(
        `SELECT
           id, title, is_published, created_at, updated_at
         FROM notices
         ORDER BY id DESC
         LIMIT 21 OFFSET ?`,
        [(page - 1) * 20]
      );

      res.json({
        rows: rows.slice(0, 20).map(serialize),
        hasNext: rows.length > 20
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/notices/:id', async (req, res, next) => {
    try {
      if (!validId(req.params.id)) {
        return res.status(400).json({
          message: '공지 번호를 확인하세요.'
        });
      }

      const rows = await pool.query(
        'SELECT * FROM notices WHERE id = ?',
        [req.params.id]
      );

      if (!rows.length) {
        return res.status(404).json({
          message: '공지를 찾을 수 없습니다.'
        });
      }

      res.json(serialize(rows[0]));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/notices', async (req, res, next) => {
    try {
      const data = noticeData(req.body);

      if (!data) {
        return res.status(400).json({
          message:
            '제목(1~200자), 본문(1~10000자), 공개 여부를 확인하세요.'
        });
      }

      const result = await pool.query(
        `INSERT INTO notices (
           title, content, is_published
         ) VALUES (?, ?, ?)`,
        data
      );

      res.status(201).json({
        id: String(result.insertId),
        message: '공지를 저장했습니다.'
      });
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/admin/notices/:id', async (req, res, next) => {
    try {
      const data = noticeData(req.body);

      if (!validId(req.params.id) || !data) {
        return res.status(400).json({
          message: '공지 번호, 제목, 본문, 공개 여부를 확인하세요.'
        });
      }

      const rows = await pool.query(
        'SELECT id FROM notices WHERE id = ?',
        [req.params.id]
      );

      if (!rows.length) {
        return res.status(404).json({
          message: '공지를 찾을 수 없습니다.'
        });
      }

      await pool.query(
        `UPDATE notices
         SET title = ?, content = ?, is_published = ?
         WHERE id = ?`,
        [...data, req.params.id]
      );

      res.json({
        message: '공지를 수정했습니다.'
      });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = {
  registerPublic,
  registerAdmin
};