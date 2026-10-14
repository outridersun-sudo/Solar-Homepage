const $ = id => document.getElementById(id);

let csrf = '';
let page = 1;
let selectedId = null;
let hasNextPage = false;
let busy = false;

const statusNames = {
  pending: '검토 대기',
  received: '정식 접수',
  rejected: '신청 불가',
  in_progress: '처리 중',
  completed: '완료'
};

const actionNames = {
  pending: '검토 대기로 되돌림',
  received: '정식 접수 승인',
  rejected: '신청 불가 처리',
  in_progress: '처리 중으로 변경',
  completed: '완료 처리'
};

const transitions = {
  pending: ['received', 'rejected'],
  rejected: ['pending'],
  received: ['in_progress', 'completed'],
  in_progress: ['completed'],
  completed: []
};

function showMessage(text) {
  $('message').textContent = text;
}

function showLogin() {
  csrf = '';
  selectedId = null;
  hasNextPage = false;

  $('login-form').hidden = false;
  $('management').hidden = true;
  $('detail').hidden = true;

  $('rows').replaceChildren();
  $('detail-fields').replaceChildren();
  $('history').replaceChildren();

  $('reason').value = '';
  $('operator-name').value = '';
  $('completed-at').value = '';
  $('completion-details').value = '';
}

async function api(url, options = {}) {
  const response = await fetch('/api/admin' + url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf
    },
    cache: 'no-store'
  });

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      '서버 응답을 확인하지 못했습니다. 서버 코드와 실행 상태를 확인하세요.'
    );
  }

  if (!response.ok) {
    if (response.status === 401) {
      showLogin();
    }

    const error = new Error(
      data.message || '요청에 실패했습니다.'
    );

    error.status = response.status;
    throw error;
  }

  return data;
}

function formatDate(value) {
  if (!value) return '-';

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul'
  });
}

function updateActionHelp() {
  const target = $('status').value;
  const completing = target === 'completed';

  $('operator-label').textContent =
    target === 'received'
      ? '접수자 이름 *'
      : completing
        ? '완료자 이름 *'
        : '처리자 이름 *';

  $('reason-group').hidden = completing;
  $('reason').required = !completing;
  $('reason').disabled = completing;

  $('completion-group').hidden = !completing;
  $('completed-at').required = completing;
  $('completed-at').disabled = !completing;
  $('completion-details').required = completing;
  $('completion-details').disabled = !completing;

  if (completing && !$('completed-at').value) {
    $('completed-at').value = new Date(
      Date.now() + 9 * 60 * 60 * 1000
    ).toISOString().slice(0, 16);
  }

  const help = {
    received:
      '접수 사유와 접수자를 입력하세요. 승인하면 접수번호와 접수일시를 기록하고 알림을 처리합니다.',
    rejected:
      '신청 불가 사유와 처리자를 입력하세요. 신청 내역과 이력은 삭제하지 않습니다.',
    pending:
      '재검토 사유와 처리자를 입력하세요. 이전 이력은 유지됩니다.',
    in_progress:
      '처리 시작 사유와 처리자를 입력하세요.',
    completed:
      '완료일시, 처리내용, 완료자를 입력하세요. 시스템 기록 시각은 별도로 자동 저장됩니다.'
  };

  $('action-help').textContent = help[target] || '';
}

async function loadList(targetPage = page) {
  const data = await api('/requests?page=' + targetPage);

  page = targetPage;
  selectedId = null;
  hasNextPage = Boolean(data.hasNext);

  $('rows').replaceChildren();
  $('detail').hidden = true;
  $('detail-fields').replaceChildren();
  $('history').replaceChildren();

  for (const row of data.rows) {
    const tr = document.createElement('tr');

    const values = [
      row.request_number || '신청 #' + row.id,
      row.customer_name,
      row.model_name,
      statusNames[row.status] || row.status,
      formatDate(row.created_at)
    ];

    for (const value of values) {
      const td = document.createElement('td');
      td.textContent = value ?? '-';
      tr.append(td);
    }

    const td = document.createElement('td');
    const button = document.createElement('button');

    button.type = 'button';
    button.textContent = '보기';

    button.addEventListener('click', () => {
      runAction(() => loadDetail(row.id));
    });

    td.append(button);
    tr.append(td);
    $('rows').append(tr);
  }

  if (data.rows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');

    td.colSpan = 6;
    td.textContent = '신청 내역이 없습니다.';

    tr.append(td);
    $('rows').append(tr);
  }

  $('page-label').textContent = page + ' 페이지';
}

async function loadDetail(id) {
  const row = await api(
    '/requests/' + encodeURIComponent(id)
  );

  selectedId = row.id;

  $('detail-fields').replaceChildren();
  $('history').replaceChildren();

  const labels = {
    id: '신청 관리번호',
    request_number: '정식 접수번호',
    status: '현재 상태',
    customer_name: '회사명 / 고객명',
    contact_name: '담당자명',
    phone: '연락처',
    email: '이메일',
    plant_name: '발전소명',
    installation_region: '설치 지역',
    product_type: '제품 구분',
    model_name: '제품 모델',
    serial_number: '시리얼번호',
    fault_code: '오류코드',
    symptoms: '고장 증상',
    created_at: '신청일',
    privacy_agreed_at: '동의일',
    accepted_at: '정식 접수일시',
    acceptance_reason: '접수 사유',
    accepted_by: '접수자',
    completed_at: '실제 완료일시',
    completion_details: '처리내용',
    completed_by: '완료자',
    completion_recorded_at: '완료 기록 시각'
  };

  for (const [key, label] of Object.entries(labels)) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');

    dt.textContent = label;

    if (key === 'status') {
      dd.textContent = statusNames[row.status] || row.status;
    } else if (key === 'request_number') {
      dd.textContent = row.request_number || '미발급';
    } else if (key.endsWith('_at')) {
      dd.textContent = formatDate(row[key]);
    } else {
      dd.textContent = row[key] ?? '-';
    }

    $('detail-fields').append(dt, dd);
  }

  for (const entry of row.history || []) {
    const item = document.createElement('li');

    const from = entry.from_status
      ? (statusNames[entry.from_status] || entry.from_status)
      : '이전 기록 없음';

    const to =
      statusNames[entry.to_status] || entry.to_status;

    item.textContent =
      formatDate(entry.created_at) + '\n' +
      '로그인 계정: ' + entry.actor + '\n' +
      '담당자: ' + (entry.performed_by || '기존 기록 없음') + '\n' +
      from + ' → ' + to + '\n' +
      '처리일시: ' + formatDate(entry.effective_at) + '\n' +
      '사유 / 처리내용: ' + entry.reason;

    $('history').append(item);
  }

  if (!$('history').children.length) {
    const item = document.createElement('li');
    item.textContent = '기록된 변경 이력이 없습니다.';
    $('history').append(item);
  }

  const allowed = transitions[row.status] || [];

  $('status').replaceChildren();

  for (const value of allowed) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = actionNames[value];
    $('status').append(option);
  }

  $('reason').value = '';
  $('operator-name').value = '';
  $('completed-at').value = '';
  $('completion-details').value = '';

  $('status-form').hidden = allowed.length === 0;
  $('no-action').hidden = row.status !== 'completed';

  updateActionHelp();

  $('detail').hidden = false;
  $('detail').scrollIntoView({ behavior: 'smooth' });
}

async function runAction(action) {
  if (busy) return;

  busy = true;
  showMessage('');

  document.querySelectorAll('button').forEach(button => {
    button.disabled = true;
  });

  try {
    await action();
  } catch (err) {
    showMessage(
      err.message || '서버 연결을 확인하세요.'
    );
  } finally {
    busy = false;

    document.querySelectorAll('button').forEach(button => {
      button.disabled = false;
    });

    $('previous').disabled = page === 1;
    $('next').disabled = !hasNextPage;
  }
}

$('login-form').addEventListener('submit', event => {
  event.preventDefault();

  runAction(async () => {
    const credentials = Object.fromEntries(
      new FormData($('login-form'))
    );

    const data = await api('/login', {
      method: 'POST',
      body: JSON.stringify(credentials)
    });

    csrf = data.csrf;

    $('login-form').reset();
    $('login-form').hidden = true;
    $('management').hidden = false;

    await loadList(1);
  });
});

$('logout').addEventListener('click', () => {
  runAction(async () => {
    await api('/logout', { method: 'POST' });

    showLogin();
    showMessage('로그아웃했습니다.');
  });
});

$('refresh').addEventListener('click', () => {
  runAction(() => loadList(page));
});

$('previous').addEventListener('click', () => {
  runAction(() => loadList(page - 1));
});

$('next').addEventListener('click', () => {
  runAction(() => loadList(page + 1));
});

$('status').addEventListener('change', updateActionHelp);

$('status-form').addEventListener('submit', event => {
  event.preventDefault();

  if (busy || !selectedId) return;

  const target = $('status').value;
  const operator = $('operator-name').value.trim();
  const reason = $('reason').value.trim();
  const details = $('completion-details').value.trim();
  const completedAt = $('completed-at').value;

  if (!operator) {
    showMessage('담당자 이름을 입력하세요.');
    $('operator-name').focus();
    return;
  }

  if (target === 'completed') {
    if (!completedAt || !details) {
      showMessage('완료일시와 처리내용을 입력하세요.');
      return;
    }
  } else if (!reason) {
    showMessage('변경 사유를 입력하세요.');
    $('reason').focus();
    return;
  }

  if (!window.confirm(
    actionNames[target] +
    '를 진행하시겠습니까?\n담당자 이름과 변경 이력이 저장됩니다.'
  )) {
    return;
  }

  runAction(async () => {
    const id = selectedId;

    const result = await api(
      '/requests/' + encodeURIComponent(id) + '/status',
      {
        method: 'PATCH',
        body: JSON.stringify({
          status: target,
          operator_name: operator,
          reason,
          completed_at: completedAt,
          completion_details: details
        })
      }
    );

    const savedMessage =
      (result.message || '처리 결과를 저장했습니다.') +
      (result.request_number
        ? '\n정식 접수번호: ' + result.request_number
        : '');

    try {
      await loadList(page);
      await loadDetail(id);
      showMessage(savedMessage);
    } catch {
      showMessage(
        savedMessage +
        '\n화면 갱신은 실패했습니다. 새로고침해 결과를 확인하세요.'
      );
    }
  });
});

// 브라우저 새로고침 시 기존 로그인 확인
runAction(async () => {
  try {
    const data = await api('/session');

    csrf = data.csrf;

    $('login-form').hidden = true;
    $('management').hidden = false;

    await loadList(1);
  } catch (err) {
    if (err.status !== 401) {
      throw err;
    }
  }
});