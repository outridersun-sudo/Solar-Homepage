(() => {
  'use strict';

  const types = {
    consultation: '고객 상담',
    remote: '원격 점검',
    onsite: '현장 점검',
    repair: '수리·조치',
    reinspection: '재점검',
    other: '기타'
  };

  const results = {
    undetermined: '미판정',
    needs_inspection: '추가 점검 필요',
    needs_action: '추가 조치 필요',
    observing: '조치 후 경과 관찰',
    normal: '정상 동작 확인'
  };

  const currentTime = () =>
    new Date(Date.now() + 9 * 3600000)
      .toISOString()
      .slice(0, 16);

  const displayTime = value =>
    new Date(value).toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul'
    });

  let active;

  async function request(url, options = {}) {
    const response = await fetch('/api/admin' + url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options
    });

    const contentType =
      response.headers.get('content-type') || '';

    if (!contentType.includes('application/json')) {
      throw new Error(
        '서버 응답을 확인하지 못했습니다. ' +
        '저장 중이었다면 기록 목록부터 확인하세요.'
      );
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.message || '요청을 처리하지 못했습니다.'
      );
    }

    return data;
  }

  function entryKey(id) {
    const storageKey = 'as-inspection-entry:' + id;

    try {
      let key = sessionStorage.getItem(storageKey);

      const valid =
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

      if (!valid.test(key || '')) {
        key = crypto.randomUUID();
        sessionStorage.setItem(storageKey, key);
      }

      return key;
    } catch {
      return crypto.randomUUID();
    }
  }

  function newKey(state) {
    try {
      sessionStorage.removeItem(
        'as-inspection-entry:' + state.id
      );
    } catch {
      // 브라우저 저장소가 제한된 경우
    }

    state.key = entryKey(state.id);
  }

  function text(parent, tag, value) {
    const element = document.createElement(tag);
    element.textContent = value;
    parent.append(element);
    return element;
  }

  function lock(state, locked) {
    state.busy = locked;

    state.form
      .querySelectorAll('input, select, textarea, button')
      .forEach(element => {
        element.disabled = locked;
      });

    state.previous.disabled =
      locked || state.page <= 1;

    state.next.disabled =
      locked || !state.hasNext;

    state.refresh.disabled = locked;
  }

  async function list(state, page = 1) {
    const data = await request(
      '/requests/' +
      state.id +
      '/inspections?page=' +
      page
    );

    if (
      active !== state ||
      !state.section.isConnected
    ) {
      return;
    }

    state.page = data.page;
    state.hasNext = data.hasNext;
    state.list.replaceChildren();

    if (!data.rows.length) {
      text(
        state.list,
        'p',
        '등록된 점검 기록이 없습니다.'
      );
    }

    for (const row of data.rows) {
      const card = document.createElement('article');
      card.className = 'inspection-card';

      text(
        card,
        'h4',
        (types[row.record_type] || row.record_type) +
        ' · ' +
        (results[row.result_code] || row.result_code)
      );

      text(
        card,
        'p',
        '점검일시: ' +
        displayTime(row.inspected_at) +
        ' / 작성자: ' +
        row.author_name
      );

      if (row.symptoms) {
        text(
          card,
          'p',
          '확인 증상: ' + row.symptoms
        );
      }

      if (row.fault_code) {
        text(
          card,
          'p',
          '확인 오류코드: ' + row.fault_code
        );
      }

      text(card, 'p', row.details);

      text(
        card,
        'small',
        '기록 #' +
        row.id +
        ' · 시스템 저장: ' +
        displayTime(row.recorded_at) +
        ' · 로그인 계정: ' +
        row.recorded_by
      );

      for (const file of row.attachments || []) {
        const line = document.createElement('p');

        text(
          line,
          'span',
          file.original_name +
          ' (' +
          (file.file_size / 1024 / 1024).toFixed(2) +
          'MB) '
        );

        const actions = [
          ['view', '보기'],
          ['download', '다운로드']
        ];

        for (const [action, label] of actions) {
          const link = text(line, 'a', label);

          link.href =
            '/api/admin/inspection-files/' +
            encodeURIComponent(file.id) +
            '/' +
            action;

          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.className = 'inspection-file-link';
        }

        card.append(line);
      }

      state.list.append(card);
    }

    state.pageLabel.textContent =
      data.page + ' 페이지';

    lock(state, state.busy);
  }

  function build(id) {
    document
      .getElementById('inspection-section')
      ?.remove();

    if (!document.getElementById('inspection-style')) {
      const style = document.createElement('style');

      style.id = 'inspection-style';

      style.textContent = `
        #inspection-section {
          margin: 28px 0;
          padding-top: 16px;
          border-top: 1px solid #d9e2ec;
        }

        #inspection-section .inspection-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
        }

        #inspection-section label {
          display: block;
          margin: 12px 0;
        }

        #inspection-section input,
        #inspection-section select,
        #inspection-section textarea {
          box-sizing: border-box;
          width: 100%;
          max-width: 100%;
          padding: 10px;
          margin-top: 6px;
        }

        #inspection-section textarea {
          min-height: 100px;
        }

        #inspection-section .inspection-card {
          padding: 16px;
          margin: 12px 0;
          border: 1px solid #d9e2ec;
          border-radius: 8px;
          background: #f7fafc;
        }

        #inspection-section .inspection-card p {
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        #inspection-section .inspection-file-link {
          display: inline-block;
          margin: 4px 8px;
        }

        #inspection-section [role="status"] {
          white-space: pre-wrap;
          color: #a13900;
        }

        #inspection-section button {
          margin: 6px 8px 6px 0;
        }

        @media (max-width: 600px) {
          #inspection-section .inspection-grid {
            grid-template-columns: 1fr;
            gap: 0;
          }
        }
      `;

      document.head.append(style);
    }

    const section = document.createElement('section');
    section.id = 'inspection-section';

    // 고정 서식만 HTML로 작성합니다.
    // 저장된 내용은 textContent로 출력합니다.
    section.innerHTML = `
      <h3>점검 기록</h3>

      <p>
        최신 점검일시 순으로 표시합니다.
        기존 기록은 수정·삭제하지 않으며,
        정정 사항은 새 기록으로 남겨 주세요.
      </p>

      <p>
        점검 결과를 ‘정상 동작 확인’으로 선택해도
        A/S는 자동 완료되지 않습니다.
      </p>

      <p role="status" aria-live="polite"></p>

      <button type="button" data-role="refresh">
        기록 목록 새로고침
      </button>

      <div data-role="list"></div>

      <div>
        <button type="button" data-role="previous">
          이전
        </button>

        <span data-role="page"></span>

        <button type="button" data-role="next">
          다음
        </button>
      </div>

      <h3>점검 기록 추가</h3>

      <form>
        <div class="inspection-grid">
          <label>
            기록 구분 *
            <select name="record_type" required></select>
          </label>

          <label>
            점검 결과 *
            <select name="result_code" required></select>
          </label>

          <label>
            점검일시 (한국 시간) *
            <input
              name="inspected_at"
              type="datetime-local"
              required
            >
          </label>

          <label>
            작성자 *
            <input
              name="author_name"
              maxlength="100"
              required
              autocomplete="off"
            >
          </label>
        </div>

        <label>
          확인 증상
          <textarea
            name="symptoms"
            maxlength="10000"
          ></textarea>
        </label>

        <label>
          확인 오류코드
          <input name="fault_code" maxlength="100">
        </label>

        <label>
          점검·조치 내용 *
          <textarea
            name="details"
            maxlength="10000"
            required
          ></textarea>
        </label>

        <label>
          사진·자료 (선택)
          <input
            name="attachments"
            type="file"
            multiple
            accept=".jpg,.jpeg,.png,.webp,.pdf"
          >
        </label>

        <p>
          JPG·PNG·WebP·PDF, 최대 5개, 파일당 10MB.
          시스템 저장 시각과 로그인 계정은 자동 기록됩니다.
        </p>

        <button type="submit">
          점검 기록 저장
        </button>

        <button type="button" data-role="reset">
          입력 초기화 / 새 기록
        </button>
      </form>
    `;

    const anchor =
      document.getElementById('attachment-section') ||
      document.getElementById('detail-fields');

    if (!anchor) {
      throw new Error(
        '관리자 상세 화면의 detail-fields 항목을 찾을 수 없습니다.'
      );
    }

    anchor.after(section);

    const role = name =>
      section.querySelector(
        '[data-role="' + name + '"]'
      );

    const form = section.querySelector('form');

    const state = {
      id,
      section,
      form,
      key: entryKey(id),
      page: 1,
      hasNext: false,
      busy: false,

      list: role('list'),
      previous: role('previous'),
      next: role('next'),
      refresh: role('refresh'),
      pageLabel: role('page'),

      message: section.querySelector('[role="status"]')
    };

    const selections = [
      ['record_type', types],
      ['result_code', results]
    ];

    for (const [name, choices] of selections) {
      for (const [value, label] of Object.entries(choices)) {
        const option = text(
          form.elements[name],
          'option',
          label
        );

        option.value = value;
      }
    }

    form.elements.inspected_at.value = currentTime();

    const refresh = async page => {
      lock(state, true);

      try {
        await list(state, page);
        state.message.textContent = '';
      } catch (error) {
        state.message.textContent = error.message;
      } finally {
        lock(state, false);
      }
    };

    state.refresh.onclick = () => refresh(1);

    state.previous.onclick = () =>
      refresh(state.page - 1);

    state.next.onclick = () =>
      refresh(state.page + 1);

    role('reset').onclick = () => {
      const accepted = confirm(
        '입력 내용을 비우고 새 기록을 작성할까요? ' +
        '저장 결과가 불확실하면 먼저 목록을 확인하세요.'
      );

      if (!accepted) return;

      form.reset();

      form.elements.inspected_at.value = currentTime();

      newKey(state);
      state.message.textContent = '';
    };

    form.addEventListener('submit', async event => {
      event.preventDefault();
      event.stopPropagation();

      if (state.busy || !form.reportValidity()) {
        return;
      }

      const files = [
        ...form.elements.attachments.files
      ];

      if (
        files.length > 5 ||
        files.some(
          file =>
            file.size > 10 * 1024 * 1024 ||
            !file.size
        )
      ) {
        state.message.textContent =
          '첨부는 최대 5개, 파일당 10MB 이하의 ' +
          '빈 파일이 아닌 자료를 선택하세요.';

        return;
      }

      const body = new FormData();

      const names = [
        'record_type',
        'result_code',
        'inspected_at',
        'author_name',
        'symptoms',
        'fault_code',
        'details'
      ];

      for (const name of names) {
        body.set(name, form.elements[name].value);
      }

      body.set('entry_key', state.key);

      for (const file of files) {
        body.append('attachments', file);
      }

      lock(state, true);

      state.message.textContent = '저장 중입니다.';

      let saved = false;

      try {
        const session = await request('/session');

        const result = await request(
          '/requests/' + state.id + '/inspections',
          {
            method: 'POST',

            headers: {
              'X-CSRF-Token': session.csrf
            },

            body
          }
        );

        saved = true;

        form.reset();

        form.elements.inspected_at.value = currentTime();

        newKey(state);

        state.message.textContent =
            '점검 기록 저장이 완료되었습니다. ' +
            '검토결과 저장을 별도로 누를 필요가 없습니다. ' +
            'A/S 상태는 유지됩니다.';

        await list(state, 1);
      } catch (error) {
        state.message.textContent = saved
          ? '기록은 저장되었습니다. 목록 새로고침을 다시 눌러 주세요.'
          : error.message +
            ' 입력 내용은 유지됩니다. ' +
            '결과가 불확실하면 목록부터 확인하세요.';
      } finally {
        lock(state, false);
      }
    });

    return state;
  }

  window.loadInspections = async (requestId, status) => {
    // 정식 접수 이후에만 점검 기록 화면을 표시합니다.
    const allowedStatuses = [
      'received',
      'in_progress',
      'completed'
    ];

    if (!allowedStatuses.includes(status)) {
      document
        .getElementById('inspection-section')
        ?.remove();

      active = null;
      return;
    }

    const id = String(requestId);

    if (!/^[1-9]\d{0,19}$/.test(id)) return;

    try {
      if (
        !active ||
        active.id !== id ||
        !active.section.isConnected
      ) {
        active = build(id);
      }

      const state = active;

      let completedNotice = state.section.querySelector(
        '[data-role="completed-notice"]'
      );

      if (status === 'completed') {
        if (!completedNotice) {
          completedNotice = document.createElement('p');

          completedNotice.dataset.role = 'completed-notice';

          completedNotice.style.cssText =
            'padding:12px 16px;' +
            'background:#eef6fc;' +
            'border-left:4px solid #1769aa;' +
            'border-radius:6px;' +
            'line-height:1.7;';

          state.form.before(completedNotice);
        }

        completedNotice.textContent =
          '완료 후 추가 기록입니다. ' +
          '고객 확인·경과 관찰·자료 보완·정정 내용을 남겨 주세요. ' +
          '추가 기록을 저장해도 기존 완료일·처리내용·완료자와 ' +
          'A/S 완료 상태는 변경되지 않습니다.';
      } else {
        completedNotice?.remove();
      }

      if (state.busy) return;

      lock(state, true);

      try {
        await list(state, 1);
      } finally {
        lock(state, false);
      }
    } catch (error) {
      if (active?.id === id) {
        active.message.textContent =
          '점검 기록 조회 실패: ' + error.message;
      } else {
        console.error(
          '점검 기록 화면:',
          error.message
        );
      }
    }
  };
})();