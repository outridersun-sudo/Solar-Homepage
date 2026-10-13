require('dotenv').config();

const express = require('express');
const mariadb = require('mariadb');
const path = require('path');

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
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/as-requests', async (req, res) => {
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ message: '잘못된 신청 데이터입니다.' });
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
      return res.status(400).json({ message: '입력 형식이 올바르지 않습니다.' });
    }

    data[field] = (value || '').trim();

    if (data[field].length > max) {
      return res.status(400).json({ message: '입력 내용이 너무 깁니다.' });
    }
  }

  const required = [
    'customer_name', 'contact_name', 'phone', 'plant_name',
    'product_type', 'model_name', 'serial_number', 'symptoms'
  ];

  if (required.some(field => !data[field])) {
    return res.status(400).json({ message: '필수 항목을 입력해 주세요.' });
  }

  if (!['태양광 인버터', '통신 RTU', '기타'].includes(data.product_type)) {
    return res.status(400).json({ message: '제품 구분을 확인해 주세요.' });
  }

  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    return res.status(400).json({ message: '이메일을 확인해 주세요.' });
  }

  if (body.privacy_agreed !== true) {
    return res.status(400).json({ message: '개인정보 수집·이용에 동의해 주세요.' });
  }

    let conn;

  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // 접수 시점을 한국 시간으로 계산
    const koreaNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const date = koreaNow.toISOString().slice(0, 10);
    const yymmdd = date.slice(2).replaceAll('-', '');

    await conn.query(
      `INSERT INTO as_request_sequences (request_date, last_number)
       VALUES (?, 0)
       ON DUPLICATE KEY UPDATE last_number = last_number`,
      [date]
    );

    // 같은 날짜의 번호 생성은 순서대로 처리
    const rows = await conn.query(
      `SELECT last_number
       FROM as_request_sequences
       WHERE request_date = ?
       FOR UPDATE`,
      [date]
    );

    const nextNumber = Number(rows[0].last_number) + 1;

    if (nextNumber > 9999) {
      await conn.rollback();
      return res.status(503).json({
        message: '당일 접수 한도를 초과했습니다. 담당자에게 문의해 주세요.'
      });
    }

    await conn.query(
      `UPDATE as_request_sequences
       SET last_number = ?
       WHERE request_date = ?`,
      [nextNumber, date]
    );

    const requestNumber =
      `AS-${yymmdd}-${String(nextNumber).padStart(4, '0')}`;

    await conn.query(
      `INSERT INTO as_requests (
        request_number,
        customer_name, contact_name, phone, email,
        plant_name, installation_region, product_type,
        model_name, serial_number, fault_code, symptoms,
        privacy_agreed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        requestNumber,
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

    await conn.commit();

    res.status(201).json({ request_number: requestNumber });
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback();
      } catch (rollbackError) {
        console.error('롤백 실패:', rollbackError.code);
      }
    }

    console.error('A/S 저장 실패:', err.code);

    res.status(500).json({
      message: '접수 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.'
    });
  } finally {
    if (conn) conn.release();
  }

});

app.listen(3000, '127.0.0.1', () => {
  console.log('http://localhost:3000');
});