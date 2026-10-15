const form = document.getElementById('as-request-form');
const button = form.querySelector('button[type="submit"]');
const resultBox = document.getElementById('request-result');

const attachments = document.getElementById('attachments');
const camera = document.getElementById('camera-photo');
const cameraButton = document.getElementById('camera-button');
const fileList = document.getElementById('attachment-list');

const selected = [];
const maxSize = 10 * 1024 * 1024;

let locked = false;
let processing = false;

let submissionKey = '';

function getSubmissionKey() {
  if (submissionKey) return submissionKey;

  try {
    submissionKey =
      sessionStorage.getItem('as-submission-id') || '';
  } catch {}

  const valid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

  if (!valid.test(submissionKey)) {
    submissionKey = crypto.randomUUID();

    try {
      sessionStorage.setItem(
        'as-submission-id',
        submissionKey
      );
    } catch {}
  }

  return submissionKey;
}

// 화면 너비 대신 브라우저의 휴대폰 정보를 사용
const isPhone =
  typeof navigator.userAgentData?.mobile === 'boolean'
    ? navigator.userAgentData.mobile
    : /Android.*Mobile|iPhone|iPod/i.test(navigator.userAgent);

document.getElementById('mobile-camera').hidden = !isPhone;

function updateButtons() {
  button.disabled = locked || processing;
  attachments.disabled = locked || processing;
  camera.disabled = locked || processing;
  cameraButton.disabled = locked || processing;
}

function renderFiles() {
  fileList.replaceChildren();

  for (const [index, item] of selected.entries()) {
    const row = document.createElement('div');
    row.className = 'attachment-item';

    if (item.preview) {
      const image = document.createElement('img');
      image.src = item.preview;
      image.alt = item.file.name + ' 미리보기';
      row.append(image);
    }

    const name = document.createElement('span');

    name.textContent =
      item.file.name + ' (' +
      (item.file.size / 1024 / 1024).toFixed(2) +
      'MB)';

    row.append(name);

    const remove = document.createElement('button');

    remove.type = 'button';
    remove.textContent = '제거';
    remove.disabled = locked || processing;
    remove.setAttribute(
      'aria-label',
      item.file.name + ' 제거'
    );

    remove.onclick = () => {
      if (locked || processing) return;

      const [removed] = selected.splice(index, 1);

      if (removed.preview) {
        URL.revokeObjectURL(removed.preview);
      }

      renderFiles();
    };

    row.append(remove);
    fileList.append(row);
  }

  const count = document.createElement('p');
  count.className = 'form-help';
  count.textContent =
    '선택한 파일: ' + selected.length + ' / 5개';

  fileList.append(count);
}

function addFiles(files) {
  const additions = [];

  for (const file of files) {
    if (
      !/\.(jpe?g|png|webp|pdf)$/i.test(file.name) ||
      !file.size ||
      file.size > maxSize
    ) {
      throw new Error(
        'JPG·PNG·WebP·PDF만 가능하며, 파일당 최대 10MB입니다.'
      );
    }

    const duplicate = [
      ...selected.map(item => item.file),
      ...additions
    ].some(item =>
      item.name === file.name &&
      item.size === file.size &&
      item.lastModified === file.lastModified
    );

    if (!duplicate) additions.push(file);
  }

  if (selected.length + additions.length > 5) {
    throw new Error(
      '촬영 사진과 선택 파일을 합해 최대 5개입니다.'
    );
  }

  for (const file of additions) {
    selected.push({
      file,
      preview: /\.(jpe?g|png|webp)$/i.test(file.name)
        ? URL.createObjectURL(file)
        : null
    });
  }

  renderFiles();
}

async function cameraJpeg(file) {
  const url = URL.createObjectURL(file);

  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();

      img.onload = () => resolve(img);

      img.onerror = () => reject(new Error(
        '촬영 사진을 읽지 못했습니다. ' +
        '카메라 저장 형식을 JPEG로 설정하거나 파일 선택을 이용하세요.'
      ));

      img.src = url;
    });

    // 촬영 사진은 긴 변 최대 2560px의 JPEG로 변환
    const scale = Math.min(
      1,
      2560 / Math.max(image.naturalWidth, image.naturalHeight)
    );

    const canvas = document.createElement('canvas');

    canvas.width = Math.max(
      1,
      Math.round(image.naturalWidth * scale)
    );

    canvas.height = Math.max(
      1,
      Math.round(image.naturalHeight * scale)
    );

    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error(
        '이 브라우저에서 사진 변환을 지원하지 않습니다.'
      );
    }

    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      image, 0, 0, canvas.width, canvas.height
    );

    const blob = await new Promise(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', 0.88);
    });

    if (!blob) {
      throw new Error('사진을 JPEG로 변환하지 못했습니다.');
    }

    const stamp = new Date()
      .toISOString()
      .replace(/[-:.TZ]/g, '');

    return new File(
      [blob],
      'AS-photo-' + stamp + '.jpg',
      {
        type: 'image/jpeg',
        lastModified: Date.now()
      }
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 일반 파일 선택
attachments.addEventListener('change', () => {
  if (locked || processing) return;

  resultBox.textContent = '';

  try {
    addFiles(Array.from(attachments.files));
  } catch (error) {
    resultBox.textContent = error.message;
  }

  attachments.value = '';
});

// 카메라 열기
cameraButton.addEventListener('click', () => {
  if (locked || processing) return;

  if (selected.length >= 5) {
    resultBox.textContent =
      '이미 5개를 선택했습니다. 파일을 제거한 뒤 촬영하세요.';
    return;
  }

  camera.value = '';
  camera.click();
});

// 촬영 사진 추가
camera.addEventListener('change', async () => {
  if (locked || processing || !camera.files.length) return;

  const file = camera.files[0];

  processing = true;
  updateButtons();
  renderFiles();

  resultBox.textContent = '촬영한 사진을 준비하고 있습니다.';

  try {
    const converted = await cameraJpeg(file);
    addFiles([converted]);

    resultBox.textContent =
      '사진을 추가했습니다. 필요하면 다시 촬영할 수 있습니다.';
  } catch (error) {
    resultBox.textContent = error.message;
  } finally {
    camera.value = '';
    processing = false;

    updateButtons();
    renderFiles();
  }
});

// 신청서 제출
form.addEventListener('submit', async event => {
  event.preventDefault();

  if (locked || processing || !form.reportValidity()) return;

  const count = selected.length;
  const data = new FormData(form);

  data.delete('attachments');

  for (const item of selected) {
    data.append('attachments', item.file);
  }

  data.set(
    'privacy_agreed',
    String(form.elements.privacy_agreed.checked)
  );

  locked = true;
  updateButtons();
  renderFiles();

  button.textContent = '제출 중…';
  resultBox.textContent = '사진과 신청 내용을 전송하고 있습니다.';

  try {
    const response = await fetch('/api/as-requests', {
      method: 'POST',
      headers: {
        'X-Submission-Id': getSubmissionKey()
      },
      body: data
    });

    const result = await response.json();

    if (!response.ok) {
      if (response.status >= 500) {
        throw new Error('결과 확인 필요');
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
      throw new Error('신청번호 확인 실패');
    }

    resultBox.textContent =
      (result.duplicate
        ? '이미 저장된 동일 요청입니다. 중복 등록하지 않았습니다.'
        : '접수 요청이 제출되었습니다.') +
      '\n신청 관리번호: ' + result.application_id +
      '\n첨부파일: ' + count + '개\n' +
      '관리자 검토 후 정식 접수됩니다.';

    try {
      sessionStorage.removeItem('as-submission-id');
    } catch {}

    submissionKey = '';

    form.reset();

    for (const item of selected) {
      if (item.preview) URL.revokeObjectURL(item.preview);
    }

    selected.length = 0;
    renderFiles();

    button.textContent = '제출 완료';
  } catch {
    resultBox.textContent =
      '제출 결과를 확인하지 못했습니다. ' +
      '이미 저장되었을 수 있으므로 재제출 전에 관리자에게 확인해 주세요.';

    button.textContent = '신청 확인 필요';
  } finally {
    updateButtons();
    renderFiles();

    if (!locked) {
      button.textContent = 'A/S 접수 요청';
    }
  }
});

renderFiles();