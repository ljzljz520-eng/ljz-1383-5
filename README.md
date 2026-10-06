# 咖啡师履历与课程站

展示拉花作品、比赛经历、学习阶段；管理端编辑门店/任职/课程/排课；后台数据库连接成长证据、素材、豆单与预约。

## 运行

```bash
npm install
npm run seed          # 生成演示数据并发布（data/seed.db）
DB_PATH=./data/seed.db npm start
# 公开站 http://localhost:3000/   管理端 http://localhost:3000/admin/
npm test              # 33 项端到端验收（独立 data/acceptance.db）
```

## 关键规则如何落实

| 需求 | 实现 |
| --- | --- |
| 拉花/比赛/学习阶段 Web 展示 | 公开年表（作品、比赛含**角色+日期**、学习阶段、任职有效区间） |
| 比赛经历关联角色与日期 | `competitions.role/date` 必填 |
| 店铺任职有有效区间 | `employments.start_date/end_date`，同店区间重叠被拒 |
| 调店后旧作品不改成新门店出品 | `works.store_id + store_name_snapshot` 创建时**冻结**，编辑接口不允许改 |
| 课程同时占用讲师/工位/机器 | `sessions` 排课做三类冲突检测（讲师重叠/工位/机器） |
| 固定容量 vs 动态瓶颈 | 实际可订 = min(固定容量, 讲师数1, 可用工位, 可用机器)；管理端逐行列出容量来源并标红瓶颈 |
| 候补/临时占位/取消释放 | `held`(15分钟过期)/`waitlisted`/`confirmed`/`cancelled`；事务内清理过期占位并按序提升候补 |
| 最后一个工位并发预订 | 整段预订事务 + SQLite 部分唯一索引 `(session_id,station_id) WHERE active=1`，冲突方自动转候补 |
| 确认绑定当时课程内容与地址 | 确认时写入 `course_title/content/address` 快照 |
| 改址需学员确认 | 改址走专用接口，更新地址同时把进行中/已确认预约标记 `reconfirm_required`；学员未确认新址时确认返回 409（不是只改页面地图） |
| 课程跨时区 | 全部 UTC 存储，展示按门店 IANA 时区换算并显示偏移（上海 +08:00 / 洛杉矶 -07:00） |
| 作品授权到期 | 发布与读取两道检查；到期撤照片，前端 `onerror` 对加载失败保留 alt 文字 |
| 撤课时学员正在确认 | held 预约被取消且 `notified_of_cancel=1`，之后确认被拒 |
| 年表/课程页读兼容发布版本 | 草稿不直接上站；`publications` 快照带 reader 主版本兼容（1.x 服务所有 1.y，拒绝 2.x） |
| 豆单是个人记录 | 公开接口带免责声明，`verified=0` 的主观结论不呈现为认证事实 |
| 成长证据/素材 | `growth_evidence`（预约确认自动写一条）、`materials` 后台连接 |

## 结构

- `server/schema.js` 表结构（含部分唯一索引）
- `server/domain.js` 事务、容量、冲突、候补、快照、发布/兼容读取
- `server/tz.js` 跨时区换算
- `server/index.js` Express API（公开端 + 管理端）
- `public/` 公开站；`admin/` 管理端；`test/acceptance.test.js` 验收
