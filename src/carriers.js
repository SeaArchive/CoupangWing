const aliases = {
  'CJ대한통운': 'CJGLS', '대한통운': 'CJGLS', 'CJ택배': 'CJGLS', 'CJ': 'CJGLS',
  '한진': 'HANJIN', '한진택배': 'HANJIN', '롯데': 'HYUNDAI', '롯데택배': 'HYUNDAI',
  '로젠': 'KGB', '로젠택배': 'KGB', '우체국': 'EPOST', '우체국택배': 'EPOST',
  '경동': 'KDEXP', '경동택배': 'KDEXP', '대신택배': 'DAESIN', '일양택배': 'ILYANG',
  '천일특송': 'CHUNIL', '합동택배': 'HDEXP', '업체직송': 'DIRECT',
};
export function carrierCode(value) { const s = String(value || '').replace(/\s+/g, '').toUpperCase(); return aliases[s] || s; }
