'use strict';
/** 演示种子数据：覆盖调店、授权到期、破损照片、固定/动态容量、跨时区、未核对豆单等场景。 */
const { openDb } = require('./db');
const { publish } = require('./services/publishing');

function seedIfEmpty(db) {
  const has = db.prepare('SELECT COUNT(*) AS c FROM shops').get().c > 0;
  if (has) return false;
  seed(db);
  return true;
}

function seed(db) {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const tx = db.transaction(() => {
    /* 门店 */
    const insShop = db.prepare('INSERT INTO shops (name, address, timezone, updated_at) VALUES (?,?,?,?)');
    const shopA = insShop.run('朝花咖啡·静安店', '上海市静安区延平路 121 号 1 层', 'Asia/Shanghai', now).lastInsertRowid;
    const shopB = insShop.run('朝花咖啡·徐汇店', '上海市徐汇区衡山路 320 号', 'Asia/Shanghai', now).lastInsertRowid;
    const shopC = insShop.run('友店·纽约快闪', '112 Greene St, New York, NY', 'America/New_York', now).lastInsertRowid;

    /* 任职区间：静安 → 徐汇（调店），旧作品仍属静安 */
    const insEmp = db.prepare('INSERT INTO employments (shop_id, role, started_on, ended_on) VALUES (?,?,?,?)');
    insEmp.run(shopA, '咖啡师', '2023-02-01', '2024-05-31');
    insEmp.run(shopB, '资深咖啡师 / 讲师', '2024-06-01', null);

    /* 学习阶段 */
    const insStage = db.prepare('INSERT INTO learning_stages (stage, started_on, ended_on, note) VALUES (?,?,?,?)');
    insStage.run('入门：意式萃取与奶泡基础', '2022-03-01', '2023-01-31', '完成 SCA 咖啡师初级课程');
    insStage.run('进阶：拉花图形与出品稳定性', '2023-02-01', '2024-01-31', '郁金香/天鹅稳定出品');
    insStage.run('精进：教学与评审', '2024-02-01', null, '开始带小班课程');

    /* 比赛经历：具体角色 + 日期 */
    const insComp = db.prepare('INSERT INTO competitions (name, role, event_date, result) VALUES (?,?,?,?)');
    insComp.run('2023 城市拉花挑战赛', '选手', '2023-09-16', '八强');
    insComp.run('2024 华东拉花大奖赛', '选手', '2024-04-15', '亚军');
    insComp.run('2025 春季咖啡节拉花赛', '评委', '2025-03-22', null);
    insComp.run('2025 门店新秀训练营', '教练', '2025-06-10', '带队 2 人进决赛');

    /* 作品：shop_id 为出品时快照；含授权到期与破损照片样例 */
    const insWork = db.prepare(
      'INSERT INTO works (title, description, photo_url, shop_id, created_on, license_expires_on) VALUES (?,?,?,?,?,?)');
    insWork.run('郁金香', '三段郁金香，奶泡厚度 0.5cm，对比度干净。',
      'https://invalid.example.com/photos/tulip.jpg', shopA, '2023-06-18', '2099-01-01'); // 照片地址失效 → 前端保留文字
    insWork.run('天鹅', '天鹅拉花，展翅对称。', 'https://invalid.example.com/photos/swan.jpg',
      shopA, '2024-01-10', '2025-01-01'); // 授权已到期 → 服务端直接不渲染图片
    insWork.run('玫瑰花', '玫瑰花拉花，徐汇店出品（调店后新作）。', null, shopB, '2024-08-02', null);

    /* 讲师与资源 */
    const insInstr = db.prepare('INSERT INTO instructors (name) VALUES (?)');
    const instrMe = insInstr.run('阿禾（主理咖啡师）').lastInsertRowid;
    const instrGuest = insInstr.run('客座讲师·小林').lastInsertRowid;
    const insWs = db.prepare('INSERT INTO workstations (shop_id, label) VALUES (?,?)');
    const insMach = db.prepare('INSERT INTO machines (shop_id, label) VALUES (?,?)');
    for (let i = 1; i <= 4; i++) insWs.run(shopA, `静安工位 ${i}`);
    for (let i = 1; i <= 3; i++) insMach.run(shopA, `静安半自动机 ${i}`);
    for (let i = 1; i <= 6; i++) insWs.run(shopB, `徐汇工位 ${i}`);
    for (let i = 1; i <= 4; i++) insMach.run(shopB, `徐汇半自动机 ${i}`);
    insWs.run(shopC, '快闪工位 1');
    insMach.run(shopC, '快闪单头机 1');

    /* 课程：固定容量 vs 动态瓶颈 */
    const insCourse = db.prepare(
      'INSERT INTO courses (title, content, capacity_mode, fixed_capacity) VALUES (?,?,?,?)');
    const c1 = insCourse.run('拉花基础班', '奶泡打发、融合手法与心形/郁金香入门，含 2 小时实操。', 'fixed', 8).lastInsertRowid;
    const c2 = insCourse.run('进阶拉花工作坊', '天鹅/玫瑰花拆解，按工位与机器动态控制人数，1 人 1 工位 1 机。', 'dynamic', null).lastInsertRowid;

    /* 课次（UTC 存储；上海 10:00 = UTC 02:00） */
    const insSession = db.prepare(
      'INSERT INTO sessions (course_id, instructor_id, shop_id, start_utc, end_utc, demo_ws, demo_machines) VALUES (?,?,?,?,?,?,?)');
    insSession.run(c1, instrMe, shopB, '2026-11-08T02:00:00.000Z', '2026-11-08T04:00:00.000Z', 1, 1);
    insSession.run(c2, instrMe, shopB, '2026-11-15T06:00:00.000Z', '2026-11-15T09:00:00.000Z', 1, 1);
    insSession.run(c2, instrGuest, shopC, '2026-11-20T14:00:00.000Z', '2026-11-20T16:00:00.000Z', 0, 0); // 纽约 09:00

    /* 豆单：个人记录；未核对结论不作认证事实 */
    const insBean = db.prepare(
      'INSERT INTO bean_notes (bean_name, origin, roast, personal_note, quality_claim, verified, created_on) VALUES (?,?,?,?,?,?,?)');
    insBean.run('耶加雪菲 日晒 G1', '埃塞俄比亚', '浅烘', '手冲有蓝莓与茉莉花香，奶咖偏酸不太适合。',
      '杯测约 90 分水准', 0, today); // 未核对 → 公开页必须带免责
    insBean.run('慧兰 水洗', '哥伦比亚', '中烘', '做澳白甜感好，出杯稳定。', null, 0, today);
    insBean.run('曼特宁 湿刨', '印度尼西亚', '深烘', '奶咖基底厚重，客人复购高。',
      '门店盲测通过率 80%', 1, today); // 已核对
  });
  tx();
  publish(db, { now });
  console.log('种子数据已写入并发布 v1');
  return { seeded: true };
}

if (require.main === module) {
  const path = require('path');
  const fs = require('fs');
  const dir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const db = openDb(path.join(dir, 'barista.db'));
  if (seedIfEmpty(db)) console.log('完成'); else console.log('已有数据，跳过（如需重置请删除 data/barista.db）');
}

module.exports = { seed, seedIfEmpty };
