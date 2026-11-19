import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './paths.mjs';
import { validMessageId } from './quotes.mjs';
import { validMentionQQ } from './mentions.mjs';

export class OneBot extends EventEmitter {
  constructor(config, token, expectedQQ, log, { stickerRoot = path.join(ROOT, 'assets', 'stickers') } = {}) {
    super(); this.config = config; this.token = token; this.expectedQQ = expectedQQ; this.log = log;
    this.pending = new Map(); this.ready = false; this.stopped = false; this.generation = 0; this.backoff = 1000;
    this.stickerRoot = stickerRoot;
  }
  connect() {
    if (this.stopped) return;
    const url = new URL(this.config.wsUrl);
    if (this.token) url.searchParams.set('access_token', this.token);
    const ws = this.ws = new WebSocket(url); this.generation++;
    const timeout = setTimeout(() => ws.close(), 10000);
    ws.addEventListener('open', async () => {
      clearTimeout(timeout);
      try {
        const login = await this.call('get_login_info', {}, false);
        if (String(login?.user_id) !== this.expectedQQ) return this.fatal('连接到的 QQ 不是哈基米小号，已拒绝接入并停止；请检查独立端口');
        if (this.stopped || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        this.ready = true; this.backoff = 1000; this.log('SnowLuma 身份校验通过，哈基米群聊已就绪'); this.emit('ready');
      } catch { if (!this.stopped) { this.log('SnowLuma 身份验证失败，将重连'); ws.close(); } }
    });
    ws.addEventListener('message', e => {
      if (typeof e.data !== 'string' || e.data.length > 256000 || this.ws !== ws) return;
      let event; try { event = JSON.parse(e.data); } catch { return; }
      if (event.echo && this.pending.has(event.echo)) {
        const p = this.pending.get(event.echo); this.pending.delete(event.echo); clearTimeout(p.timer);
        if (event.status === 'ok' && event.retcode === 0) p.resolve(event.data); else p.reject(Error('OneBot 动作失败'));
        return;
      }
      if (!this.ready || this.stopped) return;
      if (event.self_id != null && String(event.self_id) !== this.expectedQQ) return this.fatal('事件 QQ 身份与哈基米不一致，已停止');
      if (event.post_type === 'message' && ['group', 'private'].includes(event.message_type) && String(event.self_id) === this.expectedQQ) this.emit('message', event);
    });
    ws.addEventListener('error', () => { this.log('SnowLuma 连接未成功（检查新账号端口及令牌）'); ws.close(); });
    ws.addEventListener('close', () => {
      clearTimeout(timeout);
      if (this.ws !== ws) return;
      this.ready = false; this.emit('offline');
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('OneBot 已断开')); } this.pending.clear();
      if (!this.stopped) { this.reconnectTimer = setTimeout(() => this.connect(), this.backoff); this.backoff = Math.min(30000, this.backoff * 2); }
    });
  }
  fatal(message) { this.log(message); this.stop(); this.emit('fatal', message); }
  call(action, params, requireReady = true) {
    if (this.stopped || this.ws?.readyState !== WebSocket.OPEN || (requireReady && !this.ready)) return Promise.reject(Error('OneBot 未就绪'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(Error('OneBot 动作超时，不自动重发')); }, 8000);
      this.pending.set(echo, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ action, params, echo })); } catch { clearTimeout(timer); this.pending.delete(echo); reject(Error('OneBot 发送失败')); }
    });
  }
  async send(group, text, replyId = '', mentionQQ = '') {
    text = String(text).trim().replace(/^(?:哈[？?]+\s*)+/u, '').replace(/[。.．.!！?？;；:：,，、…~～]+$/u, '').trimEnd();
    const message = [{ type: 'text', data: { text } }];
    if (validMentionQQ(mentionQQ) && String(mentionQQ) !== this.expectedQQ) message.unshift({ type: 'at', data: { qq: String(mentionQQ) } }, { type: 'text', data: { text: ' ' } });
    if (validMessageId(replyId)) message.unshift({ type: 'reply', data: { id: String(replyId) } });
    return this.call('send_group_msg', { group_id: Number(group), message, auto_escape: true });
  }
  async sendPrivate(user, text) {
    if (!/^[1-9]\d{4,15}$/.test(String(user))) throw Error('私聊目标QQ无效');
    return this.call('send_private_msg', { user_id: Number(user), message: [{ type: 'text', data: { text } }], auto_escape: true });
  }
  async sendImage(group, file) {
    return this.sendLocalImage('send_group_msg', { group_id: Number(group) }, file);
  }
  async sendPrivateImage(user, file) {
    if (!validMentionQQ(user)) throw Error('私聊目标QQ无效');
    return this.sendLocalImage('send_private_msg', { user_id: Number(user) }, file);
  }
  async sendLocalImage(action, target, file) {
    const root = fs.realpathSync(this.stickerRoot), real = fs.realpathSync(file);
    if (!real.toLowerCase().startsWith(`${root}${path.sep}`.toLowerCase()) || !/\.(png|jpe?g|gif|webp)$/i.test(real) || !fs.statSync(real).isFile() || fs.statSync(real).size > 8 * 1024 * 1024) throw Error('只能发送项目表情库中的受限图片');
    return this.call(action, { ...target, message: [{ type: 'image', data: { file: pathToFileURL(real).href, cache: '0' } }], auto_escape: true });
  }
  stop() {
    this.stopped = true; this.ready = false; clearTimeout(this.reconnectTimer);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('OneBot 已停止')); } this.pending.clear();
    this.ws?.close();
  }
}
