const $ = id => document.getElementById(id);

let csrf = '';
let editingId = null;
let page = 1;
let hasNext = false;
let busy = false;

async function api(url, options = {}) {
  const response = await fetch('/api/admin' + url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf
    },
    cache: 'no-store'
  });

  const data = await response.json();

  if (!response.ok) {
    if (response.status === 401) {
      $('management').hidden = true;
      csrf = '';
      $('editor').reset();
      $('rows').replaceChildren();
    }

    throw new Error(data.message || '요청 실패');
  }

  return data;
}

function newNotice() {
  editingId = null;
  $('editor').reset();
  $('editor-title').textContent = '새 공지 작성';
}

async function list(target = page) {
  const data = await api('/notices?page=' + target);

  page = target;
  hasNext = Boolean(data.hasNext);
  $('rows').replaceChildren();

  for (const row of data.rows) {
    const tr = document.createElement('tr');

    const values = [
      row.title,
      Number(row.is_published) === 1 ? '공개' : '비공개',
      new Date(row.updated_at).toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul'
      })
    ];

    for (const value of values) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }

    const td = document.createElement('td');
    const button = document.createElement('button');

    button.type = 'button';
    button.textContent = '수정';

    button.onclick = () => run(async () => {
      const item = await api(
        '/notices/' + encodeURIComponent(row.id)
      );

      editingId = item.id;
      $('title').value = item.title;
      $('content').value = item.content;
      $('published').checked =
        Number(item.is_published) === 1;

      $('editor-title').textContent =
        '공지 수정 #' + item.id;

      $('editor').scrollIntoView({ behavior: 'smooth' });
    });

    td.append(button);
    tr.append(td);
    $('rows').append(tr);
  }

  if (!data.rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');

    td.colSpan = 4;
    td.textContent = '등록된 공지가 없습니다.';

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
  if (!busy) {
    newNotice();
    $('title').focus();
  }
};

$('refresh').onclick = () => run(() => list());
$('prev').onclick = () => run(() => list(page - 1));
$('next').onclick = () => run(() => list(page + 1));

$('editor').onsubmit = event => {
  event.preventDefault();

  run(async () => {
    const data = {
      title: $('title').value.trim(),
      content: $('content').value.trim(),
      is_published: $('published').checked
    };

    if (!data.title || !data.content) {
      throw new Error('제목과 본문을 입력하세요.');
    }

    const result = await api(
      '/notices' +
      (editingId ? '/' + encodeURIComponent(editingId) : ''),
      {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify(data)
      }
    );

    editingId = result.id || editingId;

    $('editor-title').textContent =
      '공지 수정 #' + editingId;

    try {
      await list(1);
      $('message').textContent = result.message;
    } catch (err) {
      $('message').textContent =
        result.message + '\n목록 갱신 실패: ' + err.message;
    }
  });
};

run(async () => {
  const session = await api('/session');

  csrf = session.csrf;
  $('management').hidden = false;

  await list(1);
});