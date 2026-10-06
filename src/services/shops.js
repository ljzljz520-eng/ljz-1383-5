'use strict';
/** 门店服务：改址会 bump 地址版本并把受影响预约标记为「待学员确认」，而非只更新页面地图。 */
const { BookingError } = require('./booking');

function changeAddress(db, shopId, newAddress, { now }) {
  return db.transaction(() => {
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(shopId);
    if (!shop) throw new BookingError('not_found', '门店不存在', 404);
    if (!newAddress || !newAddress.trim()) throw new BookingError('bad_input', '地址不能为空', 422);
    if (shop.address === newAddress.trim()) return { changed: false, affected: 0, address_version: shop.address_version };
    db.prepare('UPDATE shops SET address = ?, address_version = address_version + 1, updated_at = ? WHERE id = ?')
      .run(newAddress.trim(), now, shopId);
    // 已确认预约绑定的是旧地址快照 → 标记待学员确认（学员再确认前，快照保持旧地址）
    const affected = db.prepare(
      `UPDATE bookings SET reconfirm_required = 1, updated_at = ?
       WHERE state = 'confirmed'
         AND session_id IN (SELECT id FROM sessions WHERE shop_id = ?)`
    ).run(now, shopId);
    return { changed: true, affected: affected.changes, address_version: shop.address_version + 1 };
  })();
}

function updateShop(db, shopId, { name, timezone }, { now }) {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(shopId);
  if (!shop) throw new BookingError('not_found', '门店不存在', 404);
  db.prepare('UPDATE shops SET name = ?, timezone = ?, updated_at = ? WHERE id = ?')
    .run(name || shop.name, timezone || shop.timezone, now, shopId);
  return { id: shopId };
}

module.exports = { changeAddress, updateShop };
