'use strict';
const { esc, formatInTz, rangeText, todayUtc } = require('./format');
const { workAttribution } = require('./services/publishing');

const CSS = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; color: #2b2118; background: #faf6f0; }
  header { background: #4b3621; color: #fff; padding: 12px 20px; }
  header a { color: #f3e3cf; margin-right: 16px; text-decoration: none; }
  header a:hover { color: #fff; }
  main { max-width: 960px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.2rem; border-left: 4px solid #a9744f; padding-left: 8px; }
  .card { background: #fff; border: 1px solid #e5d9c8; border-radius: 8px; padding: 14px 16px; margin: 12px 0; }
  .muted { color: #8a7a68; font-size: .9rem; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: .8rem; background: #eee; }
  .badge.warn { background: #fde8c8; color: #8a5a00; }
  .badge.err { background: #f8d7da; color: #842029; }
  .badge.ok { background: #d1e7dd; color: #0f5132; }
  .photo-fallback { border: 1px dashed #c9b391; background: #fff8ec; padding: 18px; border-radius: 8px; }
  img.work-photo { max-width: 260px; border-radius: 8px; display: block; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  th, td { border: 1px solid #e5d9c8; padding: 6px 10px; text-align: left; font-size: .92rem; vertical-align: top; }
  th { background: #f1e7d8; }
  input, select, textarea { padding: 6px 8px; border: 1px solid #cbb693; border-radius: 6px; font-size: .95rem; }
  button, .btn { background: #6f4e2f; color: #fff; border: 0; padding: 7px 14px; border-radius: 6px; cursor: pointer; text-decoration: none; display: inline-block; font-size: .92rem; }
  button.danger { background: #a33; }
  form.inline { display: inline; }
  .alert { padding: 10px 14px; border-radius: 8px; margin: 10px 0; }
  .alert.warn { background: #fff3cd; border: 1px solid #ffec99; }
  .alert.err { background: #f8d7da; border: 1px solid #f1aeb5; }
  footer { text-align: center; color: #9b8a76; font-size: .8rem; padding: 24px; }
`;

function layout(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 咖啡师履历与课程</title>
<style>${CSS}</style></head>
<body><header><nav>
<a href="/">首页</a><a href="/timeline">成长年表</a><a href="/works">拉花作品</a><a href="/courses">课程</a><a href="/beans">豆单</a><a href="/admin">管理端</a>
</nav></header><main>${body}</main>
<footer>公开年表与课程页读取自兼容发布版本 · 豆单为个人记录，未经核对的品质结论不作为认证事实</footer>
<script>
// 公开照片失败保留文字：图片加载失败时移除 <img> 并展示文字卡片
document.querySelectorAll('img.work-photo').forEach(function (img) {
  img.addEventListener('error', function () {
    var wrap = img.closest('.work-photo-wrap');
    var fallback = wrap ? wrap.querySelector('.photo-fallback') : null;
    if (fallback) fallback.hidden = false;
    img.remove();
  });
});
// 课程跨时区展示：把 data-utc 的时间换算为浏览者本地时区
document.querySelectorAll('[data-utc]').forEach(function (el) {
  try {
    var d = new Date(el.getAttribute('data-utc'));
    el.textContent = d.toLocaleString('zh-CN', { hour12: false, dateStyle: 'medium', timeStyle: 'short' });
  } catch (e) { /* 保留服务端渲染文本 */ }
});
</script>
</body></html>`;
}

function errorPage(title, message, status) {
  return layout('出错了', `<div class="alert err"><h1>${esc(title)}</h1><p>${esc(message)}</p></div>
  <p><a class="btn" href="javascript:history.back()">返回</a> <a class="btn" href="/">回首页</a></p>`);
}

/* ---------------- 公开页 ---------------- */

function homePage() {
  return layout('首页', `
  <h1>咖啡师履历与课程站</h1>
  <div class="card"><p>这里展示我的拉花作品、比赛经历与学习阶段，并提供小班课程预约。</p>
  <p><a class="btn" href="/timeline">查看成长年表</a> <a class="btn" href="/courses">浏览课程</a></p></div>`);
}

function timelinePage(pub) {
  if (!pub) return layout('成长年表', '<div class="alert warn">暂无已发布内容。</div>');
  const t = pub.payload.timeline;
  const stages = t.stages.map((s) => `<li class="stage"><b>${esc(s.stage)}</b>
    <span class="muted">（${esc(rangeText(s.started_on, s.ended_on))}）</span>${s.note ? ` — ${esc(s.note)}` : ''}</li>`).join('');
  const employments = t.employments.map((e) => `<li class="employment" data-shop-id="${e.shop_id}">
    <b>${esc(e.shop_name)}</b> · ${esc(e.role)}
    <span class="muted">（任职区间：${esc(rangeText(e.started_on, e.ended_on))}）</span></li>`).join('');
  const competitions = t.competitions.map((c) => `<li class="competition">
    <time>${esc(c.event_date)}</time> · ${esc(c.name)} — 角色：<span class="role">${esc(c.role)}</span>${c.result ? ` · ${esc(c.result)}` : ''}</li>`).join('');
  const works = t.works.map((w) => {
    const attr = workAttribution(pub.payload, w);
    return `<li class="work" data-work-id="${w.id}">${esc(w.created_on)} · 《${esc(w.title)}》
      出品门店：<span class="work-shop">${esc(attr.shop_name)}</span>
      ${attr.verified ? '<span class="badge ok">任职期间核实</span>' : '<span class="badge warn">门店归属待核实</span>'}</li>`;
  }).join('');
  return layout('成长年表', `
  <h1>成长年表</h1>
  <p class="muted">数据来自发布版本 v${pub.version_no}（发布于 ${esc(pub.published_at)}），管理端未发布的修改不会出现在这里。</p>
  <h2>学习阶段</h2><ul>${stages || '<li class="muted">暂无</li>'}</ul>
  <h2>门店任职（有效区间）</h2><ul>${employments || '<li class="muted">暂无</li>'}</ul>
  <h2>比赛经历（角色 · 日期）</h2><ul>${competitions || '<li class="muted">暂无</li>'}</ul>
  <h2>作品年表（出品门店为创作时快照，调店不改写）</h2><ul>${works || '<li class="muted">暂无</li>'}</ul>`);
}

/** 作品照片：授权到期 → 不出 <img>，仅保留文字；加载失败 → 客户端替换为文字卡片 */
function workPhotoHtml(w, today) {
  const expired = w.license_expires_on && w.license_expires_on < today;
  if (expired) {
    return `<div class="photo-fallback">🔒 照片授权已到期（${esc(w.license_expires_on)}），仅保留文字记录：${esc(w.description)}</div>`;
  }
  if (!w.photo_url) {
    return `<div class="photo-fallback">📷 暂无照片，文字记录：${esc(w.description)}</div>`;
  }
  return `<div class="work-photo-wrap">
    <img class="work-photo" src="${esc(w.photo_url)}" alt="${esc(w.title)}">
    <div class="photo-fallback" hidden>📷 照片暂时无法显示，保留文字记录：${esc(w.description)}</div>
  </div>`;
}

function worksPage(works, today) {
  const cards = works.map((w) => `<div class="card work" data-work-id="${w.id}">
    <h2>《${esc(w.title)}》</h2>
    ${workPhotoHtml(w, today)}
    <p>${esc(w.description)}</p>
    <p class="muted">出品门店（创作时快照）：${esc(w.shop_name || '未记录')} · 创作于 ${esc(w.created_on)}
    ${w.license_expires_on ? ` · 授权至 ${esc(w.license_expires_on)}` : ''}</p>
  </div>`).join('');
  return layout('拉花作品', `<h1>拉花作品</h1>
  <p class="muted">照片加载失败或授权到期时保留文字记录；作品归属创作时门店，调店后不会改写为新门店出品。</p>
  ${cards || '<div class="card muted">暂无作品</div>'}`);
}

function coursesPage(pub) {
  if (!pub) return layout('课程', '<div class="alert warn">暂无已发布课程。</div>');
  const cards = pub.payload.courses.map((c) => {
    const sessions = c.sessions.map((s) => `<li>
      <b>门店时间</b> ${esc(formatInTz(s.start_utc, s.timezone))}（${esc(s.timezone)}）
      · <b>你的时区</b> <span data-utc="${esc(s.start_utc)}">${esc(s.start_utc)}</span><br>
      ${esc(s.shop_name)}（${esc(s.shop_address)}）· 讲师：${esc(s.instructor_name)}
      <a class="btn" href="/sessions/${s.id}">预约</a></li>`).join('');
    return `<div class="card course" data-course-id="${c.id}">
      <h2>${esc(c.title)}</h2>
      <p>${esc(c.content)}</p>
      <p class="muted">容量模式：${c.capacity_mode === 'fixed' ? `固定班级容量 ${c.fixed_capacity} 人` : '按资源瓶颈动态计算'}</p>
      <ul>${sessions || '<li class="muted">暂无排期</li>'}</ul>
    </div>`;
  }).join('');
  return layout('课程', `<h1>课程</h1>
  <p class="muted">课程信息来自发布版本 v${pub.version_no}；预约确认时将绑定当时的课程内容与门店地址快照。</p>
  ${cards || '<div class="card muted">暂无课程</div>'}`);
}

function sessionPage({ session, course, shop, instructor, report }) {
  const remaining = Math.max(0, report.capacity - report.occupancy.active);
  const cancelled = session.status !== 'scheduled' || course.status !== 'open';
  return layout(`预约 · ${course.title}`, `
  <h1>${esc(course.title)}</h1>
  <div class="card">
    <p>${esc(course.content)}</p>
    <p>门店时间：${esc(formatInTz(session.start_utc, shop.timezone))} ~ ${esc(formatInTz(session.end_utc, shop.timezone))}（${esc(shop.timezone)}）
    · 你的时区：<span data-utc="${esc(session.start_utc)}">${esc(session.start_utc)}</span></p>
    <p>门店：${esc(shop.name)}（${esc(shop.address)}） · 讲师：${esc(instructor.name)}</p>
    <p class="muted">${esc(report.explanation)}</p>
    <p>剩余名额：<b>${remaining}</b>${report.occupancy.waitlisted ? ` · 候补 ${report.occupancy.waitlisted} 人` : ''}</p>
    ${cancelled
      ? '<div class="alert err">本课次已撤课或课程已关闭，无法预约。</div>'
      : `<form method="post" action="/sessions/${session.id}/hold">
          <label>姓名 <input name="student_name" required maxlength="40"></label>
          <button type="submit">临时占位</button>
        </form>
        <p class="muted">占位后请在有效期内确认；确认时绑定当时课程内容与门店地址。满员时将自动进入候补。</p>`}
  </div>`);
}

function bookingPage({ booking, session, shop, course }) {
  const b = booking;
  let body = `<h1>预约 #${b.id}</h1>`;
  const stateBadge = {
    held: '<span class="badge warn">临时占位中</span>',
    confirmed: '<span class="badge ok">已确认</span>',
    waitlisted: '<span class="badge">候补中</span>',
    cancelled: '<span class="badge err">已取消</span>',
    expired: '<span class="badge err">占位已过期</span>'
  }[b.state];
  body += `<div class="card"><p>学员：${esc(b.student_name)} · 状态：${stateBadge}</p>`;

  if (b.state === 'held') {
    body += `<p>请在 <b>${esc(b.hold_expires_at || '')}</b>（UTC）前确认，逾期自动释放并顺延候补。</p>
      <form class="inline" method="post" action="/bookings/${b.id}/confirm"><button type="submit">确认预约</button></form>
      <form class="inline" method="post" action="/bookings/${b.id}/cancel"><button type="submit" class="danger">取消</button></form>`;
  } else if (b.state === 'confirmed') {
    body += `<h2>确认时绑定的快照</h2>
      <p>课程内容（v${b.course_content_version_snapshot}）：${esc(b.course_content_snapshot)}</p>
      <p>门店地址：${esc(b.shop_name_snapshot)} · ${esc(b.shop_address_snapshot)}（地址版本 v${b.shop_address_version_snapshot}）</p>`;
    if (b.reconfirm_required) {
      body += `<div class="alert warn">⚠ 门店地址已变更：预约时地址「${esc(b.shop_address_snapshot)}」→ 当前地址「${esc(shop.address)}」。
        <b>此变更待你确认</b>（我们不会只更新页面地图了事）。
        <form method="post" action="/bookings/${b.id}/reconfirm"><button type="submit">我已知晓新地址，再确认</button></form></div>`;
    }
    body += `<form method="post" action="/bookings/${b.id}/cancel"><button type="submit" class="danger">取消预约</button></form>`;
  } else if (b.state === 'waitlisted') {
    body += `<p>当前满员，你已在候补队列；有空位时将自动转为临时占位并保留确认窗口。</p>
      <form method="post" action="/bookings/${b.id}/cancel"><button type="submit" class="danger">取消候补</button></form>`;
  } else {
    body += `<p class="muted">该预约已结束（${esc(b.state)}）。</p>`;
  }
  body += `<p class="muted">课次：${esc(course ? course.title : '')} · 门店时间 ${esc(formatInTz(session.start_utc, shop.timezone))}（${esc(shop.timezone)}）</p></div>`;
  return layout(`预约 #${b.id}`, body);
}

function beansPage(notes) {
  const rows = notes.map((n) => `<tr>
    <td>${esc(n.bean_name)}</td><td>${esc(n.origin || '')}</td><td>${esc(n.roast || '')}</td>
    <td>${esc(n.personal_note)}</td>
    <td>${n.quality_claim
      ? (n.verified
        ? `<span class="badge ok">已核对</span> ${esc(n.quality_claim)}`
        : `<span class="badge warn">个人记录 · 未经核对，非认证事实</span> ${esc(n.quality_claim)}`)
      : '<span class="muted">—</span>'}</td>
  </tr>`).join('');
  return layout('豆单', `<h1>豆单（个人记录）</h1>
  <div class="alert warn">本页为我的<b>个人豆单记录</b>。其中品质结论如未标注「已核对」，均为个人主观记录，<b>不作为认证事实</b>。</div>
  <table><thead><tr><th>豆名</th><th>产地</th><th>烘焙</th><th>个人记录</th><th>品质结论</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="5" class="muted">暂无记录</td></tr>'}</tbody></table>`);
}

/* ---------------- 管理端 ---------------- */

function adminDashboard(counts) {
  return layout('管理端', `<h1>管理端</h1>
  <div class="card"><ul>
    <li><a href="/admin/shops">门店管理</a>（改址会标记受影响预约为待学员确认）</li>
    <li><a href="/admin/courses">课程管理</a>（固定容量 / 动态瓶颈）</li>
    <li><a href="/admin/sessions">课次排期</a>（容量来源解释与冲突提示）</li>
    <li><a href="/admin/publish">发布版本</a>（公开页读取兼容版本）</li>
    <li><a href="/admin/beans">豆单记录</a></li>
  </ul>
  <p class="muted">门店 ${counts.shops} · 课程 ${counts.courses} · 课次 ${counts.sessions} · 预约 ${counts.bookings} · 已发布版本 ${counts.versions}</p></div>`);
}

function adminShopsPage(shops) {
  const rows = shops.map((s) => `<tr><td>#${s.id}</td>
    <td>${esc(s.name)}<form method="post" action="/admin/shops/${s.id}">
      <input name="name" value="${esc(s.name)}" required>
      <input name="timezone" value="${esc(s.timezone)}" required title="IANA 时区">
      <button type="submit">保存名称/时区</button></form></td>
    <td>${esc(s.address)} <span class="badge">地址 v${s.address_version}</span>
      <form method="post" action="/admin/shops/${s.id}/address">
      <input name="address" placeholder="新地址" required>
      <button type="submit" class="danger">改址</button>
      <div class="muted">改址将标记受影响预约为「待学员确认」，不会只更新页面地图。</div></form></td>
    <td>${esc(s.timezone)}</td></tr>`).join('');
  return layout('门店管理', `<h1>门店管理</h1>
  <table><thead><tr><th>ID</th><th>名称</th><th>地址</th><th>时区</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function adminCoursesPage(courses) {
  const rows = courses.map((c) => `<tr><td>#${c.id}</td>
    <td><form method="post" action="/admin/courses/${c.id}">
      <input name="title" value="${esc(c.title)}" required><br>
      <textarea name="content" rows="2" cols="40">${esc(c.content)}</textarea><br>
      <select name="capacity_mode">
        <option value="fixed" ${c.capacity_mode === 'fixed' ? 'selected' : ''}>固定班级容量</option>
        <option value="dynamic" ${c.capacity_mode === 'dynamic' ? 'selected' : ''}>按资源瓶颈动态计算</option>
      </select>
      <input name="fixed_capacity" type="number" min="1" value="${c.fixed_capacity == null ? '' : c.fixed_capacity}" placeholder="固定容量">
      <button type="submit">保存</button>
      <span class="muted">内容 v${c.content_version} · ${esc(c.status)}</span>
    </form></td></tr>`).join('');
  return layout('课程管理', `<h1>课程管理</h1>
  <div class="card"><h2>新建课程</h2>
    <form method="post" action="/admin/courses">
      <input name="title" placeholder="课程名" required>
      <input name="content" placeholder="课程内容" required size="40">
      <select name="capacity_mode"><option value="fixed">固定班级容量</option><option value="dynamic">按资源瓶颈动态计算</option></select>
      <input name="fixed_capacity" type="number" min="1" placeholder="固定容量">
      <button type="submit">创建</button>
    </form></div>
  <table><thead><tr><th>ID</th><th>课程</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function adminSessionsPage(sessions, courses, instructors, shops, reports) {
  const createForm = `<div class="card"><h2>新建课次</h2>
    <form method="post" action="/admin/sessions">
      课程 <select name="course_id">${courses.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join('')}</select>
      讲师 <select name="instructor_id">${instructors.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select>
      门店 <select name="shop_id">${shops.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select><br>
      开始(UTC) <input name="start_utc" placeholder="2026-11-01T02:00:00Z" required>
      结束(UTC) <input name="end_utc" placeholder="2026-11-01T04:00:00Z" required>
      演示工位 <input name="demo_ws" type="number" min="0" value="1" size="3">
      演示机器 <input name="demo_machines" type="number" min="0" value="1" size="3">
      <button type="submit">排课</button>
    </form>
    <p class="muted">课次同时占用讲师、工位与机器；讲师排期重叠或资源不足会被拒绝。</p></div>`;
  const rows = sessions.map((s) => {
    const r = reports.get(s.id);
    const conflicts = r && r.conflicts.length
      ? `<ul>${r.conflicts.map((c) => `<li><span class="badge err">${esc(c.type)}</span> ${esc(c.message)}</li>`).join('')}</ul>`
      : '<span class="badge ok">无冲突</span>';
    return `<tr><td>#${s.id}</td><td>${esc(s.course_title)}</td><td>${esc(s.instructor_name)}</td>
      <td>${esc(s.shop_name)}<br><span class="muted">${esc(s.start_utc)} ~ ${esc(s.end_utc)}（UTC）</span></td>
      <td>${r ? `${esc(r.explanation)}<br><span class="muted">已占 ${r.occupancy.active}（占位 ${r.occupancy.held} / 确认 ${r.occupancy.confirmed}）· 候补 ${r.occupancy.waitlisted}</span>` : ''}</td>
      <td>${conflicts}</td>
      <td>${s.status === 'scheduled'
        ? `<a class="btn" href="/admin/sessions/${s.id}">预约管理</a>
           <form class="inline" method="post" action="/admin/sessions/${s.id}/cancel"><button class="danger" type="submit">撤课</button></form>`
        : '<span class="badge err">已撤课</span>'}</td></tr>`;
  }).join('');
  return layout('课次排期', `<h1>课次排期</h1>${createForm}
  <table><thead><tr><th>ID</th><th>课程</th><th>讲师</th><th>门店/时间</th><th>容量来源</th><th>冲突</th><th>操作</th></tr></thead>
  <tbody>${rows}</tbody></table>`);
}

function adminSessionBookingsPage(session, bookings, report) {
  const rows = bookings.map((b) => `<tr><td>#${b.id}</td><td>${esc(b.student_name)}</td>
    <td>${esc(b.state)}${b.reconfirm_required ? ' <span class="badge warn">改址待学员确认</span>' : ''}</td>
    <td>${b.hold_expires_at ? esc(b.hold_expires_at) : '—'}</td>
    <td>${b.shop_address_snapshot ? `${esc(b.shop_address_snapshot)}（v${b.shop_address_version_snapshot}）` : '<span class="muted">未绑定快照</span>'}</td>
    <td>${['held', 'confirmed', 'waitlisted'].includes(b.state)
      ? `<form class="inline" method="post" action="/admin/bookings/${b.id}/cancel"><button class="danger" type="submit">取消并释放</button></form>` : ''}</td>
  </tr>`).join('');
  return layout(`课次 #${session.id} 预约管理`, `<h1>课次 #${session.id} 预约管理</h1>
  <div class="card"><p>${esc(report.explanation)}</p>
  <p class="muted">占用：占位 ${report.occupancy.held} / 确认 ${report.occupancy.confirmed} / 候补 ${report.occupancy.waitlisted} · 容量 ${report.capacity}</p>
  ${report.conflicts.length ? `<div class="alert err"><ul>${report.conflicts.map((c) => `<li>${esc(c.message)}</li>`).join('')}</ul></div>` : ''}</div>
  <table><thead><tr><th>ID</th><th>学员</th><th>状态</th><th>占位截止(UTC)</th><th>地址快照</th><th>操作</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6" class="muted">暂无预约</td></tr>'}</tbody></table>`);
}

function adminPublishPage(versions, isCompat) {
  const rows = versions.map((v) => `<tr><td>v${v.version_no}</td><td>${esc(v.schema_version)}</td>
    <td>${isCompat(v.schema_version) ? '<span class="badge ok">兼容</span>' : '<span class="badge err">不兼容（公开端跳过）</span>'}</td>
    <td>${esc(v.published_at)}</td></tr>`).join('');
  return layout('发布版本', `<h1>发布版本</h1>
  <div class="card"><p>公开年表与课程页读取<b>最新兼容</b>的发布版本；不兼容版本会被自动回退跳过。</p>
  <form method="post" action="/admin/publish"><button type="submit">发布新版本</button></form></div>
  <table><thead><tr><th>版本</th><th>schema</th><th>兼容性</th><th>发布时间</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function adminBeansPage(notes) {
  const rows = notes.map((n) => `<tr><td>#${n.id}</td><td>${esc(n.bean_name)}</td><td>${esc(n.personal_note)}</td>
    <td>${esc(n.quality_claim || '—')}</td><td>${n.verified ? '已核对' : '未经核对'}</td></tr>`).join('');
  return layout('豆单管理', `<h1>豆单管理</h1>
  <div class="card"><form method="post" action="/admin/beans">
    <input name="bean_name" placeholder="豆名" required>
    <input name="origin" placeholder="产地">
    <input name="roast" placeholder="烘焙度">
    <input name="personal_note" placeholder="个人记录" required>
    <input name="quality_claim" placeholder="品质结论（可选）">
    <label><input type="checkbox" name="verified" value="1"> 已核对</label>
    <button type="submit">记录</button>
    <div class="muted">未勾「已核对」的品质结论在公开页会标注「未经核对，非认证事实」。</div>
  </form></div>
  <table><thead><tr><th>ID</th><th>豆名</th><th>个人记录</th><th>品质结论</th><th>核对</th></tr></thead><tbody>${rows}</tbody></table>`);
}

module.exports = {
  layout, errorPage, homePage, timelinePage, worksPage, coursesPage, sessionPage, bookingPage, beansPage,
  adminDashboard, adminShopsPage, adminCoursesPage, adminSessionsPage, adminSessionBookingsPage, adminPublishPage, adminBeansPage
};
