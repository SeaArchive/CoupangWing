import { scrypt, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, createHash, createPrivateKey } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const derive = promisify(scrypt);
export function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('올바른 이메일 주소를 입력하세요.');
  return value;
}
export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 5 || password.length > 200) throw new Error('비밀번호는 5~200자로 입력하세요.');
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + Buffer.from(await derive(password, salt, 64)).toString('hex');
}
export async function passwordMatches(password, encoded) {
  if (typeof password !== 'string' || password.length > 200) return false;
  const [salt, hash] = encoded.split(':');
  return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(await derive(password, salt, 64)));
}
export function sessionHash(token) { return createHash('sha256').update(token).digest('hex'); }
export class Vault {
  constructor(env, directory) {
    let key = env.ENCRYPTION_KEY;
    if (!key) {
      if (env.NODE_ENV === 'production') throw new Error('운영 서버에 ENCRYPTION_KEY를 설정하세요.');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = join(directory, 'master.key');
      if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
      key = readFileSync(file, 'utf8').trim();
    }
    this.key = Buffer.from(key, 'base64');
    if (this.key.length !== 32) throw new Error('ENCRYPTION_KEY는 32바이트를 Base64로 인코딩한 값이어야 합니다.');
  }
  encrypt(value, owner) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(owner));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes].map(b => b.toString('base64')).join('.');
  }
  decrypt(value, owner) {
    if (!value) return {};
    const [iv, tag, bytes] = value.split('.').map(s => Buffer.from(s, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(Buffer.from(owner)); cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(bytes), cipher.final()]).toString('utf8'));
  }
}
export function updateSecrets(current, incoming) {
  const result = { ...current };
  for (const key of ['COUPANG_VENDOR_ID', 'COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY']) {
    const value = String(incoming[key] || '').trim();
    if (value.length > 1000) throw new Error('쿠팡 연동 값이 너무 깁니다.');
    if (value) result[key] = value;
  }
  if (result.COUPANG_VENDOR_ID && !/^[A-Za-z0-9_-]{3,40}$/.test(result.COUPANG_VENDOR_ID)) throw new Error('업체코드 형식을 확인하세요.');
  if (incoming.GOOGLE_SERVICE_ACCOUNT_JSON) {
    let g;
    try { g = JSON.parse(incoming.GOOGLE_SERVICE_ACCOUNT_JSON); } catch { throw new Error('Google 서비스 계정 JSON 형식을 확인하세요.'); }
    if (g.type !== 'service_account' || !g.client_email || !g.private_key) throw new Error('Google 서비스 계정 키 파일을 입력하세요.');
    try { if (createPrivateKey(g.private_key).asymmetricKeyType !== 'rsa') throw new Error(); } catch { throw new Error('Google 비공개 키 형식을 확인하세요.'); }
    result.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ type: 'service_account', client_email: g.client_email, private_key: g.private_key });
  }
  return result;
}
export function secretStatus(secrets) {
  let serviceEmail = '';
  if (secrets.GOOGLE_SERVICE_ACCOUNT_JSON) serviceEmail = JSON.parse(secrets.GOOGLE_SERVICE_ACCOUNT_JSON).client_email;
  return { vendorId: secrets.COUPANG_VENDOR_ID || '', accessKeySaved: Boolean(secrets.COUPANG_ACCESS_KEY), secretKeySaved: Boolean(secrets.COUPANG_SECRET_KEY), googleSaved: Boolean(serviceEmail), serviceEmail };
}
