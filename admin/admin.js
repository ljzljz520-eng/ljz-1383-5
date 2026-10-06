'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const key = () => $('#adminkey') ? $('#adminkey').value : '';
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(key() ? { 'x-admin-key': key() } : {}) },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || url), { status: statusFix(res), data });
  return data;
}
function statusFix(res) { return res.status; }
function flash(kind, msg) { $('#flash').innerHTML = `<div class="flash ${kind}">${esc(msg)}</div>`; }
const H = (tag, attrs = {}, children = '') => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}>${children}</${tag}>`;

const renderers = {};

// ---------------- 门店与任职 ----------------
renderers.stores = async function () {
  const [stores, emps] = await Promise.all([api('/api/admin/stores'), api('/api/admin/employments')]);
  const storeOpts = (v) => stores.map((s) => `<option value="${s.id}" ${s.id === v ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  $('#view').innerHTML = `
  <div class="card">
    <h3>新建门店</h3>
    <div class="grid2">
      <div><label>名称</label><input id="s-name"></div>
      <div><label>时区 IANA</label><input id="s-tz" value="Asia/Shanghai"></div>
    </div>
    <label>地址</label><input id="s-addr">
    <p class="muted">创建后如要改址，请使用每行的「改址（标记待确认）」——不只是更新地址文本/地图。</p>
    <button class="btn" onclick="A.createStore()">创建门店</button>
  </div>
  <h3>现有门店与改址</h3>
  ${stores.map((s) => `<div class="card">
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <div><b>${esc(s.name)}</b> <span class="tag">${esc(s.tz)}</span><div class="muted">${esc(s.address)}</div></div>
      <div style="min-width:280px">
        <input id="addr-${s.id}" placeholder="输入新地址…" style="margin-bottom:6px">
        <button class="btn ghost" onclick="A.changeAddr(${s.id})">改址（标记待学员确认）</button>
      </div>
    </div>
  </div>`).join('')}
  <div class="card">
    <h3>新增任职区间（同店区间不可重叠）</h3>
    <div class="grid2">
      <div><label>门店</label><select id="e-store">${storeOpts()}</select></div>
      <div><label>角色</label><input id="e-role" placeholder="主理咖啡师"></div>
      <div><label>开始 YYYY-MM-DD</label><input id="e-start" placeholder="2024-01-01"></div>
      <div><label>结束（留空=至今）</label><input id="e-end" placeholder="2025-01-01"></div>
    </div>
    <label>备注</label><input id="e-note">
    <button class="btn" onclick="A.createEmp()">添加任职</button>
  </div>
  <h3>任职记录（有效区间）</h3>
  <div class="card"><table><thead><tr><th>门店</th><th>角色</th><th>区间</th><th>备注</th></tr></thead><tbody>
  ${emps.map((e) => `<tr><td>${esc(e.store_name)}</td><td>${esc(e.role)}</td><td>${esc(e.start_date)} → ${esc(e.end_date || '至今')}</td><td>${esc(e.note)}</td></tr>`).join('')}
  </tbody></table></div>`;
};
window.A = {};
A.createStore = async () => {
  try {
    await api('/api/admin/stores', { method: 'POST', body: JSON.stringify({ name: $('#s-name').value, address: $('#s-addr').value, tz: $('#s-tz').value }) });
    flash('ok', '门店已创建'); renderers.stores();
  } catch (e) { flash('err', e.message); }
};
A.changeAddr = async (id) => {
  const address = $(`#addr-${id}`).value;
  if (!address) return flash('warn', '请输入新地址');
  try {
    const r = await api(`/api/admin/stores/${id}/change-address`, { method: 'POST', body: JSON.stringify({ address }) });
    flash('ok', `地址已更新，并已标记 ${r.marked} 笔进行中预约待学员重新确认（不只改地图）。`);
  } catch (e) { flash('err', e.message); }
};
A.createEmp = async () => {
  try {
    await api('/api/admin/employments', { method: 'POST', body: JSON.stringify({
      store_id: Number($('#e-store').value), role: $('#e-role').value,
      start_date: $('#e-start').value, end_date: $('#e-end').value || null, note: $('#e-note').value }) });
    flash('ok', '任职已添加（有效区间）'); renderers.stores();
  } catch (e) { flash('err', e.message); }
};

// ---------------- 作品 ----------------
renderers.works = async function () {
  const [works, stores] = await Promise.all([api('/api/admin/works'), api('/api/admin/stores')]);
  $('#view').innerHTML = `
  <div class="card">
    <h3>新增拉花作品</h3>
    <label>标题</label><input id="w-title">
    <div class="grid2">
      <div><label>照片 URL（可留空/可失效）</label><input id="w-photo" placeholder="/img/sample.svg"></div>
      <div><label>授权到期时间（ISO，留空=不限）</label><input id="w-lic" placeholder="2030-01-01T00:00:00Z"></div>
    </div>
    <label>图片失败时保留的文字（alt）</label><input id="w-alt">
    <label>描述</label><textarea id="w-desc" rows="2"></textarea>
    <div class="grid2">
      <div><label>出品门店（创建后冻结，调店不改写）</label><select id="w-store">${stores.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
      <div><label>出品日期</label><input id="w-date" type="date"></div>
    </div>
    <label><input type="checkbox" id="w-pub" style="width:auto"> 发布到公开年表</label>
    <button class="btn" onclick="A.createWork()">保存作品</button>
  </div>
  <h3>作品库（旧作品出品门店已冻结）</h3>
  ${works.map((w) => `<div class="card">
    <b>${esc(w.title)}</b>
    ${w.photo_status.viewable ? '<span class="tag role">照片可展示</span>' : `<span class="tag danger">照片不可展示：${w.photo_status.reason === 'license_expired' ? '授权到期' : w.photo_status.reason}</span>`}
    ${w.published ? '<span class="tag">已发布</span>' : '<span class="tag warn">草稿</span>'}
    <div class="muted">出品门店（冻结）：${esc(w.store_name_snapshot || '未知')} · ${esc((w.produced_at || '').slice(0, 10))} · 授权至 ${esc(w.license_expires_at || '不限')}</div>
    <div>${esc(w.alt_text || w.description)}</div>
    <button class="btn ghost" onclick="A.toggleWork(${w.id}, ${w.published ? 0 : 1})">${w.published ? '撤下草稿' : '发布'}</button>
  </div>`).join('')}`;
};
A.createWork = async () => {
  try {
    await api('/api/admin/works', { method: 'POST', body: JSON.stringify({
      title: $('#w-title').value, photo_url: $('#w-photo').value, alt_text: $('#w-alt').value,
      description: $('#w-desc').value, store_id: Number($('#w-store').value),
      produced_at: $('#w-date').value ? new Date($('#w-date').value).toISOString() : null,
      license_expires_at: $('#w-lic').value || null, published: $('#w-pub').checked }) });
    flash('ok', '作品已保存，出品门店已快照冻结'); renderers.works();
  } catch (e) { flash('err', e.message); }
};
A.toggleWork = async (id, published) => {
  await api(`/api/admin/works/${id}`, { method: 'PUT', body: JSON.stringify({ published }) });
  renderers.works();
};

// ---------------- 比赛 / 学习 ----------------
renderers.career = async function () {
  const [comps, stages] = await Promise.all([api('/api/admin/competitions'), api('/api/admin/stages')]);
  $('#view').innerHTML = `
  <div class="grid2">
    <div class="card">
      <h3>比赛经历（必须有角色与日期）</h3>
      <label>赛事</label><input id="c-name">
      <div class="grid2">
        <div><label>角色</label><input id="c-role" placeholder="选手/评委/教练"></div>
        <div><label>日期</label><input id="c-date" type="date"></div>
      </div>
      <label>类别/名次/描述</label><input id="c-cat" placeholder="拿铁艺术"><input id="c-rank" placeholder="季军"><textarea id="c-desc" rows="2"></textarea>
      <label><input type="checkbox" id="c-pub" style="width:auto"> 发布</label>
      <button class="btn" onclick="A.createComp()">保存比赛</button>
    </div>
    <div class="card">
      <h3>学习阶段</h3>
      <label>标题</label><input id="g-title">
      <div class="grid2">
        <div><label>阶段</label><input id="g-stage" placeholder="进阶"></div>
        <div><label>排序</label><input id="g-order" type="number" value="1"></div>
        <div><label>开始</label><input id="g-start" type="date"></div>
        <div><label>结束</label><input id="g-end" type="date"></div>
      </div>
      <label>描述</label><textarea id="g-desc" rows="2"></textarea>
      <label><input type="checkbox" id="g-pub" style="width:auto"> 发布</label>
      <button class="btn" onclick="A.createStage()">保存阶段</button>
    </div>
  </div>
  <h3>已有比赛</h3><div class="card"><table><thead><tr><th>日期</th><th>角色</th><th>赛事</th><th>类别/名次</th></tr></thead><tbody>
  ${comps.map((c) => `<tr><td>${esc(c.date)}</td><td><span class="tag role">${esc(c.role)}</span></td><td>${esc(c.name)}</td><td>${esc(c.category)} ${esc(c.ranking)}</td></tr>`).join('')}
  </tbody></table></div>
  <h3>已有阶段</h3><div class="card"><table><thead><tr><th>排序</th><th>阶段</th><th>标题</th><th>区间</th></tr></thead><tbody>
  ${stages.map((s) => `<tr><td>${s.sort_order}</td><td>${esc(s.stage)}</td><td>${esc(s.title)}</td><td>${esc(s.start_date)} → ${esc(s.end_date || '至今')}</td></tr>`).join('')}
  </tbody></table></div>`;
};
A.createComp = async () => {
  try {
    await api('/api/admin/competitions', { method: 'POST', body: JSON.stringify({
      name: $('#c-name').value, role: $('#c-role').value, date: $('#c-date').value,
      category: $('#c-cat').value, ranking: $('#c-rank').value, description: $('#c-desc').value, published: $('#c-pub').checked }) });
    flash('ok', '比赛经历已保存（角色+日期）'); renderers.career();
  } catch (e) { flash('err', e.message); }
};
A.createStage = async () => {
  try {
    await api('/api/admin/stages', { method: 'POST', body: JSON.stringify({
      title: $('#g-title').value, stage: $('#g-stage').value,
      start_date: $('#g-start').value || null, end_date: $('#g-end').value || null,
      sort_order: Number($('#g-order').value), description: $('#g-desc').value, published: $('#g-pub').checked }) });
    flash('ok', '学习阶段已保存'); renderers.career();
  } catch (e) { flash('err', e.message); }
};

// ---------------- 资源 ----------------
renderers.resources = async function () {
  const [instructors, stations, machines, stores] = await Promise.all([
    api('/api/admin/instructors'), api('/api/admin/stations'), api('/api/admin/machines'), api('/api/admin/stores')]);
  const storeName = (id) => (stores.find((s) => s.id === id) || {}).name || '-';
  $('#view').innerHTML = `
  <div class="grid2">
    <div class="card"><h3>讲师</h3>${instructors.map((i) => `<div>${esc(i.name)} <span class="muted">${esc(i.bio || '')}</span></div>`).join('')}
      <label>姓名</label><input id="i-name"><label>简介</label><input id="i-bio">
      <button class="btn" onclick="A.add('instructors',{name:v('i-name'),bio:v('i-bio')})">添加讲师</button></div>
    <div class="card"><h3>机器</h3>${machines.map((m) => `<div>${esc(m.name)} <span class="muted">${esc(m.model || '')}</span></div>`).join('')}
      <label>名称</label><input id="m-name"><label>型号</label><input id="m-model">
      <button class="btn" onclick="A.add('machines',{name:v('m-name'),model:v('m-model')})">添加机器</button></div>
  </div>
  <div class="card"><h3>工位</h3><table><thead><tr><th>工位</th><th>所属门店</th></tr></thead><tbody>
  ${stations.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(storeName(s.store_id))}</td></tr>`).join('')}</tbody></table>
    <label>名称</label><input id="st-name"><label>门店</label><select id="st-store">${stores.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
    <button class="btn" onclick="A.add('stations',{name:v('st-name'),store_id:Number(v('st-store'))})">添加工位</button></div>`;
};
window.v = (id) => $(`#${id}`).value;
A.add = async (pathName, body) => {
  try { await api(`/api/admin/${pathName}`, { method: 'POST', body: JSON.stringify(body) }); flash('ok', '已添加'); renderers.resources(); }
  catch (e) { flash('err', e.message); }
};

// ---------------- 课程与排课 ----------------
renderers.courses = async function () {
  const [courses, stores, instructors, stations, machines, sessions] = await Promise.all([
    api('/api/admin/courses'), api('/api/admin/stores'), api('/api/admin/instructors'),
    api('/api/admin/stations'), api('/api/admin/machines'), api('/api/admin/sessions')]);
  const chk = (list, key = 'id') => list.map((x) => `<label style="display:block"><input type="checkbox" value="${x[key]}" class="${key === 'id' ? 'pick-station' : 'pick-machine'}" style="width:auto"> ${esc(x.name)}</label>`).join('');
  const stationByStore = (sid) => stations.filter((s) => !s.store_id || s.store_id === sid);
  $('#view').innerHTML = `
  <div class="card">
    <h3>课程定义</h3>
    <label>标题</label><input id="co-title">
    <label>描述</label><textarea id="co-desc" rows="2"></textarea>
    <label>固定班级容量（上限）</label><input id="co-cap" type="number" value="10">
    <label><input type="checkbox" id="co-pub" style="width:auto"> 发布课程</label>
    <button class="btn" onclick="A.createCourse()">保存课程</button>
    <p class="muted">固定容量只是上限。每场实际可订 = min(固定容量, 讲师数, 可用工位, 可用机器)。</p>
  </div>
  <div class="card">
    <h3>排课（同时占用讲师＋工位＋机器）</h3>
    <div class="grid2">
      <div><label>课程</label><select id="se-course">${courses.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join('')}</select></div>
      <div><label>门店</label><select id="se-store" onchange="A.reloadStations()">${stores.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
      <div><label>开始 UTC</label><input id="se-start" placeholder="2026-11-01T02:00:00Z"></div>
      <div><label>结束 UTC</label><input id="se-end" placeholder="2026-11-01T05:00:00Z"></div>
      <div><label>讲师（1 名=瓶颈1）</label><select id="se-inst">${instructors.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select></div>
    </div>
    <div class="grid2">
      <div><b>工位（多选）</b><div id="se-stations">${stationByStore(stores[0]?.id).map((s) => `<label style="display:block"><input type="checkbox" value="${s.id}" class="pick-station" style="width:auto"> ${esc(s.name)}</label>`).join('')}</div></div>
      <div><b>机器（多选）</b><div>${machines.map((m) => `<label style="display:block"><input type="checkbox" value="${m.id}" class="pick-machine" style="width:auto"> ${esc(m.name)}</label>`).join('')}</div></div>
    </div>
    <button class="btn" onclick="A.schedule()">检测冲突并排课</button>
  </div>
  <h3>已排场次（容量来源 + 冲突解释）</h3>
  ${sessions.map((s) => {
    const c = s.capacity;
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div><b>${esc(s.course_title)}</b> @ ${esc(s.store_name)}
          ${s.status === 'cancelled' ? '<span class="tag danger">已撤课</span>' : '<span class="tag role">开放</span>'}
          <div class="muted">当地 ${esc(s.start_local.local)} (${esc(s.tz)}) ~ ${esc(s.end_local.local)} · 讲师 ${esc(s.instructor_name)}</div>
        </div>
        ${s.status === 'open' ? `<button class="btn ghost" onclick="A.cancelSession(${s.id})">后台撤课</button>` : ''}
      </div>
      <table style="margin-top:8px"><thead><tr><th>容量来源</th><th>数量</th></tr></thead><tbody>
      ${c.bottlenecks.map((b) => `<tr style="${b.label === c.bottleneck.label ? 'background:#fbe9df' : ''}"><td>${esc(b.label)}${b.label === c.bottleneck.label ? ' ← 瓶颈' : ''}</td><td>${b.total}</td></tr>`).join('')}
      <tr><td>已占（held+confirmed）</td><td>${c.booked}</td></tr>
      <tr><td>候补中</td><td>${c.waitlisted}</td></tr>
      <tr><td><b>实际可订</b></td><td><b>${c.dynamicCapacity} / 固定 ${c.fixedCapacity}</b></td></tr>
      </tbody></table>
      ${s.conflicts.length ? `<div class="flash err">排期冲突：${s.conflicts.map((x) => esc(x.label)).join('；')}</div>` : '<div class="muted">无跨场资源冲突</div>'}
      ${s.status === 'cancelled' && s.cancel_reason ? `<div class="muted">撤课原因：${esc(s.cancel_reason)}</div>` : ''}
    </div>`;
  }).join('')}`;
};
A.reloadStations = () => {};
A.createCourse = async () => {
  try {
    await api('/api/admin/courses', { method: 'POST', body: JSON.stringify({
      title: $('#co-title').value, description: $('#co-desc').value,
      fixed_capacity: Number($('#co-cap').value), published: $('#co-pub').checked }) });
    flash('ok', '课程已保存'); renderers.courses();
  } catch (e) { flash('err', e.message); }
};
A.schedule = async (force = false) => {
  const station_ids = [...document.querySelectorAll('.pick-station:checked')].map((x) => Number(x.value));
  const machine_ids = [...document.querySelectorAll('.pick-machine:checked')].map((x) => Number(x.value));
  const body = {
    course_id: Number($('#se-course').value), store_id: Number($('#se-store').value),
    start_utc: $('#se-start').value, end_utc: $('#se-end').value,
    instructor_id: Number($('#se-inst').value), station_ids, machine_ids, force
  };
  try {
    const r = await api('/api/admin/sessions', { method: 'POST', body: JSON.stringify(body) });
    flash('ok', `排课成功 #${r.id}，动态容量 ${r.capacity.dynamicCapacity}（瓶颈：${r.capacity.bottleneck.label}）`);
    renderers.courses();
  } catch (e) {
    if (e.data && e.data.error === 'SCHEDULE_CONFLICT') {
      const forceOk = confirm(`检测到排期冲突：\n${e.data.conflicts.map((c) => `· ${c.label}（${c.session}）`).join('\n')}\n\n仍要强制排课吗？`);
      if (forceOk) return A.schedule(true);
    } else flash('err', e.message);
  }
};
A.cancelSession = async (id) => {
  const reason = prompt('撤课原因：') || '';
  try {
    const r = await api(`/api/admin/sessions/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
    flash('warn', `已撤课。需通知 ${r.notify.length} 位进行中/确认中的学员：${r.notify.map((x) => x.student).join('、') || '无'}`);
    renderers.courses();
  } catch (e) { flash('err', e.message); }
};

// ---------------- 预约 ----------------
renderers.bookings = async function () {
  const rows = await api('/api/admin/bookings');
  $('#view').innerHTML = `
  <button class="btn ghost" onclick="A.sweep()">立即清理过期占位（释放并提升候补）</button>
  <div class="card"><table><thead><tr><th>#</th><th>学员</th><th>课程</th><th>门店/当地开始</th><th>状态</th><th>工位/机器</th><th>绑定地址 / 待确认</th><th>撤课通知</th></tr></thead><tbody>
  ${rows.map((b) => `<tr>
    <td>${b.id}</td><td>${esc(b.student_name)}</td><td>${esc(b.course_title)}</td>
    <td>${esc(b.store_name)}<br><span class="muted">${esc(b.start_local.local)} ${esc(b.start_local.tz)}</span></td>
    <td><span class="pill ${b.status === 'confirmed' ? 'open' : b.status === 'waitlisted' ? 'wait' : b.status === 'cancelled' ? '' : 'full'}">${b.status}</span>
      ${b.held_expires_at && b.status === 'held' ? `<div class="muted">占位至 ${esc(b.held_expires_at)}</div>` : ''}</td>
    <td>${esc(b.station_id || '-')}/${esc(b.machine_id || '-')}</td>
    <td>${b.address_snapshot ? esc(b.address_snapshot) : '<span class="muted">确认时绑定</span>'}
      ${b.reconfirm_required ? '<div class="tag warn">待学员确认新地址</div>' : ''}</td>
    <td>${b.notified_of_cancel ? '<span class="tag danger">需通知</span>' : '-'}</td>
  </tr>`).join('')}
  </tbody></table></div>`;
};
A.sweep = async () => {
  const r = await api('/api/admin/maintenance/sweep', { method: 'POST' });
  flash('ok', `已释放 ${r.expired.length} 个过期占位，提升候补 ${r.promoted.length} 笔`);
  renderers.bookings();
};

// ---------------- 豆单 / 素材 ----------------
renderers.beans = async function () {
  const [beans, materials] = await Promise.all([api('/api/admin/beans'), api('/api/admin/materials')]);
  $('#view').innerHTML = `
  <div class="flash warn">豆单是咖啡师个人记录：杯测口味等未经第三方核对的主观结论不得当作认证事实展示。</div>
  <div class="card">
    <h3>新增豆单记录</h3>
    <div class="grid2"><input id="b-roaster" placeholder="烘焙方"><input id="b-origin" placeholder="产地">
    <input id="b-process" placeholder="处理法"><input id="b-date" type="date" title="烘焙日"></div>
    <label>个人记录（主观）</label><textarea id="b-notes" rows="2"></textarea>
    <button class="btn" onclick="A.addBean()">保存（标记为未核对）</button>
  </div>
  ${beans.map((b) => `<div class="card"><b>${esc(b.roaster)} · ${esc(b.origin)}</b> <span class="tag ${b.verified ? 'role' : 'warn'}">${b.verified ? '已核对' : '未核对，非认证'}</span>
    <div class="muted">${esc(b.process)} · ${esc(b.roast_date || '')}</div><div>${esc(b.personal_notes)}</div></div>`).join('')}
  <div class="card"><h3>素材库（${materials.length}）</h3>${materials.map((m) => `<div>${esc(m.title)} <span class="tag">${esc(m.kind)}</span><div class="muted">${esc(m.description)}</div></div>`).join('')}</div>`;
};
A.addBean = async () => {
  await api('/api/admin/beans', { method: 'POST', body: JSON.stringify({
    roaster: $('#b-roaster').value, origin: $('#b-origin').value, process: $('#b-process').value,
    roast_date: $('#b-date').value || null, personal_notes: $('#b-notes').value, verified: false }) });
  flash('ok', '豆单已记录（未核对，非认证事实）'); renderers.beans();
};

// ---------------- 发布 ----------------
renderers.publish = async function () {
  const pubs = await api('/api/admin/publications');
  const [ev] = await Promise.all([api('/api/admin/evidence')]);
  $('#view').innerHTML = `
  <div class="card">
    <h3>发布兼容版本</h3>
    <p class="muted">年表与课程页公开读取的是「已发布快照」，草稿编辑不会立刻上站。发布带 reader 版本（1.x），旧读取端按主版本兼容读取。</p>
    <button class="btn" onclick="A.pub('chronology')">发布年表新版本</button>
    <button class="btn ghost" onclick="A.pub('courses')">发布课程新版本</button>
  </div>
  <div class="card"><h3>发布历史</h3><table><thead><tr><th>类型</th><th>版本</th><th>兼容读取端</th><th>时间</th></tr></thead><tbody>
  ${pubs.map((p) => `<tr><td>${p.kind}</td><td>v${p.version}</td><td>${esc(p.reader_version)}</td><td>${esc(p.published_at)}</td></tr>`).join('')}
  </tbody></table></div>
  <div class="card"><h3>成长证据（后台连接作品/素材/预约）</h3>${ev.map((e) => `<div><span class="tag">${esc(e.kind)}</span>${esc(e.title)}<div class="muted">${esc(e.occurred_at)} · ${esc(e.note || '')}</div></div>`).join('') || '<div class="muted">暂无</div>'}</div>`;
};
A.pub = async (kind) => {
  const r = await api(`/api/admin/publish/${kind}`, { method: 'POST' });
  flash('ok', `已发布 ${r.kind} v${r.version}（兼容读取端 ${r.reader_version}）`);
  renderers.publish();
};

// tab 切换
document.querySelectorAll('#tabs button').forEach((btn) => btn.addEventListener('click', () => {
  $('#tabs').querySelectorAll('button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  renderers[btn.dataset.tab]().catch((e) => flash('err', e.message));
}));
renderers.stores().catch((e) => flash('err', e.message));
