import { Coupang, Sheets } from './providers.js';
import { flatten, deliveryHash, validateShipment } from './domain.js';
import { readiness } from './config.js';

export class Engine {
  constructor(store, secrets, providers = {}) {
    this.store = store; this.secrets = secrets; this.providers = providers;
    this.running = false; this.timer = null; this.stopped = false;
    this.nextRun = null; this.failures = 0;
  }
  status() { return { enabled: this.store.get('enabled', false), running: this.running, nextRun: this.nextRun, lastRun: this.store.get('lastRun', null), stats: this.store.stats() }; }
  validate() { const s = this.store.settings(); const missing = readiness(s, this.secrets()); if (missing.length) throw new Error('설정이 필요합니다: ' + missing.join(', ')); }
  start() {
    this.validate();
    if (this.store.get('enabled', false) && (this.timer || this.running)) return;
    this.stopped = false; this.store.set('enabled', true); this.store.log('info', 'system', '자동 연동을 시작했습니다.');
    void this.run();
  }
  stop() {
    this.store.set('enabled', false); clearTimeout(this.timer); this.timer = null; this.nextRun = null;
    this.store.log('info', 'system', this.running ? '자동 연동을 중지합니다. 진행 중인 작업이 끝나면 정지합니다.' : '자동 연동을 중지했습니다.');
  }
  shutdown() { this.stopped = true; clearTimeout(this.timer); this.nextRun = null; }
  schedule() {
    if (this.stopped || !this.store.get('enabled', false)) return;
    const delay = Math.min(3600, this.store.settings().intervalSeconds * 2 ** Math.min(this.failures, 3));
    this.nextRun = new Date(Date.now() + delay * 1000).toISOString();
    this.timer = setTimeout(() => { this.timer = null; void this.run(); }, delay * 1000); this.timer.unref();
  }
  async run() {
    if (this.running) return false;
    clearTimeout(this.timer); this.timer = null; this.nextRun = null; this.running = true;
    try {
      this.validate();
      const settings = this.store.settings();
      this.store.log('info', 'system', settings.mode === 'demo' ? '데모 작업을 시작합니다. 실제 API에는 전송하지 않습니다.' : '주문 수집과 송장 등록을 시작합니다.');
      if (settings.mode === 'demo') {
        this.store.log('success', 'orders', '데모: 주문 조회 → 지정 범위 기록 흐름을 확인했습니다.');
        this.store.log('success', 'invoices', '데모: 운송장 범위 조회 → 쿠팡 등록 흐름을 확인했습니다.');
      } else {
        const env = this.secrets();
        const coupang = this.providers.coupang || new Coupang(env); const sheets = this.providers.sheets || new Sheets(env);
        const orders = await coupang.orders(settings.lookbackDays);
        const rows = orders.flatMap(o => flatten(o, env.COUPANG_VENDOR_ID, settings.shopName));
        const result = await sheets.writeOrders(settings, rows);
        for (const row of rows) this.store.putOrder({ ...row, deliveryHash: deliveryHash(row) });
        this.store.log('success', 'orders', `주문 조회 ${orders.length}건 · 시트 신규 ${result.added}행 · 기존 확인 ${result.updated}행`);
        await this.sendInvoices(settings, coupang, sheets, env);
      }
      this.failures = 0; this.store.set('lastRun', { at: new Date().toISOString(), success: true });
      this.store.log('success', 'system', '이번 연동 작업을 완료했습니다.');
    } catch (error) {
      this.failures++; this.store.set('lastRun', { at: new Date().toISOString(), success: false });
      // Provider messages intentionally contain no raw responses, personal data, or credentials.
      this.store.log('error', 'system', safeMessage(error));
    } finally { this.running = false; this.schedule(); }
    return true;
  }
  async sendInvoices(settings, coupang, sheets, env) {
    const entries = await sheets.invoices(settings);
    const groups = new Map(); const keys = new Set();
    for (const entry of entries) {
      if (keys.has(entry.orderKey)) throw new Error('운송장 읽기 범위의 식별키가 중복되었습니다.');
      keys.add(entry.orderKey);
      const saved = this.store.order(entry.orderKey);
      if (!saved) { this.store.log('warning', 'invoices', `읽기 행 ${entry.row}: 이 계정에서 수집하지 않은 식별키를 제외했습니다.`); continue; }
      const group = groups.get(saved.shipment_id) || [];
      group.push(entry); groups.set(saved.shipment_id, group);
    }
    let completed = 0;
    for (const [id, group] of groups) {
      const ledger = this.store.invoice(id);
      if (ledger?.state === 'completed') {
        if (group.some(e => e.invoice !== ledger.invoice || e.carrier !== ledger.carrier)) this.store.log('warning', 'invoices', '이미 등록한 송장 값이 변경되었습니다. 쿠팡 Wing에서 확인하세요.');
        continue;
      }
      let pending = false;
      try {
        const shipment = await coupang.shipment(id);
        if (ledger?.state === 'uncertain') {
          if (shipment && ['DEPARTURE', 'DELIVERING', 'FINAL_DELIVERY', 'NONE_TRACKING'].includes(shipment.status) && String(shipment.invoiceNumber) === ledger.invoice) {
            this.store.setInvoice(id, 'completed', ledger.carrier, ledger.invoice); completed++;
            this.store.log('success', 'invoices', '응답 미확인 송장이 쿠팡에 등록된 것을 확인했습니다.');
          } else this.store.log('warning', 'invoices', '응답 미확인 송장이 있어 재전송을 보류했습니다. 쿠팡 Wing에서 확인하세요.');
          continue;
        }
        const saved = new Map(group.map(e => [e.orderKey, this.store.order(e.orderKey)]));
        const { carrier, invoice } = validateShipment(shipment, group, env.COUPANG_VENDOR_ID, saved);
        // Persist BEFORE the shipping request. Never retry an ambiguous POST blindly.
        this.store.setInvoice(id, 'uncertain', carrier, invoice); pending = true;
        await coupang.upload(shipment, carrier, invoice);
        this.store.setInvoice(id, 'completed', carrier, invoice); completed++;
        this.store.log('success', 'invoices', `송장 등록 완료 · ${group.length}개 품목`);
      } catch (error) {
        this.store.log(pending ? 'error' : 'warning', 'invoices', safeMessage(error) + (pending ? ' · 등록 여부를 확인할 때까지 재전송하지 않습니다.' : ''));
      }
    }
    this.store.log('info', 'invoices', `운송장 후보 ${groups.size}건 · 등록 확인 ${completed}건`);
  }
}
export function safeMessage(error) {
  const known = ['설정이 필요합니다', '쿠팡', 'Google', '시트', '쓰기', '읽기', '지정한', '상품준비중', '분리배송', '묶음배송', '택배사', '수취인', '운송장'];
  const message = String(error?.message || '');
  return known.some(k => message.startsWith(k)) ? message.slice(0, 300) : '작업 중 오류가 발생했습니다. 연결 설정과 서버 상태를 확인하세요.';
}
