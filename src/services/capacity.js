'use strict';
/**
 * 容量服务：比较「固定班级容量」与「按资源瓶颈动态计算」。
 *
 * 一门课同时占用：讲师（1，排他）+ 工位 + 机器。
 * 动态容量 = min(空闲工位, 空闲机器)，其中空闲量要扣除：
 *   - 本课讲师演示占用（demo_ws / demo_machines）
 *   - 同一时间窗内本门店其他课次的演示占用 + 已占学员席
 * 管理界面通过 capacityReport 解释容量来源及冲突。
 */

function activeOccupancy(db, sessionId) {
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN state = 'held' THEN 1 ELSE 0 END), 0)      AS held,
       COALESCE(SUM(CASE WHEN state = 'confirmed' THEN 1 ELSE 0 END), 0) AS confirmed,
       COALESCE(SUM(CASE WHEN state = 'waitlisted' THEN 1 ELSE 0 END), 0) AS waitlisted
     FROM bookings WHERE session_id = ?`
  ).get(sessionId);
  return { held: row.held, confirmed: row.confirmed, waitlisted: row.waitlisted, active: row.held + row.confirmed };
}

function overlappingSessions(db, session) {
  return db.prepare(
    `SELECT * FROM sessions
     WHERE shop_id = ? AND status = 'scheduled' AND id <> ?
       AND start_utc < ? AND end_utc > ?`
  ).all(session.shop_id, session.id, session.end_utc, session.start_utc);
}

function instructorConflicts(db, session) {
  return db.prepare(
    `SELECT s.*, c.title AS course_title
     FROM sessions s JOIN courses c ON c.id = s.course_id
     WHERE s.instructor_id = ? AND s.status = 'scheduled' AND s.id <> ?
       AND s.start_utc < ? AND s.end_utc > ?`
  ).all(session.instructor_id, session.id, session.end_utc, session.start_utc);
}

/** 资源占用明细：门店资源池 - 本课演示占用 - 重叠课次占用（演示 + 其已占学员席） */
function resourceReport(db, session) {
  const wsTotal = db.prepare('SELECT COUNT(*) AS c FROM workstations WHERE shop_id = ?').get(session.shop_id).c;
  const machTotal = db.prepare('SELECT COUNT(*) AS c FROM machines WHERE shop_id = ?').get(session.shop_id).c;
  const consumers = [];
  let wsUsed = session.demo_ws;
  let machUsed = session.demo_machines;
  if (session.demo_ws || session.demo_machines) {
    consumers.push({
      kind: 'self_demo',
      label: `本课讲师演示占用（工位 ${session.demo_ws} / 机器 ${session.demo_machines}）`,
      ws: session.demo_ws, machines: session.demo_machines
    });
  }
  for (const o of overlappingSessions(db, session)) {
    const occ = activeOccupancy(db, o.id);
    const ws = o.demo_ws + occ.active;
    const mach = o.demo_machines + occ.active;
    wsUsed += ws;
    machUsed += mach;
    consumers.push({
      kind: 'overlap', session_id: o.id,
      label: `重叠课次 #${o.id}（演示 ${o.demo_ws}/${o.demo_machines} + 已占学员席 ${occ.active}）`,
      ws, machines: mach
    });
  }
  return {
    workstations: { total: wsTotal, used: wsUsed, free: Math.max(0, wsTotal - wsUsed) },
    machines: { total: machTotal, used: machUsed, free: Math.max(0, machTotal - machUsed) },
    consumers
  };
}

/** 容量报告：容量来源解释 + 固定/动态对比 + 冲突列表（管理界面直接展示） */
function capacityReport(db, sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return null;
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(session.course_id);
  const res = resourceReport(db, session);
  const dynamicCapacity = Math.min(res.workstations.free, res.machines.free);
  const bottleneck = res.workstations.free === res.machines.free
    ? '工位与机器同为瓶颈'
    : (res.workstations.free < res.machines.free ? '工位' : '机器');
  const fixed = course.fixed_capacity;
  const capacity = course.capacity_mode === 'fixed' ? fixed : dynamicCapacity;

  let explanation;
  if (course.capacity_mode === 'fixed') {
    explanation = `容量来源：固定班级容量 ${fixed} 人（不随资源变化）。`
      + `对比：若按资源瓶颈动态计算为 ${dynamicCapacity} 人`
      + `（空闲工位 ${res.workstations.free} / 空闲机器 ${res.machines.free}）。`;
  } else {
    explanation = `容量来源：资源瓶颈动态计算 = min(空闲工位 ${res.workstations.free}, 空闲机器 ${res.machines.free})`
      + ` = ${dynamicCapacity} 人，瓶颈：${bottleneck}。`
      + (fixed != null ? `对比：固定班级容量为 ${fixed} 人。` : '未设置固定容量。');
  }

  const conflicts = [];
  for (const c of instructorConflicts(db, session)) {
    conflicts.push({
      type: 'instructor_overlap',
      message: `讲师排期重叠：与课次 #${c.id}《${c.course_title}》（${c.start_utc} ~ ${c.end_utc}）冲突`
    });
  }
  if (session.demo_ws > res.workstations.total) {
    conflicts.push({ type: 'resource_insufficient', message: `演示工位需求 ${session.demo_ws} 超过门店工位总数 ${res.workstations.total}` });
  }
  if (session.demo_machines > res.machines.total) {
    conflicts.push({ type: 'resource_insufficient', message: `演示机器需求 ${session.demo_machines} 超过门店机器总数 ${res.machines.total}` });
  }
  if (course.capacity_mode === 'dynamic' && dynamicCapacity === 0) {
    conflicts.push({ type: 'resource_exhausted', message: '动态容量为 0：工位或机器已被占满' });
  }
  if (course.capacity_mode === 'fixed' && fixed != null && fixed > dynamicCapacity) {
    conflicts.push({ type: 'overbook_risk', message: `固定容量 ${fixed} 超出当前资源可支撑的 ${dynamicCapacity}，存在超售风险` });
  }

  return {
    session_id: sessionId,
    mode: course.capacity_mode,
    capacity,
    fixed_capacity: fixed,
    dynamic_capacity: dynamicCapacity,
    bottleneck,
    explanation,
    resources: res,
    occupancy: activeOccupancy(db, sessionId),
    conflicts
  };
}

module.exports = { capacityReport, activeOccupancy, resourceReport, instructorConflicts, overlappingSessions };
