'use strict';
// 端到端验收：启动一次性服务器（独立 DB），覆盖需求中列出的全部边界场景。
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', 'acceptance.db');
process.env.PORT = '0';
const fs = require('fs');
try { fs.unlinkSync(process.env.DB_PATH); fs.unlinkSync(process.env.DB_PATH + '-wal'); fs.unlinkSync(process.env.DB_PATH + '-shm'); } catch {}

const app = require('../server/index');
const db = require('../server/db');

let server, base;
const started = new Promise((resolve) => { server = app.listen(0, resolve); });
const NOW = '2026-10-06T10:00:00.000Z';

function req(method, pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(base + pathName);
    const r = require('http').request({ hostname: '127.0.0.1', port: server.address().port, path: u.pathname + u.search,
      method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        let chunks = '';
        res.on('data', (d) => (chunks += d));
        res.on('end', () => { try { resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : {} }); } catch (e) { console.error('NON-JSON from', method, u.pathname + u.search, res.statusCode, chunks.slice(0,120)); throw e; } });
      });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const get = (p, h) => req('GET', p, null, h);
const post = (p, b, h) => req('POST', p, b, h);
const put = (p, b, h) => req('PUT', p, b, h);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

async function setup() {
  const t = NOW;
  db.prepare(`INSERT INTO profile (id,name,title,bio,updated_at) VALUES (1,'测试咖啡师','选手','bio',?)`).run(t);
  const st1id = db.prepare("INSERT INTO stores (name,address,tz,active,created_at) VALUES ('旗舰店','旧地址 A','Asia/Shanghai',1,?)").run(t).lastInsertRowid;
  const st2id = db.prepare("INSERT INTO stores (name,address,tz,active,created_at) VALUES ('海外店','Overseas','America/Los_Angeles',1,?)").run(t).lastInsertRowid;
  const ins = db.prepare('INSERT INTO instructors (name,bio,active) VALUES (?,? ,1)').run('讲师甲', '').lastInsertRowid;
  const ins2 = db.prepare('INSERT INTO instructors (name,bio,active) VALUES (?,? ,1)').run('讲师乙', '').lastInsertRowid;
  const a = db.prepare('INSERT INTO stations (name,store_id,active) VALUES (?, ?,1)').run('工位A', st1id).lastInsertRowid;
  const b = db.prepare('INSERT INTO stations (name,store_id,active) VALUES (?, ?,1)').run('工位B', st1id).lastInsertRowid;
  const m1 = db.prepare('INSERT INTO machines (name,model,active) VALUES (?,? ,1)').run('机器1', 'X').lastInsertRowid;
  const m2 = db.prepare('INSERT INTO machines (name,model,active) VALUES (?,? ,1)').run('机器2', 'Y').lastInsertRowid;
  const cid = db.prepare('INSERT INTO courses (title,description,fixed_capacity,published,created_at) VALUES (?,?,6,1,?)')
    .run('基础课', '内容v1', t).lastInsertRowid;
  const cid2 = db.prepare('INSERT INTO courses (title,description,fixed_capacity,published,created_at) VALUES (?,?,6,1,?)')
    .run('工作坊', '工坊', t).lastInsertRowid;
  return { st1id, st2id, ins, ins2, a, b, m1, m2, cid, cid2 };
}

async function createSession(x, overrides = {}) {
  const body = {
    course_id: x.cid, store_id: x.st1id,
    start_utc: '2026-10-20T02:00:00.000Z', end_utc: '2026-10-20T04:00:00.000Z',
    instructor_id: x.ins, station_ids: [x.a, x.b], machine_ids: [x.m1, x.m2], ...overrides
  };
  return post('/api/admin/sessions', body, { 'x-now': NOW });
}

(async () => {
  await started;
  base = 'http://127.0.0.1';
  const x = await setup();
  const dom = require('../server/domain');

  console.log('\n[1] 固定班级容量 vs 资源瓶颈动态计算');
  let r = await createSession(x);
  const sid = r.body.id;
  check('排课成功', r.status === 200, r.body);
  check('固定容量6但讲师=1 -> 动态容量瓶颈=1', r.body.capacity.dynamicCapacity === 1 && r.body.capacity.bottleneck.resource === 'instructor', r.body.capacity);
  let listing = await get('/api/admin/sessions', { 'x-now': NOW });
  const sess = listing.body.find((s) => s.id === sid);
  check('管理端列出全部容量来源并标出瓶颈', sess.capacity.bottlenecks.length === 4 && sess.capacity.bottleneck.label.includes('讲师'), sess.capacity);

  console.log('\n[2] 最后一个工位被并发预订：只有一人成功占位，另一人转候补');
  const results = await Promise.all([
    post(`/api/public/sessions/${sid}/book`, { name: '学员一' }, { 'x-now': NOW }),
    post(`/api/public/sessions/${sid}/book`, { name: '学员二' }, { 'x-now': NOW })
  ]);
  const statuses = results.map((q) => q.body.status).sort();
  check('两笔并发：1 held + 1 waitlisted', JSON.stringify(statuses) === JSON.stringify(['held', 'waitlisted']), results.map((q) => q.body));
  const dup = db.prepare("SELECT station_id, COUNT(*) c FROM bookings WHERE session_id=? AND active=1 AND station_id IS NOT NULL GROUP BY station_id HAVING c>1").all(sid);
  check('数据库层面无同一工位重复占用', dup.length === 0, dup);

  console.log('\n[3] 临时占位到期释放 + 候补自动提升');
  r = await post('/api/admin/maintenance/sweep', {}, { 'x-now': '2026-10-06T10:14:59.000Z' });
  check('未到15分钟不释放', r.body.expired.length === 0, r.body);
  r = await post('/api/admin/maintenance/sweep', {}, { 'x-now': '2026-10-06T10:15:01.000Z' });
  check('过期占位被取消并释放', r.body.expired.length === 1, r.body);
  check('候补按序自动提升为 held', r.body.promoted.length === 1, r.body);
  // 释放给下一位候补的链路：再取消当前 hold，若无候补则不提升
  const heldId = db.prepare("SELECT id FROM bookings WHERE session_id=? AND status='held'").get(sid).id;
  r = await post(`/api/public/bookings/${heldId}/cancel`, {}, { 'x-now': '2026-10-06T10:20:00.000Z' });
  check('手动取消返回成功', r.status === 200 && r.body.cancelled === heldId, r.body);

  console.log('\n[4] 确认绑定当时课程内容与门店地址；后台改址后标记待学员确认（不能只改地图）');
  let book = (await post(`/api/public/sessions/${sid}/book`, { name: '小张' }, { 'x-now': '2026-10-06T10:25:00.000Z' })).body;
  // 先确认一版（地址旧地址A）
  let cf = await post(`/api/public/bookings/${book.booking_id}/confirm`, {}, { 'x-now': '2026-10-06T10:26:00.000Z' });
  check('确认成功并写入快照', cf.status === 200 && cf.body.booking.address_snapshot === '旧地址 A' && cf.body.booking.course_title_snapshot === '基础课', cf.body);
  // 另一位学员先占位
  book = (await post(`/api/public/sessions/${sid}/book`, { name: '小李' }, { 'x-now': '2026-10-06T10:27:00.000Z' })).body;
  check('容量瓶颈下第二位转候补', book.status === 'waitlisted', book);
  // 改址
  let addr = await post(`/api/admin/stores/${x.st1id}/change-address`, { address: '新地址 B 栋 2F' }, { 'x-now': '2026-10-06T10:30:00.000Z' });
  check('改址返回被标记的进行中预约数 >=1', addr.status === 200 && addr.body.marked >= 1, addr.body);
  const markedConfirmed = db.prepare("SELECT reconfirm_required FROM bookings WHERE address_snapshot=? AND status='confirmed'").get('旧地址 A');
  check('已确认学员快照不被覆盖，且被标记待确认', markedConfirmed && markedConfirmed.reconfirm_required === 1, markedConfirmed);
  // 候补提升出的 held 也可能被标记：直接验证 held 记录
  // 用一个新的干净场次验证 held 改址确认流程
  r = await createSession(x, { start_utc: '2026-11-01T02:00:00Z', end_utc: '2026-11-01T04:00:00Z' });
  const sid2 = r.body.id;
  book = (await post(`/api/public/sessions/${sid2}/book`, { name: '小王' }, { 'x-now': '2026-10-06T11:00:00Z' })).body;
  await post(`/api/admin/stores/${x.st1id}/change-address`, { address: '新地址 C' }, { 'x-now': '2026-10-06T11:01:00Z' });
  cf = await post(`/api/public/bookings/${book.booking_id}/confirm`, {}, { 'x-now': '2026-10-06T11:02:00Z' });
  check('未确认新地址 -> 409 ADDRESS_RECONFIRM 并回传新旧地址', cf.status === 409 && cf.body.error === 'ADDRESS_RECONFIRM' && cf.body.new_address === '新地址 C', cf.body);
  cf = await post(`/api/public/bookings/${book.booking_id}/confirm`, { ackNewAddress: true }, { 'x-now': '2026-10-06T11:03:00Z' });
  check('学员确认新地址后通过，绑定新地址', cf.status === 200 && cf.body.booking.address_snapshot === '新地址 C' && cf.body.booking.reconfirm_required === 0, cf.body);

  console.log('\n[5] 讲师排期重叠被拦截');
  const conflict = await createSession(x, { start_utc: '2026-10-20T03:00:00.000Z', end_utc: '2026-10-20T05:00:00.000Z' }); // 与第一场重叠
  check('返回 409 且冲突类型含 instructor', conflict.status === 409 && conflict.body.conflicts.some((c) => c.type === 'instructor'), conflict.body);
  const forced = await post('/api/admin/sessions', {
    course_id: x.cid2, store_id: x.st1id, start_utc: '2026-10-20T03:00:00Z', end_utc: '2026-10-20T05:00:00Z',
    instructor_id: x.ins, station_ids: [x.a], machine_ids: [x.m1], force: true
  }, { 'x-now': NOW });
  check('可 force 强制排课', forced.status === 200, forced.body);
  // 工位/机器跨场重叠也被识别
  const stationConflict = await post('/api/admin/sessions', {
    course_id: x.cid2, store_id: x.st1id, start_utc: '2026-10-20T03:30:00Z', end_utc: '2026-10-20T04:30:00Z',
    instructor_id: x.ins2, station_ids: [x.a], machine_ids: [x.m1]
  }, { 'x-now': NOW });
  check('不同讲师但工位/机器重叠也报冲突', stationConflict.status === 409 &&
    stationConflict.body.conflicts.some((c) => c.type === 'station') && stationConflict.body.conflicts.some((c) => c.type === 'machine'), stationConflict.body);

  console.log('\n[6] 课程跨时区展示（UTC 存储，按门店时区换算）');
  r = await post('/api/admin/sessions', {
    course_id: x.cid, store_id: x.st2id, start_utc: '2026-10-22T18:00:00Z', end_utc: '2026-10-22T21:00:00Z',
    instructor_id: x.ins2, station_ids: [], machine_ids: []
  }, { 'x-now': NOW });
  const tzSid = r.body.id;
  await post('/api/admin/publish/courses', {}, { 'x-now': NOW });
  const pubCourses = await get('/api/public/courses?v=1.0');
  if (pubCourses.body.error) console.log('DEBUG courses err:', JSON.stringify(pubCourses.body).slice(0,400));
  const tzSession = pubCourses.body.courses.flatMap((c) => c.sessions).find((s) => s.id === tzSid);
  check('洛杉矶场次显示当地时区与偏移（PDT UTC-07:00）', tzSession && tzSession.tz === 'America/Los_Angeles' && tzSession.start.utcOffset === '-07:00' && tzSession.start.local.startsWith('2026-10-22 11:00'), tzSession);
  const shSession = pubCourses.body.courses.flatMap((c) => c.sessions).find((s) => s.id === sid2);
  check('上海场次 UTC+08:00', shSession && shSession.start.utcOffset === '+08:00', shSession);

  console.log('\n[7] 作品授权到期：发布后读取时到期也撤照片（文字保留）');
  const t = NOW;
  const wid = db.prepare(`INSERT INTO works (title,photo_url,alt_text,description,store_id,store_name_snapshot,produced_at,license_expires_at,published,created_at)
    VALUES ('授权作品','/img/x.jpg','到期图案文字','描述',?,?,'2026-01-01','2026-09-01T00:00:00Z',1,?)`)
    .run(x.st1id, '旗舰店', t).lastInsertRowid;
  // 另一作品：照片 URL 失效（404），发布时 URL 存在
  const wid2 = db.prepare(`INSERT INTO works (title,photo_url,alt_text,description,store_id,store_name_snapshot,produced_at,published,created_at)
    VALUES ('图挂了','/img/missing-404.jpg','图挂后的文字说明','描述2',?,?,'2026-02-01',1,?)`).run(x.st1id, '旗舰店', t).lastInsertRowid;
  await post('/api/admin/publish/chronology', {}, { 'x-now': NOW });
  const chron = await get('/api/public/chronology?v=1.0');
  const expiredWork = chron.body.payload.works.find((w) => w.id === wid);
  check('授权到期作品照片被撤下但文字保留', expiredWork.photo_url === null && expiredWork.photo_blocked && expiredWork.alt_text.includes('文字'), expiredWork);
  const brokenWork = chron.body.payload.works.find((w) => w.id === wid2);
  check('照片 URL 仍给出（前端 onerror 降级文字），alt 文字存在', brokenWork.photo_url === '/img/missing-404.jpg' && !!brokenWork.alt_text, brokenWork);

  console.log('\n[8] 后台撤课时学员正在确认(held)：拦截确认并要求通知');
  const cancelSidSession = (await createSession(x, { start_utc: '2026-12-01T02:00:00Z', end_utc: '2026-12-01T04:00:00Z' })).body.id;
  const holdBooking = (await post(`/api/public/sessions/${cancelSidSession}/book`, { name: '待确认学员' }, { 'x-now': '2026-10-06T12:00:00Z' })).body;
  const cancelRes = await post(`/api/admin/sessions/${cancelSidSession}/cancel`, { reason: '设备检修' }, { 'x-now': '2026-10-06T12:05:00Z' });
  check('撤课返回必须通知的 held 学员', cancelRes.body.notify.some((n) => n.student === '待确认学员' && n.must_notify), cancelRes.body);
  const notifiedFlag = db.prepare('SELECT notified_of_cancel,status FROM bookings WHERE id=?').get(holdBooking.booking_id);
  check('held 预约标记需通知并取消', notifiedFlag.notified_of_cancel === 1 && notifiedFlag.status === 'cancelled', notifiedFlag);
  const confirmAfterCancel = await post(`/api/public/bookings/${holdBooking.booking_id}/confirm`, {}, { 'x-now': '2026-10-06T12:06:00Z' });
  check('撤课后确认被拒绝', confirmAfterCancel.status >= 400, confirmAfterCancel.body);

  console.log('\n[9] 调店后旧作品不自动改成新门店出品（门店快照冻结）');
  // wid 出品于 st1id 旗舰店；把门店改名/改址，作品快照不变
  await put(`/api/admin/stores/${x.st1id}`, { name: '旗舰店（已升级）' });
  const wrow = db.prepare('SELECT store_id,store_name_snapshot FROM works WHERE id=?').get(wid);
  check('作品 store_id 与名称快照保持创作当时值', wrow.store_id === x.st1id && wrow.store_name_snapshot === '旗舰店', wrow);

  console.log('\n[10] 年表/课程页从兼容发布版本读取（草稿不直接上站 + 版本兼容）');
  const before = await get('/api/public/chronology?v=1.0');
  const vBefore = before.body.version;
  db.prepare("INSERT INTO competitions (name,role,category,date,description,published,created_at) VALUES ('待发布赛事','选手','x','2026-10-01','d',1,?)").run(NOW);
  const mid = await get('/api/public/chronology?v=1.0');
  check('未重新发布前草稿不出现在公开年表', mid.body.version === vBefore && !JSON.stringify(mid.body.payload.competitions).includes('待发布赛事'));
  await post('/api/admin/publish/chronology', {}, { 'x-now': NOW });
  const after = await get('/api/public/chronology?v=1.0');
  check('重新发布后出现，版本号递增', after.body.version === vBefore + 1 && JSON.stringify(after.body.payload.competitions).includes('待发布赛事'));
  const v2Reader = await get('/api/public/chronology?v=2.0');
  check('读取端 v2 不兼容 1.x 发布（主版本不匹配）', v2Reader.status === 404, v2Reader.body);
  const v1Reader = await get('/api/public/chronology?v=1.9');
  check('读取端 1.9 可兼容 1.x 发布', v1Reader.status === 200 && v1Reader.body.version === vBefore + 1);

  console.log('\n[11] 豆单是个人记录：未核对品质结论不当作认证事实');
  await post('/api/admin/beans', { roaster: '自烘', origin: '肯尼亚', process: '水洗', personal_notes: '像黑醋栗（主观）', verified: false });
  const beans = await get('/api/public/beans');
  check('公开豆单带免责声明且记录 verified=0', beans.body.disclaimer.includes('不构成') && beans.body.disclaimer.includes('未经第三方核对') && beans.body.beans[0].verified === 0, beans.body.disclaimer);
  check('年表不携带豆单的主观品质结论', !('beans' in (await get('/api/public/chronology?v=1.0')).body.payload));

  console.log('\n[12] 成长证据连接后台数据库');
  const ev = await get('/api/admin/evidence');
  check('预约确认生成成长证据记录', ev.body.some((e) => e.kind === 'booking' && e.ref_table === 'bookings'), ev.body.slice(0, 2));

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  server.close(); db.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
