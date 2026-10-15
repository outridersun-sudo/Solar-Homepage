const crypto = require('node:crypto');

module.exports = function registerAdmin(app, pool) {
  const sessions = new Map();
  const sessionDuration = 2 * 60 * 60 * 1000;

  let loginAttempts = 0;
  let loginWindowEnds = 0;

  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) {
      if (session.expires <= Date.now()) {
        sessions.delete(id);
      }
    }
  }, 60000);

  cleanup.unref();

  function getSession(req) {
    const cookie = (req.headers.cookie || '')
      .split(';')
      .map(value => value.trim())
      .find(value => value.startsWith('admin_session='));

    if (!cookie) return null;

    const id = cookie.slice('admin_session='.length);
    const session = sessions.get(id);

    return session && session.expires > Date.now()
      ? session
      : null;
  }

  function makeCookie(req, value, maxAge) {
    const secure =
      req.secure ||
      req.headers['x-forwarded-proto'] === 'https';

    return (
      `admin_session=${value}; ` +
      'Path=/api/admin; HttpOnly; SameSite=Strict; ' +
      `Max-Age=${maxAge}` +
      (secure ? '; Secure' : '')
    );
  }

  function serialize(row) {
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === 'bigint' ? String(value) : value
      ])
    );
  }

  app.use('/api/admin', (req, res, next) => {
    res.set('Cache-Control', 'no-store');

    if (!['GET', 'HEAD'].includes(req.method)) {
      let origin;

      try {
        origin = new URL(req.headers.origin);
      } catch {
        return res.status(403).json({
          message: '허용되지 않은 요청입니다.'
        });
      }

      if (
        origin.host !== req.headers.host ||
        !['http:', 'https:'].includes(origin.protocol)
      ) {
        return res.status(403).json({
          message: '허용되지 않은 요청입니다.'
        });
      }
    }

    next();
  });

  app.post('/api/admin/login', async (req, res, next) => {
    const savedUsername = process.env.ADMIN_USERNAME;
    const savedPassword = process.env.ADMIN_PASSWORD_HASH;

    if (!savedUsername || !savedPassword) {
      return res.status(503).json({
        message: '.env의 관리자 계정 설정을 확인하세요.'
      });
    }

    if (Date.now() >= loginWindowEnds) {
      loginAttempts = 0;
      loginWindowEnds = Date.now() + 10 * 60 * 1000;
    }

    if (loginAttempts >= 10) {
      return res.status(429).json({
        message: '로그인 시도가 많습니다. 10분 후 다시 시도하세요.'
      });
    }

    loginAttempts++;

    const { username, password } = req.body || {};

    if (
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      password.length > 256
    ) {
      return res.status(401).json({
        message: '아이디 또는 비밀번호를 확인하세요.'
      });
    }

    const [salt, savedHash] = savedPassword.split(':');

    if (
      !/^[a-f0-9]{32}$/.test(salt || '') ||
      !/^[a-f0-9]{128}$/.test(savedHash || '')
    ) {
      return res.status(503).json({
        message: '관리자 비밀번호 해시 설정을 확인하세요.'
      });
    }

    try {
      const hash = await new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (err, value) => {
          if (err) reject(err);
          else resolve(value);
        });
      });

      const matches = crypto.timingSafeEqual(
        hash,
        Buffer.from(savedHash, 'hex')
      );

      if (!matches || username !== savedUsername) {
        return res.status(401).json({
          message: '아이디 또는 비밀번호를 확인하세요.'
        });
      }

      const previous = getSession(req);

      if (previous) {
        sessions.delete(previous.id);
      }

      const id = crypto.randomBytes(32).toString('hex');
      const csrf = crypto.randomBytes(32).toString('hex');

      sessions.set(id, {
        id,
        csrf,
        username,
        expires: Date.now() + sessionDuration
      });

      res.setHeader(
        'Set-Cookie',
        makeCookie(req, id, sessionDuration / 1000)
      );

      res.json({ csrf });
    } catch (err) {
      next(err);
    }
  });

  // 아래 관리자 기능은 모두 로그인 필요
  app.use('/api/admin', (req, res, next) => {
    const session = getSession(req);

    if (!session) {
      return res.status(401).json({
        message: '로그인이 필요합니다.'
      });
    }

    if (
      !['GET', 'HEAD'].includes(req.method) &&
      req.headers['x-csrf-token'] !== session.csrf
    ) {
      return res.status(403).json({
        message: '요청 인증에 실패했습니다. 다시 로그인하세요.'
      });
    }

    req.adminSession = session;
    next();
  });

  app.get('/api/admin/session', (req, res) => {
    res.json({ csrf: req.adminSession.csrf });
  });

  app.post('/api/admin/logout', (req, res) => {
    sessions.delete(req.adminSession.id);

    res.setHeader('Set-Cookie', makeCookie(req, '', 0));
    res.json({ ok: true });
  });

  app.get('/api/admin/requests', async (req, res, next) => {
    try {
      const page = Number(req.query.page || 1);

      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000000
      ) {
        return res.status(400).json({
          message: '페이지 번호를 확인하세요.'
        });
      }

      const rows = await pool.query(
        `SELECT
           id, request_number, customer_name,
           model_name, status, created_at
         FROM as_requests
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

  // 상세 조회·검토·승인 기능 연결
  require('./notices').registerAdmin(app, pool);
  require('./downloads').registerAdmin(app, pool);
  require('./attachments').registerAdmin(app, pool);
  require('./review')(app, pool);

  app.use('/api/admin', (err, req, res, next) => {
    console.error('관리자 API 오류:', err.code || err.name);

    res.status(500).json({
      message: '처리에 실패했습니다. 서버 터미널을 확인하세요.'
    });
  });
};