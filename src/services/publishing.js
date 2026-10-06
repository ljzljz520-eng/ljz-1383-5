'use strict';
/**
 * 发布版本：公开年表与课程页从「兼容发布版本」读取，而非实时表。
 * - 管理端编辑不影响公开页，直到显式发布。
 * - 若最新版本 schema 不兼容（如旧格式/迁移中），自动回退到最近一个兼容版本。
 */
const { CURRENT_SCHEMA_VERSION, isCompatible } = require('../db');

function buildPayload(db) {
  const stages = db.prepare('SELECT * FROM learning_stages ORDER BY started_on ASC, id ASC').all();
  const employments = db.prepare(
    `SELECT e.*, s.name AS shop_name FROM employments e JOIN shops s ON s.id = e.shop_id
     ORDER BY e.started_on ASC, e.id ASC`
  ).all();
  const competitions = db.prepare('SELECT * FROM competitions ORDER BY event_date ASC, id ASC').all();
  const works = db.prepare(
    `SELECT w.*, s.name AS shop_name FROM works w LEFT JOIN shops s ON s.id = w.shop_id
     ORDER BY w.created_on ASC, w.id ASC`
  ).all();
  const courses = db.prepare(`SELECT * FROM courses WHERE status = 'open' ORDER BY id ASC`).all().map((c) => ({
    id: c.id, title: c.title, content: c.content, content_version: c.content_version,
    capacity_mode: c.capacity_mode, fixed_capacity: c.fixed_capacity,
    sessions: db.prepare(
      `SELECT se.id, se.start_utc, se.end_utc, se.demo_ws, se.demo_machines,
              s.name AS shop_name, s.address AS shop_address, s.timezone, i.name AS instructor_name
       FROM sessions se
       JOIN shops s ON s.id = se.shop_id
       JOIN instructors i ON i.id = se.instructor_id
       WHERE se.course_id = ? AND se.status = 'scheduled'
       ORDER BY se.start_utc ASC`
    ).all(c.id)
  }));
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    timeline: { stages, employments, competitions, works },
    courses
  };
}

function publish(db, { now }) {
  const payload = buildPayload(db);
  const nextNo = db.prepare('SELECT COALESCE(MAX(version_no), 0) AS m FROM published_versions').get().m + 1;
  db.prepare('INSERT INTO published_versions (version_no, schema_version, published_at, payload) VALUES (?,?,?,?)')
    .run(nextNo, CURRENT_SCHEMA_VERSION, now, JSON.stringify(payload));
  return { version_no: nextNo, schema_version: CURRENT_SCHEMA_VERSION };
}

/** 读取最新「兼容」发布版本；不兼容的新版本会被跳过（回退）。 */
function readCompatiblePayload(db) {
  const rows = db.prepare('SELECT * FROM published_versions ORDER BY version_no DESC').all();
  for (const r of rows) {
    if (!isCompatible(r.schema_version)) continue;
    try {
      const payload = JSON.parse(r.payload);
      if (!isCompatible(payload.schema_version)) continue;
      return { version_no: r.version_no, published_at: r.published_at, payload };
    } catch { /* 跳过损坏版本，继续回退 */ }
  }
  return null;
}

/** 作品门店归属：取创作时快照门店，并校验当时是否确实任职于该门店（调店不回写旧作品）。 */
function workAttribution(payload, work) {
  const employedThere = payload.timeline.employments.some((e) =>
    e.shop_id === work.shop_id &&
    e.started_on <= work.created_on &&
    (!e.ended_on || work.created_on <= e.ended_on));
  return { shop_name: work.shop_name || '未记录门店', verified: employedThere };
}

module.exports = { buildPayload, publish, readCompatiblePayload, workAttribution };
