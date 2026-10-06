'use strict';
/**
 * 验收测试：
 *  1. 最后一个工位被并发预订 —— 只有一人占位成功，其余进入候补
 *  2. 讲师排期重叠 —— 创建冲突课次被拒绝并说明冲突
 *  3. 课程跨时区展示 —— UTC 存储，按门店时区与浏览者时区分别正确显示
 *  4. 作品授权到期 —— 不渲染图片但保留文字；照片加载失败有文字兜底
 *  5. 后台撤课时学员正在确认 —— 确认失败、占位被释放
 *  6. 候补 / 临时占位 / 取消释放 —— 释放后候补自动晋升
 *  7. 改址待学员确认 —— 快照不被静默覆盖，需学员再确认
 *  8. 年表与课程页从兼容发布版本读取 —— 不兼容版本自动回退
 *  9. 调店后旧作品仍属旧门店
 * 10. 管理端解释容量来源（固定 vs 动态瓶颈）及冲突
 * 11. 豆单为个人记录，未核对结论不作认证事实
 * 12. 比赛关联角色与日期、任职有有效区间
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { formatInTz } = require('../src/format');
const { createHold, confirmBooking, cancelBooking, sweepExpired } = require('../src/services/booking');
const { publish } = require('../src/services/publishing');

const NOW = '2026-10-06T08:00:00.000Z';

/** 造一间门店 + 资源 + 讲师 + 课程 + 课次的夹具 */
function makeFixtures(db, { ws = 1, machines = 1, capacityMode = 'dynamic', fixedCapacity = null, demoWs = 0, demoMachines = 0 } = {}) {
  const shop = db.prepare('INSERT INTO shops (name, address, timezone, updated_at) VALUES (?,?,?,?)')
    .run('测试门店', '测试路 1 号', 'Asia/Shanghai', NOW).lastInsertRowid;
  for (let i = 0; i < ws; i++) db.prepare('INSERT INTO workstations (shop_id, label) VALUES (?,?)').run(shop, `工位${i + 1}`);
  for (let i = 0; i < machines; i++) db.prepare('INSERT INTO machines (shop_id, label) VALUES (?,?)').run(shop, `机器${i + 1}`);
  const instructor = db.prepare('INSERT INTO instructors (name) VALUES (?)').run('讲师甲').lastInsertRowid;
  const course = db.prepare('INSERT INTO courses (title, content, capacity_mode, fixed_capacity) VALUES (?,?,?,?)')
    .run('测试课程', '课程内容 v1', capacityMode, fixedCapacity).lastInsertRowid;
  const session = db.prepare(
    'INSERT INTO sessions (course_id, instructor_id, shop_id, start_utc, end_utc, demo_ws, demo_machines) VALUES (?,?,?,?,?,?,?)')
    .run(course, instructor, shop, '2026-11-01T02:00:00.000Z', '2026-11-01T04:00:00.000Z', demoWs, demoMachines).lastInsertRowid;
  return { shop, instructor, course, session };
}

async function startServer(db) {
  const app = createApp(db, { holdTtlSeconds: 600 });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

const postJson = (base, path, body) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {})
}).then(async (res) => ({ status: res.status, body: await res.json() }));

/* ---------- 1. 最后一个工位被并发预订 ---------- */
test('最后一个工位被并发预订：仅一人占位成功，另一人进入候补', async () => {
  const db = openDb(':memory:');
  const { session } = makeFixtures(db, { ws: 1, machines: 1, capacityMode: 'dynamic' });
  const { server, base } = await startServer(db);
  try {
    const [a, b] = await Promise.all([
      postJson(base, `/api/sessions/${session}/holds`, { student_name: '学员A' }),
      postJson(base, `/api/sessions/${session}/holds`, { student_name: '学员B' })
    ]);
    const states = [a.body.state, b.body.state].sort();
    assert.deepEqual(states, ['held', 'waitlisted'], '最后一个工位只能有一人占位成功');
    const cap = await fetch(`${base}/api/sessions/${session}/capacity`).then((r) => r.json());
    assert.equal(cap.capacity, 1, '动态容量 = min(1 工位, 1 机器) = 1');
    assert.equal(cap.occupancy.active, 1);
    assert.equal(cap.occupancy.waitlisted, 1);
  } finally { server.close(); }
});

/* ---------- 2. 讲师排期重叠 ---------- */
test('讲师排期重叠：冲突课次被拒绝，边界相接不算重叠', async () => {
  const db = openDb(':memory:');
  const f = makeFixtures(db, { ws: 4, machines: 4 });
  const { server, base } = await startServer(db);
  try {
    const overlap = await postJson(base, '/api/admin/sessions', {
      course_id: f.course, instructor_id: f.instructor, shop_id: f.shop,
      start_utc: '2026-11-01T03:00:00.000Z', end_utc: '2026-11-01T05:00:00.000Z', demo_ws: 1, demo_machines: 1
    });
    assert.equal(overlap.status, 409);
    assert.equal(overlap.body.error, 'instructor_overlap');
    assert.match(overlap.body.message, /讲师排期重叠/);
    assert.equal(overlap.body.conflicts[0].session_id, f.session);
    // 边界相接（上一课结束即下一课开始）允许
    const adjacent = await postJson(base, '/api/admin/sessions', {
      course_id: f.course, instructor_id: f.instructor, shop_id: f.shop,
      start_utc: '2026-11-01T04:00:00.000Z', end_utc: '2026-11-01T06:00:00.000Z', demo_ws: 1, demo_machines: 1
    });
    assert.equal(adjacent.status, 200);
  } finally { server.close(); }
});

/* ---------- 3. 课程跨时区展示 ---------- */
test('课程跨时区展示：UTC 存储，门店时区与浏览者时区各自正确', async () => {
  assert.equal(formatInTz('2026-11-01T02:00:00.000Z', 'Asia/Shanghai'), '2026-11-01 10:00');
  assert.equal(formatInTz('2026-11-01T02:00:00.000Z', 'America/New_York'), '2026-10-31 22:00');
  const db = openDb(':memory:');
  makeFixtures(db, { ws: 2, machines: 2 });
  publish(db, { now: NOW });
  const { server, base } = await startServer(db);
  try {
    const html = await fetch(`${base}/courses`).then((r) => r.text());
    assert.ok(html.includes('2026-11-01 10:00'), '课程页按门店时区（Asia/Shanghai）显示');
    assert.ok(html.includes('data-utc="2026-11-01T02:00:00.000Z"'), '页面带 UTC 数据供浏览器换算浏览者时区');
  } finally { server.close(); }
});

/* ---------- 4. 作品授权到期 & 照片失败保留文字 ---------- */
test('作品授权到期：不渲染图片但保留文字；照片失败有文字兜底', async () => {
  const db = openDb(':memory:');
  const shop = db.prepare('INSERT INTO shops (name, address, timezone, updated_at) VALUES (?,?,?,?)')
    .run('门店', '地址', 'Asia/Shanghai', NOW).lastInsertRowid;
  db.prepare('INSERT INTO works (title, description, photo_url, shop_id, created_on, license_expires_on) VALUES (?,?,?,?,?,?)')
    .run('授权到期作品', '这段文字必须保留', 'https://cdn.example.com/a.jpg', shop, '2024-01-01', '2026-01-01');
  db.prepare('INSERT INTO works (title, description, photo_url, shop_id, created_on, license_expires_on) VALUES (?,?,?,?,?,?)')
    .run('照片破损作品', '破损照片的文字说明', 'https://invalid.example.com/404.jpg', shop, '2024-02-01', '2099-01-01');
  const { server, base } = await startServer(db);
  try {
    const html = await fetch(`${base}/works`).then((r) => r.text());
    // 授权到期作品（id=1）的卡片区域：从 data-work-id="1" 到主内容结束
    const expiredCard = html.split('data-work-id="1"')[1].split('</main>')[0];
    assert.ok(!expiredCard.includes('<img'), '授权到期的作品不应渲染 <img>');
    assert.ok(html.includes('授权已到期'), '应提示授权已到期');
    assert.ok(html.includes('这段文字必须保留'), '授权到期仍保留文字');
    assert.ok(html.includes('<img class="work-photo" src="https://invalid.example.com/404.jpg"'), '授权有效时渲染图片');
    assert.ok(html.includes('photo-fallback'), '照片加载失败时有文字兜底结构');
    assert.ok(html.includes('破损照片的文字说明'), '兜底文字存在');
  } finally { server.close(); }
});

/* ---------- 5. 后台撤课时学员正在确认 ---------- */
test('后台撤课时学员正在确认：确认失败并释放占位', async () => {
  const db = openDb(':memory:');
  const { session } = makeFixtures(db, { ws: 1, machines: 1 });
  const { server, base } = await startServer(db);
  try {
    const hold = await postJson(base, `/api/sessions/${session}/holds`, { student_name: '正在确认的学员' });
    assert.equal(hold.body.state, 'held');
    // 学员确认到一半，后台撤课
    const cancel = await postJson(base, `/api/admin/sessions/${session}/cancel`);
    assert.equal(cancel.body.cancelled, true);
    assert.equal(cancel.body.bookings_released, 1);
    // 学员提交确认 → 失败
    const confirm = await postJson(base, `/api/bookings/${hold.body.id}/confirm`);
    assert.equal(confirm.status, 410);
    assert.equal(confirm.body.error, 'session_cancelled');
    const booking = await fetch(`${base}/api/bookings/${hold.body.id}`).then((r) => r.json());
    assert.equal(booking.state, 'cancelled', '占位已被释放');
    // 撤课后新的占位也被拒绝
    const late = await postJson(base, `/api/sessions/${session}/holds`, { student_name: '后来者' });
    assert.equal(late.status, 410);
  } finally { server.close(); }
});

/* ---------- 6. 候补 / 临时占位 / 取消释放 ---------- */
test('候补、临时占位与取消释放：释放后候补自动晋升，占位过期自动顺延', async () => {
  const db = openDb(':memory:');
  const { session } = makeFixtures(db, { ws: 1, machines: 1 });
  // A 占位（容量 1），B 候补
  const a = createHold(db, session, '学员A', { now: NOW, holdTtlSeconds: 600 });
  const b = createHold(db, session, '学员B', { now: NOW, holdTtlSeconds: 600 });
  assert.equal(a.state, 'held');
  assert.equal(b.state, 'waitlisted');
  // A 取消 → 释放 → B 晋升为临时占位
  const cancelled = cancelBooking(db, a.id, { now: NOW, holdTtlSeconds: 600 });
  assert.deepEqual(cancelled.promoted, [b.id]);
  const bAfter = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
  assert.equal(bAfter.state, 'held');
  assert.ok(bAfter.hold_expires_at, '晋升的候补获得新的占位有效期');
  // B 确认成功并绑定快照
  confirmBooking(db, b.id, { now: NOW, holdTtlSeconds: 600 });
  const bConfirmed = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
  assert.equal(bConfirmed.state, 'confirmed');
  assert.equal(bConfirmed.course_content_snapshot, '课程内容 v1');
  assert.equal(bConfirmed.shop_address_snapshot, '测试路 1 号');
  // 占位过期：C 占位后过期，D 候补自动晋升
  const c = createHold(db, session, '学员C', { now: NOW, holdTtlSeconds: 600 });
  assert.equal(c.state, 'waitlisted'); // B 已确认占满
  cancelBooking(db, b.id, { now: NOW, holdTtlSeconds: 600 }); // 释放 → C 晋升
  const c2 = db.prepare('SELECT * FROM bookings WHERE id = ?').get(c.id);
  assert.equal(c2.state, 'held');
  const d = createHold(db, session, '学员D', { now: NOW, holdTtlSeconds: 600 });
  assert.equal(d.state, 'waitlisted');
  // C 的占位过期 → 清扫后 D 晋升
  sweepExpired(db, '2026-10-06T08:11:00.000Z', 600);
  assert.equal(db.prepare('SELECT state FROM bookings WHERE id = ?').get(c.id).state, 'expired');
  assert.equal(db.prepare('SELECT state FROM bookings WHERE id = ?').get(d.id).state, 'held');
});

/* ---------- 7. 改址待学员确认 ---------- */
test('改址：确认快照不被静默覆盖，标记待学员确认，再确认后更新', async () => {
  const db = openDb(':memory:');
  const f = makeFixtures(db, { ws: 2, machines: 2 });
  const { server, base } = await startServer(db);
  try {
    const hold = await postJson(base, `/api/sessions/${f.session}/holds`, { student_name: '学员E' });
    await postJson(base, `/api/bookings/${hold.body.id}/confirm`);
    let booking = await fetch(`${base}/api/bookings/${hold.body.id}`).then((r) => r.json());
    assert.equal(booking.shop_address_snapshot, '测试路 1 号');
    assert.equal(booking.shop_address_version_snapshot, 1);
    // 后台改址
    const change = await postJson(base, `/api/admin/shops/${f.shop}/address`, { address: '新址大道 99 号' });
    assert.equal(change.body.changed, true);
    assert.equal(change.body.affected, 1);
    booking = await fetch(`${base}/api/bookings/${hold.body.id}`).then((r) => r.json());
    assert.equal(booking.reconfirm_required, 1, '改址后标记待学员确认');
    assert.equal(booking.shop_address_snapshot, '测试路 1 号', '快照仍是预约时的旧地址，不被静默覆盖');
    // 学员页面同时展示旧快照与新地址，而不是只更新地图
    const page = await fetch(`${base}/bookings/${hold.body.id}`).then((r) => r.text());
    assert.ok(page.includes('测试路 1 号'), '页面保留预约时地址快照');
    assert.ok(page.includes('新址大道 99 号'), '页面展示当前新地址');
    assert.ok(page.includes('待你确认') || page.includes('待学员确认'), '页面提示待确认');
    // 学员再确认 → 快照更新为新地址
    await postJson(base, `/api/bookings/${hold.body.id}/reconfirm`);
    booking = await fetch(`${base}/api/bookings/${hold.body.id}`).then((r) => r.json());
    assert.equal(booking.reconfirm_required, 0);
    assert.equal(booking.shop_address_snapshot, '新址大道 99 号');
    assert.equal(booking.shop_address_version_snapshot, 2);
  } finally { server.close(); }
});

/* ---------- 8. 年表与课程页从兼容发布版本读取 ---------- */
test('年表与课程页读取最新兼容发布版本，不兼容版本自动回退', async () => {
  const db = openDb(':memory:');
  const f = makeFixtures(db, { ws: 2, machines: 2 });
  publish(db, { now: NOW }); // v1
  // 管理端改了课程名，但未发布 → 公开页不变
  db.prepare('UPDATE courses SET title = ? WHERE id = ?').run('新课名（未发布）', f.course);
  // 塞入一个更新的但 schema 不兼容的发布版本
  db.prepare('INSERT INTO published_versions (version_no, schema_version, published_at, payload) VALUES (?,?,?,?)')
    .run(99, '1.0', NOW, JSON.stringify({ schema_version: '1.0', timeline: {}, courses: [] }));
  const { server, base } = await startServer(db);
  try {
    let html = await fetch(`${base}/courses`).then((r) => r.text());
    assert.ok(html.includes('测试课程'), '公开页显示已发布的旧课名');
    assert.ok(!html.includes('新课名（未发布）'), '未发布的修改不出现在公开页');
    assert.ok(html.includes('v1'), '不兼容的 v99 被跳过，回退到兼容的 v1');
    // 发布新版本（兼容）→ 公开页更新；版本号单调递增（越过不兼容的 v99）
    const pub2 = await postJson(base, '/api/admin/publish');
    assert.equal(pub2.body.version_no, 100, '版本号单调递增，不回填不兼容版本的坑位');
    html = await fetch(`${base}/courses`).then((r) => r.text());
    assert.ok(html.includes('新课名（未发布）'), '发布后公开页才更新');
    const api = await fetch(`${base}/api/public/courses`).then((r) => r.json());
    assert.equal(api.version_no, pub2.body.version_no);
  } finally { server.close(); }
});

/* ---------- 9. 调店后旧作品仍属旧门店 ---------- */
test('调店后旧作品仍归属原门店，不自动改成新门店出品', async () => {
  const db = openDb(':memory:');
  const shopA = db.prepare('INSERT INTO shops (name, address, timezone, updated_at) VALUES (?,?,?,?)')
    .run('旧门店', '旧地址', 'Asia/Shanghai', NOW).lastInsertRowid;
  const shopB = db.prepare('INSERT INTO shops (name, address, timezone, updated_at) VALUES (?,?,?,?)')
    .run('新门店', '新地址', 'Asia/Shanghai', NOW).lastInsertRowid;
  db.prepare('INSERT INTO employments (shop_id, role, started_on, ended_on) VALUES (?,?,?,?)')
    .run(shopA, '咖啡师', '2023-01-01', '2024-05-31');
  db.prepare('INSERT INTO employments (shop_id, role, started_on, ended_on) VALUES (?,?,?,?)')
    .run(shopB, '资深咖啡师', '2024-06-01', null);
  db.prepare('INSERT INTO works (title, description, photo_url, shop_id, created_on) VALUES (?,?,?,?,?)')
    .run('调店前的天鹅', '旧门店时期作品', null, shopA, '2023-06-01');
  publish(db, { now: NOW });
  const { server, base } = await startServer(db);
  try {
    const html = await fetch(`${base}/timeline`).then((r) => r.text());
    const workLi = html.split('调店前的天鹅')[1].split('</li>')[0];
    assert.ok(workLi.includes('旧门店'), '旧作品仍标注旧门店');
    assert.ok(!workLi.includes('新门店'), '旧作品不会被改成新门店出品');
    assert.ok(workLi.includes('任职期间核实'), '创作时间落在旧门店任职区间内，归属可核实');
  } finally { server.close(); }
});

/* ---------- 10. 管理端解释容量来源及冲突 ---------- */
test('管理端容量解释：固定容量与动态瓶颈并列对比，冲突可见', async () => {
  const db = openDb(':memory:');
  // 固定容量 8，但资源只能支撑 min(6-1, 4-1)=3 → 应提示超售风险
  const f = makeFixtures(db, { ws: 6, machines: 4, capacityMode: 'fixed', fixedCapacity: 8, demoWs: 1, demoMachines: 1 });
  const { server, base } = await startServer(db);
  try {
    const report = await fetch(`${base}/api/admin/sessions/${f.session}/capacity`).then((r) => r.json());
    assert.equal(report.mode, 'fixed');
    assert.equal(report.capacity, 8);
    assert.equal(report.dynamic_capacity, 3);
    assert.match(report.explanation, /固定班级容量 8/);
    assert.match(report.explanation, /动态计算为 3/);
    assert.ok(report.conflicts.some((c) => c.type === 'overbook_risk'), '固定容量超过资源支撑时提示超售风险');
    // 动态模式：瓶颈解释
    const g = makeFixtures(db, { ws: 5, machines: 2, capacityMode: 'dynamic', demoWs: 1, demoMachines: 1 });
    const report2 = await fetch(`${base}/api/admin/sessions/${g.session}/capacity`).then((r) => r.json());
    assert.equal(report2.capacity, 1, 'min(空闲工位 4, 空闲机器 1) = 1');
    assert.equal(report2.bottleneck, '机器');
    assert.match(report2.explanation, /资源瓶颈动态计算/);
    // 管理页 HTML 也包含解释
    const html = await fetch(`${base}/admin/sessions`).then((r) => r.text());
    assert.ok(html.includes('容量来源'), '管理界面解释容量来源');
  } finally { server.close(); }
});

/* ---------- 11. 豆单：个人记录，未核对结论不作认证事实 ---------- */
test('豆单为个人记录，未经核对的品质结论带免责，不当认证事实', async () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO bean_notes (bean_name, origin, roast, personal_note, quality_claim, verified, created_on) VALUES (?,?,?,?,?,?,?)')
    .run('耶加雪菲', '埃塞', '浅烘', '花香明显', '杯测 92 分顶级水准', 0, '2026-10-01');
  db.prepare('INSERT INTO bean_notes (bean_name, origin, roast, personal_note, quality_claim, verified, created_on) VALUES (?,?,?,?,?,?,?)')
    .run('慧兰', '哥伦比亚', '中烘', '甜感好', '门店盲测通过', 1, '2026-10-02');
  const { server, base } = await startServer(db);
  try {
    const html = await fetch(`${base}/beans`).then((r) => r.text());
    assert.ok(html.includes('个人记录'), '页面声明为个人记录');
    assert.ok(html.includes('未经核对，非认证事实'), '未核对结论带免责声明');
    const claimSection = html.split('杯测 92 分顶级水准')[0];
    assert.ok(claimSection.includes('未经核对'), '免责标注紧邻未核对结论');
    assert.ok(!html.includes('<span class="badge ok">已核对</span> 杯测 92'), '未核对结论不得标为已核对');
    assert.ok(html.includes('已核对'), '已核对结论有明确标识');
  } finally { server.close(); }
});

/* ---------- 12. 比赛角色与日期、任职有效区间 ---------- */
test('年表展示比赛角色+日期与任职有效区间', async () => {
  const db = openDb(':memory:');
  const shop = db.prepare('INSERT INTO shops (name, address, timezone, updated_at) VALUES (?,?,?,?)')
    .run('门店X', '地址', 'Asia/Shanghai', NOW).lastInsertRowid;
  db.prepare('INSERT INTO employments (shop_id, role, started_on, ended_on) VALUES (?,?,?,?)')
    .run(shop, '咖啡师', '2023-02-01', '2024-05-31');
  db.prepare('INSERT INTO employments (shop_id, role, started_on, ended_on) VALUES (?,?,?,?)')
    .run(shop, '店长', '2024-06-01', null);
  db.prepare('INSERT INTO competitions (name, role, event_date, result) VALUES (?,?,?,?)')
    .run('2024 华东拉花大奖赛', '选手', '2024-04-15', '亚军');
  db.prepare('INSERT INTO competitions (name, role, event_date, result) VALUES (?,?,?,?)')
    .run('2025 春季咖啡节', '评委', '2025-03-22', null);
  db.prepare('INSERT INTO learning_stages (stage, started_on, ended_on, note) VALUES (?,?,?,?)')
    .run('入门阶段', '2022-03-01', '2023-01-31', 'SCA 初级');
  publish(db, { now: NOW });
  const { server, base } = await startServer(db);
  try {
    const html = await fetch(`${base}/timeline`).then((r) => r.text());
    assert.ok(html.includes('2023-02-01 ~ 2024-05-31'), '任职展示有效区间');
    assert.ok(html.includes('2024-06-01 ~ 至今'), '在任区间显示至今');
    assert.ok(html.includes('选手') && html.includes('2024-04-15'), '比赛关联角色与日期');
    assert.ok(html.includes('评委') && html.includes('2025-03-22'), '不同角色分别记录');
    assert.ok(html.includes('入门阶段'), '学习阶段展示');
  } finally { server.close(); }
});
