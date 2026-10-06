'use strict';
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const readerVersion = '1.0';

function flash(kind, msg) {
  $('#flash').innerHTML = `<div class="flash ${kind}">${esc(msg)}</div>`;
}
async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || url), { status: res.status, data });
  return data;
}

// ---------- 生涯年表 ----------
async function renderChronology() {
  const v = $('#view');
  try {
    const pub = await api(`/api/public/chronology?v=${readerVersion}`);
    const p = pub.payload;
    $('#hero-name').textContent = p.profile ? p.profile.name : '咖啡师生涯站';
    $('#hero-title').textContent = p.profile ? `${p.profile.title} · 发布版本 v${pub.version}（兼容读取端 ${pub.reader_version}）` : '';

    const works = (p.works || []).map((w) => {
      let media;
      if (w.photo_url) {
        // 公开照片失败 -> 保留文字（onerror 降级，不阻塞年表）
        media = `<div class="work"><img src="${esc(w.photo_url)}" alt="${esc(w.alt_text || w.title)}"
          onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'fallback',textContent:'照片暂不可用，保留文字：${esc(w.alt_text || w.description || w.title)}'}))"></div>`;
      } else if (w.photo_blocked === 'license_expired' || w.photo_blocked === 'license_expired_after_publish') {
        media = `<div class="fallback">照片授权已到期，已撤下照片 · 保留文字：${esc(w.alt_text || w.description || '')}</div>`;
      } else {
        media = `<div class="fallback">无照片 · 文字记录：${esc(w.alt_text || w.description || '')}</div>`;
      }
      return `<div class="card">
        <h3>${esc(w.title)}</h3>
        ${media}
        <p class="muted">出品门店（创作当时归属，不随后续调店改变）：<b>${esc(w.store_name_snapshot || '未知')}</b> · ${esc((w.produced_at || '').slice(0, 10))}</p>
      </div>`;
    }).join('');

    const comps = (p.competitions || []).map((c) =>
      `<div class="item"><span class="tag role">${esc(c.role)}</span><b>${esc(c.name)}</b>
        <div class="muted">日期：${esc(c.date)} · ${esc(c.category || '')} ${c.ranking ? '· ' + esc(c.ranking) : ''}</div>
        <div class="muted">${esc(c.description || '')}</div></div>`).join('');

    const emps = (p.employments || []).map((e) =>
      `<tr><td>${esc(e.store_name)}</td><td>${esc(e.role)}</td><td>${esc(e.start_date)} → ${esc(e.end_date || '至今')}</td><td>${esc(e.note || '')}</td></tr>`).join('');

    const stages = (p.stages || []).map((s) =>
      `<div class="item"><span class="tag">${esc(s.stage || '阶段')}</span><b>${esc(s.title)}</b>
        <div class="muted">${esc(s.start_date || '?')} → ${esc(s.end_date || '至今')}</div><div>${esc(s.description || '')}</div></div>`).join('');

    v.innerHTML = `
      <div class="card"><h3>个人简介</h3><p>${esc(p.profile ? p.profile.bio : '')}</p></div>
      <h2>拉花作品</h2>${works || '<div class="card muted">暂无已发布作品</div>'}
      <h2>比赛经历（角色与日期）</h2><div class="card"><div class="timeline">${comps}</div></div>
      <h2>学习阶段</h2><div class="card"><div class="timeline">${stages}</div></div>
      <h2>门店任职（有效区间）</h2>
      <div class="card"><table><thead><tr><th>门店</th><th>角色</th><th>有效区间</th><th>备注</th></tr></thead><tbody>${emps}</tbody></table></div>`;
  } catch (e) {
    v.innerHTML = `<div class="flash err">${esc(e.message)}</div>`;
  }
}

// ---------- 课程 ----------
async function renderCourses() {
  const v = $('#view');
  try {
    const pub = await api(`/api/public/courses?v=${readerVersion}`);
    const html = pub.courses.map((c) => {
      const sessions = (c.sessions || []).map((s) => {
        const pct = s.dynamic_capacity ? Math.min(100, (s.dynamic_capacity - s.available) / s.dynamic_capacity * 100) : 100;
        const pill = s.available > 0
          ? `<span class="pill open">可订 ${s.available} 席</span>`
          : `<span class="pill full">满员，候补 ${s.capacity_source.waitlisted} 人</span>`;
        return `<div class="card">
          <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
            <div><b>${esc(s.store_name)}</b> · ${pill}
              <div class="muted">当地时间（${esc(s.tz)}, UTC${esc(s.start.utcOffset)}）：${esc(s.start.local)} ~ ${esc(s.end.local)}</div>
              <div class="muted">UTC：${esc(s.start.iso)}</div>
              <div class="muted">地址：${esc(s.address)}</div>
            </div>
            <button class="btn" onclick="bookFlow(${s.id})">预约 / 候补</button>
          </div>
          <div class="cap-bar"><i style="width:${pct}%"></i></div>
          <div class="muted">固定班级容量 ${s.fixed_capacity} 人，但本场可订 ${s.dynamic_capacity} 席
            —— 瓶颈来自「${esc(s.capacity_source.bottleneck.label)}」。
            讲师/工位/机器需同时占用，余量按瓶颈动态计算。</div>
          <details class="muted"><summary>容量来源明细</summary><table>
            ${s.capacity_source.bottlenecks.map((b) => `<tr><td>${esc(b.label)}</td><td>${b.total}</td></tr>`).join('')}
            <tr><td>已占（含临时占位）</td><td>${s.capacity_source.booked}</td></tr></table></details>
        </div>`;
      }).join('');
      return `<div class="card"><h3>${esc(c.title)}</h3><p class="muted">${esc(c.description || '')}</p>${sessions || '<div class="muted">暂无排课</div>'}</div>`;
    }).join('');
    v.innerHTML = `<div class="muted">课程内容读取自已发布版本 v${pub.version}（兼容 ${pub.reader_version}）；余量与跨时区时间实时计算。</div>${html}`;
  } catch (e) {
    v.innerHTML = `<div class="flash err">${esc(e.message)}</div>`;
  }
}

// ---------- 预约流程：临时占位 -> 待确认（可能改址） ----------
window.bookFlow = async function (sessionId) {
  const name = prompt('学员姓名：');
  if (!name) return;
  const contact = prompt('联系方式（可选）：') || '';
  try {
    const r = await api(`/api/public/sessions/${sessionId}/book`, {
      method: 'POST', body: JSON.stringify({ name, contact })
    });
    if (r.status === 'waitlisted') {
      flash('warn', `当前满员，已进入候补（#${r.booking_id}）。有人取消释放资源时将自动按序提升为临时占位。`);
    } else {
      flash('ok', `已临时占位（#${r.booking_id}）：工位 ${r.station} / 机器 ${r.machine}。请在 ${r.held_expires_at} 前确认，15 分钟未确认自动释放。`);
      await confirmFlow(r.booking_id);
    }
    renderCourses();
  } catch (e) { flash('err', e.message); }
};

async function confirmFlow(bookingId) {
  try {
    const b = await api(`/api/public/bookings/${bookingId}`);
    const r = await api(`/api/public/bookings/${bookingId}/confirm`, { method: 'POST', body: JSON.stringify({}) });
    flash('ok', `预约已确认 #${bookingId}。已绑定确认时的课程「${r.booking.course_title_snapshot}」与地址「${r.booking.address_snapshot}」。`);
  } catch (e) {
    if (e.data && e.data.error === 'ADDRESS_RECONFIRM') {
      const ok = confirm(`门店已改址，需要你确认新地址：\n旧地址：${e.data.old_address || '（见预约）'}\n新地址：${e.data.new_address}\n原因：${e.data.reason}\n\n确认接受新地址吗？`);
      if (ok) {
        const r = await api(`/api/public/bookings/${bookingId}/confirm`, { method: 'POST', body: JSON.stringify({ ackNewAddress: true }) });
        flash('ok', `已按新地址确认 #${bookingId}：${r.booking.address_snapshot}`);
      } else {
        flash('warn', '未确认新地址，预约保持占位（过期前仍可操作）。');
      }
    } else if (e.data && e.data.error === 'SESSION_CANCELLED') {
      flash('err', `抱歉，该课程已被后台撤除，无法确认。后台已记录需通知你（#${bookingId}）。`);
    } else { flash('err', e.message); }
  }
}
window.confirmFlow = confirmFlow;

// ---------- 豆单 ----------
async function renderBeans() {
  const d = await api('/api/public/beans');
  const rows = d.beans.map((b) => `<div class="card">
    <h3>${esc(b.roaster)} · ${esc(b.origin)} <span class="tag ${b.verified ? 'role' : 'warn'}">${b.verified ? '已核对' : '未核对'}</span></h3>
    <div class="muted">处理法：${esc(b.process)} · 烘焙日：${esc(b.roast_date || '未知')}</div>
    <p>${esc(b.personal_notes)}</p></div>`).join('');
  $('#view').innerHTML = `<div class="flash warn">${esc(d.disclaimer)}</div>${rows}`;
}

document.querySelectorAll('nav.tabs button').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  ({ chronology: renderChronology, courses: renderCourses, beans: renderBeans })[btn.dataset.tab]();
}));
renderChronology();
