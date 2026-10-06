'use strict';
/** 课次服务：创建（讲师排期重叠校验 + 资源校验）与撤课（释放全部预约）。 */
const { BookingError } = require('./booking');
const { instructorConflicts } = require('./capacity');

function createSession(db, { course_id, instructor_id, shop_id, start_utc, end_utc, demo_ws = 1, demo_machines = 1 }) {
  return db.transaction(() => {
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(course_id);
    if (!course) throw new BookingError('not_found', '课程不存在', 404);
    if (course.status !== 'open') throw new BookingError('course_closed', '课程已关闭，不能排课', 410);
    const instructor = db.prepare('SELECT * FROM instructors WHERE id = ?').get(instructor_id);
    if (!instructor) throw new BookingError('not_found', '讲师不存在', 404);
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(shop_id);
    if (!shop) throw new BookingError('not_found', '门店不存在', 404);
    if (!(Date.parse(start_utc) < Date.parse(end_utc))) {
      throw new BookingError('bad_time', '结束时间必须晚于开始时间', 422);
    }
    // 讲师排期重叠：同一讲师同一时间窗只能带一门课
    const conflicts = instructorConflicts(db, { id: -1, instructor_id, start_utc, end_utc });
    if (conflicts.length) {
      throw new BookingError(
        'instructor_overlap',
        `讲师排期重叠：${instructor.name} 在该时段已有课次 #${conflicts[0].id}《${conflicts[0].course_title}》`,
        409,
        { conflicts: conflicts.map((c) => ({ session_id: c.id, course_title: c.course_title, start_utc: c.start_utc, end_utc: c.end_utc })) }
      );
    }
    // 资源校验：演示占用不能超过门店资源池
    const wsTotal = db.prepare('SELECT COUNT(*) AS c FROM workstations WHERE shop_id = ?').get(shop_id).c;
    const machTotal = db.prepare('SELECT COUNT(*) AS c FROM machines WHERE shop_id = ?').get(shop_id).c;
    if (demo_ws > wsTotal) throw new BookingError('resource_insufficient', `工位不足：门店共 ${wsTotal} 个工位，演示需求 ${demo_ws}`, 422);
    if (demo_machines > machTotal) throw new BookingError('resource_insufficient', `机器不足：门店共 ${machTotal} 台机器，演示需求 ${demo_machines}`, 422);
    const info = db.prepare(
      `INSERT INTO sessions (course_id, instructor_id, shop_id, start_utc, end_utc, demo_ws, demo_machines)
       VALUES (?,?,?,?,?,?,?)`
    ).run(course_id, instructor_id, shop_id, start_utc, end_utc, demo_ws, demo_machines);
    return { id: Number(info.lastInsertRowid) };
  })();
}

/** 后台撤课：课次取消，所有活跃预约（占位/已确认/候补）一并释放 */
function cancelSession(db, sessionId, { now }) {
  return db.transaction(() => {
    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!s) throw new BookingError('not_found', '课次不存在', 404);
    if (s.status === 'cancelled') return { cancelled: true, already: true, bookings_released: 0 };
    db.prepare(`UPDATE sessions SET status = 'cancelled' WHERE id = ?`).run(sessionId);
    const affected = db.prepare(
      `UPDATE bookings SET state = 'cancelled', hold_expires_at = NULL, updated_at = ?
       WHERE session_id = ? AND state IN ('held','confirmed','waitlisted')`
    ).run(now, sessionId);
    return { cancelled: true, bookings_released: affected.changes };
  })();
}

module.exports = { createSession, cancelSession };
