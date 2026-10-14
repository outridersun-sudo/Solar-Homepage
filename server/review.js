const { notifyAsRequest } = require('./notification');

module.exports = function registerReview(app, pool) {
  const transitions = {
    pending: ['received', 'rejected'],
    rejected: ['pending'],
    received: ['in_progress', 'completed'],
    in_progress: ['completed'],
    completed: []
  };

  function serialize(row) {
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === 'bigint' ? String(value) : value
      ])
    );
  }

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function koreaTime() {
    return new Date(Date.now() + 9 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
  }

  // 상세 정보와 이력 조회
  app.get('/api/admin/requests/:id', async (req, res, next) => {
    try {
      if (!/^\d{1,20}$/.test(req.params.id)) {
        return res.status(400).json({
          message: '신청 ID를 확인하세요.'
        });
      }

      const rows = await pool.query(
        'SELECT * FROM as_requests WHERE id = ?',
        [req.params.id]
      );

      if (!rows.length) {
        return res.status(404).json({
          message: '신청을 찾을 수 없습니다.'
        });
      }

      const history = await pool.query(
        `SELECT
           from_status, to_status, reason, actor,
           performed_by, effective_at, created_at
         FROM as_request_history
         WHERE request_id = ?
         ORDER BY id`,
        [req.params.id]
      );

      res.json({
        ...serialize(rows[0]),
        history: history.map(serialize)
      });
    } catch (err) {
      next(err);
    }
  });

  // 정식 접수·신청 불가·완료 처리
  app.patch(
    '/api/admin/requests/:id/status',
    async (req, res, next) => {
      const id = req.params.id;
      const target = req.body?.status;
      const operator = text(req.body?.operator_name);
      const reason = text(req.body?.reason);
      const details = text(req.body?.completion_details);

      let completedAt = null;

      if (
        !/^\d{1,20}$/.test(id) ||
        typeof target !== 'string' ||
        !Object.hasOwn(transitions, target) ||
        !operator ||
        operator.length > 100
      ) {
        return res.status(400).json({
          message: '처리 선택과 담당자 이름(1~100자)을 확인하세요.'
        });
      }

      if (target === 'completed') {
        const value = req.body?.completed_at;

        if (
          !details ||
          details.length > 10000 ||
          typeof value !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)
        ) {
          return res.status(400).json({
            message: '완료일시와 처리내용(1~10000자)을 입력하세요.'
          });
        }

        // 입력한 완료일시는 한국 시간으로 해석
        const instant = new Date(value + ':00+09:00');

        if (
          !Number.isFinite(instant.getTime()) ||
          new Date(instant.getTime() + 9 * 60 * 60 * 1000)
            .toISOString().slice(0, 16) !== value ||
          Number(value.slice(0, 4)) < 1000 ||
          instant.getTime() > Date.now()
        ) {
          return res.status(400).json({
            message:
              '완료일시는 유효한 한국 시간이어야 하며 ' +
              '현재 이후일 수 없습니다.'
          });
        }

        completedAt = value.replace('T', ' ') + ':00';
      } else if (!reason || reason.length > 1000) {
        return res.status(400).json({
          message: '변경 사유(1~1000자)를 입력하세요.'
        });
      }

      let conn;
      let approval = null;
      let result;

      try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const rows = await conn.query(
          'SELECT * FROM as_requests WHERE id = ? FOR UPDATE',
          [id]
        );

        if (!rows.length) {
          await conn.rollback();

          return res.status(404).json({
            message: '신청을 찾을 수 없습니다.'
          });
        }

        const row = rows[0];

        if (!(transitions[row.status] || []).includes(target)) {
          await conn.rollback();

          return res.status(409).json({
            message:
              '현재 상태에서 변경할 수 없습니다. ' +
              '상세 화면을 다시 확인하세요.'
          });
        }

        const now = koreaTime();
        let requestNumber = row.request_number;

        if (target === 'received') {
          const date = now.slice(0, 10);

          await conn.query(
            `INSERT INTO as_request_sequences (
               request_date, last_number
             ) VALUES (?, 0)
             ON DUPLICATE KEY UPDATE
               last_number = last_number`,
            [date]
          );

          const sequence = await conn.query(
            `SELECT last_number
             FROM as_request_sequences
             WHERE request_date = ?
             FOR UPDATE`,
            [date]
          );

          const number = Number(sequence[0].last_number) + 1;

          if (number > 9999) {
            await conn.rollback();

            return res.status(503).json({
              message: '당일 접수번호 한도를 초과했습니다.'
            });
          }

          await conn.query(
            `UPDATE as_request_sequences
             SET last_number = ?
             WHERE request_date = ?`,
            [number, date]
          );

          const yymmdd = date.slice(2).replaceAll('-', '');

          requestNumber =
            `AS-${yymmdd}-${String(number).padStart(4, '0')}`;

          await conn.query(
            `UPDATE as_requests
             SET status = ?,
                 request_number = ?,
                 accepted_at = ?,
                 acceptance_reason = ?,
                 accepted_by = ?
             WHERE id = ?`,
            [
              target,
              requestNumber,
              now,
              reason,
              operator,
              id
            ]
          );

          approval = {
            requestNumber,
            productType: row.product_type,
            modelName: row.model_name
          };
        } else if (target === 'completed') {
          await conn.query(
            `UPDATE as_requests
             SET status = ?,
                 completed_at = ?,
                 completion_details = ?,
                 completed_by = ?,
                 completion_recorded_at = ?
             WHERE id = ?`,
            [
              target,
              completedAt,
              details,
              operator,
              now,
              id
            ]
          );
        } else {
          await conn.query(
            'UPDATE as_requests SET status = ? WHERE id = ?',
            [target, id]
          );
        }

        // 계정과 직접 입력한 담당자 이름을 구분해 기록
        await conn.query(
          `INSERT INTO as_request_history (
             request_id,
             from_status,
             to_status,
             reason,
             actor,
             performed_by,
             effective_at,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            row.status,
            target,
            target === 'completed' ? details : reason,
            req.adminSession.username,
            operator,
            completedAt || now,
            now
          ]
        );

        await conn.commit();

        result = {
          ok: true,
          request_number: requestNumber,
          message: '담당자 정보와 변경 이력을 저장했습니다.'
        };
      } catch (err) {
        if (conn) {
          try {
            await conn.rollback();
          } catch (rollbackError) {
            console.error('롤백 실패:', rollbackError.code);
          }
        }

        return next(err);
      } finally {
        if (conn) conn.release();
      }

      // 정식 접수 저장 후 알림
      if (approval) {
        try {
          await notifyAsRequest(approval);

          result.message +=
            ' 개발용 알림을 출력했습니다(실제 문자 미발송).';
        } catch (err) {
          console.error(
            '승인 후 알림 실패:',
            approval.requestNumber,
            err.code || err.name
          );

          result.message +=
            ' 알림 처리에는 실패했습니다. 정식 접수는 유지됩니다.';
        }
      }

      res.json(result);
    }
  );
};