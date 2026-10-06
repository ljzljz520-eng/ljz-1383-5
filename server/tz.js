'use strict';

// 课程跨时区展示：存储统一 UTC，展示时换算到门店时区（带 IANA 名与 UTC 偏移）
function toZoned(isoUtc, timeZone) {
  if (!isoUtc) return null;
  const date = new Date(isoUtc);
  const locale = 'en-US';
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  // 计算 UTC 偏移（如 +08:00）
  const dtf = new Intl.DateTimeFormat(locale, { timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour === '24' ? 0 : parts.hour, parts.minute, parts.second);
  let offsetMin = Math.round((asUTC - date.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  offsetMin = Math.abs(offsetMin);
  const oh = String(Math.floor(offsetMin / 60)).padStart(2, '0');
  const om = String(offsetMin % 60).padStart(2, '0');
  return {
    iso: isoUtc,
    tz: timeZone,
    local: `${parts.year}-${parts.month}-${parts.day} ${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
    utcOffset: `${sign}${oh}:${om}`
  };
}

module.exports = { toZoned };
