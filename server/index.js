'use strict';
const path = require('path');
const express = require('express');
const db = require('./db');
const dom = require('./domain');
const { toZoned } = require('./tz');

const app = express();
app.use(express.json({ limit: '1mb' }));

// 管理端简单口令（开发环境可不设）
const ADMIN_KEY = process.env.ADMIN_KEY || '';
function adminOnly(req, res, next) {
  if (ADMIN_KEY && req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ error: 'UNAUTHORIZED' });
  next();
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
    const rest = { old_address: e.old_address, new_address: e.new_address, reason: e.reason, conflicts: e.conflicts };
    Object.keys(rest).forEach((k) => rest[k] === undefined && delete rest[k]);
    res.status(e.status || 500).json({ error: e.code || 'ERROR', message: e.message, ...rest });
  });
}

const nowOverride = (req) => req.get('x-now') || undefined; // 验收测试可注入时钟

// ---------- 公开端：年表（从兼容发布版本读取） ----------
app.get('/api/public/chronology', (req, res) => {
  const pub = dom.readPublished('chronology', req.query.v);
  if (!pub) return res.status(404).json({ error: 'NO_PUBLICATION', message: '年表尚未发布' });
  // 比赛经历含角色与日期；作品照片失败时 alt_text/描述文字保留
  res.json({ ...pub, payload: { ...pub.payload, bean_disclaimer: '豆单为个人记录，非第三方品质认证' } });
});

// ---------- 公开端：课程页（从兼容发布版本读取 + 实时余量/跨时区展示） ----------
app.get('/api/public/courses', wrap((req, res) => {
  const pub = dom.readPublished('courses', req.query.v);
  if (!pub) return res.status(404).json({ error: 'NO_PUBLICATION', message: '课程尚未发布' });
  // 发布版本用于课程内容；余量与本地时间实时计算（时间换算到门店时区）
  const courses = pub.payload.courses.map((c) => ({
    ...c,
    sessions: c.sessions
      .filter((s) => s.status === 'open')
      .map((s) => {
        const live = db.prepare('SELECT * FROM sessions WHERE id=?').get(s.id);
        const store = live && db.prepare('SELECT * FROM stores WHERE id=?').get(live.store_id);
        const cap = dom.capacityOf(live);
        return {
          id: s.id, start: toZoned(live.start_utc, store.tz), end: toZoned(live.end_utc, store.tz),
          store_name: store.name, store_id: store.id, address: store.address, tz: store.tz,
          fixed_capacity: c.fixed_capacity, available: cap.available, dynamic_capacity: cap.dynamicCapacity,
          capacity_source: { bottleneck: cap.bottleneck, bottlenecks: cap.bottlenecks, booked: cap.booked, waitlisted: cap.waitlisted }
        };
      })
  }));
  res.json({ version: pub.version, reader_version: pub.reader_version, published_at: pub.published_at, courses });
}));

// 公开预约：占位
app.post('/api/public/sessions/:id/book', wrap((req, res) => {
  const result = dom.bookSession(Number(req.params.id), req.body, nowOverride(req));
  res.status(200).json(result);
}));
// 确认（ackNewAddress=true 表示学员已确认改址）
app.post('/api/public/bookings/:id/confirm', wrap((req, res) => {
  const b = dom.confirmBooking(Number(req.params.id), !!req.body.ackNewAddress, nowOverride(req));
  res.json({ ok: true, booking: b });
}));
app.post('/api/public/bookings/:id/cancel', wrap((req, res) => {
  res.json(dom.cancelBooking(Number(req.params.id), nowOverride(req)));
}));
app.get('/api/public/bookings/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'NOT_FOUND' });
  const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(b.session_id);
  const store = db.prepare('SELECT * FROM stores WHERE id=?').get(session.store_id);
  res.json({ ...b, session_status: session.status, current_address: store.address, start_local: toZoned(session.start_utc, store.tz) });
});

// 豆单（公开）：明确标注个人记录
app.get('/api/public/beans', (req, res) => {
  const rows = db.prepare('SELECT id,roaster,origin,process,roast_date,personal_notes,verified FROM bean_log ORDER BY id DESC').all();
  res.json({ disclaimer: '以下为咖啡师个人杯测/烘焙记录，属未经第三方核对的主观品质结论，不构成任何认证事实。', beans: rows });
});

// ---------- 管理端：门店 ----------
app.post('/api/admin/stores', adminOnly, wrap((req, res) => {
  const t = new Date().toISOString();
  const info = db.prepare('INSERT INTO stores (name,address,tz,active,created_at) VALUES (?,?,?,1,?)')
    .run(req.body.name, req.body.address, req.body.tz || 'Asia/Shanghai', t);
  res.json({ id: info.lastInsertRowid });
}));
app.get('/api/admin/stores', adminOnly, (req, res) => res.json(db.prepare('SELECT * FROM stores ORDER BY id').all()));
app.put('/api/admin/stores/:id', adminOnly, wrap((req, res) => {
  const s = db.prepare('SELECT * FROM stores WHERE id=?').get(Number(req.params.id));
  if (!s) throw Object.assign(new Error('门店不存在'), { status: 404 });
  db.prepare('UPDATE stores SET name=?, tz=?, active=? WHERE id=?')
    .run(req.body.name ?? s.name, req.body.tz ?? s.tz, req.body.active ?? s.active, s.id);
  res.json({ ok: true });
}));
// 改址专用：不只是更新地址文本/地图，会标记相关预约"待学员确认"
app.post('/api/admin/stores/:id/change-address', adminOnly, wrap((req, res) => {
  res.json(dom.changeStoreAddress(Number(req.params.id), req.body.address, nowOverride(req)));
}));

// 任职区间
app.post('/api/admin/employments', adminOnly, wrap((req, res) => {
  const b = req.body;
  // 同一门店区间重叠校验
  const rows = db.prepare('SELECT * FROM employments WHERE store_id=?').all(b.store_id);
  for (const r of rows) {
    if (r.end_date && b.start_date > r.end_date) continue;
    if (b.end_date && b.end_date < r.start_date) continue;
    throw Object.assign(new Error('任职有效区间与该门店已有任职重叠'), { status: 409 });
  }
  const t = new Date().toISOString();
  const info = db.prepare('INSERT INTO employments (store_id,role,start_date,end_date,note,created_at) VALUES (?,?,?,?,?,?)')
    .run(b.store_id, b.role, b.start_date, b.end_date || null, b.note || '', t);
  res.json({ id: info.lastInsertRowid });
}));
app.get('/api/admin/employments', adminOnly, (req, res) =>
  res.json(db.prepare('SELECT e.*, s.name store_name FROM employments e JOIN stores s ON s.id=e.store_id ORDER BY start_date DESC').all()));

// 作品（拉花）
app.post('/api/admin/works', adminOnly, wrap((req, res) => {
  const b = req.body;
  const store = db.prepare('SELECT * FROM stores WHERE id=?').get(b.store_id);
  const t = new Date().toISOString();
  const info = db.prepare(`INSERT INTO works
    (title,photo_url,alt_text,description,store_id,store_name_snapshot,produced_at,license_expires_at,license_note,published,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.title, b.photo_url || null, b.alt_text || '', b.description || '', b.store_id,
      store ? store.name : null, b.produced_at || null, b.license_expires_at || null, b.license_note || '', b.published ? 1 : 0, t);
  res.json({ id: info.lastInsertRowid });
}));
app.get('/api/admin/works', adminOnly, (req, res) => {
  const now = nowOverride(req) || new Date().toISOString();
  res.json(db.prepare('SELECT * FROM works ORDER BY id DESC').all().map((w) => ({ ...w, photo_status: dom.photoViewable(w, now) })));
});
app.put('/api/admin/works/:id', adminOnly, wrap((req, res) => {
  const w = db.prepare('SELECT * FROM works WHERE id=?').get(Number(req.params.id));
  if (!w) throw Object.assign(new Error('作品不存在'), { status: 404 });
  const b = req.body;
  db.prepare(`UPDATE works SET title=?,photo_url=?,alt_text=?,description=?,produced_at=?,license_expires_at=?,license_note=?,published=? WHERE id=?`)
    .run(b.title ?? w.title, b.photo_url ?? w.photo_url, b.alt_text ?? w.alt_text, b.description ?? w.description,
      b.produced_at ?? w.produced_at, b.license_expires_at ?? w.license_expires_at, b.license_note ?? w.license_note,
      b.published === undefined ? w.published : (b.published ? 1 : 0), w.id);
  res.json({ ok: true, note: 'store_id/store_name_snapshot 不可编辑：调店不改写旧作品出品门店' });
}));

// 比赛经历（角色 + 日期）
app.post('/api/admin/competitions', adminOnly, wrap((req, res) => {
  const b = req.body;
  if (!b.role || !b.date) throw Object.assign(new Error('比赛必须关联具体角色和日期'), { status: 400 });
  const info = db.prepare('INSERT INTO competitions (name,role,category,date,ranking,description,published,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(b.name, b.role, b.category || '', b.date, b.ranking || '', b.description || '', b.published ? 1 : 0, new Date().toISOString());
  res.json({ id: info.lastInsertRowid });
}));
app.get('/api/admin/competitions', adminOnly, (req, res) => res.json(db.prepare('SELECT * FROM competitions ORDER BY date DESC').all()));
app.put('/api/admin/competitions/:id', adminOnly, wrap((req, res) => {
  const c = db.prepare('SELECT * FROM competitions WHERE id=?').get(Number(req.params.id));
  const b = req.body;
  db.prepare('UPDATE competitions SET name=?,role=?,category=?,date=?,ranking=?,description=?,published=? WHERE id=?')
    .run(b.name ?? c.name, b.role ?? c.role, b.category ?? c.category, b.date ?? c.date, b.ranking ?? c.ranking,
      b.description ?? c.description, b.published === undefined ? c.published : (b.published ? 1 : 0), c.id);
  res.json({ ok: true });
}));

// 学习阶段
app.post('/api/admin/stages', adminOnly, (req, res) => {
  const b = req.body;
  const info = db.prepare('INSERT INTO learning_stages (title,stage,start_date,end_date,description,sort_order,published,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(b.title, b.stage || '', b.start_date || null, b.end_date || null, b.description || '', b.sort_order || 0, b.published ? 1 : 0, new Date().toISOString());
  res.json({ id: info.lastInsertRowid });
});
app.get('/api/admin/stages', adminOnly, (req, res) => res.json(db.prepare('SELECT * FROM learning_stages ORDER BY sort_order,start_date').all()));
app.put('/api/admin/stages/:id', adminOnly, (req, res) => {
  const s = db.prepare('SELECT * FROM learning_stages WHERE id=?').get(Number(req.params.id));
  const b = req.body;
  db.prepare('UPDATE learning_stages SET title=?,stage=?,start_date=?,end_date=?,description=?,sort_order=?,published=? WHERE id=?')
    .run(b.title ?? s.title, b.stage ?? s.stage, b.start_date ?? s.start_date, b.end_date ?? s.end_date,
      b.description ?? s.description, b.sort_order ?? s.sort_order, b.published === undefined ? s.published : (b.published ? 1 : 0), s.id);
  res.json({ ok: true });
});

// 资源：讲师/工位/机器
for (const [pathName, table, cols] of [
  ['instructors', 'instructors', ['name', 'bio']],
  ['stations', 'stations', ['name', 'store_id']],
  ['machines', 'machines', ['name', 'model']]
]) {
  app.get(`/api/admin/${pathName}`, adminOnly, (req, res) => res.json(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
  app.post(`/api/admin/${pathName}`, adminOnly, (req, res) => {
    const vals = cols.map((c) => req.body[c] ?? null);
    const info = db.prepare(`INSERT INTO ${table} (${cols.join(',')},active) VALUES (${cols.map(() => '?').join(',')},1)`).run(...vals);
    res.json({ id: info.lastInsertRowid });
  });
  app.put(`/api/admin/${pathName}/:id`, adminOnly, (req, res) => {
    const sets = cols.map((c) => req.body[c] !== undefined ? `${c}=?` : null).filter(Boolean);
    const vals = cols.filter((c) => req.body[c] !== undefined).map((c) => req.body[c]);
    if (req.body.active !== undefined) { sets.push('active=?'); vals.push(req.body.active ? 1 : 0); }
    vals.push(Number(req.params.id));
    db.prepare(`UPDATE ${table} SET ${sets.join(',')} WHERE id=?`).run(...vals);
    res.json({ ok: true });
  });
}

// 课程
app.post('/api/admin/courses', adminOnly, (req, res) => {
  const b = req.body;
  const info = db.prepare('INSERT INTO courses (title,description,fixed_capacity,published,created_at) VALUES (?,?,?,?,?)')
    .run(b.title, b.description || '', Number(b.fixed_capacity) || 1, b.published ? 1 : 0, new Date().toISOString());
  res.json({ id: info.lastInsertRowid });
});
app.get('/api/admin/courses', adminOnly, (req, res) => res.json(db.prepare('SELECT * FROM courses ORDER BY id').all()));
app.put('/api/admin/courses/:id', adminOnly, (req, res) => {
  const c = db.prepare('SELECT * FROM courses WHERE id=?').get(Number(req.params.id));
  const b = req.body;
  db.prepare('UPDATE courses SET title=?,description=?,fixed_capacity=?,published=? WHERE id=?')
    .run(b.title ?? c.title, b.description ?? c.description, b.fixed_capacity ?? c.fixed_capacity,
      b.published === undefined ? c.published : (b.published ? 1 : 0), c.id);
  res.json({ ok: true });
});

// 排课：讲师+工位+机器同时占用，返回冲突说明
app.post('/api/admin/sessions', adminOnly, wrap((req, res) => {
  const b = req.body;
  const startUtc = new Date(b.start_utc).toISOString();
  const endUtc = new Date(b.end_utc).toISOString();
  if (endUtc <= startUtc) throw Object.assign(new Error('结束时间必须晚于开始时间'), { status: 400 });
  const conflicts = dom.findScheduleConflicts({
    instructor_id: Number(b.instructor_id), station_ids: b.station_ids, machine_ids: b.machine_ids,
    start_utc: startUtc, end_utc: endUtc
  });
  if (conflicts.length && !b.force) return res.status(409).json({ error: 'SCHEDULE_CONFLICT', message: '排期存在资源冲突', conflicts });
  const store = db.prepare('SELECT * FROM stores WHERE id=?').get(Number(b.store_id));
  const info = db.prepare(`INSERT INTO sessions (course_id,store_id,start_utc,end_utc,instructor_id,station_ids,machine_ids,address_snapshot,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(Number(b.course_id), Number(b.store_id), startUtc, endUtc,
      Number(b.instructor_id), JSON.stringify(b.station_ids || []), JSON.stringify(b.machine_ids || []), store.address, new Date().toISOString());
  const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid, capacity: dom.capacityOf(session) });
}));

app.get('/api/admin/sessions', adminOnly, (req, res) => {
  const rows = db.prepare(`SELECT s.*, c.title course_title, c.fixed_capacity, st.name store_name, st.tz, i.name instructor_name
    FROM sessions s JOIN courses c ON c.id=s.course_id JOIN stores st ON st.id=s.store_id JOIN instructors i ON i.id=s.instructor_id
    ORDER BY s.start_utc`).all();
  res.json(rows.map((s) => {
    const full = db.prepare('SELECT * FROM sessions WHERE id=?').get(s.id);
    const cap = dom.capacityOf(full);
    return {
      ...s,
      start_local: toZoned(s.start_utc, s.tz), end_local: toZoned(s.end_utc, s.tz),
      station_ids: dom.parseIds(s.station_ids), machine_ids: dom.parseIds(s.machine_ids),
      capacity: cap, conflicts: dom.findScheduleConflicts({
        instructor_id: s.instructor_id, station_ids: dom.parseIds(s.station_ids), machine_ids: dom.parseIds(s.machine_ids),
        start_utc: s.start_utc, end_utc: s.end_utc, exclude_session_id: s.id
      })
    };
  }));
});
app.post('/api/admin/sessions/:id/cancel', adminOnly, wrap((req, res) => {
  res.json(dom.cancelSession(Number(req.params.id), req.body.reason, nowOverride(req)));
}));

// 预约总览（后台连接预约数据）
app.get('/api/admin/bookings', adminOnly, (req, res) => {
  const rows = db.prepare(`SELECT b.*, c.title course_title, st.name store_name, st.tz, s.start_utc session_start_utc
    FROM bookings b JOIN sessions s ON s.id=b.session_id JOIN courses c ON c.id=s.course_id JOIN stores st ON st.id=s.store_id
    ORDER BY b.id DESC`).all();
  res.json(rows.map((b) => ({ ...b, start_local: toZoned(b.session_start_utc, b.tz) })));
});
app.post('/api/admin/maintenance/sweep', adminOnly, wrap((req, res) => res.json(dom.sweepExpiredHolds(nowOverride(req)))));

// 成长证据 / 素材 / 豆单
app.get('/api/admin/evidence', adminOnly, (req, res) => res.json(db.prepare('SELECT * FROM growth_evidence ORDER BY occurred_at DESC').all()));
app.post('/api/admin/materials', adminOnly, (req, res) => {
  const b = req.body;
  const info = db.prepare('INSERT INTO materials (title,kind,url,description,created_at) VALUES (?,?,?,?,?)')
    .run(b.title, b.kind || '', b.url || '', b.description || '', new Date().toISOString());
  res.json({ id: info.lastInsertRowid });
});
app.get('/api/admin/materials', adminOnly, (req, res) => res.json(db.prepare('SELECT * FROM materials ORDER BY id DESC').all()));
app.post('/api/admin/beans', adminOnly, (req, res) => {
  const b = req.body;
  const info = db.prepare('INSERT INTO bean_log (roaster,origin,process,roast_date,personal_notes,verified,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(b.roaster || '', b.origin || '', b.process || '', b.roast_date || null, b.personal_notes || '', b.verified ? 1 : 0, new Date().toISOString());
  res.json({ id: info.lastInsertRowid });
});
app.get('/api/admin/beans', adminOnly, (req, res) => res.json(db.prepare('SELECT * FROM bean_log ORDER BY id DESC').all()));

// 个人资料
app.put('/api/admin/profile', adminOnly, (req, res) => {
  const b = req.body;
  db.prepare(`INSERT INTO profile (id,name,title,bio,updated_at) VALUES (1,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,title=excluded.title,bio=excluded.bio,updated_at=excluded.updated_at`)
    .run(b.name, b.title || '', b.bio || '', new Date().toISOString());
  res.json({ ok: true });
});

// 发布
app.post('/api/admin/publish/:kind', adminOnly, wrap((req, res) => res.json(dom.publish(req.params.kind, nowOverride(req)))));
app.get('/api/admin/publications', adminOnly, (req, res) =>
  res.json(db.prepare('SELECT id,kind,version,reader_version,published_at FROM publications ORDER BY id DESC').all()));

// 静态资源
app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));
app.use(express.static(path.join(__dirname, '..', 'public')));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`barista app listening on http://localhost:${port}  (admin: /admin)`));
}
module.exports = app;
