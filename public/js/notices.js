const $ = id => document.getElementById(id);

let page = 1;
let busy = false;

function date(value) {
  return new Date(value).toLocaleDateString('ko-KR', {
    timeZone: 'Asia/Seoul'
  });
}

async function api(url) {
  const response = await fetch('/api/notices' + url, {
    cache: 'no-store'
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || '공지 조회 실패');
  }

  return data;
}

async function detail(id) {
  const row = await api('/' + encodeURIComponent(id));

  $('title').textContent = row.title;
  $('date').textContent =
    '작성일: ' + date(row.created_at) +
    ' / 수정일: ' + date(row.updated_at);

  $('content').textContent = row.content;
  $('detail').hidden = false;
  $('detail').scrollIntoView({ behavior: 'smooth' });
}

async function list(target = page) {
  if (busy) return;

  busy = true;
  $('prev').disabled = true;
  $('next').disabled = true;
  $('message').textContent = '';

  try {
    const data = await api('?page=' + target);

    page = target;
    $('list').replaceChildren();
    $('detail').hidden = true;

    for (const row of data.rows) {
      const p = document.createElement('p');
      const button = document.createElement('button');

      button.type = 'button';
      button.className = 'btn btn-gray';
      button.textContent = row.title;

      button.onclick = () => {
        detail(row.id).catch(err => {
          $('message').textContent = err.message;
        });
      };

      p.append(
        button,
        document.createTextNode(' ' + date(row.created_at))
      );

      $('list').append(p);
    }

    if (!data.rows.length) {
      $('list').textContent = '등록된 공지가 없습니다.';
    }

    $('page').textContent = page + ' 페이지';
    $('prev').disabled = page === 1;
    $('next').disabled = !data.hasNext;
  } catch (err) {
    $('message').textContent = err.message;
  } finally {
    busy = false;
  }
}

$('prev').onclick = () => list(page - 1);
$('next').onclick = () => list(page + 1);

list();