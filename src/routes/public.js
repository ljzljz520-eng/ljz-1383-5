'use strict';
const express = require('express');
const views = require('../views');
const { todayUtc } = require('../format');
const { readCompatiblePayload } = require('../services/publishing');
const { createHold, confirmBooking, cancelBooking, reconfirmBooking, BookingError } = require('../services/booking');
const { capacityReport } = require('../services/capacity');

module.exports = function publicRoutes(ctx) {
  const { db } = ctx;
  const r = express.Router();
  const now = () => new Date().toISOString();
  const ttl = () => ctx.holdTtlSeconds;

  const renderError = (res, e) => {
    const status = e instanceof BookingError ? e.status : 500;
    if (!(e instanceof BookingError)) console.error(e);
    res.status(status).send(views.errorPage(`操作失败（${status}）`, e.message, status));
  };

  r.get('/', (req, res) => res.send(views.homePage()));

  // 年表：从兼容发布版本读取
  r.get('/timeline', (req, res) => {
    const pub = readCompatiblePayload(db);
    res.send(views.timelinePage(pub));
  });

  // 作品：照片授权到期/加载失败均保留文字
  r.get('/works', (req, res) => {
    const works = db.prepare(
      `SELECT w.*, s.name AS shop_name FROM works w LEFT JOIN shops s ON s.id = w.shop_id
       ORDER BY w.created_on DESC, w.id DESC`
    ).all();
    res.send(views.worksPage(works, todayUtc()));
  });

  // 课程页：从兼容发布版本读取
  r.get('/courses', (req, res) => {
    const pub = readCompatiblePayload(db);
    res.send(views.coursesPage(pub));
  });

  r.get('/sessions/:id', (req, res, next) => {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(req.params.id));
    if (!session) return next();
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(session.course_id);
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(session.shop_id);
    const instructor = db.prepare('SELECT * FROM instructors WHERE id = ?').get(session.instructor_id);
    const report = capacityReport(db, session.id);
    res.send(views.sessionPage({ session, course, shop, instructor, report }));
  });

  r.post('/sessions/:id/hold', (req, res) => {
    try {
      const name = String(req.body.student_name || '').trim() || '匿名学员';
      const out = createHold(db, Number(req.params.id), name, { now: now(), holdTtlSeconds: ttl() });
      res.redirect(`/bookings/${out.id}`);
    } catch (e) { renderError(res, e); }
  });

  r.get('/bookings/:id', (req, res, next) => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(req.params.id));
    if (!b) return next();
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(b.session_id);
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(session.shop_id);
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(session.course_id);
    res.send(views.bookingPage({ booking: b, session, shop, course }));
  });

  r.post('/bookings/:id/confirm', (req, res) => {
    try {
      confirmBooking(db, Number(req.params.id), { now: now(), holdTtlSeconds: ttl() });
      res.redirect(`/bookings/${req.params.id}`);
    } catch (e) { renderError(res, e); }
  });

  r.post('/bookings/:id/cancel', (req, res) => {
    try {
      cancelBooking(db, Number(req.params.id), { now: now(), holdTtlSeconds: ttl() });
      res.redirect(`/bookings/${req.params.id}`);
    } catch (e) { renderError(res, e); }
  });

  r.post('/bookings/:id/reconfirm', (req, res) => {
    try {
      reconfirmBooking(db, Number(req.params.id), { now: now() });
      res.redirect(`/bookings/${req.params.id}`);
    } catch (e) { renderError(res, e); }
  });

  // 豆单：个人记录，未经核对的品质结论不作认证事实
  r.get('/beans', (req, res) => {
    const notes = db.prepare('SELECT * FROM bean_notes ORDER BY created_on DESC, id DESC').all();
    res.send(views.beansPage(notes));
  });

  return r;
};
