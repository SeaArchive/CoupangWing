export const FIELDS = [
  ['receivedAt', '주문 접수 일'], ['recordedAt', '시트 작성 일'], ['recipient', '수취인 명'],
  ['postalCode', '우편번호'], ['address', '수취인주소'], ['phone', '수취인 전화번호'],
  ['phone2', '전화번호2'], ['product', '품목명'], ['quantity', '수량'],
  ['message', '배송메시지'], ['option', '규격'], ['shop', '보내는분 성명'],
  ['status', '주문 상태'], ['orderKey', '연동 식별키'], ['orderId', '주문번호'], ['shipmentBoxId', '묶음배송번호'], ['vendorItemId', '옵션 ID'],
];
export const READ_FIELDS = [['orderKey', '연동 식별키'], ['carrier', '택배사 코드'], ['invoice', '운송장번호']];
export const DEFAULT_SETTINGS = {
  mode: 'demo', spreadsheetId: '', intervalSeconds: 300, lookbackDays: 7, shopName: '',
  write: { tab: '', startRow: 55, maxRows: 10000, columns: { receivedAt: 'A', recordedAt: 'B', recipient: 'C', postalCode: 'D', address: 'E', phone: 'F', phone2: 'G', product: 'H', quantity: 'I', message: 'J', option: 'K', shop: 'L', status: 'M', orderKey: 'AA', orderId: '', shipmentBoxId: '', vendorItemId: '' } },
  read: { tab: '', range: 'A55:AA10054', columns: { orderKey: 'AA', carrier: 'O', invoice: 'P' } },
};
export function columnIndex(column) {
  if (!/^[A-Z]{1,3}$/.test(column)) throw new Error('열은 A, B, AA 같은 문자로 입력하세요.');
  const n = [...column].reduce((sum, c) => sum * 26 + c.charCodeAt(0) - 64, 0);
  if (n > 18278) throw new Error('시트 열 범위를 초과했습니다.');
  return n;
}
export function columnName(n) {
  let name = '';
  while (n > 0) { const r = (n - 1) % 26; name = String.fromCharCode(65 + r) + name; n = Math.floor((n - 1) / 26); }
  return name;
}
export function parseRange(value) {
  const match = /^([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/.exec(value);
  if (!match) throw new Error('읽기 범위는 A2:T2000처럼 행이 지정된 범위로 입력하세요.');
  const [left, top, right, bottom] = [columnIndex(match[1]), Number(match[2]), columnIndex(match[3]), Number(match[4])];
  if (left > right || top > bottom || bottom > 1000000 || bottom - top > 9999 || right - left > 199) throw new Error('읽기 범위는 최대 10,000행 · 200열입니다.');
  return { left, top, right, bottom };
}
export function normalizeSettings(input) {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.mode = input.mode === 'live' ? 'live' : 'demo';
  for (const k of ['spreadsheetId', 'shopName']) s[k] = String(input[k] ?? '').trim();
  if (s.spreadsheetId && !/^[a-zA-Z0-9_-]{10,200}$/.test(s.spreadsheetId)) throw new Error('시트 ID 형식을 확인하세요. URL의 /d/와 /edit 사이 값을 입력하세요.');
  s.intervalSeconds = Number(input.intervalSeconds ?? s.intervalSeconds);
  s.lookbackDays = Number(input.lookbackDays ?? s.lookbackDays);
  if (!Number.isInteger(s.intervalSeconds) || s.intervalSeconds < 60 || s.intervalSeconds > 3600) throw new Error('실행 간격은 60~3600초입니다.');
  if (!Number.isInteger(s.lookbackDays) || s.lookbackDays < 1 || s.lookbackDays > 30) throw new Error('주문 조회 기간은 1~30일입니다.');
  for (const section of ['write', 'read']) {
    s[section].tab = String(input[section]?.tab ?? '').trim();
    if (s[section].tab.length > 100) throw new Error('탭 이름이 너무 깁니다.');
    const cols = [];
    for (const k of Object.keys(s[section].columns)) {
      const val = String(input[section]?.columns?.[k] ?? s[section].columns[k]).trim().toUpperCase();
      if (val) { columnIndex(val); cols.push(val); }
      s[section].columns[k] = val;
    }
    if (new Set(cols).size !== cols.length) throw new Error('한 항목에 지정한 열은 다른 항목과 겹칠 수 없습니다.');
  }
  s.write.startRow = Number(input.write?.startRow ?? 55);
  s.write.maxRows = Number(input.write?.maxRows ?? 10000);
  if (!Number.isInteger(s.write.startRow) || s.write.startRow < 1 || s.write.startRow > 990000 || !Number.isInteger(s.write.maxRows) || s.write.maxRows < 1 || s.write.maxRows > 10000) throw new Error('쓰기 시작 행과 최대 행 수를 확인하세요.');
  const mapped = Object.values(s.write.columns).filter(Boolean).map(columnIndex);
  if (mapped.length && Math.max(...mapped) - Math.min(...mapped) > 199) throw new Error('쓰기 열은 200열 이내에 배치하세요.');
  s.read.range = String(input.read?.range ?? s.read.range).trim().toUpperCase();
  if (s.read.range) {
    const range = parseRange(s.read.range);
    if (Object.values(s.read.columns).filter(Boolean).some(c => columnIndex(c) < range.left || columnIndex(c) > range.right)) throw new Error('읽기 열은 지정한 읽기 범위 안에 있어야 합니다.');
  }
  return s;
}
export function readiness(s, env) {
  if (s.mode === 'demo') return [];
  const missing = [];
  for (const k of ['COUPANG_VENDOR_ID', 'COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY']) if (!env[k]) missing.push(k);
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON && !env.GOOGLE_SERVICE_ACCOUNT_FILE) missing.push('Google 서비스 계정');
  if (!s.spreadsheetId) missing.push('Google Sheet ID');
  if (!s.write.tab || !s.write.columns.orderKey || !s.write.columns.recipient || !s.write.columns.address || !s.write.columns.quantity) missing.push('쓰기 탭·식별키·수취인·주소·수량 열');
  if (!s.read.tab || !s.read.range || Object.values(s.read.columns).some(v => !v)) missing.push('운송장 읽기 탭·범위·열');
  return missing;
}
export function tabRange(tab, range) { return `'${tab.replaceAll("'", "''")}'!${range}`; }
