const crypto = require('node:crypto');
const net = require('node:net');
const fs = require('node:fs');

module.exports = function installSecurity(app, pool) {
  const key = process.env.SECURITY_HMAC_KEY;

  if (!/^[a-f0-9]{64}$/i.test(key || '')) {
    throw new Error(
      'SECURITY_HMAC_KEY 설정이 필요합니다. node setup-security.js를 실행하세요.'
    );
  }

  const origins = new Set([
    'http://127.0.0.1:3000',
    'http://localhost:3000'
  ]);

  let publicOrigin;

  if (process.env.PUBLIC_ORIGIN) {
    const url = new URL(process.env.PUBLIC_ORIGIN);

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        'PUBLIC_ORIGIN은 경로 없는 HTTPS 주소여야 합니다.'
      );
    }

    publicOrigin = url.origin;
    origins.add(publicOrigin);
  }

  const trustTunnel =
    process.env.TRUST_CLOUDFLARE_TUNNEL === 'true';

  if (trustTunnel && !publicOrigin) {
    throw new Error(
      '터널 사용 시 PUBLIC_ORIGIN을 설정하세요.'
    );
  }

  const hash = value => crypto
    .createHmac('sha256', Buffer.from(key, 'hex'))
    .update(value)
    .digest('hex');

  const uuid = value =>
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
      .test(value);

  function clientIp(req) {
    const peer = req.socket.remoteAddress || 'unknown';

    const loopback = [
      '127.0.0.1',
      '::1',
      '::ffff:127.0.0.1'
    ].includes(peer);

    const cfIp = req.headers['cf-connecting-ip'];
    const host = publicOrigin && new URL(publicOrigin).host;

    // 같은 PC의 터널과 지정 호스트만 신뢰
    if (
      trustTunnel &&
      loopback &&
      req.headers.host === host &&
      typeof cfIp === 'string' &&
      net.isIP(cfIp)
    ) {
      return cfIp;
    }

    // 임의의 X-Forwarded-For는 사용하지 않음
    return peer;
  }

  function problem(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  const blocked = new Map();

  const sweep = setInterval(() => {
    for (const [identity, until] of blocked) {
      if (until <= Date.now()) blocked.delete(identity);
    }
  }, 60000);

  sweep.unref();

  async function take(scope, value, seconds, max) {
    const identity = hash(scope + ':' + value);
    const cached = blocked.get(identity);

    if (cached && cached > Date.now()) {
      const error = problem(
        '요청이 많습니다. 잠시 후 다시 시도해 주세요.',
        429
      );

      error.retryAfter = Math.max(
        1,
        Math.ceil((cached - Date.now()) / 1000)
      );

      throw error;
    }

    const window =
      Math.floor(Date.now() / 1000 / seconds) * seconds;

    let conn;

    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();

      const args = [scope, identity, window];

      await conn.query(
        `INSERT INTO security_rate_limits (
           scope, key_hash, window_start, hits
         ) VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE hits = hits + 1`,
        args
      );

      const rows = await conn.query(
        `SELECT hits
         FROM security_rate_limits
         WHERE scope = ?
           AND key_hash = ?
           AND window_start = ?
         FOR UPDATE`,
        args
      );

      await conn.commit();

      if (Number(rows[0].hits) > max) {
        if (blocked.size < 5000) {
          blocked.set(identity, (window + seconds) * 1000);
        }

        const error = problem(
          '요청이 많습니다. 잠시 후 다시 시도해 주세요.',
          429
        );

        error.retryAfter = Math.max(
          1,
          window + seconds - Math.floor(Date.now() / 1000)
        );

        throw error;
      }
    } catch (error) {
      if (conn && error.status !== 429) {
        try {
          await conn.rollback();
        } catch (rollbackError) {
          console.error(
            '보안 카운터 롤백 실패:',
            rollbackError.code
          );
        }
      }

      throw error;
    } finally {
      if (conn) conn.release();
    }
  }

  function deny(res, error) {
    if (error.retryAfter) {
      res.set('Retry-After', String(error.retryAfter));
    }

    if (!error.status) {
      console.error(
        '보안 확인 실패:',
        error.code || error.name
      );
    }

    return res.status(error.status || 503).json({
      message: error.status
        ? error.message
        : '보안 확인에 실패했습니다. 잠시 후 다시 시도하세요.'
    });
  }

  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy':
        'camera=(self), microphone=(), geolocation=()'
    });

    const privatePath =
      /\/(?:\.env(?:\.[^/]*)?|\.git|\.aws|\.codex|uploads|server)(?:\/|$)/i;

    if (
      privatePath.test(req.path) ||
      /\.(?:sql|bak|log)$/i.test(req.path)
    ) {
      return res.sendStatus(404);
    }

    if (
      req.path.startsWith('/api/') ||
      req.path.includes('admin') ||
      req.path === '/as-request.html' ||
      req.path === '/js/as-request.js'
    ) {
      res.set('Cache-Control', 'no-store');
    }

    if (
      req.path.startsWith('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    ) {
      if (!origins.has(req.headers.origin)) {
        return res.status(403).json({
          message: '허용되지 않은 사이트의 요청입니다.'
        });
      }
    }

    next();
  });

  const inFlight = new Map();
  let activeUploads = 0;

  const security = {
    clientIp,

    async loginLimit(req, res, next) {
      try {
        await take('login-ip', clientIp(req), 900, 10);
        await take('login-total', 'all', 60, 60);
        next();
      } catch (error) {
        deny(res, error);
      }
    },

    async submissionLimit(req, res, next) {
      try {
        if (!uuid(req.get('X-Submission-Id'))) {
          throw problem(
            '신청 화면을 새로고침한 뒤 제출하세요.'
          );
        }

        const ip = clientIp(req);
        const ipKey = hash(ip);

        if (
          (inFlight.get(ipKey) || 0) >= 2 ||
          activeUploads >= 4
        ) {
          const error = problem(
            '동시에 처리 중인 요청이 많습니다. 잠시 후 다시 시도하세요.',
            429
          );
          error.retryAfter = 10;
          throw error;
        }

        await take('submit-minute', ip, 60, 10);
        await take('submit-hour', ip, 3600, 50);
        await take('submit-day', 'all', 86400, 1000);

        // DB 검사 중 다른 요청이 들어왔을 수 있어 재확인
        if (
          (inFlight.get(ipKey) || 0) >= 2 ||
          activeUploads >= 4
        ) {
          const error = problem(
            '현재 요청 처리 중입니다. 잠시 후 다시 시도하세요.',
            429
          );
          error.retryAfter = 10;
          throw error;
        }

        activeUploads++;

        inFlight.set(
          ipKey,
          (inFlight.get(ipKey) || 0) + 1
        );

        let released = false;

        const release = () => {
          if (released) return;

          released = true;
          activeUploads--;

          const count = (inFlight.get(ipKey) || 1) - 1;

          if (count) inFlight.set(ipKey, count);
          else inFlight.delete(ipKey);
        };

        res.once('finish', release);
        res.once('close', release);

        next();
      } catch (error) {
        deny(res, error);
      }
    },

    async phoneLimit(phone) {
      const number = phone.replace(/\D/g, '');

      if (number.length < 7 || number.length > 15) {
        throw problem('연락처를 확인하세요.');
      }

      await take('submit-phone', number, 600, 3);
    },

    async beginSubmission(conn, req, data) {
      const files = [];

      for (const file of req.files || []) {
        const digest = crypto.createHash('sha256');

        for await (
          const chunk of fs.createReadStream(file.path)
        ) {
          digest.update(chunk);
        }

        files.push(digest.digest('hex'));
      }

      const normalized = {
        ...data,
        phone: data.phone.replace(/\D/g, '')
      };

      const fingerprint = hash(
        JSON.stringify([normalized, files.sort()])
      );

      const submissionKey = req.get('X-Submission-Id');

      await conn.query(
        `INSERT INTO as_submission_keys (
           submission_key, payload_hash
         ) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE
           submission_key = submission_key`,
        [submissionKey, fingerprint]
      );

      const keys = await conn.query(
        `SELECT payload_hash, request_id
         FROM as_submission_keys
         WHERE submission_key = ?
         FOR UPDATE`,
        [submissionKey]
      );

      if (keys[0].payload_hash !== fingerprint) {
        throw problem(
          '이전 제출과 내용이 다릅니다. 기존 신청 저장 여부를 관리자에게 확인하세요.',
          409
        );
      }

      if (keys[0].request_id) {
        return {
          existingId: String(keys[0].request_id)
        };
      }

      await conn.query(
        `INSERT INTO as_submission_fingerprints (
           fingerprint
         ) VALUES (?)
         ON DUPLICATE KEY UPDATE
           fingerprint = fingerprint`,
        [fingerprint]
      );

      const rows = await conn.query(
        `SELECT request_id, accepted_at
         FROM as_submission_fingerprints
         WHERE fingerprint = ?
         FOR UPDATE`,
        [fingerprint]
      );

      if (
        rows[0].request_id &&
        Date.now() - Number(rows[0].accepted_at) < 600000
      ) {
        const id = String(rows[0].request_id);

        await conn.query(
          `UPDATE as_submission_keys
           SET request_id = ?
           WHERE submission_key = ?`,
          [id, submissionKey]
        );

        return { existingId: id };
      }

      return {
        submissionKey,
        fingerprint
      };
    },

    async finishSubmission(conn, context, id) {
      await conn.query(
        `UPDATE as_submission_keys
         SET request_id = ?
         WHERE submission_key = ?`,
        [id, context.submissionKey]
      );

      await conn.query(
        `UPDATE as_submission_fingerprints
         SET request_id = ?, accepted_at = ?
         WHERE fingerprint = ?`,
        [id, Date.now(), context.fingerprint]
      );
    },

    deny
  };

  app.locals.security = security;

  return security;
};