const $ = id => document.getElementById(id);

let page = 1;
let hasNext = false;
let busy = false;
let detailVersion = 0;
let opener = null;

function date(value) {
  if (!value) return '-';

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) return '-';

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(parsed);

  const get = type =>
    parts.find(part => part.type === type).value;

  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function api(url) {
  const response = await fetch('/api/notices' + url, {
    cache: 'no-store'
  });

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      '공지 응답을 확인하지 못했습니다. 잠시 후 다시 시도하세요.'
    );
  }

  if (!response.ok) {
    throw new Error(
      data.message || '공지 조회에 실패했습니다.'
    );
  }

  return data;
}

function messageRow(text) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');

  td.colSpan = 4;
  td.className = 'notice-empty';
  td.textContent = text;

  tr.append(td);
  $('list').replaceChildren(tr);
}

async function detail(id, button) {
  if (busy) return;

  const version = ++detailVersion;

  $('message').textContent = '';

  try {
    const row = await api('/' + encodeURIComponent(id));

    if (version !== detailVersion) return;

    opener = button;

    $('title').textContent = row.title;
    $('date').textContent =
      '등록일 ' + date(row.created_at) +
      '  ·  수정일 ' + date(row.updated_at);

    $('content').textContent = row.content;
    $('detail').hidden = false;

    $('detail').scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });

    $('title').focus({ preventScroll: true });
  } catch (err) {
    if (version !== detailVersion) return;

    $('detail').hidden = true;
    $('message').textContent = err.message;
  }
}

async function list(target = page) {
  if (busy) return;

  busy = true;
  detailVersion++;

  $('detail').hidden = true;
  $('message').textContent = '';
  $('table-region').setAttribute('aria-busy', 'true');

  $('prev').disabled = true;
  $('next').disabled = true;
  $('reload').disabled = true;

  try {
    const data = await api('?page=' + target);

    page = target;
    hasNext = Boolean(data.hasNext);

    $('list').replaceChildren();

    for (const row of data.rows) {
      const tr = document.createElement('tr');

      const number = document.createElement('td');
      number.className = 'notice-number';
      number.textContent = row.id;

      const titleCell = document.createElement('td');
      const titleButton = document.createElement('button');

      titleButton.type = 'button';
      titleButton.className = 'notice-title-button';
      titleButton.textContent = row.title;

      titleButton.onclick = () =>
        detail(row.id, titleButton);

      titleCell.append(titleButton);

      const created = document.createElement('td');
      created.className = 'notice-date';
      created.textContent = date(row.created_at);

      const action = document.createElement('td');
      const view = document.createElement('button');

      view.type = 'button';
      view.className = 'notice-view';
      view.textContent = '보기';

      view.setAttribute(
        'aria-label',
        row.title + ' 본문 보기'
      );

      view.onclick = () => detail(row.id, view);

      action.append(view);
      tr.append(number, titleCell, created, action);

      $('list').append(tr);
    }

    if (!data.rows.length) {
      messageRow('등록된 공지가 없습니다.');
    }

    $('summary').textContent =
      '현재 페이지 ' + data.rows.length + '건';

    $('page').textContent = page + ' 페이지';
  } catch (err) {
    $('message').textContent =
      err.message + ' 새로고침 버튼으로 다시 시도하세요.';

    if (!$('list').querySelector('button')) {
      messageRow('공지를 불러오지 못했습니다.');

      $('summary').textContent =
        '연결 상태를 확인해 주세요.';
    }
  } finally {
    busy = false;

    $('table-region').setAttribute('aria-busy', 'false');

    $('prev').disabled = page === 1;
    $('next').disabled = !hasNext;
    $('reload').disabled = false;
  }
}

$('prev').onclick = () => list(page - 1);
$('next').onclick = () => list(page + 1);
$('reload').onclick = () => list(page);

$('close-detail').onclick = () => {
  detailVersion++;
  $('detail').hidden = true;

  $('table-region').scrollIntoView({
    behavior: 'smooth',
    block: 'center'
  });

  if (opener?.isConnected) {
    opener.focus({ preventScroll: true });
  }
};

list();