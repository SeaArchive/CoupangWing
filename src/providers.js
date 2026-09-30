import { createHmac, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { carrierCode } from './carriers.js';
import { tabRange, columnIndex, columnName, parseRange } from './config.js';

export function parseLossless(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!/^\d+$/.test(context.source)) throw new Error('식별자 숫자 형식을 확인하세요.');
      return context.source;
    }
    return value;
  });
}
export function numericId(id) {
  if (!/^\d{1,30}$/.test(String(id))) throw new Error('쿠팡 식별자 형식이 잘못되었습니다.');
  return JSON.rawJSON(String(id));
}
export class ProviderError extends Error {
  constructor(provider, status, ambiguous = false) { super(`${provider} 연결 오류${status ? ` (HTTP ${status})` : ''}`); this.ambiguous = ambiguous; }
}
async function request(url, options, provider) {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000), redirect: 'error' }); }
  catch { throw new ProviderError(provider, null, options.method !== 'GET'); }
  if (!response.ok) throw new ProviderError(provider, response.status, options.method !== 'GET');
  const text = await response.text();
  try { return parseLossless(text); } catch { throw new ProviderError(provider, response.status, options.method !== 'GET'); }
}
export class Coupang {
  constructor(env) { this.env = env; }
  async call(method, path, params = {}, body) {
    const query = new URLSearchParams(params).toString();
    const date = new Date().toISOString().replace(/[-:]/g, '').slice(2, 15) + 'Z';
    const signature = createHmac('sha256', this.env.COUPANG_SECRET_KEY).update(date + method + path + query).digest('hex');
    const Authorization = `CEA algorithm=HmacSHA256, access-key=${this.env.COUPANG_ACCESS_KEY}, signed-date=${date}, signature=${signature}`;
    const result = await request(`https://api-gateway.coupang.com${path}${query ? '?' + query : ''}`, { method, headers: { Authorization, 'Content-Type': 'application/json;charset=UTF-8' }, ...(body ? { body: JSON.stringify(body) } : {}) }, '쿠팡');
    if (String(result.code) !== '200') throw new ProviderError('쿠팡', result.code, method !== 'GET');
    return result;
  }
  get base() { return `/v2/providers/openapi/apis/api/v5/vendors/${encodeURIComponent(this.env.COUPANG_VENDOR_ID)}/ordersheets`; }
  async orders(days) {
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const from = new Date(Date.parse(today) - days * 86400000).toISOString().slice(0, 10);
    const orders = [];
    for (const status of ['ACCEPT', 'INSTRUCT', 'DEPARTURE', 'DELIVERING', 'FINAL_DELIVERY', 'NONE_TRACKING']) {
      let token = ''; const seen = new Set();
      do {
        const result = await this.call('GET', this.base, { createdAtFrom: `${from}+09:00`, createdAtTo: `${today}+09:00`, maxPerPage: '50', status, ...(token ? { nextToken: token } : {}) });
        if (!Array.isArray(result.data)) throw new ProviderError('쿠팡', null);
        orders.push(...result.data);
        token = result.nextToken || '';
        if (token && seen.has(token)) throw new Error('쿠팡 페이지 조회가 반복되어 중단했습니다.');
        seen.add(token);
      } while (token);
    }
    return orders;
  }
  async shipment(id) { return (await this.call('GET', this.base + '/' + encodeURIComponent(id))).data; }
  async upload(order, carrier, invoice) {
    const path = `/v2/providers/openapi/apis/api/v4/vendors/${encodeURIComponent(this.env.COUPANG_VENDOR_ID)}/orders/invoices`;
    const body = { vendorId: this.env.COUPANG_VENDOR_ID, orderSheetInvoiceApplyDtos: order.orderItems.filter(i => remaining(i) > 0).map(item => ({
      shipmentBoxId: numericId(order.shipmentBoxId), orderId: numericId(order.orderId), vendorItemId: numericId(item.vendorItemId),
      deliveryCompanyCode: carrier, invoiceNumber: invoice, splitShipping: false, preSplitShipped: false, estimatedShippingDate: '',
    })) };
    const data = (await this.call('POST', path, {}, body)).data;
    if (Number(data?.responseCode) !== 0 || !data?.responseList?.length || data.responseList.some(r => r.succeed !== true)) throw new ProviderError('쿠팡 송장 등록', null, true);
  }
}
export function remaining(item) {
  if (item.canceled) return 0;
  return Number(item.shippingCount || 0) - Number(item.cancelCount || 0) - Number(item.holdCountForCancel || 0);
}
export class Sheets {
  constructor(env) {
    this.credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON || readFileSync(env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
    if (!this.credentials.client_email || !this.credentials.private_key) throw new Error('Google 서비스 계정 설정을 확인하세요.');
  }
  async token() {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: this.credentials.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })).toString('base64url');
    const content = header + '.' + payload;
    const assertion = content + '.' + sign('RSA-SHA256', Buffer.from(content), this.credentials.private_key).toString('base64url');
    const result = await request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() }, 'Google 인증');
    if (!result.access_token) throw new ProviderError('Google 인증', null);
    this.accessToken = result.access_token; this.expiresAt = Date.now() + (Number(result.expires_in || 3600) - 120) * 1000;
    return this.accessToken;
  }
  async call(id, suffix, method = 'GET', body) {
    return request(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}${suffix}`, { method, headers: { Authorization: 'Bearer ' + await this.token(), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, 'Google Sheets');
  }
  async layout(id, tab) {
    const metadata = await this.call(id, '?fields=sheets(properties(sheetId,title,gridProperties))');
    const properties = metadata.sheets?.find(s => s.properties?.title === tab)?.properties;
    if (!properties) throw new Error('시트 탭 이름을 확인하세요.');
    return properties;
  }
  async grow(id, properties, rows, columns) {
    const rowCount = Math.max(rows, properties.gridProperties.rowCount), columnCount = Math.max(columns, properties.gridProperties.columnCount);
    if (rowCount === properties.gridProperties.rowCount && columnCount === properties.gridProperties.columnCount) return;
    await this.call(id, ':batchUpdate', 'POST', { requests: [{ updateSheetProperties: { properties: { sheetId: properties.sheetId, gridProperties: { rowCount, columnCount } }, fields: 'gridProperties.rowCount,gridProperties.columnCount' } }] });
  }
  async read(id, range) {
    const result = await this.call(id, `/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`);
    return result.values || [];
  }
  async write(id, data) {
    for (let i = 0; i < data.length; i += 500) await this.call(id, '/values:batchUpdate', 'POST', { valueInputOption: 'RAW', data: data.slice(i, i + 500) });
  }
  async writeOrders(settings, orders) {
    const { tab, startRow, maxRows, columns } = settings.write;
    const indices = Object.values(columns).filter(Boolean).map(columnIndex);
    const left = Math.min(...indices), right = Math.max(...indices);
    const grid = await this.layout(settings.spreadsheetId, tab);
    await this.grow(settings.spreadsheetId, grid, startRow, right);
    const bottom = Math.min(startRow + maxRows - 1, Math.max(startRow, grid.gridProperties.rowCount));
    const rows = await this.read(settings.spreadsheetId, tabRange(tab, `${columnName(left)}${startRow}:${columnName(right)}${bottom}`));
    const keyIndex = columnIndex(columns.orderKey) - left;
    const existing = new Map(); let lastOccupied = -1;
    rows.forEach((row, i) => {
      if (row.some(v => v !== '' && v != null)) lastOccupied = i;
      const key = row[keyIndex];
      if (key) { if (existing.has(String(key))) throw new Error('쓰기 범위의 연동 식별키가 중복되었습니다.'); existing.set(String(key), i); }
    });
    let next = lastOccupied + 1, added = 0, updated = 0; let data = []; const batches = []; const unique = new Set();
    for (const order of orders) {
      if (unique.has(order.orderKey)) continue;
      unique.add(order.orderKey);
      let offset = existing.get(order.orderKey);
      if (offset === undefined) { offset = next++; added++; } else updated++;
      if (offset >= maxRows) throw new Error('지정한 쓰기 범위가 가득 찼습니다. 최대 행 수를 늘리세요.');
      const rowData = [];
      for (const [field, col] of Object.entries(columns)) {
        if (!col) continue;
        // Preserve the first recorded time when a row already exists.
        if (field === 'recordedAt' && rows[offset]?.[columnIndex(col) - left]) continue;
        const val = String(order[field] ?? '');
        if (String(rows[offset]?.[columnIndex(col) - left] ?? '') === val) continue;
        rowData.push({ range: tabRange(tab, `${col}${startRow + offset}`), values: [[val]] });
      }
      if (data.length + rowData.length > 400) { batches.push(data); data = []; }
      data.push(...rowData);
    }
    if (data.length) batches.push(data);
    await this.grow(settings.spreadsheetId, { ...grid, gridProperties: { ...grid.gridProperties, columnCount: Math.max(right, grid.gridProperties.columnCount) } }, startRow + next - 1, right);
    for (const batch of batches) await this.write(settings.spreadsheetId, batch);
    return { added, updated };
  }
  async invoices(settings) {
    const { tab, range, columns } = settings.read;
    const { left, top, right, bottom } = parseRange(range);
    const grid = await this.layout(settings.spreadsheetId, tab);
    if (top > grid.gridProperties.rowCount) return [];
    if (right > grid.gridProperties.columnCount) throw new Error('읽기 범위의 열이 시트에 없습니다.');
    const bounded = `${columnName(left)}${top}:${columnName(right)}${Math.min(bottom, grid.gridProperties.rowCount)}`;
    const rows = await this.read(settings.spreadsheetId, tabRange(tab, bounded));
    return rows.map((row, i) => { const entry = { row: top + i, ...Object.fromEntries(Object.entries(columns).map(([key, col]) => [key, String(row[columnIndex(col) - left] ?? '').trim()])) }; entry.carrier = carrierCode(entry.carrier); return entry; }).filter(r => r.orderKey && r.invoice);
  }
}
