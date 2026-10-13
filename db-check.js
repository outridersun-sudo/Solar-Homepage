require('dotenv').config();
const mariadb = require('mariadb');

async function check() {
  let conn;

  try {
    conn = await mariadb.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });

    const rows = await conn.query(
      'SELECT COUNT(*) AS total FROM as_requests'
    );

    console.log('DB 연결 성공');
    console.log('현재 접수 건수:', String(rows[0].total));
  } catch (err) {
    console.error('DB 연결 실패:', err.code || err.message);
    process.exitCode = 1;
  } finally {
    if (conn) await conn.end();
  }
}

check();