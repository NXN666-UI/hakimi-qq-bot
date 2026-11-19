import fs from 'node:fs';
import path from 'node:path';

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const dayKey = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
export class BudgetError extends Error {}
export class Budget {
  constructor(file, limits, clock = Date.now) {
    this.file = file; this.limits = limits; this.clock = clock;
    this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, day: dayKey(clock()), dailyRequests: 0, totalRequests: 0, dailyReservedTokens: 0, totalReservedTokens: 0, actualTokens: 0 };
    for (const k of ['dailyRequests', 'totalRequests', 'dailyReservedTokens', 'totalReservedTokens', 'actualTokens']) {
      if (!Number.isSafeInteger(this.state[k]) || this.state[k] < 0) throw Error('用量文件损坏，已停止；请保留 data/usage.json 进行检查');
    }
    if (this.state.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(this.state.day)) throw Error('用量文件版本或日期错误');
    for (const field of ['DailyRequests', 'TotalRequests', 'DailyReservedTokens', 'TotalReservedTokens']) {
      const owner = 'owner' + field, total = field[0].toLowerCase() + field.slice(1);
      this.state[owner] ??= 0;
      if (!Number.isSafeInteger(this.state[owner]) || this.state[owner] < 0 || this.state[owner] > this.state[total]) throw Error('主人用量字段损坏，保留文件检查');
    }
    this.state.ordinaryDailyResetBaseline ??= 0;
    if (!Number.isSafeInteger(this.state.ordinaryDailyResetBaseline) || this.state.ordinaryDailyResetBaseline < 0 || this.state.ordinaryDailyResetBaseline > this.state.dailyRequests - this.state.ownerDailyRequests) throw Error('每日额度刷新记录损坏，请保留用量文件检查');
    atomicJson(file, this.state);
  }
  rollover() {
    // Moving the clock backwards must not grant another daily allowance.
    const today = dayKey(this.clock());
    if (today > this.state.day) {
      const next = { ...this.state, day: today, dailyRequests: 0, dailyReservedTokens: 0, ownerDailyRequests: 0, ownerDailyReservedTokens: 0, ordinaryDailyResetBaseline: 0 };
      atomicJson(this.file, next); this.state = next;
    }
  }
  ordinaryDailyUsage() { this.rollover(); const s = this.state; return s.dailyRequests - s.ownerDailyRequests - s.ordinaryDailyResetBaseline; }
  refreshDailyAllowance() {
    this.rollover();
    // Reset the allowance, not the accounting. Preserve totals, owner counters,
    // token usage and even calls already reserved by an in-flight generation.
    const next = { ...this.state, ordinaryDailyResetBaseline: this.state.dailyRequests - this.state.ownerDailyRequests, lastDailyRefreshAt: this.clock() };
    atomicJson(this.file, next); this.state = next;
  }
  reserve(tokens, { exempt = false } = {}) {
    if (!Number.isSafeInteger(tokens) || tokens <= 0) throw Error('无效用量预留');
    this.rollover(); const s = this.state, l = this.limits;
    const dailyTokensExceeded = l.reservedTokensPerDay > 0 && s.dailyReservedTokens - s.ownerDailyReservedTokens + tokens > l.reservedTokensPerDay;
    const totalTokensExceeded = l.reservedTokensTotal > 0 && s.totalReservedTokens - s.ownerTotalReservedTokens + tokens > l.reservedTokensTotal;
    if (!exempt && (s.dailyRequests - s.ownerDailyRequests - s.ordinaryDailyResetBaseline >= l.requestsPerDay || (l.requestsTotal > 0 && s.totalRequests - s.ownerTotalRequests >= l.requestsTotal) || dailyTokensExceeded || totalTokensExceeded)) throw new BudgetError('达到普通群友本地请求数或已启用的 token 预留上限，暂停模型调用');
    const next = { ...s, dailyRequests: s.dailyRequests + 1, totalRequests: s.totalRequests + 1, dailyReservedTokens: s.dailyReservedTokens + tokens, totalReservedTokens: s.totalReservedTokens + tokens };
    if (exempt) { next.ownerDailyRequests++; next.ownerTotalRequests++; next.ownerDailyReservedTokens += tokens; next.ownerTotalReservedTokens += tokens; }
    atomicJson(this.file, next); this.state = next;
  }
  recordUsage(usage) {
    const n = usage?.total_tokens;
    if (Number.isSafeInteger(n) && n >= 0) { const next = { ...this.state, actualTokens: this.state.actualTokens + n }; atomicJson(this.file, next); this.state = next; }
  }
  summary() { this.rollover(); const s = this.state; const tokenLimits = !this.limits.reservedTokensPerDay && !this.limits.reservedTokensTotal ? 'token仅记账不限额' : 'token按已启用上限检查'; return `总请求今日${s.dailyRequests}/累计${s.totalRequests}；普通群友额度已用${this.ordinaryDailyUsage()}/${this.limits.requestsPerDay}次；${this.limits.requestsTotal ? `普通群友累计上限${this.limits.requestsTotal}次` : '不设累计请求上限'}；主人今日${s.ownerDailyRequests}次不设本地配额；${tokenLimits}；预留${s.dailyReservedTokens} token；上游累计${s.actualTokens} token`; }
}
export function acquireLock(root) {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const file = path.join(root, 'data', 'app.lock');
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('进程锁格式无效，请检查 data/app.lock');
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw Error('哈基米已经在运行，拒绝重复启动');
    fs.unlinkSync(file);
  }
  fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
  return () => { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); };
}
