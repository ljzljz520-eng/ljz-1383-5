'use strict';

// 全部表结构。说明性注释同步对应验收规则。
module.exports = `
PRAGMA foreign_keys = ON;

-- 个人资料（咖啡师履历主信息）
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  title TEXT,
  bio TEXT,
  updated_at TEXT NOT NULL
);

-- 门店
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  tz TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 任职区间：同一个人在同一门店的有效区间不得重叠
CREATE TABLE IF NOT EXISTS employments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  role TEXT NOT NULL,
  start_date TEXT NOT NULL,  -- ISO 日期 YYYY-MM-DD
  end_date TEXT,             -- NULL 表示至今
  note TEXT,
  created_at TEXT NOT NULL
);

-- 作品（拉花照片等）。store_id 在创建时"冻结"：调店后不随门店变化而改写
CREATE TABLE IF NOT EXISTS works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  photo_url TEXT,            -- 公开展示图，可能失效
  alt_text TEXT,             -- 图片失败时保留的文字
  description TEXT,
  store_id INTEGER REFERENCES stores(id),  -- 出品门店（冻结快照）
  store_name_snapshot TEXT,                -- 门店名称快照，防止门店改名后年表含义漂移
  produced_at TEXT,                        -- 出品日期
  license_expires_at TEXT,                 -- 照片授权到期时间（ISO），到期不得展示照片
  license_note TEXT,
  published INTEGER NOT NULL DEFAULT 0,    -- 是否发布到公开年表
  created_at TEXT NOT NULL
);

-- 比赛经历：关联具体角色与日期
CREATE TABLE IF NOT EXISTS competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,                     -- 如：选手/评委/教练/志愿者
  category TEXT,                          -- 如：拿铁艺术
  date TEXT NOT NULL,                     -- 比赛日期
  ranking TEXT,
  description TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 学习阶段（时间轴）
CREATE TABLE IF NOT EXISTS learning_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  stage TEXT,                             -- 入门/进阶/比赛训练 等
  start_date TEXT,
  end_date TEXT,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 成长证据（连接后台数据库：作品/素材/预约等产生的成长记录）
CREATE TABLE IF NOT EXISTS growth_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  kind TEXT,                              -- evidence/material/booking/work
  ref_table TEXT,
  ref_id INTEGER,
  occurred_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

-- 素材库
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  kind TEXT,                              -- doc/video/image
  url TEXT,
  description TEXT,
  created_at TEXT NOT NULL
);

-- 豆单：个人记录，非认证事实（杯测口味等"未经核对的品质结论"不得作为认证）
CREATE TABLE IF NOT EXISTS bean_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roaster TEXT,
  origin TEXT,
  process TEXT,
  roast_date TEXT,
  personal_notes TEXT,                    -- 明确为个人主观记录
  verified INTEGER NOT NULL DEFAULT 0,    -- 0=未核对
  created_at TEXT NOT NULL
);

-- 讲师
CREATE TABLE IF NOT EXISTS instructors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  bio TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

-- 工位
CREATE TABLE IF NOT EXISTS stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  store_id INTEGER REFERENCES stores(id),
  active INTEGER NOT NULL DEFAULT 1
);

-- 机器
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  model TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

-- 课程定义（固定班级容量为"上限"，实际可订容量按讲师/工位/机器瓶颈动态计算）
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  fixed_capacity INTEGER NOT NULL,       -- 固定班级容量
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 排课：同时占用讲师、工位、机器
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  store_id INTEGER NOT NULL REFERENCES stores(id),
  start_utc TEXT NOT NULL,               -- UTC ISO
  end_utc TEXT NOT NULL,
  instructor_id INTEGER NOT NULL REFERENCES instructors(id),
  station_ids TEXT NOT NULL,             -- JSON 数组
  machine_ids TEXT NOT NULL,             -- JSON 数组
  status TEXT NOT NULL DEFAULT 'open',   -- open/cancelled
  cancel_reason TEXT,
  address_snapshot TEXT,                 -- 排课时的门店地址（预约确认时再绑定一份）
  created_at TEXT NOT NULL
);

-- 预约。active=1 的 held/confirmed 预约消耗具体工位/机器/讲师（讲师由 session 决定）
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  student_name TEXT NOT NULL,
  student_contact TEXT,
  status TEXT NOT NULL,                 -- held/confirmed/waitlisted/cancelled
  station_id INTEGER REFERENCES stations(id),
  machine_id INTEGER REFERENCES machines(id),
  held_expires_at TEXT,                 -- 临时占位过期时间（UTC）
  confirmed_at TEXT,
  -- 预约确认时绑定的当时课程内容与门店地址（快照，后续改址不覆盖）
  course_title_snapshot TEXT,
  course_content_snapshot TEXT,
  address_snapshot TEXT,
  -- 门店改址后需学员重新确认
  reconfirm_required INTEGER NOT NULL DEFAULT 0,
  reconfirm_reason TEXT,
  notified_of_cancel INTEGER NOT NULL DEFAULT 0,  -- 撤课时学员正在确认（held）需要通知
  active INTEGER NOT NULL DEFAULT 1,             -- 活跃占位；取消即 0（唯一索引释放资源）
  created_at TEXT NOT NULL
);

-- 同一 session 下具体工位/机器不得被两笔活跃预约占用（最后一个工位并发预订的关键约束）
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_session_station
  ON bookings(session_id, station_id) WHERE active = 1 AND station_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_session_machine
  ON bookings(session_id, machine_id) WHERE active = 1 AND machine_id IS NOT NULL;

-- 兼容发布版本：年表与课程页从"已发布且兼容读取端"的版本取数，而非直接读实时编辑数据
CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                   -- chronology / courses
  version INTEGER NOT NULL,
  reader_version TEXT NOT NULL,         -- 发布目标读取端版本，如 '1.x'
  payload TEXT NOT NULL,                -- JSON 快照
  published_at TEXT NOT NULL,
  UNIQUE(kind, version)
);
`;
