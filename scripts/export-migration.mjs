import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync, chmodSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, createDecipheriv } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function prepareMigration(source, keyText, origin, directory) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('A plain HTTPS origin is required.');
  const key = Buffer.from(keyText || '', 'base64');
  if (key.length !== 32 || key.toString('base64') !== keyText) throw new Error('Missing or invalid ENCRYPTION_KEY.');
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  try {
    if (sourceDb.prepare("SELECT COUNT(*) AS n FROM kv WHERE key='enabled' AND value='true'").get().n) {
      throw new Error('Stop automatic sync for every account and wait for running jobs to finish first.');
    }
    await backup(sourceDb, join(directory, 'bridge.sqlite'));
  } finally { sourceDb.close(); }
  const target = join(directory, 'bridge.sqlite');
  chmodSync(target, 0o600);
  const db = new DatabaseSync(target);
  let users;
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('SQLite integrity check failed.');
    for (const row of db.prepare("SELECT user_id,value FROM kv WHERE key='secrets'").all()) {
      const encoded = JSON.parse(row.value);
      if (!encoded) continue;
      const [iv, tag, bytes] = encoded.split('.').map(v => Buffer.from(v, 'base64'));
      const cipher = createDecipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(row.user_id)); cipher.setAuthTag(tag);
      JSON.parse(Buffer.concat([cipher.update(bytes), cipher.final()]).toString('utf8'));
    }
    users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    db.exec("DELETE FROM sessions; UPDATE kv SET value='false' WHERE key='enabled'; PRAGMA wal_checkpoint(TRUNCATE);");
  } finally { db.close(); }
  const environment = `NODE_ENV=production\nHOST=0.0.0.0\nPORT=3000\nDATA_DIR=/app/data\nAPP_ORIGIN=${origin}\nCOOKIE_SECURE=true\nALLOW_REGISTRATION=true\nENCRYPTION_KEY=${keyText}\n`;
  writeFileSync(join(directory, 'app.env'), environment, { mode: 0o600, flag: 'wx' });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), users, origin, databaseSha256: sha(readFileSync(target)), environmentSha256: sha(environment) }), { mode: 0o600, flag: 'wx' });
  return users;
}

async function main() {
  process.umask(0o077);
  execFileSync('wormhole', ['--version'], { stdio: 'ignore' });
  const origin = process.argv[2];
  if (!origin) throw new Error('Usage: node export-migration.mjs https://YOUR-HOST');
  const directory = mkdtempSync(join(tmpdir(), 'coupang-migration-'));
  const archive = join(directory, 'coupang-migration.tar.gz');
  try {
    const users = await prepareMigration(join(process.env.DATA_DIR || '/var/data', 'bridge.sqlite'), process.env.ENCRYPTION_KEY, origin, directory);
    execFileSync('tar', ['-czf', archive, '-C', directory, 'bridge.sqlite', 'app.env', 'manifest.json']);
    console.log(`Verified backup ready: ${users} account(s). Copy the wormhole receive command to the Lightsail terminal. Do not post the code in chat.`);
    await new Promise((resolve, reject) => {
      const child = spawn('wormhole', ['send', '--code-length', '4', archive], { stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Transfer failed; the original database is unchanged.')));
    });
    console.log('Transfer completed. The Render database remains unchanged.');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
