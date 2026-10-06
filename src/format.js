'use strict';
/** 时间与展示辅助：统一 UTC 存储，展示层按 IANA 时区换算（跨时区展示）。 */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** 把 UTC ISO 时间格式化为指定时区的 'YYYY-MM-DD HH:mm'（确定性输出，便于测试）。 */
function formatInTz(isoUtc, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(isoUtc));
  const p = {};
  for (const part of parts) if (part.type !== 'literal') p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const todayUtc = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();

/** 任职/学习区间展示：'2023-02-01 ~ 至今' */
function rangeText(start, end) {
  return `${start} ~ ${end || '至今'}`;
}

module.exports = { esc, formatInTz, todayUtc, nowIso, rangeText };
