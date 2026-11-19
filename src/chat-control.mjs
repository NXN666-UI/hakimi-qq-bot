import fs from 'node:fs';
import { atomicJson } from './storage.mjs';

export class ChatControl {
  constructor(file) {
    this.file = file;
    const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, paused: false };
    if (state.version !== 1 || typeof state.paused !== 'boolean') throw Error('静音控制文件损坏，请保留data/chat-control.json检查');
    this.paused = state.paused;
  }
  setPaused(paused) {
    atomicJson(this.file, { version: 1, paused }); this.paused = paused;
  }
}

const quiet = new Set(['闭嘴', '先闭嘴', '闭嘴吧', '安静', '安静点', '安静一下', '先安静', '先安静一下', '别说话', '先别说话', '别说话了', '闭麦', '闭麦吧', '暂停聊天']);
const speak = new Set(['出来讲话', '出来说话', '可以说话了', '可以讲话了', '恢复聊天', '解除禁言', '开麦', '出来吧']);
const refresh = new Set(['刷新一下额度', '刷新额度', '重置额度', '重置聊天额度', '刷新聊天额度']);
export function speechCommand(text, { privateChat = false, addressed = false, aliases = [] } = {}) {
  let value = text.trim();
  for (const alias of [...aliases].sort((a, b) => b.length - a.length)) {
    if (value.startsWith(alias)) { addressed = true; value = value.slice(alias.length).replace(/^[\s,，:：]+/u, ''); break; }
  }
  if (!privateChat && !addressed) return '';
  value = value.replace(/[。.!！?？~～]+$/u, '').trim();
  return quiet.has(value) ? '暂停' : speak.has(value) ? '恢复' : refresh.has(value) ? '刷新额度' : '';
}
