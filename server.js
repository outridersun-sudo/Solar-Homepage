require('dotenv').config();

const express = require('express');
const mariadb = require('mariadb');
const path = require('path');
const attachments = require('./server/attachments');
const serialRules = require('./server/serial-rules');

const app = express();
// 브라우저의 기본 아이콘 요청에 빈 정상 응답
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

const pool = mariadb.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 5
});

const security = require('./server/security')(app, pool);

app.use(express.json({ limit: '100kb' }));
require('./server/quote-mail')(app, security);

require('./server/notices').registerPublic(app, pool);
require('./server/downloads').registerPublic(app, pool);
require('./server/admin')(app, pool);

require('./server/calculator')(app);

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filename) {
    // Keep calculator markup and its interactive controls on the same release.
    if (filename === path.join(__dirname, 'public', 'calculator.html') ||
        filename === path.join(__dirname, 'public', 'js', 'calculator.js')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

app.post(
  '/api/as-requests',
  security.submissionLimit,
  attachments.receive,
  async (req, res) => {
    async function reject(message) {
      try {
        await attachments.cleanup(req);
      } catch (error) {
        console.error('첨부 정리 실패:', error.code);
      }

      return res.status(400).json({ message });
    }

    const body = req.body;

    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body)
    ) {
      return reject('잘못된 신청 데이터입니다.');
    }

    const limits = {
      customer_name: 150,
      contact_name: 100,
      phone: 30,
      email: 254,
      plant_name: 150,
      installation_region: 150,
      product_type: 50,
      model_name: 100,
      serial_number: 100,
      fault_code: 100,
      symptoms: 10000
    };

    const data = {};

    for (const [field, max] of Object.entries(limits)) {
      const value = body[field];

      if (value != null && typeof value !== 'string') {
        return reject('입력 형식이 올바르지 않습니다.');
      }

      data[field] = (value || '').trim();

      if (data[field].length > max) {
        return reject('입력 내용이 너무 깁니다.');
      }
    }

    const required = [
      'customer_name',
      'contact_name',
      'phone',
      'plant_name',
      'product_type',
      'model_name',
      'serial_number',
      'symptoms'
    ];

    if (required.some(field => !data[field])) {
      return reject('필수 항목을 입력해 주세요.');
    }

    if (
      !['태양광 인버터', '통신 RTU', '기타']
        .includes(data.product_type)
    ) {
      return reject('제품 구분을 확인해 주세요.');
    }

    // Solis inverter S/N format check. RTU/other product formats are unchanged.
    if (data.product_type === '태양광 인버터') {
      const serialReview = serialRules.validate(data.serial_number);
      if (!serialReview.valid) {
        return reject('시리얼 번호를 확인해 주세요.\n' + serialReview.message);
      }
      data.serial_number = serialReview.serial;
    }

    if (
      data.email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)
    ) {
      return reject('이메일을 확인해 주세요.');
    }

    if (
      body.privacy_agreed !== true &&
      body.privacy_agreed !== 'true'
    ) {
      return reject('개인정보 수집·이용에 동의해 주세요.');
    }

    let conn;

    try {
      await security.phoneLimit(data.phone);

      conn = await pool.getConnection();
      await conn.beginTransaction();

      const submission = await security.beginSubmission(
        conn,
        req,
        data
      );

      if (submission.existingId) {
        await conn.commit();

        return res.status(200).json({
          application_id: submission.existingId,
          duplicate: true,
          message: '이미 저장된 동일 요청입니다.'
        });
      }

      const result = await conn.query(
        `INSERT INTO as_requests (
          customer_name, contact_name, phone, email,
          plant_name, installation_region, product_type,
          model_name, serial_number, fault_code, symptoms,
          privacy_agreed_at, status
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          CURRENT_TIMESTAMP, 'pending'
        )`,
        [
          data.customer_name,
          data.contact_name,
          data.phone,
          data.email || null,
          data.plant_name,
          data.installation_region || null,
          data.product_type,
          data.model_name,
          data.serial_number,
          data.fault_code || null,
          data.symptoms
        ]
      );

      const id = String(result.insertId);

      await conn.query(
        `INSERT INTO as_request_history (
          request_id, from_status, to_status, reason, actor
        ) VALUES (
          ?, NULL, 'pending',
          '고객 접수 요청 제출', 'applicant'
        )`,
        [id]
      );

      for (const file of req.files || []) {
        await conn.query(
          `INSERT INTO as_request_attachments (
            request_id, original_name, stored_name,
            mime_type, file_size
          ) VALUES (?, ?, ?, ?, ?)`,
          [
            id,
            file.originalName,
            file.storedName,
            file.mimeType,
            file.size
          ]
        );
      }

      // COMMIT 중 연결이 끊기면 저장 여부가 불명확하므로
      // 파일을 지우지 않고 보존합니다.
      await security.finishSubmission(conn, submission, id);

      req.keepUploadFiles = true;

      await conn.commit();

      res.status(201).json({
        application_id: id,
        message:
          '접수 요청이 제출되었습니다. 관리자 검토 후 정식 접수됩니다.'
      });
    } catch (err) {
      if (conn) {
        try {
          await conn.rollback();
        } catch (rollbackError) {
          console.error('롤백 실패:', rollbackError.code);
        }
      }

      try {
        await attachments.cleanup(req);
      } catch (error) {
        console.error('첨부 정리 실패:', error.code);
      }

      if (err.status) {
        return security.deny(res, err);
      }

      console.error('신청 저장 실패:', err.code);

      res.status(500).json({
        message: '신청 저장에 실패했습니다.'
      });
    } finally {
      if (conn) conn.release();

      try {
        await attachments.cleanup(req);
      } catch (error) {
        console.error('첨부 정리 실패:', error.code);
      }
    }
  }
);

app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);

  console.error(
    'API 처리 오류:',
    err.code || err.type || err.name
  );

  const status =
    err.type === 'entity.too.large'
      ? 413
      : err.type === 'entity.parse.failed'
        ? 400
        : 500;

  res.status(status).json({
    message: status === 500
      ? '요청 처리에 실패했습니다.'
      : '전송 내용이나 크기를 확인하세요.'
  });
});



if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Solar-Homepage running on port ${PORT}`);
  });
}

module.exports = app;

