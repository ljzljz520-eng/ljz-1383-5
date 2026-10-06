'use strict';
const db = require('./db');

const HOLD_MINUTES = 15;
const nowIso = (now) => (now ? new Date(now).toISOString() : new Date().toISOString());

// ---------- 资源与容量 ----------
function parseIds(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }

function sessionResources(session) {
  const stations = parseIds(session.station_ids)
    .map((id) => db.prepare('SELECT id,name,active FROM stations WHERE id=?').get(id))
    .filter(Boolean);
  const machines = parseIds(session.machine_ids)
    .map((id) => db.prepare('SELECT id,name,active FROM machines WHERE id=?').get(id))
    .filter(Boolean);
  return { stations, machines };
}

function activeBookings(sessionId) {
  return db.prepare("SELECT * FROM bookings WHERE session_id=? AND status IN ('held','confirmed')").all(sessionId);
}

// 动态容量：固定班级容量 vs 讲师（每 session 固定 1 名）、工位、机器瓶颈取最小值
function capacityOf(session) {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(session.course_id);
  const { stations, machines } = sessionResources(session);
  const activeStations = stations.filter((s) => s.active);
  const activeMachines = machines.filter((m) => m.active);
  const bookings = activeBookings(session.id);
  const usedStations = new Set(bookings.filter((b) => b.station_id).map((b) => b.station_id));
  const usedMachines = new Set(bookings.filter((b) => b.machine_id).map((b) => b.machine_id));
  const freeStations = activeStations.filter((s) => !usedStations.has(s.id));
  const freeMachines = activeMachines.filter((m) => !usedMachines.has(m.id));

  // 瓶颈逐项列出，管理界面据此解释容量来源
  const bottlenecks = [
    { resource: 'fixed_capacity', label: '固定班级容量', total: course.fixed_capacity },
    { resource: 'station', label: '可用工位', total: activeStations.length },
    { resource: 'machine', label: '可用机器', total: activeMachines.length },
    { resource: 'instructor', label: '讲师（每场1人）', total: 1 }
  ];
  const dynamicCapacity = Math.min(course.fixed_capacity, activeStations.length, activeMachines.length, 1);
  const booked = bookings.length;
  return {
    fixedCapacity: course.fixed_capacity,
    dynamicCapacity,
    booked,
    waitlisted: db.prepare("SELECT COUNT(*) c FROM bookings WHERE session_id=? AND status='waitlisted' AND active=1").get(session.id).c,
    available: Math.max(0, dynamicCapacity - booked),
    bottleneck: bottlenecks.find((b) => b.total === dynamicCapacity),
    bottlenecks,
    freeStations,
    freeMachines
  };
}

// ---------- 讲师排期重叠 / 资源跨场冲突 ----------
function findScheduleConflicts({ instructor_id, station_ids, machine_ids, start_utc, end_utc, exclude_session_id }) {
  const conflicts = [];
  const overlapSql = `
    SELECT s.*, c.title course_title FROM sessions s JOIN courses c ON c.id=s.course_id
    WHERE s.status='open' AND NOT (s.end_utc <= ? OR s.start_utc >= ?)
      AND (? IS NULL OR s.id <> ?)`;
  const params = [start_utc, end_utc, exclude_session_id || null, exclude_session_id || null];

  const sameInstructor = db.prepare(overlapSql + ' AND s.instructor_id=?').all(...params, instructor_id);
  for (const s of sameInstructor) {
    conflicts.push({ type: 'instructor', label: `讲师排期重叠：${db.prepare('SELECT name FROM instructors WHERE id=?').get(instructor_id).name}`, session_id: s.id, session: s.course_title, start_utc: s.start_utc, end_utc: s.end_utc });
  }
  for (const sid of station_ids || []) {
    const hit = db.prepare(overlapSql + " AND s.station_ids LIKE ?").all(...params, `%${sid}%`)
      .find((s) => parseIds(s.station_ids).includes(sid));
    if (hit) conflicts.push({ type: 'station', label: `工位被占用：${db.prepare('SELECT name FROM stations WHERE id=?').get(sid)?.name}`, session_id: hit.id, session: hit.course_title, start_utc: hit.start_utc, end_utc: hit.end_utc });
  }
  for (const mid of machine_ids || []) {
    const hit = db.prepare(overlapSql + " AND s.machine_ids LIKE ?").all(...params, `%${mid}%`)
      .find((s) => parseIds(s.machine_ids).includes(mid));
    if (hit) conflicts.push({ type: 'machine', label: `机器被占用：${db.prepare('SELECT name FROM machines WHERE id=?').get(mid)?.name}`, session_id: hit.id, session: hit.course_title, start_utc: hit.start_utc, end_utc: hit.end_utc });
  }
  return conflicts;
}

// ---------- 候补提升（事务内调用） ----------
function promoteWaitlist(sessionId, now) {
  const promoted = [];
  for (;;) {
    const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
    if (!session || session.status !== 'open') break;
    const cap = capacityOf(session);
    if (cap.available <= 0 || !cap.freeStations[0] || !cap.freeMachines[0]) break;
    const next = db.prepare("SELECT * FROM bookings WHERE session_id=? AND status='waitlisted' AND active=1 ORDER BY id LIMIT 1").get(sessionId);
    if (!next) break;
    db.prepare(`UPDATE bookings SET status='held', station_id=?, machine_id=?, held_expires_at=? WHERE id=?`)
      .run(cap.freeStations[0].id, cap.freeMachines[0].id, new Date(new Date(now).getTime() + HOLD_MINUTES * 60000).toISOString(), next.id);
    promoted.push(next.id);
  }
  return promoted;
}

// ---------- 过期占位清理 ----------
function sweepExpiredHolds(now) {
  now = nowIso(now);
  return db.transaction(() => {
    const expired = db.prepare("SELECT * FROM bookings WHERE status='held' AND held_expires_at<=? AND active=1").all(now);
    const sessionIds = new Set();
    for (const b of expired) {
      db.prepare("UPDATE bookings SET status='cancelled', active=0 WHERE id=?").run(b.id);
      sessionIds.add(b.session_id);
    }
    const promotions = [];
    for (const sid of sessionIds) promotions.push(...promoteWaitlist(sid, now));
    return { expired: expired.map((b) => b.id), promoted: promotions };
  })();
}

// ---------- 预约（含并发：整段事务 + 唯一索引兜底最后一个工位） ----------
function bookSession(sessionId, student, now) {
  now = nowIso(now);
  return db.transaction(() => {
    sweepExpiredHolds(now);
    const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
    if (!session) throw httpError(404, 'SESSION_NOT_FOUND', '课程场次不存在');
    if (session.status === 'cancelled') throw httpError(409, 'SESSION_CANCELLED', '该场次已撤课');
    const cap = capacityOf(session);
    if (cap.available <= 0 || !cap.freeStations[0] || !cap.freeMachines[0]) {
      const info = db.prepare(`INSERT INTO bookings (session_id,student_name,student_contact,status,created_at)
        VALUES (?,?,?,'waitlisted',?)`).run(sessionId, student.name, student.contact || '', now);
      return { status: 'waitlisted', booking_id: info.lastInsertRowid, capacity: cap };
    }
    const station = cap.freeStations[0];
    const machine = cap.freeMachines[0];
    const expires = new Date(new Date(now).getTime() + HOLD_MINUTES * 60000).toISOString();
    try {
      const info = db.prepare(`INSERT INTO bookings
        (session_id,student_name,student_contact,status,station_id,machine_id,held_expires_at,created_at)
        VALUES (?,?,?,'held',?,?,?,?)`)
        .run(sessionId, student.name, student.contact || '', station.id, machine.id, expires, now);
      return { status: 'held', booking_id: info.lastInsertRowid, station: station.name, machine: machine.name, held_expires_at: expires, capacity: capacityOf(session) };
    } catch (e) {
      // 并发下唯一索引冲突 -> 进候补
      if (String(e.message).includes('UNIQUE')) {
        const info = db.prepare(`INSERT INTO bookings (session_id,student_name,student_contact,status,created_at)
          VALUES (?,?,?,'waitlisted',?)`).run(sessionId, student.name, student.contact || '', now);
        return { status: 'waitlisted', booking_id: info.lastInsertRowid, capacity: capacityOf(session), note: '并发抢占，已转候补' };
      }
      throw e;
    }
  })();
}

// ---------- 确认：绑定当时课程内容与门店地址 ----------
function confirmBooking(bookingId, ackNewAddress, now) {
  now = nowIso(now);
  return db.transaction(() => {
    sweepExpiredHolds(now);
    const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
    if (!b) throw httpError(404, 'BOOKING_NOT_FOUND', '预约不存在');
    if (b.status === 'cancelled' && b.held_expires_at && b.held_expires_at <= now)
      throw httpError(410, 'HOLD_EXPIRED', '临时占位已过期，预约已取消');
    if (b.status !== 'held') throw httpError(409, 'NOT_HOLD', `当前状态 ${b.status} 不可确认`);
    const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(b.session_id);
    if (session.status === 'cancelled') throw httpError(409, 'SESSION_CANCELLED', '课程已被后台撤除，无法确认');

    if (b.reconfirm_required && !ackNewAddress) {
      const store = db.prepare('SELECT * FROM stores WHERE id=?').get(session.store_id);
      throw httpError(409, 'ADDRESS_RECONFIRM', '门店已改址，请学员确认新地址后再确认预约', {
        old_address: b.address_snapshot,
        new_address: store.address,
        reason: b.reconfirm_reason
      });
    }
    const course = db.prepare('SELECT * FROM courses WHERE id=?').get(session.course_id);
    const store = db.prepare('SELECT * FROM stores WHERE id=?').get(session.store_id);
    db.prepare(`UPDATE bookings SET status='confirmed', confirmed_at=?,
        course_title_snapshot=?, course_content_snapshot=?, address_snapshot=?,
        reconfirm_required=0, reconfirm_reason=NULL WHERE id=?`)
      .run(now, course.title, course.description || '', store.address, b.id);
    db.prepare(`INSERT INTO growth_evidence (title,kind,ref_table,ref_id,occurred_at,note,created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(`${b.student_name} 完成《${course.title}》预约确认`, 'booking', 'bookings', b.id, now, '成长证据：预约确认时绑定课程内容与门店地址', now);
    return db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id);
  })();
}

// ---------- 取消（释放资源 -> 候补提升） ----------
function cancelBooking(bookingId, now) {
  now = nowIso(now);
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
    if (!b) throw httpError(404, 'BOOKING_NOT_FOUND', '预约不存在');
    if (['cancelled'].includes(b.status)) throw httpError(409, 'ALREADY_CANCELLED', '预约已取消');
    db.prepare("UPDATE bookings SET status='cancelled', active=0 WHERE id=?").run(b.id);
    const promoted = promoteWaitlist(b.session_id, now);
    return { cancelled: bookingId, promoted };
  })();
}

// ---------- 后台撤课：学员正在确认(held)必须通知 ----------
function cancelSession(sessionId, reason, now) {
  now = nowIso(now);
  return db.transaction(() => {
    const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
    if (!s) throw httpError(404, 'SESSION_NOT_FOUND', '场次不存在');
    db.prepare("UPDATE sessions SET status='cancelled', cancel_reason=? WHERE id=?").run(reason || '', sessionId);
    const affected = db.prepare("SELECT * FROM bookings WHERE session_id=? AND status IN ('held','confirmed') AND active=1").all(sessionId);
    for (const b of affected) {
      db.prepare("UPDATE bookings SET notified_of_cancel=1 WHERE id=?").run(b.id);
      if (b.status === 'held') db.prepare("UPDATE bookings SET status='cancelled', active=0 WHERE id=?").run(b.id);
    }
    return { session_id: sessionId, notify: affected.map((b) => ({ booking_id: b.id, student: b.student_name, status: b.status, must_notify: 1 })) };
  })();
}

// ---------- 门店改址：不能只更新页面地图，需标记待学员确认 ----------
function changeStoreAddress(storeId, newAddress, now) {
  now = nowIso(now);
  return db.transaction(() => {
    const store = db.prepare('SELECT * FROM stores WHERE id=?').get(storeId);
    if (!store) throw httpError(404, 'STORE_NOT_FOUND', '门店不存在');
    if (store.address === newAddress) return { store_id: storeId, marked: 0 };
    db.prepare('UPDATE stores SET address=? WHERE id=?').run(newAddress, storeId);
    const sessions = db.prepare("SELECT id FROM sessions WHERE store_id=? AND status='open' AND end_utc>=?").all(storeId, now);
    let marked = 0;
    for (const s of sessions) {
      const rows = db.prepare("SELECT * FROM bookings WHERE session_id=? AND status IN ('held','confirmed') AND active=1").all(s.id);
      for (const b of rows) {
        db.prepare('UPDATE bookings SET reconfirm_required=1, reconfirm_reason=? WHERE id=?')
          .run(`门店「${store.name}」地址变更：旧地址 ${b.address_snapshot || store.address} -> 新地址 ${newAddress}`, b.id);
        marked++;
      }
    }
    return { store_id: storeId, old_address: store.address, new_address: newAddress, marked };
  })();
}

// ---------- 照片授权 ----------
function photoViewable(work, now) {
  now = nowIso(now);
  if (!work.photo_url) return { viewable: false, reason: 'no_photo' };
  if (work.license_expires_at && work.license_expires_at <= now) return { viewable: false, reason: 'license_expired' };
  return { viewable: true };
}

// ---------- 发布（兼容版本） ----------
function publish(kind, now) {
  now = nowIso(now);
  return db.transaction(() => {
    let payload;
    if (kind === 'chronology') {
      const profile = db.prepare('SELECT * FROM profile WHERE id=1').get();
      const employments = db.prepare(`SELECT e.*, s.name store_name FROM employments e JOIN stores s ON s.id=e.store_id ORDER BY e.start_date DESC`).all();
      const works = db.prepare('SELECT * FROM works WHERE published=1 ORDER BY produced_at DESC').all()
        .map((w) => {
          const v = photoViewable(w, now);
          return { ...w, photo_url: v.viewable ? w.photo_url : null, photo_blocked: v.viewable ? null : v.reason };
        });
      const competitions = db.prepare('SELECT * FROM competitions WHERE published=1 ORDER BY date DESC').all();
      const stages = db.prepare('SELECT * FROM learning_stages WHERE published=1 ORDER BY sort_order, start_date').all();
      payload = { profile, employments, works, competitions, stages };
    } else if (kind === 'courses') {
      const courses = db.prepare('SELECT * FROM courses WHERE published=1').all().map((c) => {
        const sessions = db.prepare('SELECT * FROM sessions WHERE course_id=? ORDER BY start_utc').all(c.id)
          .map((s) => ({ ...s, capacity: capacityOf(s) }));
        return { ...c, sessions };
      });
      payload = { courses };
    } else throw httpError(400, 'BAD_KIND', '未知发布类型');

    const row = db.prepare('SELECT MAX(version) m FROM publications WHERE kind=?').get(kind);
    const version = (row.m || 0) + 1;
    db.prepare('INSERT INTO publications (kind,version,reader_version,payload,published_at) VALUES (?,?,?,?,?)')
      .run(kind, version, '1.x', JSON.stringify(payload), now);
    return { kind, version, reader_version: '1.x', published_at: now };
  })();
}

// 从兼容发布版本读取（年表/课程页公开读取不直接读草稿编辑数据）
function readPublished(kind, readerVersion, now) {
  now = nowIso(now);
  const rows = db.prepare('SELECT * FROM publications WHERE kind=? ORDER BY version DESC').all(kind);
  const matches = rows.filter((r) => isCompatible(r.reader_version, readerVersion || '1.0'));
  if (!matches.length) return null;
  const pub = matches[0];
  const payload = JSON.parse(pub.payload);
  // 授权到期是持续生效的：即便发布时仍有效，读取时到期也必须撤下照片（文字保留）
  if (kind === 'chronology' && Array.isArray(payload.works)) {
    payload.works = payload.works.map((w) => {
      if (w.photo_url && w.license_expires_at && w.license_expires_at <= now) {
        return { ...w, photo_url: null, photo_blocked: 'license_expired_after_publish' };
      }
      return w;
    });
  }
  return { version: pub.version, reader_version: pub.reader_version, published_at: pub.published_at, payload };
}

function isCompatible(publishedReader, requestedReader) {
  // 语义化主版本兼容：1.x 发布满足所有 1.y 读取端
  const p = String(publishedReader).split('.')[0];
  const r = String(requestedReader).split('.')[0];
  return p === r;
}

function httpError(status, code, message, extra) {
  const e = new Error(message);
  e.status = status; e.code = code; Object.assign(e, extra || {});
  return e;
}

module.exports = {
  HOLD_MINUTES, capacityOf, findScheduleConflicts, bookSession, confirmBooking,
  cancelBooking, cancelSession, changeStoreAddress, sweepExpiredHolds,
  promoteWaitlist, publish, readPublished, photoViewable, sessionResources, parseIds
};
