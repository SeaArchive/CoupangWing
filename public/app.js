const $ = id => document.getElementById(id);
let csrf = '', state = null, register = false, logs = [], lastLog = 0, pollBusy = false, shownAuth = false;
let toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
async function api(path, method = 'GET', body) {
  const response = await fetch('/api/' + path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== 'login') showAuth();
    throw new Error(result.error || '요청을 처리하지 못했습니다.');
  }
  return result;
}
function showAuth() { shownAuth = true; state = null; logs = []; lastLog = 0; $('auth-view').hidden = false; $('dashboard').hidden = true; }
function showDashboard() { shownAuth = false; $('auth-view').hidden = true; $('dashboard').hidden = false; }
function formatDate(value) { return value ? new Date(value).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }) : '—'; }
function renderState(s) {
  state = s; $('account-email').textContent = s.email;
  const enabled = s.enabled, running = s.running, demo = s.settings.mode === 'demo';
  $('status-label').textContent = running ? '작업 중' : enabled ? '자동 연동 중' : '대기 중';
  $('worker-label').textContent = running ? 'PROCESSING' : enabled ? 'SCHEDULED' : 'IDLE';
  $('status-dot').classList.toggle('on', enabled || running);
  $('control-title').textContent = enabled ? '서버가 작업을 이어갑니다.' : running ? '이번 작업을 처리하고 있습니다.' : '자동 연동을 시작할 준비';
  $('control-description').textContent = enabled ? '브라우저를 닫아도 서버가 실행 중이면 연동은 계속됩니다.' : '시작 버튼을 누르면 서버가 정해진 간격으로 작업합니다.';
  $('next-run').textContent = formatDate(s.nextRun); $('last-run').textContent = formatDate(s.lastRun?.at) + (s.lastRun ? s.lastRun.success ? ' · 완료' : ' · 오류' : '');
  $('toggle-worker').textContent = enabled ? '자동 연동 중지 ■' : '자동 연동 시작 ↗';
  $('toggle-worker').disabled = !enabled && (running || s.missing.length > 0);
  $('run-once').disabled = running || s.missing.length > 0;
  $('save-settings').disabled = enabled || running;
  $('orders-count').textContent = s.stats.orders; $('completed-count').textContent = s.stats.completed; $('uncertain-count').textContent = s.stats.uncertain;
  $('interval-count').textContent = Number((s.settings.intervalSeconds / 60).toFixed(1));
  $('mode-badge').textContent = demo ? 'DEMO MODE' : 'LIVE SYNC'; $('mode-badge').classList.toggle('live', !demo);
  $('demo-notice').hidden = !demo; $('missing-notice').hidden = !s.missing.length;
  $('missing-notice').textContent = s.missing.length ? '시작 전에 설정하세요: ' + s.missing.join(' / ') : '';
}
function mapping(container, fields, columns, section) {
  $(container).replaceChildren();
  for (const [key, title] of fields) {
    const label = document.createElement('label'); label.textContent = title;
    const input = document.createElement('input'); input.dataset.section = section; input.dataset.key = key;
    input.value = columns[key] || ''; input.maxLength = 3; input.placeholder = '미사용'; input.setAttribute('aria-label', title + ' 열');
    label.append(input); $(container).append(label);
  }
}
function renderSettings(s) {
  const config = s.settings, c = s.credentials;
  const values = { 'setting-mode': config.mode, 'vendor-id': c.vendorId, 'sheet-id': config.spreadsheetId, 'write-tab': config.write.tab, 'read-tab': config.read.tab, 'interval': config.intervalSeconds, 'lookback': config.lookbackDays, 'shop-name': config.shopName, 'start-row': config.write.startRow, 'max-rows': config.write.maxRows, 'read-range': config.read.range };
  for (const [id, value] of Object.entries(values)) $(id).value = value;
  for (const id of ['access-key', 'secret-key', 'google-json']) $(id).value = '';
  $('access-saved').textContent = c.accessKeySaved ? '저장됨' : '미설정'; $('secret-saved').textContent = c.secretKeySaved ? '저장됨' : '미설정'; $('google-saved').textContent = c.googleSaved ? '저장됨' : '미설정';
  $('service-email').textContent = c.serviceEmail ? '시트를 편집자로 공유할 주소: ' + c.serviceEmail : '아직 연결된 서비스 계정이 없습니다.';
  mapping('write-mapping', s.fields, config.write.columns, 'write'); mapping('read-mapping', s.readFields, config.read.columns, 'read');
}
function renderLogs() {
  const filter = $('log-filter').value;
  const visible = logs.filter(l => filter === 'all' || l.level === filter).slice(-150).reverse();
  $('log-list').replaceChildren(); $('empty-logs').hidden = visible.length > 0; $('log-count').textContent = String(logs.length).padStart(2, '0');
  for (const log of visible) {
    const row = document.createElement('div'); row.className = 'log-row';
    const cells = [formatDate(log.at), { info: '안내', success: '완료', warning: '확인 필요', error: '오류' }[log.level] || log.level, { system: '시스템', orders: '주문 → 시트', invoices: '시트 → 쿠팡' }[log.stage] || log.stage, log.message];
    cells.forEach((text, i) => { const el = document.createElement('span'); el.textContent = text; el.className = ['log-time', 'log-badge ' + log.level, 'log-stage', 'log-message'][i]; row.append(el); });
    $('log-list').append(row);
  }
}
async function refresh(initial = false) {
  if (shownAuth || pollBusy) return;
  pollBusy = true;
  try {
    const [s, records] = await Promise.all([api('state'), api('logs?after=' + lastLog)]);
    renderState(s); if (initial) renderSettings(s);
    logs.push(...records.logs); logs = logs.slice(-300); lastLog = logs.at(-1)?.id || lastLog; renderLogs();
    $('refresh-status').textContent = '최근 갱신 ' + new Date().toLocaleTimeString('ko-KR', { hour12: false });
  } catch (error) { if (!shownAuth) $('refresh-status').textContent = '연결 대기 · 다음 갱신에서 재시도'; }
  finally { pollBusy = false; }
}
$('auth-toggle').addEventListener('click', () => {
  register = !register; $('auth-title').textContent = register ? '이메일로 계정 만들기' : '이메일로 로그인';
  $('auth-help').textContent = register ? '비밀번호는 5자 이상으로 입력하세요. 기호는 선택 사항입니다.' : '내 계정의 연동 설정과 작업 기록을 엽니다.';
  $('auth-submit').textContent = register ? '계정 만들기 ↗' : '로그인 ↗';
  $('auth-toggle').textContent = register ? '이미 계정이 있으신가요? 로그인' : '처음이신가요? 계정 만들기'; $('auth-error').textContent = '';
  $('password').autocomplete = register ? 'new-password' : 'current-password';
});
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); $('auth-submit').disabled = true; $('auth-error').textContent = '';
  try { const result = await api(register ? 'register' : 'login', 'POST', { email: $('email').value, password: $('password').value }); csrf = result.csrf; $('password').value = ''; showDashboard(); await refresh(true); }
  catch (error) { $('auth-error').textContent = error.message; }
  finally { $('auth-submit').disabled = false; }
});
$('logout').addEventListener('click', async () => { try { await api('logout', 'POST'); csrf = ''; showAuth(); } catch (e) { toast(e.message); } });
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => {
  const tab = button.dataset.tab;
  for (const other of document.querySelectorAll('[data-tab]')) { const active = other === button; other.classList.toggle('active', active); other.setAttribute('aria-selected', active); }
  $('logs-panel').hidden = tab !== 'logs'; $('settings-panel').hidden = tab !== 'settings';
});
$('toggle-worker').addEventListener('click', async () => { try { await api(state.enabled ? 'stop' : 'start', 'POST'); await refresh(); } catch (e) { toast(e.message); } });
$('run-once').addEventListener('click', async () => { try { await api('run', 'POST'); toast('작업을 시작했습니다. 로그에서 결과를 확인하세요.'); await refresh(); } catch (e) { toast(e.message); } });
$('refresh-logs').addEventListener('click', () => refresh()); $('log-filter').addEventListener('change', renderLogs);
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); const feedback = $('settings-feedback'); feedback.textContent = '저장 중…'; feedback.classList.remove('error-message');
  const settings = { mode: $('setting-mode').value, spreadsheetId: $('sheet-id').value.trim(), shopName: $('shop-name').value, intervalSeconds: Number($('interval').value), lookbackDays: Number($('lookback').value), write: { tab: $('write-tab').value, startRow: Number($('start-row').value), maxRows: Number($('max-rows').value), columns: {} }, read: { tab: $('read-tab').value, range: $('read-range').value, columns: {} } };
  for (const input of document.querySelectorAll('[data-section]')) settings[input.dataset.section].columns[input.dataset.key] = input.value;
  const credentials = { COUPANG_VENDOR_ID: $('vendor-id').value, COUPANG_ACCESS_KEY: $('access-key').value, COUPANG_SECRET_KEY: $('secret-key').value, GOOGLE_SERVICE_ACCOUNT_JSON: $('google-json').value };
  try { await api('settings', 'PUT', { settings, credentials }); await refresh(true); feedback.textContent = '설정을 저장했습니다.'; }
  catch (error) { feedback.textContent = error.message; feedback.classList.add('error-message'); }
});
(async () => {
  try { const auth = await api('auth'); csrf = auth.csrf || ''; $('auth-toggle').hidden = !auth.registration; if (auth.authenticated) { showDashboard(); await refresh(true); } else showAuth(); }
  catch { showAuth(); $('auth-error').textContent = '서버에 연결하지 못했습니다. 잠시 후 새로고침하세요.'; }
  setInterval(() => refresh(), 5000);
})();
