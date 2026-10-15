const $ = id => document.getElementById(id);

let csrf = '';
let editingId = null;
let page = 1;
let hasNext = false;
let busy = false;

async function api(url, options = {}) {
  const headers = {
    'X-CSRF-Token': csrf
  };

  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch('/api/admin' + url, {
    ...options,
    headers,
    cache: 'no-store'
  });

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      '서버 응답을 확인하지 못했습니다. 새 등록은 중복 제출 전에 목록을 확인하세요.'
    );
  }

  if (!response.ok) {
    if (response.status === 401) {
      $('management').hidden = true;
      $('editor').reset();
      $('rows').replaceChildren();
      csrf = '';
    }

    throw new Error(data.message || '처리 결과 확인 실패');
  }

  return data;
}

function fresh() {
  editingId = null;
  $('editor').reset();

  $('file').disabled = false;
  $('file').required = true;

  $('editor-title').textContent = '새 자료 등록';
  $('file-help').textContent =
    'PDF 1개, 최대 20MB. 새 자료는 기본 비공개입니다.';
}

async function list(target = page) {
  const data = await api('/downloads?page=' + target);

  page = target;
  hasNext = Boolean(data.hasNext);
  $('rows').replaceChildren();

  for (const row of data.rows) {
    const tr = document.createElement('tr');

    for (const value of [
      row.category,
      row.product_name + ' / ' + row.title,
      row.version,
      Number(row.is_published) === 1 ? '공개' : '비공개'
    ]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }

    const td = document.createElement('td');
    const edit = document.createElement('button');

    edit.type = 'button';
    edit.textContent = '수정';

    edit.onclick = () => run(async () => {
      editingId = row.id;

      $('category').value = row.category;
      $('product').value = row.product_name;
      $('title').value = row.title;
      $('version').value = row.version;
      $('published').checked =
        Number(row.is_published) === 1;

      $('file').value = '';
      $('file').disabled = true;
      $('file').required = false;

      $('editor-title').textContent =
        '자료 정보 수정 #' + row.id;

      $('file-help').textContent =
        '기존 파일: ' + row.original_name +
        '. PDF 교체는 새 자료로 등록하고 이전 자료를 비공개로 바꾸세요.';

      $('editor').scrollIntoView({
        behavior: 'smooth'
      });
    });

    td.append(edit);

    for (const [action, label] of [
      ['view', '보기'],
      ['download', '다운로드']
    ]) {
      const link = document.createElement('a');

      link.textContent = label;
      link.style.margin = '0 6px';

      link.href =
        '/api/admin/downloads/' +
        encodeURIComponent(row.id) +
        '/' + action;

      link.target = '_blank';
      link.rel = 'noopener noreferrer';

      td.append(link);
    }

    tr.append(td);
    $('rows').append(tr);
  }

  if (!data.rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');

    td.colSpan = 5;
    td.textContent = '등록된 기술자료가 없습니다.';

    tr.append(td);
    $('rows').append(tr);
  }

  $('page').textContent = page + ' 페이지';
}

async function run(action) {
  if (busy) return;

  busy = true;
  $('message').textContent = '';

  document.querySelectorAll('button').forEach(button => {
    button.disabled = true;
  });

  try {
    await action();
  } catch (err) {
    $('message').textContent = err.message;
  } finally {
    busy = false;

    document.querySelectorAll('button').forEach(button => {
      button.disabled = false;
    });

    $('prev').disabled = page === 1;
    $('next').disabled = !hasNext;
  }
}

$('new').onclick = () => {
  if (!busy) fresh();
};

$('refresh').onclick = () => run(() => list());
$('prev').onclick = () => run(() => list(page - 1));
$('next').onclick = () => run(() => list(page + 1));

$('editor').onsubmit = event => {
  event.preventDefault();

  run(async () => {
    const data = {
      category: $('category').value,
      product_name: $('product').value.trim(),
      title: $('title').value.trim(),
      version: $('version').value.trim(),
      is_published: $('published').checked
    };

    if (!data.product_name || !data.title || !data.version) {
      throw new Error('필수 항목을 입력하세요.');
    }

    let result;

    if (editingId) {
      result = await api(
        '/downloads/' + encodeURIComponent(editingId),
        {
          method: 'PATCH',
          body: JSON.stringify(data)
        }
      );
    } else {
      const file = $('file').files[0];

      if (
        !file ||
        !/\.pdf$/i.test(file.name) ||
        file.size === 0 ||
        file.size > 20 * 1024 * 1024
      ) {
        throw new Error(
          'PDF 1개, 최대 20MB까지 선택하세요.'
        );
      }

      const form = new FormData();

      for (const [key, value] of Object.entries(data)) {
        form.set(key, String(value));
      }

      form.set('file', file);

      result = await api('/downloads', {
        method: 'POST',
        body: form
      });

      editingId = result.id;

      $('file').disabled = true;
      $('file').required = false;

      $('editor-title').textContent =
        '자료 정보 수정 #' + editingId;

      $('file-help').textContent =
        '등록된 PDF: ' + file.name +
        '. 파일 교체는 새 자료로 등록하세요.';
    }

    try {
      await list(1);
      $('message').textContent = result.message;
    } catch (err) {
      $('message').textContent =
        result.message +
        '\n목록 갱신 실패: ' + err.message;
    }
  });
};

run(async () => {
  const session = await api('/session');

  csrf = session.csrf;
  $('management').hidden = false;

  fresh();
  await list(1);
});