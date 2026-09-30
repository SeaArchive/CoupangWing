import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Database } from '../src/store.js';
import { Vault } from '../src/security.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/config.js';
import { Coupang, Sheets, parseLossless, numericId } from '../src/providers.js';
import { flatten, deliveryHash, validateShipment } from '../src/domain.js';
import { carrierCode } from '../src/carriers.js';
import { Engine } from '../src/engine.js';
const order = () => ({ orderId: '4000019469460', shipmentBoxId: '123456789012345680', paidAt: '2026-09-30T10:00:00+09:00', status: 'INSTRUCT', receiver: { name: '샘플', postCode: '00123', addr1: '배송지', addr2: '상세주소', safeNumber: '05012345678' }, seller: { sellerName: '상점' }, orderItems: [{ vendorItemId: '1234', sequenceNo: '001', sellerProductName: '샘플 상품', sellerProductItemName: '대형', shippingCount: 2, cancelCount: 0, holdCountForCancel: 0 }] });
function tenant() { const database = new Database(':memory:'); database.createUser('a', 'a@example.com', 'test'); return { database, store: database.tenant('a') }; }
const secrets = { COUPANG_VENDOR_ID: 'A000123', COUPANG_ACCESS_KEY: 'fake', COUPANG_SECRET_KEY: 'fake', GOOGLE_SERVICE_ACCOUNT_JSON: '{}' };
function live(store) { store.set('settings', { ...structuredClone(DEFAULT_SETTINGS), mode: 'live', spreadsheetId: '1234567890', write: { ...DEFAULT_SETTINGS.write, tab: '주문' }, read: { ...DEFAULT_SETTINGS.read, tab: '주문' } }); }

test('계정별 설정·로그·주문·송장 원장이 격리된다', () => {
  const { database, store } = tenant(); database.createUser('b', 'b@example.com', 'test'); const other = database.tenant('b');
  store.set('settings', { spreadsheetId: 'private' }); store.log('info', 'system', 'private');
  const row = flatten(order(), 'A000123')[0]; store.putOrder({ ...row, deliveryHash: deliveryHash(row) }); store.setInvoice(row.shipmentBoxId, 'completed', 'CJGLS', '000000000000');
  assert.notEqual(other.settings().spreadsheetId, 'private'); assert.equal(other.logs().length, 0); assert.equal(other.order(row.orderKey), undefined); assert.equal(other.invoice(row.shipmentBoxId), undefined); database.close();
});
test('암호화 값은 원문을 포함하지 않고 소유자가 바뀌면 복호화되지 않는다', () => {
  const vault = new Vault({ ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  const encoded = vault.encrypt({ secret: 'private-secret' }, 'a'); assert.ok(!encoded.includes('private-secret')); assert.equal(vault.decrypt(encoded, 'a').secret, 'private-secret'); assert.throws(() => vault.decrypt(encoded, 'b'));
});
test('큰 배송번호의 정밀도와 송장 앞자리 0을 유지한다', () => {
  assert.equal(parseLossless('{"shipmentBoxId":123456789012345680}').shipmentBoxId, '123456789012345680');
  assert.equal(JSON.stringify({ id: numericId('123456789012345680') }), '{"id":123456789012345680}');
  assert.equal(flatten(order(), 'A000123')[0].postalCode, '00123');
});
test('쿠팡 HMAC 형식과 실제 POST 숫자 식별자를 검증한다', async () => {
  const api = new Coupang(secrets); const previous = global.fetch; let body;
  global.fetch = async (url, options) => {
    assert.match(options.headers.Authorization, /signed-date=\d{6}T\d{6}Z, signature=[a-f0-9]{64}/);
    body = options.body; return new Response(JSON.stringify({ code: 200, data: { responseCode: 0, responseList: [{ succeed: true }] } }));
  };
  try { await api.upload(order(), 'CJGLS', '001234567890'); assert.ok(body.includes('"shipmentBoxId":123456789012345680')); assert.ok(body.includes('"invoiceNumber":"001234567890"')); } finally { global.fetch = previous; }
});
test('설정은 55행과 A~M, 공급자 O/P, AA 식별키를 기본으로 한다', () => {
  const s = normalizeSettings({}); assert.equal(s.write.startRow, 55); assert.equal(s.write.columns.status, 'M'); assert.equal(s.read.columns.carrier, 'O'); assert.equal(s.read.columns.invoice, 'P'); assert.equal(s.write.columns.orderKey, 'AA');
  assert.throws(() => normalizeSettings({ write: { columns: { ...s.write.columns, receivedAt: 'N', recipient: 'N' } } }));
});
test('시트 갱신은 1~54행과 N~Z 및 최초 작성일을 건드리지 않는다', async () => {
  const s = normalizeSettings({}); s.write.tab = '주문'; s.spreadsheetId = '1234567890';
  const row = flatten(order(), 'A000123')[0]; const existing = Array(27).fill(''); existing[0] = row.receivedAt; existing[1] = '최초작성일'; existing[13] = '공급자값'; existing[26] = row.orderKey;
  const sheet = Object.create(Sheets.prototype); let reads = 0, patches = [];
  sheet.layout = async () => ({ sheetId: 1, gridProperties: { rowCount: 1000, columnCount: 27 } }); sheet.grow = async () => {};
  sheet.read = async () => { reads++; return [existing]; }; sheet.write = async (_, data) => patches.push(...data);
  const result = await sheet.writeOrders(s, [row, row]); assert.equal(result.added, 0); assert.equal(result.updated, 1); assert.equal(reads, 1);
  for (const patch of patches) { assert.match(patch.range, /55$/); assert.ok(!/![N-Z]55$/.test(patch.range)); assert.ok(!/!B55$/.test(patch.range)); }
});
test('누락된 실전화번호는 빈칸이며 택배사 이름이 코드로 변환된다', () => {
  const row = flatten(order(), 'A000123')[0]; assert.equal(row.phone2, ''); assert.equal(carrierCode('CJ 대한통운'), 'CJGLS'); assert.equal(carrierCode('로젠택배'), 'KGB');
});
test('배송지 변경과 불완전한 묶음배송은 전송을 막는다', () => {
  const o = order(), row = flatten(o, 'A000123')[0], saved = new Map([[row.orderKey, { delivery_hash: deliveryHash(row) }]]);
  const entries = [{ orderKey: row.orderKey, carrier: 'CJGLS', invoice: '001234567890' }];
  assert.equal(validateShipment(o, entries, 'A000123', saved).carrier, 'CJGLS');
  assert.throws(() => validateShipment({ ...o, receiver: { ...o.receiver, addr1: '변경된주소' } }, entries, 'A000123', saved));
  assert.throws(() => validateShipment({ ...o, orderItems: [...o.orderItems, { ...o.orderItems[0], sequenceNo: '002' }] }, entries, 'A000123', saved));
});
test('완료한 송장은 다시 등록하지 않는다', async () => {
  const { database, store } = tenant(); live(store); let calls = 0; const row = flatten(order(), secrets.COUPANG_VENDOR_ID)[0];
  const providers = { coupang: { orders: async () => [order()], shipment: async () => order(), upload: async () => { calls++; } }, sheets: { writeOrders: async () => ({ added: 1, updated: 0 }), invoices: async () => [{ row: 55, orderKey: row.orderKey, carrier: 'CJGLS', invoice: '001234567890' }] } };
  const engine = new Engine(store, () => secrets, providers); await engine.run(); await engine.run(); assert.equal(calls, 1); assert.equal(store.stats().completed, 1); database.close();
});
test('응답 미확인 송장은 재전송하지 않고 다음 주기에 등록 여부만 확인한다', async () => {
  const { database, store } = tenant(); live(store); let calls = 0, shipped = false; const row = flatten(order(), secrets.COUPANG_VENDOR_ID)[0];
  const providers = { coupang: { orders: async () => [order()], shipment: async () => shipped ? { ...order(), status: 'DEPARTURE', invoiceNumber: '001234567890' } : order(), upload: async () => { calls++; throw new Error('timeout'); } }, sheets: { writeOrders: async () => ({ added: 1, updated: 0 }), invoices: async () => [{ row: 55, orderKey: row.orderKey, carrier: 'CJGLS', invoice: '001234567890' }] } };
  const engine = new Engine(store, () => secrets, providers); await engine.run(); await engine.run(); assert.equal(calls, 1); assert.equal(store.stats().uncertain, 1);
  shipped = true; await engine.run(); assert.equal(calls, 1); assert.equal(store.stats().completed, 1); database.close();
});
test('같은 계정의 주기가 겹치지 않는다', async () => {
  const { database, store } = tenant(); live(store); let release; const wait = new Promise(resolve => { release = resolve; });
  const engine = new Engine(store, () => secrets, { coupang: { orders: async () => { await wait; return []; } }, sheets: { writeOrders: async () => ({ added: 0, updated: 0 }), invoices: async () => [] } });
  const first = engine.run(); assert.equal(await engine.run(), false); release(); await first; database.close();
});
