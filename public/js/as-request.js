const form = document.getElementById('as-request-form');
const button = form.querySelector('button[type="submit"]');
const resultBox = document.getElementById('request-result');

let locked = false;

form.addEventListener('submit', async event => {
  event.preventDefault();

  if (locked || !form.reportValidity()) {
    return;
  }

  const fields = new FormData(form);
  const data = Object.fromEntries(fields.entries());

  data.privacy_agreed = fields.has('privacy_agreed');

  locked = true;
  button.disabled = true;
  button.textContent = '제출 중…';
  resultBox.textContent = '';

  try {
    const response = await fetch('/api/as-requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });

    const result = await response.json();

    if (!response.ok) {
      if (response.status >= 500) {
        throw new Error('保存結果を確認できません');
      }

      resultBox.textContent =
        result.message || '입력 내용을 확인해 주세요.';

      locked = false;
      return;
    }

    if (
      typeof result.application_id !== 'string' ||
      !/^\d+$/.test(result.application_id)
    ) {
      throw new Error('신청 관리번호를 확인하지 못했습니다.');
    }

    resultBox.textContent =
      '접수 요청이 제출되었습니다.\n' +
      '신청 관리번호: ' + result.application_id + '\n' +
      '관리자 검토 후 정식 접수됩니다.\n' +
      '아직 정식 접수번호가 발급된 상태는 아닙니다.';

    form.reset();
    button.textContent = '제출 완료';
  } catch {
    resultBox.textContent =
      '제출 결과를 확인하지 못했습니다.\n' +
      '이미 저장되었을 수 있으므로 다시 제출하기 전에 ' +
      '관리자에게 확인해 주세요.';

    button.textContent = '신청 확인 필요';
  } finally {
    if (!locked) {
      button.disabled = false;
      button.textContent = 'A/S 접수 요청';
    }
  }
});