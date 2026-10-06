'use strict';
process.env.DB_PATH = process.env.DB_PATH || require('path').join(__dirname, '..', 'data', 'seed.db');
const db = require('./db');
const dom = require('./domain');

db.pragma('foreign_keys = ON');
db.exec(`DELETE FROM bookings;DELETE FROM sessions;DELETE FROM courses;DELETE FROM machines;DELETE FROM stations;DELETE FROM instructors;
  DELETE FROM bean_log;DELETE FROM materials;DELETE FROM growth_evidence;DELETE FROM learning_stages;DELETE FROM competitions;
  DELETE FROM works;DELETE FROM employments;DELETE FROM stores;DELETE FROM publications;DELETE FROM profile;
  DELETE FROM sqlite_sequence;`);

const t = new Date().toISOString();
db.prepare(`INSERT INTO profile (id,name,title,bio,updated_at) VALUES (1,?,?,?,?)`)
  .run('林岸', '资深咖啡师 · 拿铁艺术选手', '专注意式萃取与拉花，参加过 W 区域赛，正在备赛训练阶段。', t);

const insStore = db.prepare('INSERT INTO stores (name,address,tz,active,created_at) VALUES (?,?,?,1,?)');
const sh = insStore.run('河滨旗舰店（上海）', '上海市静安区南京西路 1788 号 1F', 'Asia/Shanghai', t).lastInsertRowid;
const la = insStore.run('Harbor Lab（洛杉矶）', '120 Figueroa St, Los Angeles, CA', 'America/Los_Angeles', t).lastInsertRowid;

db.prepare('INSERT INTO employments (store_id,role,start_date,end_date,note,created_at) VALUES (?,?,?,?,?,?)')
  .run(sh, '主理咖啡师', '2023-03-01', null, '在职', t);
db.prepare('INSERT INTO employments (store_id,role,start_date,end_date,note,created_at) VALUES (?,?,?,?,?,?)')
  .run(la, '客座咖啡师', '2021-06-01', '2023-02-28', '已离任；旧作品仍归属此店', t);

// 作品：正常照片 / 照片失效但有文字 / 授权到期
db.prepare(`INSERT INTO works (title,photo_url,alt_text,description,store_id,store_name_snapshot,produced_at,license_expires_at,license_note,published,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  .run('天鹅拉花', '/img/sample.svg', '意式浓缩上的天鹅奶泡图案', '对称翼展练习，奶温 60°C', la, 'Harbor Lab（洛杉矶）', '2022-09-10T00:00:00.000Z', '2030-01-01T00:00:00.000Z', '商用授权至 2030', 1, t);
db.prepare(`INSERT INTO works (title,photo_url,alt_text,description,store_id,store_name_snapshot,produced_at,license_expires_at,license_note,published,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  .run('郁金香六层', '/img/missing-photo.jpg', '六层郁金香拉花的文字记录', '照片托管失败，保留文字：六层等距郁金香，融合点居中', sh, '河滨旗舰店（上海）', '2024-05-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', '', 1, t);
db.prepare(`INSERT INTO works (title,photo_url,alt_text,description,store_id,store_name_snapshot,produced_at,license_expires_at,license_note,published,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  .run('获奖玫瑰（授权已到期）', '/img/rose.jpg', '比赛获奖玫瑰图案', '照片授权 2025 年到期，公开展示撤下照片，仅保留文字', la, 'Harbor Lab（洛杉矶）', '2022-11-20T00:00:00.000Z', '2025-12-31T00:00:00.000Z', '授权已过期', 1, t);

// 比赛经历：角色 + 日期
const comp = db.prepare('INSERT INTO competitions (name,role,category,date,ranking,description,published,created_at) VALUES (?,?,?,?,?,?,1,?)');
comp.run('W Latte Art 区域赛 2022', '选手', '拿铁艺术', '2022-11-19', '季军', '指定图形 + 自选图形两轮', t);
comp.run('城市拉花联赛 2023', '评委', '评委团', '2023-08-05', '', '负责图形对称性打分', t);
comp.run('新秀赛 2024', '教练', '教练组', '2024-04-12', '', '带训两名新手选手', t);

// 学习阶段
const stage = db.prepare('INSERT INTO learning_stages (title,stage,start_date,end_date,description,sort_order,published,created_at) VALUES (?,?,?,?,?,?,1,?)');
stage.run('入门：奶泡与融合', '入门', '2020-09-01', '2021-05-30', '掌握奶泡打发与基础融合', 1, t);
stage.run('进阶：图形体系', '进阶', '2021-06-01', '2022-10-31', '心形、郁金香、天鹅系统化训练', 2, t);
stage.run('比赛训练', '备赛', '2022-09-01', null, '稳定输出与赛时节奏', 3, t);

// 资源
const insI = db.prepare('INSERT INTO instructors (name,bio,active) VALUES (?,?,1)');
const i1 = insI.run('林岸', '主理人/讲师').lastInsertRowid;
const i2 = insI.run('Maya Chen', '外聘拉花教练').lastInsertRowid;
const insStation = db.prepare('INSERT INTO stations (name,store_id,active) VALUES (?,?,1)');
const st1 = insStation.run('A 工位（上海）', sh).lastInsertRowid;
const st2 = insStation.run('B 工位（上海）', sh).lastInsertRowid;
const st3 = insStation.run('C 工位（洛杉矶）', la).lastInsertRowid;
const insM = db.prepare('INSERT INTO machines (name,model,active) VALUES (?,?,1)');
const m1 = insM.run('La Marzocco #1', 'Linea PB').lastInsertRowid;
const m2 = insM.run('Slayer #2', 'Slayer Steam EP').lastInsertRowid;

// 课程：固定 10 人，但每场只 1 名讲师 -> 动态容量瓶颈=1
const c1 = db.prepare('INSERT INTO courses (title,description,fixed_capacity,published,created_at) VALUES (?,?,?,1,?)')
  .run('拿铁艺术基础', '奶泡、融合与心形/郁金香。固定班级容量 10，实际按讲师/工位/机器瓶颈动态计算。', 10, t).lastInsertRowid;
const c2 = db.prepare('INSERT INTO courses (title,description,fixed_capacity,published,created_at) VALUES (?,?,?,1,?)')
  .run('赛级图形工作坊', '天鹅与复杂复合图形，小班制。', 10, t).lastInsertRowid;

db.prepare(`INSERT INTO sessions (course_id,store_id,start_utc,end_utc,instructor_id,station_ids,machine_ids,address_snapshot,created_at)
  VALUES (?,?,?,?,?,?,?,?,?)`).run(c1, sh, '2026-10-20T02:00:00.000Z', '2026-10-20T05:00:00.000Z', i1, JSON.stringify([st1, st2]), JSON.stringify([m1, m2]), '上海市静安区南京西路 1788 号 1F', t);
db.prepare(`INSERT INTO sessions (course_id,store_id,start_utc,end_utc,instructor_id,station_ids,machine_ids,address_snapshot,created_at)
  VALUES (?,?,?,?,?,?,?,?,?)`).run(c2, la, '2026-10-22T18:00:00.000Z', '2026-10-22T21:00:00.000Z', i2, JSON.stringify([st3]), JSON.stringify([m2]), '120 Figueroa St, Los Angeles, CA', t);

// 豆单：明确个人记录
db.prepare('INSERT INTO bean_log (roaster,origin,process,roast_date,personal_notes,verified,created_at) VALUES (?,?,?,?,?,0,?)')
  .run('河滨自烘', '埃塞 Yirgacheffe', '水洗', '2026-09-20', '个人感觉柑橘明亮、回甘长（未经第三方核对，非认证结论）', t);

db.prepare('INSERT INTO materials (title,kind,url,description,created_at) VALUES (?,?,?,?,?)')
  .run('奶泡打发 SOP', 'doc', '/files/milk-sop.pdf', '内部训练材料', t);

const p1 = dom.publish('chronology');
const p2 = dom.publish('courses');
console.log('seed done at', process.env.DB_PATH);
console.log('published:', p1, p2);
