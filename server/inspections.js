const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const uploads = require('./attachments');

const recordTypes = new Set([
  'consultation',
  'remote',
  'onsite',
  'repair',
  'reinspection',
  'other'
]);

const resultCodes = new Set([
  'undetermined',
  'needs_inspection',
  'needs_action',
  'observing',
  'normal'
]);

const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

const validId = value =>
  /^[1-9]\d{0,19}$/.test(String(value));

const kstNow = () =>
  new Date(Date.now() + 9 * 3600000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function fields(body) {
  const value = (name, max, required = true) => {
    if (typeof body[name] !== 'string') {
      if (!required && body[name] === undefined) return '';

      fail(400, '입력 항목을 확인하세요: ' + name);
    }

    const text = body[name].trim();

    if ((required && !text) || text.length > max) {
      fail(400, '입력 길이를 확인하세요: ' + name);
    }

    return text;
  };

  const data = {
    record_type: value('record_type', 30),
    result_code: value('result_code', 30),
    inspected_at: value('inspected_at', 16),
    author_name: value('author_name', 100),
    symptoms: value('symptoms', 10000, false),
    fault_code: value('fault_code', 100, false),
    details: value('details', 10000)
  };

  if (
    !recordTypes.has(data.record_type) ||
    !resultCodes.has(data.result_code)
  ) {
    fail(400, '기록 구분과 점검 결과를 확인하세요.');
  }

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(data.inspected_at)) {
    fail(400, '점검일시를 확인하세요.');
  }

  const stamp = Date.parse(data.inspected_at + ':00+09:00');

  if (
    !Number.isFinite(stamp) ||
    Number(data.inspected_at.slice(0, 4)) < 1000 ||
    new Date(stamp + 9 * 3600000)
      .toISOString()
      .slice(0, 16) !== data.inspected_at ||
    stamp > Date.now()
  ) {
    fail(
      400,
      '점검일시는 유효한 과거 또는 현재 시각이어야 합니다. (한국 시간)'
    );
  }

  const key = value('entry_key', 36);

  if (!uuid.test(key)) {
    fail(
      400,
      '저장 식별값이 올바르지 않습니다. 화면을 다시 열어 주세요.'
    );
  }

  return {
    data,
    key: key.toLowerCase()
  };
}

async function fileHash(file) {
  const hash = crypto.createHash('sha256');

  for await (const chunk of fs.createReadStream(file.path)) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

module.exports = function registerInspections(app, pool) {
  // 반드시 기존 관리자 인증·CSRF 미들웨어 뒤에서 등록합니다.

  // 점검 기록 목록 조회
  app.get(
    '/api/admin/requests/:id/inspections',
    async (req, res, next) => {
      try {
        if (!validId(req.params.id)) {
          fail(400, '신청 ID를 확인하세요.');
        }

        const page = Number(req.query.page || 1);

        if (
          !Number.isSafeInteger(page) ||
          page < 1 ||
          page > 1000000
        ) {
          fail(400, '페이지를 확인하세요.');
        }

        const parent = await pool.query(
            'SELECT id, status FROM as_requests WHERE id = ?',
            [req.params.id]
        );

        if (!parent.length) {
            fail(404, '신청 내역을 찾을 수 없습니다.');
        }

        if (
            !['received', 'in_progress', 'completed'].includes(
                parent[0].status
            )
        ) {
            fail(
                409,
                '점검 기록은 정식 접수 이후에만 이용할 수 있습니다.'
            );
        }

        const rows = await pool.query(
          `SELECT
             id,
             request_id,
             record_type,
             result_code,
             DATE_FORMAT(
               inspected_at,
               '%Y-%m-%dT%H:%i:%s'
             ) AS inspected_at,
             author_name,
             symptoms,
             fault_code,
             details,
             recorded_by,
             DATE_FORMAT(
               recorded_at,
               '%Y-%m-%dT%H:%i:%s'
             ) AS recorded_at
           FROM as_inspections
           WHERE request_id = ?
           ORDER BY inspected_at DESC, id DESC
           LIMIT 21 OFFSET ?`,
          [
            req.params.id,
            (page - 1) * 20
          ]
        );

        const hasNext = rows.length > 20;

        rows.splice(20);

        const files = rows.length
          ? await pool.query(
              `SELECT
                 id,
                 inspection_id,
                 original_name,
                 mime_type,
                 file_size
               FROM as_inspection_attachments
               WHERE inspection_id IN (
                 ${rows.map(() => '?').join(',')}
               )
               ORDER BY id`,
              rows.map(row => String(row.id))
            )
          : [];

        res.set('Cache-Control', 'no-store').json({
          page,
          hasNext,
          rows: rows.map(row => ({
            ...row,

            id: String(row.id),
            request_id: String(row.request_id),

            inspected_at: row.inspected_at + '+09:00',
            recorded_at: row.recorded_at + '+09:00',

            attachments: files
              .filter(
                file =>
                  String(file.inspection_id) === String(row.id)
              )
              .map(file => ({
                id: String(file.id),
                original_name: file.original_name,
                mime_type: file.mime_type,
                file_size: Number(file.file_size)
              }))
          }))
        });
      } catch (error) {
        if (error.status) {
          return res.status(error.status).json({
            message: error.message
          });
        }

        next(error);
      }
    }
  );

  // 점검 기록 추가
  // 기존 신청 내용과 A/S 진행 상태는 변경하지 않습니다.
  app.post(
    '/api/admin/requests/:id/inspections',
    uploads.receive,
    async (req, res) => {
      let connection;
      let transaction = false;

      try {
        if (!validId(req.params.id)) {
          fail(400, '신청 ID를 확인하세요.');
        }

        const { data, key } = fields(req.body || {});

        const digests = await Promise.all(
          (req.files || []).map(fileHash)
        );

        const hash = crypto
          .createHash('sha256')
          .update(
            JSON.stringify([
              data,
              digests.sort()
            ])
          )
          .digest('hex');

        connection = await pool.getConnection();

        await connection.beginTransaction();
        transaction = true;

        // 동일 신청에 대한 동시 저장을 순서대로 처리합니다.
        const parent = await connection.query(
            'SELECT id, status FROM as_requests WHERE id = ? FOR UPDATE',
            [req.params.id]
        );

        if (!parent.length) {
            fail(404, '신청 내역을 찾을 수 없습니다.');
        }

        if (
            !['received', 'in_progress', 'completed'].includes(
                parent[0].status
            )
        ) {
            fail(
                409,
                '점검 기록은 정식 접수 이후에만 이용할 수 있습니다.'
            );
        }

        const existing = await connection.query(
          `SELECT id, request_id, payload_hash
           FROM as_inspections
           WHERE entry_key = ?`,
          [key]
        );

        // 응답 유실 등으로 같은 저장 요청이 재전송된 경우
        if (existing.length) {
          const row = existing[0];

          if (
            String(row.request_id) !== req.params.id ||
            row.payload_hash !== hash
          ) {
            fail(
              409,
              '같은 저장 식별값으로 다른 내용이 제출되었습니다. ' +
              '기록 목록을 확인하고 새 기록을 작성하세요.'
            );
          }

          await connection.commit();
          transaction = false;

          await uploads.cleanup(req);

          return res.json({
            id: String(row.id),
            duplicate: true,
            message: '이미 저장된 점검 기록입니다.'
          });
        }

        const now = kstNow();

        const inserted = await connection.query(
          `INSERT INTO as_inspections (
             request_id,
             entry_key,
             payload_hash,
             record_type,
             result_code,
             inspected_at,
             author_name,
             symptoms,
             fault_code,
             details,
             recorded_by,
             recorded_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.params.id,
            key,
            hash,
            data.record_type,
            data.result_code,
            data.inspected_at.replace('T', ' ') + ':00',
            data.author_name,
            data.symptoms,
            data.fault_code,
            data.details,
            req.adminSession.username,
            now
          ]
        );

        for (const file of req.files || []) {
          await connection.query(
            `INSERT INTO as_inspection_attachments (
               inspection_id,
               original_name,
               stored_name,
               mime_type,
               file_size,
               created_at
             )
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              String(inserted.insertId),
              file.originalName,
              file.storedName,
              file.mimeType,
              file.size,
              now
            ]
          );
        }

        // COMMIT 응답이 유실되어도 저장된 첨부를 삭제하지 않도록
        // 먼저 파일 보존을 표시합니다.
        req.keepUploadFiles = true;

        await connection.commit();
        transaction = false;

        res.status(201).json({
          id: String(inserted.insertId),
          duplicate: false,
          message: '점검 기록을 저장했습니다.'
        });
      } catch (error) {
        if (transaction) {
          try {
            await connection.rollback();
          } catch (rollbackError) {
            console.error(
              '점검 기록 롤백 오류:',
              rollbackError.code
            );
          }
        }

        if (!error.status) {
          console.error(
            '점검 기록 저장 오류:',
            error.code || error.name
          );
        }

        try {
          await uploads.cleanup(req);
        } catch (cleanupError) {
          console.error(
            '점검 첨부 정리 오류:',
            cleanupError.code
          );
        }

        const status =
          error.status ||
          (error.code === 'ER_DUP_ENTRY' ? 409 : 500);

        res.status(status).json({
          message: error.status
            ? error.message
            : '저장 결과를 확인하지 못했습니다. ' +
              '목록을 확인한 뒤 같은 내용으로 다시 시도하세요.'
        });
      } finally {
        if (connection) {
          connection.release();
        }

        try {
          await uploads.cleanup(req);
        } catch (error) {
          console.error(
            '점검 첨부 정리 오류:',
            error.code
          );
        }
      }
    }
  );

  // 관리자 전용 첨부 보기·다운로드
  app.get(
    '/api/admin/inspection-files/:id/:action',
    async (req, res, next) => {
      try {
        if (
          !validId(req.params.id) ||
          !['view', 'download'].includes(req.params.action)
        ) {
          fail(400, '첨부 요청을 확인하세요.');
        }

        const rows = await pool.query(
          `SELECT stored_name, original_name, mime_type
           FROM as_inspection_attachments
           WHERE id = ?`,
          [req.params.id]
        );

        if (!rows.length) {
          fail(404, '첨부파일을 찾을 수 없습니다.');
        }

        const file = rows[0];

        if (
          !/^[a-f0-9-]{36}\.(jpg|png|webp|pdf)$/.test(
            file.stored_name
          ) ||
          ![
            'image/jpeg',
            'image/png',
            'image/webp',
            'application/pdf'
          ].includes(file.mime_type)
        ) {
          fail(500, '첨부 저장 정보를 확인하세요.');
        }

        const name = encodeURIComponent(
          file.original_name
        ).replace(
          /['()*]/g,
          char =>
            '%' +
            char.charCodeAt(0).toString(16).toUpperCase()
        );

        const disposition =
          req.params.action === 'view'
            ? 'inline'
            : 'attachment';

        res.set({
          'Content-Type': file.mime_type,

          'Content-Disposition':
            `${disposition}; filename="attachment"; ` +
            `filename*=UTF-8''${name}`,

          'X-Content-Type-Options': 'nosniff',

          'Content-Security-Policy':
            "sandbox; default-src 'none'",

          'Cache-Control': 'no-store'
        });

        const filePath = path.join(
          __dirname,
          '..',
          'uploads',
          'files',
          file.stored_name
        );

        res.sendFile(filePath, error => {
          if (!error) return;

          if (res.headersSent) {
            return next(error);
          }

          res.removeHeader('Content-Disposition');

          res.status(
            error.code === 'ENOENT' ? 404 : 500
          ).json({
            message: '첨부파일을 열 수 없습니다.'
          });
        });
      } catch (error) {
        if (error.status) {
          return res.status(error.status).json({
            message: error.message
          });
        }

        next(error);
      }
    }
  );
};