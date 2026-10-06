'use strict';
const express = require('express');
const { capacityReport } = require('../services/capacity');
const { createHold, confirmBooking, cancelBooking, reconfirmBooking, BookingError } = require('../services/booking');
const { createSession, cancelSession } = require('../services/sessions');
const { changeAddress } = require('../services/shops');
const { publish, readCompatiblePayload } = require('../services/publishing');

module.exports = function apiRoutes(ctx) {
  const { db } = ctx;
  const r = express.Router();
  const now = () => new Date().toISOString();
  const ttl = () => ctx.holdTtlSeconds;

  const handle = (fn) => (req, res) => {
    try {
      const out = fn(req);
      res.json(out);
    } catch (e) {
      if (e instanceof BookingError) {
        res.status(e.status).json({ error: e.code, message: e.message, ...e.extra });
      } else {
        console.error(e);
        res.status(500).json({ error: 'internal', message: e.message });
      }
    }
  };

  /* ---- 预约 ---- */
  r.post('/sessions/:id/holds', handle((req) =>
    createHold(db, Number(req.params.id), String((req.body && req.body.student_name) || '').trim() || '匿名学员',
      { now: now(), holdTtlSeconds: ttl() })));

  r.post('/bookings/:id/confirm', handle((req) =>
    confirmBooking(db, Number(req.params.id), { now: now(), holdTtlSeconds: ttl() })));

  r.post('/bookings/:id/cancel', handle((req) =>
    cancelBooking(db, Number(req.params.id), { now: now(), holdTtlSeconds: ttl() })));

  r.post('/bookings/:id/reconfirm', handle((req) =>
    reconfirmBooking(db, Number(req.params.id), { now: now() })));

  r.get('/bookings/:id', handle((req) => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(req.params.id));
    if (!b) throw new BookingError('not_found', '预约不存在', 404);
    return b;
  }));

  r.get('/sessions/:id/capacity', handle((req) => {
    const report = capacityReport(db, Number(req.params.id));
    if (!report) throw new BookingError('not_found', '课次不存在', 404);
    return report;
  }));

  /* ---- 管理端 JSON ---- */
  r.post('/admin/sessions', handle((req) => createSession(db, {
    course_id: Number(req.body.course_id),
    instructor_id: Number(req.body.instructor_id),
    shop_id: Number(req.body.shop_id),
    start_utc: String(req.body.start_utc || ''),
    end_utc: String(req.body.end_utc || ''),
    demo_ws: Number(req.body.demo_ws ?? 1),
    demo_machines: Number(req.body.demo_machines ?? 1)
  })));

  r.post('/admin/sessions/:id/cancel', handle((req) =>
    cancelSession(db, Number(req.params.id), { now: now() })));

  r.post('/admin/shops/:id/address', handle((req) =>
    changeAddress(db, Number(req.params.id), String((req.body && req.body.address) || ''), { now: now() })));

  r.post('/admin/publish', handle(() => publish(db, { now: now() })));

  r.get('/admin/sessions/:id/capacity', handle((req) => {
    const report = capacityReport(db, Number(req.params.id));
    if (!report) throw new BookingError('not_found', '课次不存在', 404);
    return report;
  }));

  /* ---- 公开 JSON（同样从兼容发布版本读取） ---- */
  r.get('/public/timeline', handle(() => {
    const pub = readCompatiblePayload(db);
    if (!pub) throw new BookingError('not_found', '暂无兼容的发布版本', 404);
    return { version_no: pub.version_no, published_at: pub.published_at, ...pub.payload.timeline };
  }));
  r.get('/public/courses', handle(() => {
    const pub = readCompatiblePayload(db);
    if (!pub) throw new BookingError('not_found', '暂无兼容的发布版本', 404);
    return { version_no: pub.version_no, published_at: pub.published_at, courses: pub.payload.courses };
  }));

  return r;
};
