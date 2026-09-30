import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/server.js';

test('이메일 인증, CSRF, 계정별 HTTP 설정/로그 격리 및 비밀키 비노출', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cw-http-')); const origin = 'http://localhost:3000';
  const app = createApplication({ DATA_DIR: dir, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: origin });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}`;
  async function call(path, method = 'GET', body, account = {}) {
    const r = await fetch(base + '/api/' + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(account.cookie ? { Cookie: account.cookie } : {}), ...(account.csrf ? { 'X-CSRF-Token': account.csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    assert.equal((await call('state')).status, 401);
    assert.equal((await call('register', 'POST', { email: 'short@example.com', password: '1234' })).status, 400);
    const a = await call('register', 'POST', { email: 'a@example.com', password: 'abcde' }); const aa = { cookie: a.cookie, csrf: a.data.csrf }; assert.equal(a.status, 201);
    const b = await call('register', 'POST', { email: 'b@example.com', password: '12345' }); const bb = { cookie: b.cookie, csrf: b.data.csrf };
    assert.equal((await call('settings', 'PUT', {}, { cookie: a.cookie })).status, 403);
    const saved = await call('settings', 'PUT', { settings: { spreadsheetId: 'private-sheet-12345', write: { tab: 'a' }, read: { tab: 'a' } }, credentials: { COUPANG_VENDOR_ID: 'A12345', COUPANG_ACCESS_KEY: 'private-access', COUPANG_SECRET_KEY: 'private-secret' } }, aa); assert.equal(saved.status, 200);
    const aState = await call('state', 'GET', null, aa); const bState = await call('state', 'GET', null, bb);
    assert.equal(aState.data.settings.spreadsheetId, 'private-sheet-12345'); assert.equal(bState.data.settings.spreadsheetId, ''); assert.equal(bState.data.credentials.accessKeySaved, false);
    assert.ok(!JSON.stringify(aState.data).includes('private-secret')); assert.ok(!JSON.stringify(aState.data).includes('private-access'));
    assert.equal((await call('run', 'POST', {}, aa)).status, 202);
    const bLogs = await call('logs', 'GET', null, bb); assert.ok(bLogs.data.logs.every(l => !l.message.includes('데모')));
    assert.equal((await call('logout', 'POST', {}, aa)).status, 200); assert.equal((await call('state', 'GET', null, aa)).status, 401);
    assert.equal((await call('login', 'POST', { email: 'a@example.com', password: 'wrong-password' })).status, 401);
    assert.equal((await call('login', 'POST', { email: 'a@example.com', password: 'abcde' })).status, 200);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
