'use strict';
const express = require('express');
const views = require('../views');
const { isCompatible } = require('../db');
const { capacityReport } = require('../services/capacity');
const { createSession, cancelSession } = require('../services/sessions');
const { changeAddress } = require('../services/shops');
const { cancelBooking, BookingError } = require('../services/booking');
const { publish } = require('../services/publishing');

module.exports = function adminRoutes(ctx) {
  const { db } = ctx;
  const r = express.Router();
  const now = () => new Date().toISOString();
  const ttl = () => ctx.holdTtlSeconds;

  const renderError = (res, e) => {
    const status = e instanceof BookingError ? e.status : 500;
    if (!(e instanceof BookingError)) console.error(e);
    res.status(status).send(views.errorPage(`操作失败（${status}）`, e.message, status));
  };

  r.get('/', (req, res) => {
    const count = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    res.send(views.adminDashboard({
      shops: count('shops'), courses: count('courses'), sessions: count('sessions'),
      bookings: count('bookings'), versions: count('published_versions')
    }));
  });

  /* 门店：编辑名称/时区；改址单独动作（触发待学员确认） */
  r.get('/shops', (req, res) => {
    res.send(views.adminShopsPage(db.prepare('SELECT * FROM shops ORDER BY id').all()));
  });
  r.post('/shops/:id', (req, res) => {
    try {
      db.prepare('UPDATE shops SET name = ?, timezone = ?, updated_at = ? WHERE id = ?')
        .run(String(req.body.name || '').trim(), String(req.body.timezone || 'Asia/Shanghai').trim(), now(), Number(req.params.id));
      res.redirect('/admin/shops');
    } catch (e) { renderError(res, e); }
  });
  r.post('/shops/:id/address', (req, res) => {
    try {
      changeAddress(db, Number(req.params.id), String(req.body.address || ''), { now: now() });
      res.redirect('/admin/shops');
    } catch (e) { renderError(res, e); }
  });

  /* 课程：编辑内容（bump 内容版本）与容量模式 */
  r.get('/courses', (req, res) => {
    res.send(views.adminCoursesPage(db.prepare('SELECT * FROM courses ORDER BY id').all()));
  });
  r.post('/courses', (req, res) => {
    try {
      const mode = req.body.capacity_mode === 'dynamic' ? 'dynamic' : 'fixed';
      const fixed = req.body.fixed_capacity ? Number(req.body.fixed_capacity) : null;
      if (mode === 'fixed' && !fixed) throw new BookingError('bad_input', '固定容量模式必须填写固定容量', 422);
      db.prepare('INSERT INTO courses (title, content, capacity_mode, fixed_capacity) VALUES (?,?,?,?)')
        .run(String(req.body.title || '').trim(), String(req.body.content || '').trim(), mode, fixed);
      res.redirect('/admin/courses');
    } catch (e) { renderError(res, e); }
  });
  r.post('/courses/:id', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM courses WHERE id = ?').get(Number(req.params.id));
      if (!c) throw new BookingError('not_found', '课程不存在', 404);
      const mode = req.body.capacity_mode === 'dynamic' ? 'dynamic' : 'fixed';
      const fixed = req.body.fixed_capacity ? Number(req.body.fixed_capacity) : null;
      if (mode === 'fixed' && !fixed) throw new BookingError('bad_input', '固定容量模式必须填写固定容量', 422);
      const contentChanged = String(req.body.content || '') !== c.content;
      db.prepare(
        `UPDATE courses SET title = ?, content = ?, capacity_mode = ?, fixed_capacity = ?,
           content_version = content_version + ? WHERE id = ?`
      ).run(String(req.body.title || '').trim(), String(req.body.content || '').trim(), mode, fixed,
        contentChanged ? 1 : 0, c.id);
      res.redirect('/admin/courses');
    } catch (e) { renderError(res, e); }
  });

  /* 课次：排期（冲突校验）与撤课；列表解释容量来源及冲突 */
  r.get('/sessions', (req, res) => {
    const sessions = db.prepare(
      `SELECT se.*, c.title AS course_title, i.name AS instructor_name, s.name AS shop_name
       FROM sessions se
       JOIN courses c ON c.id = se.course_id
       JOIN instructors i ON i.id = se.instructor_id
       JOIN shops s ON s.id = se.shop_id
       ORDER BY se.start_utc DESC`
    ).all();
    const reports = new Map(sessions.map((s) => [s.id, capacityReport(db, s.id)]));
    res.send(views.adminSessionsPage(
      sessions,
      db.prepare(`SELECT * FROM courses WHERE status = 'open' ORDER BY id`).all(),
      db.prepare('SELECT * FROM instructors ORDER BY id').all(),
      db.prepare('SELECT * FROM shops ORDER BY id').all(),
      reports
    ));
  });
  r.post('/sessions', (req, res) => {
    try {
      createSession(db, {
        course_id: Number(req.body.course_id),
        instructor_id: Number(req.body.instructor_id),
        shop_id: Number(req.body.shop_id),
        start_utc: String(req.body.start_utc || ''),
        end_utc: String(req.body.end_utc || ''),
        demo_ws: Number(req.body.demo_ws || 0),
        demo_machines: Number(req.body.demo_machines || 0)
      });
      res.redirect('/admin/sessions');
    } catch (e) { renderError(res, e); }
  });
  r.post('/sessions/:id/cancel', (req, res) => {
    try {
      cancelSession(db, Number(req.params.id), { now: now() });
      res.redirect('/admin/sessions');
    } catch (e) { renderError(res, e); }
  });
  r.get('/sessions/:id', (req, res, next) => {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(req.params.id));
    if (!session) return next();
    const bookings = db.prepare('SELECT * FROM bookings WHERE session_id = ? ORDER BY created_at, id').all(session.id);
    res.send(views.adminSessionBookingsPage(session, bookings, capacityReport(db, session.id)));
  });
  r.post('/bookings/:id/cancel', (req, res) => {
    try {
      const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(req.params.id));
      cancelBooking(db, Number(req.params.id), { now: now(), holdTtlSeconds: ttl() });
      res.redirect(b ? `/admin/sessions/${b.session_id}` : '/admin/sessions');
    } catch (e) { renderError(res, e); }
  });

  /* 发布版本 */
  r.get('/publish', (req, res) => {
    const versions = db.prepare('SELECT * FROM published_versions ORDER BY version_no DESC').all();
    res.send(views.adminPublishPage(versions, isCompatible));
  });
  r.post('/publish', (req, res) => {
    try {
      publish(db, { now: now() });
      res.redirect('/admin/publish');
    } catch (e) { renderError(res, e); }
  });

  /* 豆单 */
  r.get('/beans', (req, res) => {
    res.send(views.adminBeansPage(db.prepare('SELECT * FROM bean_notes ORDER BY id DESC').all()));
  });
  r.post('/beans', (req, res) => {
    try {
      db.prepare(
        `INSERT INTO bean_notes (bean_name, origin, roast, personal_note, quality_claim, verified, created_on)
         VALUES (?,?,?,?,?,?,?)`
      ).run(
        String(req.body.bean_name || '').trim(), String(req.body.origin || ''), String(req.body.roast || ''),
        String(req.body.personal_note || '').trim(), String(req.body.quality_claim || ''),
        req.body.verified === '1' ? 1 : 0, now().slice(0, 10)
      );
      res.redirect('/admin/beans');
    } catch (e) { renderError(res, e); }
  });

  return r;
};
