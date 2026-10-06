'use strict';
/**
 * 预约服务：候补、临时占位、取消释放。
 * 所有「检查 + 写入」都在同一事务内完成（better-sqlite3 事务串行化），
 * 保证最后一个工位被并发预订时只有一人成功。
 */
const { capacityReport, activeOccupancy } = require('./capacity');

class BookingError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const getSessionOrThrow = (db, sessionId) => {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!s) throw new BookingError('not_found', '课次不存在', 404);
  return s;
};

/** 过期占位清扫：held 且已过 hold_expires_at → expired，释放出的名额晋升候补 */
function sweepExpired(db, now, holdTtlSeconds) {
  const expired = db.prepare(
    `UPDATE bookings SET state = 'expired', updated_at = ?
     WHERE state = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?
     RETURNING session_id`
  ).all(now, now);
  const sessionIds = [...new Set(expired.map((r) => r.session_id))];
  for (const sid of sessionIds) promoteWaitlist(db, sid, now, holdTtlSeconds);
  return sessionIds;
}

/** 候补晋升：有空位时把最早候补转为临时占位（等待学员在占位窗口内确认） */
function promoteWaitlist(db, sessionId, now, holdTtlSeconds) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session || session.status !== 'scheduled') return [];
  const cap = capacityReport(db, sessionId).capacity;
  const promoted = [];
  let occ = activeOccupancy(db, sessionId).active;
  while (occ < cap) {
    const next = db.prepare(
      `SELECT * FROM bookings WHERE session_id = ? AND state = 'waitlisted'
       ORDER BY created_at ASC, id ASC LIMIT 1`
    ).get(sessionId);
    if (!next) break;
    const exp = new Date(Date.parse(now) + holdTtlSeconds * 1000).toISOString();
    db.prepare(
      `UPDATE bookings SET state = 'held', hold_expires_at = ?, updated_at = ?
       WHERE id = ? AND state = 'waitlisted'`
    ).run(exp, now, next.id);
    promoted.push(next.id);
    occ += 1;
  }
  return promoted;
}

/** 临时占位：有容量 → held（占用容量，有过期时间）；无容量 → waitlisted（候补） */
function createHold(db, sessionId, studentName, { now, holdTtlSeconds }) {
  return db.transaction(() => {
    sweepExpired(db, now, holdTtlSeconds);
    const s = getSessionOrThrow(db, sessionId);
    if (s.status !== 'scheduled') throw new BookingError('session_cancelled', '课程已撤课，无法预约', 410);
    const c = db.prepare('SELECT * FROM courses WHERE id = ?').get(s.course_id);
    if (!c || c.status !== 'open') throw new BookingError('course_closed', '课程已关闭', 410);
    const cap = capacityReport(db, sessionId).capacity;
    const occ = activeOccupancy(db, sessionId).active;
    const state = occ < cap ? 'held' : 'waitlisted';
    const exp = state === 'held' ? new Date(Date.parse(now) + holdTtlSeconds * 1000).toISOString() : null;
    const info = db.prepare(
      `INSERT INTO bookings (session_id, student_name, state, hold_expires_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`
    ).run(sessionId, studentName, state, exp, now, now);
    return { id: Number(info.lastInsertRowid), state, hold_expires_at: exp, capacity: cap, occupancy: occ };
  })();
}

/**
 * 确认预约：在事务内重新校验课次状态（撤课时学员正在确认 → 确认失败并释放占位），
 * 成功则绑定「当时课程内容 + 当时门店地址」快照。
 */
function confirmBooking(db, bookingId, { now, holdTtlSeconds }) {
  return db.transaction(() => {
    sweepExpired(db, now, holdTtlSeconds);
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!b) throw new BookingError('not_found', '预约不存在', 404);
    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(b.session_id);
    if (!s || s.status !== 'scheduled') {
      if (b.state === 'held') {
        db.prepare(`UPDATE bookings SET state = 'cancelled', hold_expires_at = NULL, updated_at = ? WHERE id = ?`).run(now, bookingId);
      }
      throw new BookingError('session_cancelled', '课程已撤课，本次占位已释放', 410);
    }
    const c = db.prepare('SELECT * FROM courses WHERE id = ?').get(s.course_id);
    if (!c || c.status !== 'open') throw new BookingError('course_closed', '课程已关闭', 410);
    if (b.state === 'confirmed') return { id: b.id, state: 'confirmed', already: true };
    if (b.state !== 'held') throw new BookingError('bad_state', `当前状态 ${b.state} 不能确认`, 409);
    // 防御性容量复核：动态容量可能因重叠课次占满而缩小
    const cap = capacityReport(db, b.session_id).capacity;
    const occ = activeOccupancy(db, b.session_id).active;
    if (occ > cap) {
      db.prepare(`UPDATE bookings SET state = 'waitlisted', hold_expires_at = NULL, updated_at = ? WHERE id = ?`).run(now, bookingId);
      throw new BookingError('capacity_full', '容量已被占满，已转入候补', 409, { state: 'waitlisted' });
    }
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(s.shop_id);
    db.prepare(
      `UPDATE bookings SET state = 'confirmed', hold_expires_at = NULL,
         course_title_snapshot = ?, course_content_snapshot = ?, course_content_version_snapshot = ?,
         shop_name_snapshot = ?, shop_address_snapshot = ?, shop_address_version_snapshot = ?, shop_timezone_snapshot = ?,
         reconfirm_required = 0, updated_at = ?
       WHERE id = ?`
    ).run(c.title, c.content, c.content_version, shop.name, shop.address, shop.address_version, shop.timezone, now, bookingId);
    return { id: bookingId, state: 'confirmed' };
  })();
}

/** 取消释放：取消后立刻把释放出的名额晋升给候补 */
function cancelBooking(db, bookingId, { now, holdTtlSeconds }) {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!b) throw new BookingError('not_found', '预约不存在', 404);
    if (b.state === 'cancelled' || b.state === 'expired') return { id: b.id, state: b.state, already: true };
    db.prepare(`UPDATE bookings SET state = 'cancelled', hold_expires_at = NULL, updated_at = ? WHERE id = ?`).run(now, bookingId);
    const promoted = promoteWaitlist(db, b.session_id, now, holdTtlSeconds);
    return { id: bookingId, state: 'cancelled', promoted };
  })();
}

/** 改址后学员再确认：把地址快照更新为当前地址并清除待确认标记 */
function reconfirmBooking(db, bookingId, { now }) {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!b) throw new BookingError('not_found', '预约不存在', 404);
    if (b.state !== 'confirmed') throw new BookingError('bad_state', '仅已确认的预约需要改址再确认', 409);
    if (!b.reconfirm_required) return { id: b.id, reconfirm_required: 0, already: true };
    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(b.session_id);
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(s.shop_id);
    db.prepare(
      `UPDATE bookings SET shop_address_snapshot = ?, shop_address_version_snapshot = ?, shop_name_snapshot = ?,
         shop_timezone_snapshot = ?, reconfirm_required = 0, updated_at = ?
       WHERE id = ?`
    ).run(shop.address, shop.address_version, shop.name, shop.timezone, now, bookingId);
    return { id: bookingId, reconfirm_required: 0 };
  })();
}

module.exports = { BookingError, createHold, confirmBooking, cancelBooking, reconfirmBooking, sweepExpired, promoteWaitlist };
