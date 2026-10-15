const form = document.getElementById('as-request-form');
const button = form.querySelector('button[type="submit"]');
const resultBox = document.getElementById('request-result');

let locked = false;

form.addEventListener('submit', async event => {
  event.preventDefault();

  if (locked || !form.reportValidity()) return;

  const files = Array.from(
    document.getElementById('attachments').files
  );

  if (files.length > 5) {
    resultBox.textContent = '첨부는 최대 5개입니다.';
    return;
  }

  for (const file of files) {
    if (
      !/\.(jpe?g|png|webp|pdf)$/i.test(file.name) ||
      file.size === 0 ||
      file.size > 10 * 1024 * 1024
    ) {
      resultBox.textContent =
        'JPG·PNG·WebP·PDF만 가능하며, ' +
        '빈 파일은 제외하고 파일당 최대 10MB입니다.';
      return;
    }
  }

  const data = new FormData(form);

  // 선택하지 않은 빈 파일 항목을 제외하고 추가
  data.delete('attachments');

  for (const file of files) {
    data.append('attachments', file);
  }

  data.set(
    'privacy_agreed',
    String(form.elements.privacy_agreed.checked)
  );

  locked = true;
  button.disabled = true;
  button.textContent = '제출 중…';

  resultBox.textContent =
    '파일이 있으면 전송에 시간이 걸릴 수 있습니다.';

  try {
    // Content-Type은 브라우저가 multipart 경계와 함께 설정
    const response = await fetch('/api/as-requests', {
      method: 'POST',
      body: data
    });

    const result = await response.json();

    if (!response.ok) {
      if (response.status >= 500) {
        throw new Error('저장 결과 확인 필요');
      }

      resultBox.textContent =
        result.message || '입력 내용과 첨부파일을 확인하세요.';

      locked = false;
      return;
    }

    if (
      typeof result.application_id !== 'string' ||
      !/^\d+$/.test(result.application_id)
    ) {
      throw new Error('신청 관리번호 확인 실패');
    }

    resultBox.textContent =
      '접수 요청이 제출되었습니다.\n' +
      '신청 관리번호: ' + result.application_id + '\n' +
      '첨부파일: ' + files.length + '개\n' +
      '관리자 검토 후 정식 접수됩니다.';

    form.reset();
    button.textContent = '제출 완료';
  } catch {
    resultBox.textContent =
      '제출 결과를 확인하지 못했습니다. ' +
      '이미 저장되었을 수 있으므로 재제출 전에 관리자에게 확인해 주세요.';

    button.textContent = '신청 확인 필요';
  } finally {
    if (!locked) {
      button.disabled = false;
      button.textContent = 'A/S 접수 요청';
    }
  }
});