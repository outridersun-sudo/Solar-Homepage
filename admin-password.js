const crypto = require('node:crypto');
const readline = require('node:readline');

if (!process.stdin.isTTY) {
  throw new Error('VS Code 터미널에서 실행하세요.');
}

process.stdout.write(
  '새 관리자 비밀번호 (12~256자, 입력 문자는 표시되지 않음): '
);

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);

let password = '';

process.stdin.on('keypress', (text, key) => {
  if (key.ctrl && key.name === 'c') {
    process.stdin.setRawMode(false);
    process.exit(1);
  }

  if (key.name === 'return') {
    process.stdin.setRawMode(false);
    process.stdin.pause();

    if (password.length < 12 || password.length > 256) {
      console.error('\n비밀번호를 12~256자로 설정하세요.');
      process.exitCode = 1;
      return;
    }

    const salt = crypto.randomBytes(16).toString('hex');

    crypto.scrypt(password, salt, 64, (err, hash) => {
      if (err) {
        console.error('\n비밀번호 설정 생성에 실패했습니다.');
        process.exitCode = 1;
        return;
      }

      console.log('\n아래 두 줄을 로컬 .env에 추가하세요.');
      console.log('ADMIN_USERNAME=admin');
      console.log(
        'ADMIN_PASSWORD_HASH=' +
        salt + ':' + hash.toString('hex')
      );
    });
  } else if (key.name === 'backspace') {
    password = password.slice(0, -1);
  } else if (text && !key.ctrl && !key.meta) {
    password += text;
  }
});