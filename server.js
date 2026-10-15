require('dotenv').config();

const express = require('express');
const mariadb = require('mariadb');
const path = require('path');
const attachments = require('./server/attachments');

const app = express();

const pool = mariadb.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 5
});

app.use(express.json({ limit: '100kb' }));

require('./server/notices').registerPublic(app, pool);
require('./server/admin')(app, pool);

app.use(express.static(path.join(__dirname, 'public')));

app.post(
  '/api/as-requests',
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
      conn = await pool.getConnection();
      await conn.beginTransaction();

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

if (require.main === module) {
  app.listen(3000, '127.0.0.1', () => {
    console.log('http://localhost:3000');
  });
}

module.exports = app;