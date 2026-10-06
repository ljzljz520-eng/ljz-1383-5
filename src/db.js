'use strict';
/**
 * 数据库层：SQLite（WAL + 外键），所有多步写入均在事务内完成。
 *
 * 关键设计：
 * - works.shop_id 是「出品时门店快照」，调店（新增任职区间）不会回写旧作品。
 * - bookings.*_snapshot 在「确认」时绑定当时课程内容与门店地址；
 *   门店改址只 bump address_version 并把受影响预约标记 reconfirm_required，
 *   不会静默覆盖快照（不能只更新页面地图）。
 * - published_versions 承载公开年表与课程页的数据，公开端只读「兼容」版本。
 */
const Database = require('better-sqlite3');

const CURRENT_SCHEMA_VERSION = '2.0';
const schemaMajor = (v) => String(v == null ? '' : v).split('.')[0];
const isCompatible = (v) => schemaMajor(v) === schemaMajor(CURRENT_SCHEMA_VERSION);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  address_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- 店铺任职：有效区间（ended_on NULL = 至今）
CREATE TABLE IF NOT EXISTS employments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  role TEXT NOT NULL,
  started_on TEXT NOT NULL,
  ended_on TEXT
);

-- 比赛经历：关联具体角色与日期
CREATE TABLE IF NOT EXISTS competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  event_date TEXT NOT NULL,
  result TEXT
);

-- 学习阶段
CREATE TABLE IF NOT EXISTS learning_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage TEXT NOT NULL,
  started_on TEXT NOT NULL,
  ended_on TEXT,
  note TEXT
);

-- 拉花作品：shop_id 为出品门店快照；license_expires_on 为素材授权到期日
CREATE TABLE IF NOT EXISTS works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'latte_art',
  description TEXT NOT NULL,
  photo_url TEXT,
  shop_id INTEGER REFERENCES shops(id),
  created_on TEXT NOT NULL,
  license_expires_on TEXT
);

CREATE TABLE IF NOT EXISTS instructors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);

-- 资源池：工位与机器均属于门店
CREATE TABLE IF NOT EXISTS workstations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  label TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  label TEXT NOT NULL
);

-- 课程：capacity_mode = fixed（固定班级容量）| dynamic（按资源瓶颈动态计算）
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_version INTEGER NOT NULL DEFAULT 1,
  capacity_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (capacity_mode IN ('fixed','dynamic')),
  fixed_capacity INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);

-- 课次：同时占用讲师 + 工位 + 机器（demo_* 为讲师演示占用，学员每席再各占 1）
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  instructor_id INTEGER NOT NULL REFERENCES instructors(id),
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  start_utc TEXT NOT NULL,          -- 统一存 UTC，展示层负责跨时区换算
  end_utc TEXT NOT NULL,
  demo_ws INTEGER NOT NULL DEFAULT 1,
  demo_machines INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled'))
);

-- 预约：held(临时占位) / confirmed / waitlisted(候补) / cancelled / expired
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  student_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held','confirmed','waitlisted','cancelled','expired')),
  hold_expires_at TEXT,             -- 临时占位过期时间（过期自动释放并晋升候补）
  -- 确认时绑定的快照（当时课程内容 + 当时门店地址）
  course_title_snapshot TEXT,
  course_content_snapshot TEXT,
  course_content_version_snapshot INTEGER,
  shop_name_snapshot TEXT,
  shop_address_snapshot TEXT,
  shop_address_version_snapshot INTEGER,
  shop_timezone_snapshot TEXT,
  reconfirm_required INTEGER NOT NULL DEFAULT 0,  -- 改址后待学员确认
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_session ON bookings(session_id, state);
CREATE INDEX IF NOT EXISTS idx_sessions_shop_time ON sessions(shop_id, start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_sessions_instructor ON sessions(instructor_id, start_utc, end_utc);

-- 发布版本：公开年表与课程页只读取「兼容」的发布版本
CREATE TABLE IF NOT EXISTS published_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_no INTEGER NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  published_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

-- 豆单：个人记录；未经核对的品质结论不得当作认证事实
CREATE TABLE IF NOT EXISTS bean_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bean_name TEXT NOT NULL,
  origin TEXT,
  roast TEXT,
  personal_note TEXT NOT NULL,
  quality_claim TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  created_on TEXT NOT NULL
);
`;

function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb, CURRENT_SCHEMA_VERSION, isCompatible, schemaMajor };
