import { createHash } from 'node:crypto';
import { remaining } from './providers.js';
export function orderKey(order, item, vendor) { return [vendor, order.orderId, order.shipmentBoxId, item.vendorItemId, item.sequenceNo || '001'].map(String).join(':'); }
export function flatten(order, vendor, shopName = '') {
  const r = order.receiver || {};
  return (order.orderItems || []).filter(i => remaining(i) > 0).map(item => ({
    orderKey: orderKey(order, item, vendor), orderId: String(order.orderId), shipmentBoxId: String(order.shipmentBoxId), vendorItemId: String(item.vendorItemId), sequence: String(item.sequenceNo || '001'),
    status: ({ ACCEPT: '주문접수', INSTRUCT: '배송대기', DEPARTURE: '배송지시', DELIVERING: '배송중', FINAL_DELIVERY: '배송완료', NONE_TRACKING: '직접배송', CANCELLED: '주문취소' })[order.status] || order.status || '', receivedAt: kstDate(order.paidAt || order.orderedAt), recordedAt: kstDate(new Date().toISOString()), recipient: r.name || '', postalCode: r.postCode || '',
    address: [r.addr1, r.addr2].filter(Boolean).join(' '), phone: r.safeNumber || '', phone2: r.receiverNumber || '',
    product: item.sellerProductName || item.vendorItemName || '', quantity: remaining(item), message: order.parcelPrintMessage || '', option: item.sellerProductItemName || '', shop: shopName || order.seller?.sellerName || '',
  }));
}
export function validateShipment(order, entries, vendor, savedOrders) {
  if (order.status !== 'INSTRUCT') throw new Error('상품준비중 주문만 송장을 등록할 수 있습니다.');
  if (order.splitShipping) throw new Error('분리배송 주문은 자동 등록 대상에서 제외됩니다.');
  const current = flatten(order, vendor);
  if (!current.length || current.length !== entries.length || current.some(o => !entries.some(e => e.orderKey === o.orderKey))) throw new Error('묶음배송 상품이 누락되었거나 주문 구성이 변경되었습니다.');
  const carriers = new Set(entries.map(e => e.carrier)); const invoices = new Set(entries.map(e => e.invoice));
  if (carriers.size !== 1 || carriers.has('') || invoices.size !== 1) throw new Error('묶음배송의 모든 품목에 같은 택배사 코드와 운송장번호가 필요합니다.');
  const carrier = entries[0].carrier; const invoice = entries[0].invoice;
  if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(carrier) || !/^\d{5,40}$/.test(invoice)) throw new Error('택배사 코드 또는 운송장번호 형식을 확인하세요.');
  for (const o of current) {
    if (!savedOrders.get(o.orderKey) || savedOrders.get(o.orderKey).delivery_hash !== deliveryHash(o)) throw new Error('수취인 또는 배송수량이 변경되었습니다. 주문을 다시 수집한 뒤 확인하세요.');
  }
  return { carrier, invoice };
}
export function deliveryHash(order) { return createHash('sha256').update(JSON.stringify([order.recipient, order.postalCode, order.address, order.phone, order.quantity, order.vendorItemId])).digest('hex'); }

export function kstDate(value) { if (!value) return ''; const date = new Date(value); if (Number.isNaN(date.getTime())) return String(value); return new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 19).replace('T', ' '); }
