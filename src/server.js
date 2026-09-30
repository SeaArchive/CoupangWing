import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Database } from './store.js';
import { Vault, normalizeEmail, passwordHash, passwordMatches, sessionHash, updateSecrets, secretStatus } from './security.js';
import { normalizeSettings, readiness, FIELDS, READ_FIELDS } from './config.js';
import { Engine } from './engine.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
export function createApplication(env = process.env) {
  const directory = env.DATA_DIR || './data';
  const database = new Database(directory); const vault = new Vault(env, directory);
  const engines = new Map(); const rate = new Map();
  const origin = env.APP_ORIGIN || `http://localhost:${env.PORT || 3000}`;
  const secure = env.COOKIE_SECURE === 'true';
  if (env.NODE_ENV === 'production' && (!secure || !origin.startsWith('https://'))) throw new Error('운영 서버는 HTTPS APP_ORIGIN과 COOKIE_SECURE=true가 필요합니다.');
  const credentials = store => vault.decrypt(store.get('secrets', ''), store.id);
  function engine(id) {
    if (!engines.has(id)) { const store = database.tenant(id); engines.set(id, new Engine(store, () => credentials(store))); }
    return engines.get(id);
  }
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const cookie = (token, age) => `cw_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  async function body(req) {
    let text = ''; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 100000) throw new Error('입력 내용이 너무 큽니다.'); text += chunk; }
    try { return JSON.parse(text || '{}'); } catch { throw new Error('요청 형식이 잘못되었습니다.'); }
  }
  function session(req) {
    const token = /(?:^|;\s*)cw_session=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
    if (!token) return null;
    return database.db.prepare('SELECT s.*,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>?').get(sessionHash(token), Date.now());
  }
  function limited(req) {
    const now = Date.now(), key = req.socket.remoteAddress;
    for (const [id, r] of rate) if (r.expires < now) rate.delete(id);
    const r = rate.get(key) || { attempts: 0, expires: now + 600000 }; r.attempts++; rate.set(key, r);
    return r.attempts > 20;
  }
  function newSession(id, res) {
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex');
    database.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    database.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(sessionHash(token), id, csrf, Date.now() + 12 * 3600000);
    res.setHeader('Set-Cookie', cookie(token, 12 * 3600));
    return csrf;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, origin); const path = url.pathname;
      if (path === '/healthz') return json(res, 200, { ok: true });
      if (!path.startsWith('/api/')) {
        const files = { '/': ['../index.html', 'text/html'], '/index.html': ['../index.html', 'text/html'], '/public/app.js': ['app.js', 'text/javascript'], '/public/style.css': ['style.css', 'text/css'], '/public/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
        if (req.method !== 'GET' || !files[path]) return json(res, 404, { error: '페이지를 찾을 수 없습니다.' });
        const [name, type] = files[path]; const file = await readFile(publicDir + name);
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' }); return res.end(file);
      }
      const current = session(req);
      if (req.method !== 'GET' && req.headers.origin !== origin) return json(res, 403, { error: '허용되지 않은 요청입니다.' });
      if (path === '/api/auth' && req.method === 'GET') return json(res, 200, { authenticated: Boolean(current), email: current?.email, csrf: current?.csrf, registration: env.ALLOW_REGISTRATION !== 'false' });
      if (['/api/login', '/api/register'].includes(path) && req.method === 'POST') {
        if (limited(req)) return json(res, 429, { error: '잠시 후 다시 시도하세요.' });
        const input = await body(req); const email = normalizeEmail(input.email);
        if (path === '/api/register') {
          if (env.ALLOW_REGISTRATION === 'false') return json(res, 403, { error: '현재 회원가입이 닫혀 있습니다.' });
          const encoded = await passwordHash(input.password);
          if (database.user(email)) return json(res, 409, { error: '계정을 만들 수 없습니다. 로그인 또는 다른 이메일을 사용하세요.' });
          const id = randomUUID(); database.createUser(id, email, encoded);
          database.tenant(id).log('info', 'system', '계정을 생성했습니다. 연동 설정을 저장하면 사용할 수 있습니다.');
          return json(res, 201, { csrf: newSession(id, res), email });
        }
        const user = database.user(email);
        // Always run scrypt, even for an unknown email, to reduce account enumeration by timing.
        const encoded = user?.password || '00000000000000000000000000000000:' + '0'.repeat(128);
        if (!await passwordMatches(input.password, encoded) || !user) return json(res, 401, { error: '이메일 또는 비밀번호를 확인하세요.' });
        return json(res, 200, { csrf: newSession(user.id, res), email });
      }
      if (!current) return json(res, 401, { error: '로그인이 필요합니다.' });
      if (req.method !== 'GET' && req.headers['x-csrf-token'] !== current.csrf) return json(res, 403, { error: '로그인 정보를 새로고침하세요.' });
      const store = database.tenant(current.user_id); const worker = engine(current.user_id);
      if (path === '/api/logout' && req.method === 'POST') { database.db.prepare('DELETE FROM sessions WHERE hash=?').run(current.hash); res.setHeader('Set-Cookie', cookie('', 0)); return json(res, 200, { ok: true }); }
      if (path === '/api/state' && req.method === 'GET') return json(res, 200, { email: current.email, ...worker.status(), settings: store.settings(), credentials: secretStatus(credentials(store)), missing: readiness(store.settings(), credentials(store)), fields: FIELDS, readFields: READ_FIELDS });
      if (path === '/api/logs' && req.method === 'GET') {
        const after = Number(url.searchParams.get('after') || 0); if (!Number.isSafeInteger(after) || after < 0) throw new Error('로그 조회 값이 잘못되었습니다.');
        return json(res, 200, { logs: store.logs(after) });
      }
      if (path === '/api/settings' && req.method === 'PUT') {
        if (worker.running || worker.status().enabled) return json(res, 409, { error: '자동 연동을 중지하고 작업이 끝난 뒤 설정을 저장하세요.' });
        const input = await body(req); const settings = normalizeSettings(input.settings || {});
        const secrets = updateSecrets(credentials(store), input.credentials || {});
        store.set('secrets', vault.encrypt(secrets, store.id)); store.set('settings', settings);
        store.log('info', 'system', '계정의 연결 정보와 시트 설정을 저장했습니다.');
        return json(res, 200, { ok: true, credentials: secretStatus(secrets) });
      }
      if (path === '/api/start' && req.method === 'POST') { worker.start(); return json(res, 200, { ok: true }); }
      if (path === '/api/stop' && req.method === 'POST') { worker.stop(); return json(res, 200, { ok: true }); }
      if (path === '/api/run' && req.method === 'POST') {
        worker.validate(); if (worker.running) return json(res, 409, { error: '이미 작업이 실행 중입니다.' });
        void worker.run(); return json(res, 202, { ok: true });
      }
      return json(res, 404, { error: '요청을 찾을 수 없습니다.' });
    } catch (error) {
      // Never expose provider bodies, cryptographic errors, stacks, or secrets.
      const message = error?.message || '';
      const known = ['설정이', '올바른', '비밀번호', '쿠팡 연동', '업체코드', 'Google 서비스', 'Google 비공개', '시트 ID', '열은', '시트 열', '읽기 범위', '실행 간격', '주문 조회', '탭 이름', '한 항목', '쓰기 시작', '쓰기 열', '읽기 열', '입력 내용', '요청 형식'];
      return json(res, 400, { error: known.some(k => message.startsWith(k)) ? message : '요청을 처리하지 못했습니다. 설정과 서버 상태를 확인하세요.' });
    }
  });
  server.requestTimeout = 45000;
  function restore() { for (const user of database.users()) if (database.tenant(user.id).get('enabled', false)) { const w = engine(user.id); try { w.start(); } catch { w.stop(); database.tenant(user.id).log('error', 'system', '서버 재시작 후 설정을 확인해야 합니다.'); } } }
  async function close() {
    for (const w of engines.values()) w.shutdown();
    await new Promise(resolve => server.close(resolve));
    const deadline = Date.now() + 40000;
    while ([...engines.values()].some(w => w.running) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    if ([...engines.values()].some(w => w.running)) return; // Let process exit, never close the DB under an in-flight job.
    database.close();
  }
  return { server, database, restore, close };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApplication();
  app.server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => { console.log(`CoupangWing listening on port ${process.env.PORT || 3000}`); app.restore(); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
