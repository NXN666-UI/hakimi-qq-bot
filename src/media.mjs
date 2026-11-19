import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_MEDIA_OPTIONS = Object.freeze({
  enabled: true,
  autoViewImages: false,
  maxImagesPerDay: 20,
  maxImagesTotal: 100,
  maxImageBytes: 2097152,
  maxCacheBytes: 52428800,
  cacheTtlHours: 24,
  stickersEnabled: true,
  stickerProbability: 0.15,
  stickerCooldownMs: 60000
});

export class MediaError extends Error {
  constructor(message) { super(message); this.name = 'MediaError'; }
}

const SHA_FILE = /^[a-f0-9]{64}\.(?:jpg|png|webp)$/;
const TEMP_FILE = /^[a-f0-9]{64}\.(?:jpg|png|webp)\.tmp-[a-f0-9-]{36}$/;
const dayKey = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, target) => { const relative = path.relative(parent, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

function canonicalRoot(root) {
  try {
    const resolved = fs.realpathSync(path.resolve(root));
    if (!fs.statSync(resolved).isDirectory()) throw Error();
    return resolved;
  } catch { throw new MediaError('图片目录的项目根路径不可用'); }
}

function localDirectory(root, ...segments) {
  let current = root;
  try {
    for (const segment of segments) {
      if (!segment || segment === '..' || segment.includes('/') || segment.includes('\\')) throw Error();
      current = path.join(current, segment);
      if (!inside(root, current)) throw Error();
      if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(root, fs.realpathSync(current))) throw Error();
    }
    return current;
  } catch { throw new MediaError('图片目录不可用或包含越界链接，已停止操作'); }
}

function assertLocalFile(root, file) {
  if (!inside(root, file)) throw new MediaError('图片文件路径越界');
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || !inside(root, fs.realpathSync(file))) throw Error();
    return stat;
  } catch { throw new MediaError('图片文件不可用或包含越界链接'); }
}

function writeJsonSafely(root, file, value) {
  const directory = localDirectory(root, 'data');
  if (path.dirname(file) !== directory) throw new MediaError('图片额度文件路径异常');
  if (fs.existsSync(file)) assertLocalFile(directory, file);
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    try { if (fs.existsSync(temporary) && fs.lstatSync(temporary).isFile() && !fs.lstatSync(temporary).isSymbolicLink()) fs.unlinkSync(temporary); } catch { /* leave an owned temporary file for inspection */ }
    throw new MediaError('图片用量保存失败，停止本次看图');
  }
}

function cqDecode(value) {
  return value.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');
}

/** Extract only a real image segment; it is never interpreted as a local file. */
export function imageParts(message) {
  let segments = message;
  if (typeof message === 'string') {
    const match = message.match(/\[CQ:image((?:,[^\]]*)?)\]/);
    if (!match) return [];
    const data = {};
    for (const item of match[1].split(',').filter(Boolean)) {
      const at = item.indexOf('=');
      if (at > 0) data[item.slice(0, at)] = cqDecode(item.slice(at + 1));
    }
    segments = [{ type: 'image', data }];
  }
  if (!Array.isArray(segments)) return [];
  const found = segments.slice(0, 100).find(segment => segment?.type === 'image' && segment.data && typeof segment.data === 'object' && !Array.isArray(segment.data));
  if (!found) return [];
  const data = {};
  for (const key of ['url', 'file', 'file_id']) {
    if (typeof found.data[key] === 'string' && found.data[key].length <= (key === 'url' ? 4096 : 1024)) data[key] = found.data[key];
  }
  return [{ type: 'image', data }];
}

function mediaUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowed = host === 'qpic.cn' || host.endsWith('.qpic.cn') || host === 'qlogo.cn' || host.endsWith('.qlogo.cn') || host === 'multimedia.nt.qq.com.cn';
    const defaultPort = url.protocol === 'https:' ? '443' : '80';
    if (!['http:', 'https:'].includes(url.protocol) || !allowed || url.username || url.password || (url.port && url.port !== defaultPort)) throw Error();
    url.hash = '';
    return url;
  } catch { throw new MediaError('仅允许当前 QQ 消息中的受支持媒体地址'); }
}

function publicV4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
}

function publicAddress(address) {
  if (typeof address !== 'string') return false;
  if (net.isIP(address) === 4) return publicV4(address);
  if (net.isIP(address) !== 6 || address.includes('%')) return false;
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const tail = lower.slice(7);
    if (net.isIP(tail) === 4) return publicV4(tail);
    const pieces = tail.split(':');
    if (pieces.length !== 2 || pieces.some(x => !/^[a-f0-9]{1,4}$/.test(x))) return false;
    const high = parseInt(pieces[0], 16), low = parseInt(pieces[1], 16);
    return publicV4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  // Public global-unicast IPv6 only; reject local, multicast, documentation and transition ranges.
  const first = parseInt(lower.split(':')[0], 16);
  return first >= 0x2000 && first <= 0x3fff && !/^2001:db8(?::|$)/.test(lower) && !/^2001:(?:0|0000)(?::|$)/.test(lower) && !/^2002:/.test(lower);
}

function lookupAll(lookupImpl, hostname) {
  return new Promise((resolve, reject) => {
    const callback = (error, addresses) => error ? reject(error) : resolve(addresses);
    try {
      const returned = lookupImpl(hostname, { all: true, verbatim: true }, callback);
      if (returned && typeof returned.then === 'function') returned.then(resolve, reject);
      else if (Array.isArray(returned)) resolve(returned);
    } catch (error) { reject(error); }
  });
}

function imageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg', extension: 'jpg' };
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', extension: 'png' };
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', extension: 'webp' };
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) throw new MediaError('暂不分析 GIF 动图，请改发静态 JPG、PNG 或 WEBP');
  throw new MediaError('图片内容不是受支持的 JPG、PNG 或 WEBP');
}

export class MediaStore {
  constructor(root, options = {}, { clock = Date.now, fetchImpl = fetch, lookupImpl = dns.lookup } = {}) {
    this.root = canonicalRoot(root); this.options = { ...DEFAULT_MEDIA_OPTIONS, ...options };
    Object.assign(this, { clock, fetchImpl, lookupImpl });
    for (const key of ['maxImagesPerDay', 'maxImagesTotal', 'maxImageBytes', 'maxCacheBytes']) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] < 1) throw new MediaError('图片额度或容量配置无效');
    }
    if (!Number.isFinite(this.options.cacheTtlHours) || this.options.cacheTtlHours < 0) throw new MediaError('图片缓存过期配置无效');
    this.urlCache = new Map();
    this.usageFile = path.join(this.root, 'data', 'media-usage.json');
    this.state = { version: 1, day: dayKey(clock()), dailyImages: 0, totalImages: 0 };
    if (!this.options.enabled) return;
    this.cacheDirectory();
    if (fs.existsSync(this.usageFile)) {
      try {
        assertLocalFile(path.join(this.root, 'data'), this.usageFile);
        if (fs.statSync(this.usageFile).size > 65536) throw Error();
        const state = JSON.parse(fs.readFileSync(this.usageFile, 'utf8'));
        if (state?.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(state.day) || !Number.isSafeInteger(state.dailyImages) || state.dailyImages < 0 || !Number.isSafeInteger(state.totalImages) || state.totalImages < state.dailyImages) throw Error();
        this.state = state;
      } catch { throw new MediaError('图片用量文件损坏，已停止；原文件保留，请检查 data/media-usage.json'); }
    }
    for (const [owner, total] of [['ownerDailyImages', 'dailyImages'], ['ownerTotalImages', 'totalImages']]) { this.state[owner] ??= 0; if (!Number.isSafeInteger(this.state[owner]) || this.state[owner] < 0 || this.state[owner] > this.state[total]) throw new MediaError('主人看图用量字段损坏'); }
    this.cleanupCache();
  }

  cacheDirectory() { return localDirectory(this.root, 'data', 'media'); }

  reserveImage({ exempt = false } = {}) {
    if (!this.options.enabled) throw new MediaError('看图功能未启用');
    const next = { ...this.state }, today = dayKey(this.clock());
    if (today > next.day) { next.day = today; next.dailyImages = 0; next.ownerDailyImages = 0; }
    if (!exempt && (next.dailyImages - next.ownerDailyImages >= this.options.maxImagesPerDay || next.totalImages - next.ownerTotalImages >= this.options.maxImagesTotal)) throw new MediaError('达到普通群友本地每日或累计看图上限，本次不调用看图模型');
    next.dailyImages++; next.totalImages++;
    if (exempt) { next.ownerDailyImages++; next.ownerTotalImages++; }
    writeJsonSafely(this.root, this.usageFile, next); this.state = next;
    return { ...next };
  }

  cleanupCache() {
    const directory = this.cacheDirectory(), now = this.clock(), remaining = [];
    const ttl = this.options.cacheTtlHours * 3600000;
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || (!SHA_FILE.test(entry.name) && !TEMP_FILE.test(entry.name))) continue;
        const file = path.join(directory, entry.name), stat = assertLocalFile(directory, file);
        if (now - stat.mtimeMs > ttl || TEMP_FILE.test(entry.name)) fs.unlinkSync(file);
        else remaining.push({ file, bytes: stat.size, modified: stat.mtimeMs });
      }
      let bytes = remaining.reduce((n, entry) => n + entry.bytes, 0);
      for (const entry of remaining.sort((a, b) => a.modified - b.modified)) {
        if (bytes <= this.options.maxCacheBytes) break;
        assertLocalFile(directory, entry.file); fs.unlinkSync(entry.file); bytes -= entry.bytes;
      }
      for (const [key, entry] of this.urlCache) if (!fs.existsSync(entry.file) || now - entry.time > ttl) this.urlCache.delete(key);
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError('图片缓存清理失败，未操作项目目录之外的文件');
    }
  }

  async assertPublicUrl(value) {
    const url = mediaUrl(value); let timeout;
    try {
      const addresses = await Promise.race([
        lookupAll(this.lookupImpl, url.hostname),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(Error()), 10000); })
      ]);
      const rows = Array.isArray(addresses) ? addresses : [addresses];
      if (!rows.length || !rows.every(row => publicAddress(typeof row === 'string' ? row : row?.address))) throw Error();
      return url;
    } catch { throw new MediaError('QQ 图片域名解析异常或指向非公网地址，已拒绝读取'); }
    finally { clearTimeout(timeout); }
  }

  async download(value) {
    let current = value;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const url = await this.assertPublicUrl(current);
      let response;
      try {
        response = await this.fetchImpl(url.href, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { accept: 'image/jpeg,image/png,image/webp' } });
      } catch { throw new MediaError('QQ 图片下载失败或超时，本次未调用模型'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new MediaError('QQ 图片跳转过多或缺少目标地址');
        try { current = new URL(location, url).href; } catch { throw new MediaError('QQ 图片跳转地址无效'); }
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new MediaError('QQ 图片地址已过期或暂不可用'); }
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > this.options.maxImageBytes) { await response.body?.cancel(); throw new MediaError('图片超过本地大小上限，请发较小的静态图'); }
      const reader = response.body?.getReader();
      if (!reader) throw new MediaError('QQ 图片返回内容为空');
      const chunks = []; let bytes = 0;
      try {
        while (true) {
          const result = await reader.read(); if (result.done) break;
          bytes += result.value.length;
          if (bytes > this.options.maxImageBytes) { await reader.cancel(); throw new MediaError('图片超过本地大小上限，请发较小的静态图'); }
          chunks.push(Buffer.from(result.value));
        }
      } catch (error) {
        if (error instanceof MediaError) throw error;
        throw new MediaError('QQ 图片读取失败或超时，本次未调用模型');
      }
      if (!bytes) throw new MediaError('QQ 图片返回内容为空');
      return Buffer.concat(chunks);
    }
    throw new MediaError('QQ 图片跳转过多');
  }

  async prepareImage(segment, onebot) {
    if (!this.options.enabled) throw new MediaError('看图功能未启用');
    const selected = imageParts([segment])[0];
    if (!selected) throw new MediaError('本次消息没有可分析的图片');
    let url = selected.data.url;
    if (!url) {
      const file = selected.data.file || selected.data.file_id;
      if (!file || /^(?:file:|base64:|data:|[a-z]:[\\/]|[\\/])/i.test(file)) throw new MediaError('图片缺少可读取的 QQ 媒体标识');
      try {
        const info = await onebot.call('get_image', { file });
        url = info?.url;
      } catch { throw new MediaError('未能获取这张图片的 QQ 媒体地址'); }
    }
    if (!url) throw new MediaError('这张图片的 QQ 下载地址不可用');
    const canonical = mediaUrl(url).href, sourceKey = digest(canonical);
    this.cleanupCache();
    let bytes;
    const cached = this.urlCache.get(sourceKey);
    if (cached && this.clock() - cached.time <= this.options.cacheTtlHours * 3600000) {
      try {
        const stat = assertLocalFile(this.cacheDirectory(), cached.file);
        if (stat.size > this.options.maxImageBytes) throw Error();
        const saved = fs.readFileSync(cached.file);
        if (digest(saved) !== path.basename(cached.file).split('.')[0]) throw Error();
        bytes = saved;
      } catch { this.urlCache.delete(sourceKey); }
    }
    if (!bytes) bytes = await this.download(canonical);
    const kind = imageType(bytes), hash = digest(bytes), directory = this.cacheDirectory(), file = path.join(directory, `${hash}.${kind.extension}`);
    if (bytes.length <= this.options.maxCacheBytes) {
      try {
        if (!fs.existsSync(file)) {
          const temporary = `${file}.tmp-${randomUUID()}`;
          try { fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
          catch (error) { try { if (fs.existsSync(temporary) && fs.lstatSync(temporary).isFile() && !fs.lstatSync(temporary).isSymbolicLink()) fs.unlinkSync(temporary); } catch {} throw error; }
        } else assertLocalFile(directory, file);
        const stamp = new Date(this.clock()); fs.utimesSync(file, stamp, stamp);
        this.urlCache.set(sourceKey, { file, time: this.clock() }); this.cleanupCache();
      } catch (error) {
        if (error instanceof MediaError) throw error;
        throw new MediaError('图片缓存保存失败，本次未调用模型');
      }
    }
    return {
      part: { type: 'image_url', image_url: { url: `data:${kind.mime};base64,${bytes.toString('base64')}`, detail: 'low' } },
      estimatedTokens: 1120,
      description: '本次 QQ 图片（低清模式，仅本轮分析）',
      hash
    };
  }
}

export class StickerLibrary {
  constructor(root, options = {}, { clock = Date.now, random = Math.random } = {}) {
    this.root = canonicalRoot(root); this.options = { ...DEFAULT_MEDIA_OPTIONS, ...options };
    Object.assign(this, { clock, random }); this.lastSent = -Infinity; this.lastFile = null;
    if (!Number.isFinite(this.options.stickerProbability) || this.options.stickerProbability < 0 || this.options.stickerProbability > 1 || !Number.isFinite(this.options.stickerCooldownMs) || this.options.stickerCooldownMs < 0) throw new MediaError('表情包概率或冷却配置无效');
  }
  choose(text) {
    if (!this.options.stickersEnabled || this.clock() - this.lastSent < this.options.stickerCooldownMs) return null;
    text = String(text ?? '').slice(0, 4096);
    const rules = [
      [/吃瓜|有瓜|瓜来了|瓜呢|瓜保熟/i, 'mock', '吃瓜'],
      [/看戏|围观|好戏|看热闹|坐等|接着演|前排|搬.{0,2}凳/i, 'mock', '看戏'],
      [/憋笑|忍笑|忍住不笑|差点笑|嘴角.{0,4}压不住/i, 'mock', '憋笑'],
      [/偷笑|窃笑|坏笑|暗爽/i, 'mock', '偷笑'],
      [/拿捏|尽在掌握|本猫出马|手到擒来/i, 'smug', '拿捏了'],
      [/笑疯|笑不活|笑到|绷不住|乐麻/i, 'mock', '笑疯了'],
      [/开心|快乐|好耶|好诶|芜湖|高兴|喜事|乐呵/i, 'smug', '开心'],
      [/笑眯眯|眯着|眯眼|美滋滋|嘿嘿|舒服了|心情不错/i, 'smug', '笑眯眯'],
      [/大笑|哈哈|笑死|乐死|笑出声|乐了|乐子/i, 'mock', '大笑'],
      [/咧嘴笑|憋不住|噗/i, 'mock', '咧嘴笑'],
      [/典中典|典了|复读|台词|包浆|嘴硬|刻舟|逻辑|证据|mock/i, 'mock', '典中典'],
      [/急了|破防|红温/i, 'angry', '急了'],
      [/再说一遍|生气|气死|火大|angry/i, 'angry', '再说一遍'],
      [/赢麻|赢了|胜利|拿下/i, 'smug', '赢麻了'],
      [/就这|得意|哼|自信|嘴强|满分|smug/i, 'smug', '就这'],
      [/嘶/i, 'hissing', '嘶'],
      [/哈气|炸毛|哈[？?]|hissing/i, 'hissing', '哈气']
    ];
    const matches = rules.filter(([pattern]) => pattern.test(text));
    if (!matches.length) return null;
    const chance = this.random(); if (!Number.isFinite(chance) || chance < 0 || chance >= this.options.stickerProbability) return null;
    for (const [, category, hint] of matches) try {
      const library = path.join(this.root, 'assets', 'stickers'), directory = path.join(library, category);
      if (!fs.existsSync(directory)) continue;
      // No directory links, no recursive walk, and no model-provided file path.
      let current = this.root;
      for (const segment of ['assets', 'stickers', category]) {
        current = path.join(current, segment);
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(this.root, fs.realpathSync(current))) return null;
      }
      let files = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && /\.(?:png|jpe?g|webp|gif)$/i.test(entry.name)).map(entry => path.join(directory, entry.name)).filter(file => {
        try { const stat = fs.lstatSync(file); return stat.isFile() && stat.size <= 8 * 1024 * 1024 && !stat.isSymbolicLink() && inside(library, fs.realpathSync(file)); } catch { return false; }
      }).sort();
      if (!files.length) continue;
      // Keep happy faces together rather than replacing a repeat with a sneer.
      const family = ['开心', '笑眯眯'].includes(hint) ? ['开心', '笑眯眯'] : ['就这', '赢麻了', '拿捏了'].includes(hint) ? ['就这', '赢麻了', '拿捏了'] : ['看戏', '吃瓜'].includes(hint) ? ['看戏', '吃瓜'] : ['偷笑', '憋笑', '大笑', '笑疯了', '咧嘴笑'].includes(hint) ? ['偷笑', '憋笑', '大笑', '笑疯了', '咧嘴笑'] : null;
      if (family) { const related = files.filter(file => family.includes(path.basename(file, path.extname(file)))); if (related.length) files = related; }
      const alternatives = files.filter(file => file !== this.lastFile);
      if (alternatives.length) files = alternatives;
      const preferred = files.filter(file => path.basename(file, path.extname(file)) === hint);
      if (preferred.length) files = preferred;
      const pick = this.random(); if (!Number.isFinite(pick) || pick < 0 || pick >= 1) return null;
      this.lastSent = this.clock(); this.lastFile = files[Math.floor(pick * files.length)];
      return this.lastFile;
    } catch { /* Try another matching local mood without reading outside the library. */ }
    return null;
  }
}
