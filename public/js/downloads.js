const $ = id => document.getElementById(id);

let page = 1;
let hasNext = false;
let busy = false;

let filters = {
  q: '',
  category: ''
};

function date(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));

  return ['year', 'month', 'day']
    .map(key => parts.find(part => part.type === key).value)
    .join('-');
}

async function list(target = page, proposed = filters) {
  if (busy) return;

  busy = true;
  $('message').textContent = '';

  document.querySelectorAll('.download-page button')
    .forEach(button => {
      button.disabled = true;
    });

  try {
    const query = new URLSearchParams({
      page: String(target),
      ...proposed
    });

    const response = await fetch('/api/downloads?' + query, {
      cache: 'no-store'
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || '자료 조회 실패');
    }

    page = target;
    filters = { ...proposed };
    hasNext = Boolean(data.hasNext);

    $('rows').replaceChildren();

    for (const row of data.rows) {
      const tr = document.createElement('tr');

      for (const value of [
        row.category,
        row.product_name,
        row.title,
        row.version,
        date(row.created_at)
      ]) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.append(td);
      }

      const td = document.createElement('td');
      const actions = document.createElement('div');

      actions.className = 'file-actions';

      for (const [action, label] of [
        ['view', 'PDF 보기'],
        ['download', '다운로드']
      ]) {
        const link = document.createElement('a');

        link.className = 'download-btn';
        link.textContent = label;

        link.href =
          '/api/downloads/' +
          encodeURIComponent(row.id) +
          '/' + action;

        link.target = '_blank';
        link.rel = 'noopener noreferrer';

        actions.append(link);
      }

      td.append(actions);
      tr.append(td);
      $('rows').append(tr);
    }

    if (!data.rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');

      td.colSpan = 6;
      td.className = 'empty';
      td.textContent = '조건에 맞는 공개 자료가 없습니다.';

      tr.append(td);
      $('rows').append(tr);
    }

    $('summary').textContent =
      '현재 페이지 ' + data.rows.length + '건';

    $('page').textContent = page + ' 페이지';
  } catch (err) {
    $('message').textContent =
      '자료를 불러오지 못했습니다. ' + err.message;
  } finally {
    busy = false;

    document.querySelectorAll('.download-page button')
      .forEach(button => {
        button.disabled = false;
      });

    $('prev').disabled = page === 1;
    $('next').disabled = !hasNext;
  }
}

$('filters').onsubmit = event => {
  event.preventDefault();

  list(1, {
    q: $('searchInput').value.trim(),
    category: $('categoryFilter').value
  });
};

$('reset').onclick = () => {
  $('filters').reset();
  list(1, { q: '', category: '' });
};

$('prev').onclick = () => list(page - 1);
$('next').onclick = () => list(page + 1);

list();