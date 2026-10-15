const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const filename = path.join(__dirname, '.env');

const current = fs.existsSync(filename)
  ? fs.readFileSync(filename, 'utf8')
  : '';

if (/^\s*(?:export\s+)?SECURITY_HMAC_KEY\s*=/m.test(current)) {
  console.log('기존 SECURITY_HMAC_KEY를 유지합니다.');
} else {
  fs.appendFileSync(
    filename,
    '\nSECURITY_HMAC_KEY=' +
    crypto.randomBytes(32).toString('hex') +
    '\n',
    { mode: 0o600 }
  );

  console.log('로컬 .env에 보안용 키를 추가했습니다.');
}