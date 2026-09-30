import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from './config.js';

export class Database {
  constructor(directory) {
    if (directory !== ':memory:') mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(directory === ':memory:' ? directory : join(directory, 'bridge.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(user_id,key));
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id), at TEXT NOT NULL, level TEXT NOT NULL, stage TEXT NOT NULL, message TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS logs_user ON logs(user_id,id);
      CREATE TABLE IF NOT EXISTS orders (user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, order_id TEXT NOT NULL, shipment_id TEXT NOT NULL, item_id TEXT NOT NULL, sequence TEXT NOT NULL, delivery_hash TEXT NOT NULL, PRIMARY KEY(user_id,key));
      CREATE TABLE IF NOT EXISTS invoices (user_id TEXT NOT NULL REFERENCES users(id), shipment_id TEXT NOT NULL, state TEXT NOT NULL, carrier TEXT NOT NULL, invoice TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(user_id,shipment_id));
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    `);
  }
  tenant(id) { return new TenantStore(this.db, id); }
  user(email) { return this.db.prepare('SELECT * FROM users WHERE email=?').get(email); }
  createUser(id, email, password) { this.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(id, email, password, new Date().toISOString()); }
  users() { return this.db.prepare('SELECT id,email FROM users').all(); }
  close() { this.db.close(); }
}
export class TenantStore {
  constructor(db, id) { this.db = db; this.id = id; }
  get(key, fallback) { const r = this.db.prepare('SELECT value FROM kv WHERE user_id=? AND key=?').get(this.id, key); return r ? JSON.parse(r.value) : structuredClone(fallback); }
  set(key, value) { this.db.prepare('INSERT INTO kv VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value').run(this.id, key, JSON.stringify(value)); }
  settings() { return this.get('settings', DEFAULT_SETTINGS); }
  log(level, stage, message) {
    this.db.prepare('INSERT INTO logs(user_id,at,level,stage,message) VALUES (?,?,?,?,?)').run(this.id, new Date().toISOString(), level, stage, message);
    this.db.prepare('DELETE FROM logs WHERE user_id=? AND id NOT IN (SELECT id FROM logs WHERE user_id=? ORDER BY id DESC LIMIT 2000)').run(this.id, this.id);
  }
  logs(after = 0) { return this.db.prepare('SELECT id,at,level,stage,message FROM (SELECT * FROM logs WHERE user_id=? AND id>? ORDER BY id DESC LIMIT 300) ORDER BY id ASC').all(this.id, after); }
  putOrder(o) {
    this.db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET delivery_hash=excluded.delivery_hash').run(this.id, o.orderKey, o.orderId, o.shipmentBoxId, o.vendorItemId, o.sequence, o.deliveryHash);
  }
  order(key) { return this.db.prepare('SELECT * FROM orders WHERE user_id=? AND key=?').get(this.id, key); }
  invoice(id) { return this.db.prepare('SELECT * FROM invoices WHERE user_id=? AND shipment_id=?').get(this.id, id); }
  setInvoice(id, state, carrier, invoice) { this.db.prepare('INSERT INTO invoices VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,shipment_id) DO UPDATE SET state=excluded.state,carrier=excluded.carrier,invoice=excluded.invoice,at=excluded.at').run(this.id, id, state, carrier, invoice, new Date().toISOString()); }
  stats() {
    return { orders: this.db.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id=?').get(this.id).n, completed: this.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE user_id=? AND state='completed'").get(this.id).n, uncertain: this.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE user_id=? AND state='uncertain'").get(this.id).n };
  }
}
