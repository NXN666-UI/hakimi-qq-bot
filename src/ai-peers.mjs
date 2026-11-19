import fs from 'node:fs';
import { atomicJson } from './storage.mjs';

const dayKey = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
export class AiPeers {
  constructor(file, definitions = [], clock = Date.now) {
    Object.assign(this, { file, definitions: definitions ?? [], clock });
    this.state = { version: 1, day: dayKey(clock()), peers: {} };
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 65536) throw Error('AI互动用量文件过大，请保留检查');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(data.day) || !data.peers || typeof data.peers !== 'object' || Array.isArray(data.peers) || Object.keys(data.peers).length > 1000) throw Error('AI互动用量文件损坏');
      for (const [key, row] of Object.entries(data.peers)) {
        if (!/^\d+:\d+$/.test(key) || !row || ['dailyReplies', 'lastAt', 'windowStart', 'windowReplies'].some(k => !Number.isSafeInteger(row[k]) || row[k] < 0)) throw Error('AI互动用量记录损坏');
      }
      this.state = data;
    }
  }
  known(qq) { return this.definitions.find(peer => peer.qq === String(qq)); }
  definition(group, qq) { const peer = this.known(qq); return peer?.groups.includes(String(group)) ? peer : null; }
  rollover() {
    const today = dayKey(this.clock());
    if (today > this.state.day) {
      const next = { ...this.state, day: today, peers: Object.fromEntries(Object.entries(this.state.peers).map(([key, row]) => [key, { ...row, dailyReplies: 0 }])) };
      atomicJson(this.file, next); this.state = next;
    }
  }
  available(group, qq) {
    const peer = this.definition(group, qq); if (!peer) return false;
    this.rollover();
    const row = this.state.peers[`${group}:${qq}`]; if (!row) return true;
    const now = this.clock();
    return row.dailyReplies < peer.maxRepliesPerDay && now - row.lastAt >= peer.cooldownMs && (now - row.windowStart >= peer.windowMs || row.windowReplies < peer.maxRepliesPerWindow);
  }
  reserve(group, qq) {
    if (!this.available(group, qq)) return false;
    const now = this.clock(), peer = this.definition(group, qq), key = `${group}:${qq}`, previous = this.state.peers[key];
    const newWindow = !previous || now - previous.windowStart >= peer.windowMs;
    const row = { dailyReplies: (previous?.dailyReplies ?? 0) + 1, lastAt: now, windowStart: newWindow ? now : previous.windowStart, windowReplies: newWindow ? 1 : previous.windowReplies + 1 };
    const next = { ...this.state, peers: { ...this.state.peers, [key]: row } };
    atomicJson(this.file, next); this.state = next; return true;
  }
}
