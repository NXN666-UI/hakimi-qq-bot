import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MEMORY_OPTIONS } from './memory.mjs';
import { DEFAULT_MEDIA_OPTIONS } from './media.mjs';
import { ROOT } from './paths.mjs';
import { DEFAULT_SEARCH } from './search.mjs';

export { ROOT } from './paths.mjs';
const loopback = h => ['127.0.0.1', 'localhost', '[::1]'].includes(h);
const id = v => typeof v === 'string' && /^[1-9]\d{4,15}$/.test(v);
export function validateConfig(c, { credentials = true, secrets = {} } = {}) {
  const errors = [];
  if (!id(c.botQQ)) errors.push('botQQ：填写哈基米小号 QQ（字符串）');
  if (!id(c.ownerQQ)) errors.push('ownerQQ：填写主人 QQ（字符串）');
  if (c.botQQ && c.botQQ === c.ownerQQ) errors.push('主人和机器人必须使用不同 QQ');
  for (const key of ['allowedGroups', 'ignoredUsers']) {
    if (!Array.isArray(c[key]) || !c[key].every(id)) errors.push(`${key}：必须是 QQ/群号字符串数组`);
  }
  if (!c.allowedGroups?.length) errors.push('allowedGroups：至少填写一个测试群');
  if (c.aiPeers != null && (!Array.isArray(c.aiPeers) || c.aiPeers.length > 10)) errors.push('aiPeers：需要最多10项的数组');
  else {
    const seenPeers = new Set();
    for (const peer of c.aiPeers ?? []) {
      if (!peer || !id(peer.qq) || peer.qq === c.botQQ || peer.qq === c.ownerQQ || (Array.isArray(c.ignoredUsers) && c.ignoredUsers.includes(peer.qq)) || seenPeers.has(peer.qq)) { errors.push('aiPeers：AI账号无效、重复或与主人/自号/忽略名单冲突'); continue; }
      seenPeers.add(peer.qq);
      if (peer.ownerQQ != null && (!id(peer.ownerQQ) || peer.ownerQQ === peer.qq)) errors.push('aiPeers.ownerQQ：需要有效且与该AI不同的QQ');
      if (peer.ownerLabel != null && (typeof peer.ownerLabel !== 'string' || !peer.ownerLabel.trim() || peer.ownerLabel.length > 20 || /[\r\n]/.test(peer.ownerLabel) || !peer.ownerQQ)) errors.push('aiPeers.ownerLabel：需有ownerQQ，称呼为1～20字符单行文字');
      if (peer.attitude != null && !['normal', 'aloof'].includes(peer.attitude)) errors.push('aiPeers.attitude：需要normal或aloof');
      if (!Array.isArray(peer.groups) || !peer.groups.length || !peer.groups.every(group => id(group) && Array.isArray(c.allowedGroups) && c.allowedGroups.includes(group))) errors.push('aiPeers.groups：必须使用当前白名单群');
      for (const [key, lo, hi] of [['cooldownMs', 10000, 3600000], ['windowMs', 60000, 3600000], ['maxRepliesPerWindow', 1, 5], ['maxRepliesPerDay', 1, 100]]) if (!Number.isSafeInteger(peer[key]) || peer[key] < lo || peer[key] > hi) errors.push(`aiPeers.${key}：需要${lo}～${hi}整数`);
    }
  }
  if (!Array.isArray(c.aliases) || !c.aliases.length || !c.aliases.every(x => typeof x === 'string' && x.trim().length > 0 && x.length <= 20)) errors.push('aliases：填写有效称呼');
  try {
    const u = new URL(c.onebot.wsUrl);
    if (u.protocol !== 'ws:' || !loopback(u.hostname) || !u.port || u.username || u.password || u.search || u.hash || !['/', ''].includes(u.pathname)) throw Error();
    const blocked = new Set([...(c.onebot.protectedPorts ?? [])]);
    if (blocked.has(Number(u.port))) errors.push('该端口属于其他机器人保护范围，请为新账号分配独立端口（建议 3011）');
  } catch { errors.push('onebot.wsUrl：必须是本机独立端口的 ws://127.0.0.1:端口/'); }
  try {
    const u = new URL(c.llm.baseUrl);
    if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback(u.hostname))) || u.username || u.password || u.search || u.hash || !/\/v1\/?$/.test(u.pathname)) throw Error();
  } catch { errors.push('llm.baseUrl：必须使用 HTTPS /v1 地址（本机模拟服务例外）'); }
  if (typeof c.llm?.model !== 'string' || !/^[\w./:@+-]{1,150}$/.test(c.llm.model)) errors.push('llm.model 无效');
  if (c.llm?.fallbackModel != null && (typeof c.llm.fallbackModel !== 'string' || (c.llm.fallbackModel && (!/^[\w./:@+-]{1,150}$/.test(c.llm.fallbackModel) || c.llm.fallbackModel === c.llm.model)))) errors.push('llm.fallbackModel：备用模型ID需有效且与主模型不同，可留空关闭');
  if (c.llm?.lastResortModel != null && (typeof c.llm.lastResortModel !== 'string' || (c.llm.lastResortModel && (!/^[\w./:@+-]{1,150}$/.test(c.llm.lastResortModel) || [c.llm.model,c.llm.fallbackModel].includes(c.llm.lastResortModel))))) errors.push('llm.lastResortModel：保底模型需有效且与首选/次选不同，可留空关闭');
  if (c.llm?.primaryFailureCooldownMs != null && (!Number.isSafeInteger(c.llm.primaryFailureCooldownMs) || c.llm.primaryFailureCooldownMs < 30000 || c.llm.primaryFailureCooldownMs > 3600000)) errors.push('llm.primaryFailureCooldownMs：需30000～3600000整数');
  if (!['low', 'medium', 'high'].includes(c.llm?.reasoningEffort)) errors.push('reasoningEffort 无效');
  const ranges = {
    'llm.maxTokens': [128, 8192], 'llm.timeoutMs': [1000, 180000],
    'chat.mergeMs': [0, 10000], 'chat.cooldownMs': [0, 300000], 'chat.followupMs': [0, 600000],
    'chat.contextMessages': [2, 100], 'chat.contextTtlMs': [1000, 3600000], 'chat.maxContextChars': [1000, 20000],
    'chat.maxMessageChars': [50, 4000], 'chat.maxReplyChars': [20, 1000], 'chat.maxQueueAgeMs': [1000, 300000],
    'chat.maxPendingGroups': [1, 50], 'chat.spontaneousCooldownMs': [1000, 3600000], 'chat.maxSpontaneousDaily': [0, 100],
    'limits.requestsPerMinute': [1, 60], 'limits.requestsPerDay': [1, 10000], 'limits.requestsTotal': [0, 100000]
  };
  for (const [key, [lo, hi]] of Object.entries(ranges)) {
    const [a, b] = key.split('.'), v = c[a]?.[b];
    if (!Number.isInteger(v) || v < lo || v > hi) errors.push(`${key}：需要 ${lo}～${hi} 的整数`);
  }
  for (const [key, max] of [['reservedTokensPerDay', 10000000], ['reservedTokensTotal', 100000000]]) {
    const value = c.limits?.[key];
    if (!Number.isInteger(value) || (value !== 0 && (value < 1000 || value > max))) errors.push(`limits.${key}：需要 0（不限额）或 1000～${max} 的整数`);
  }
  const chance = c.chat?.spontaneousProbability;
  if (c.chat?.quoteReplies != null && typeof c.chat.quoteReplies !== 'boolean') errors.push('chat.quoteReplies：需要 true 或 false');
  if (c.chat?.allowMentions != null && typeof c.chat.allowMentions !== 'boolean') errors.push('chat.allowMentions：需要 true 或 false');
  if (c.chat?.ownerPrivateChat != null && typeof c.chat.ownerPrivateChat !== 'boolean') errors.push('chat.ownerPrivateChat：需要 true 或 false');
  if (!Number.isFinite(chance) || chance < 0 || chance > 0.2) errors.push('spontaneousProbability：需要 0～0.2');
  if (c.chat?.interestProbability != null && (!Number.isFinite(c.chat.interestProbability) || c.chat.interestProbability < 0 || c.chat.interestProbability > 0.2)) errors.push('interestProbability：需要0～0.2');
  const memory = { ...DEFAULT_MEMORY_OPTIONS, ...c.memory };
  if (typeof memory.enabled !== 'boolean') errors.push('memory.enabled：需要 true 或 false');
  if (!['facts', 'impressions'].includes(memory.mode)) errors.push('memory.mode：需要facts或impressions');
  if (!Number.isInteger(memory.maxPeople) || memory.maxPeople < 1 || memory.maxPeople > 30) errors.push('memory.maxPeople：需要1～30的整数（所有群合计）');
  if (typeof memory.forgettingEnabled !== 'boolean') errors.push('memory.forgettingEnabled：需要true或false');
  if (!['json', 'sqlite'].includes(memory.storage)) errors.push('memory.storage：需要json或sqlite');
  if (!Number.isSafeInteger(memory.storageMaxBytes) || memory.storageMaxBytes < 1048576 || memory.storageMaxBytes > 5000000000) errors.push('memory.storageMaxBytes：需要1MiB～5GB整数');
  if (!Array.isArray(memory.forgettingDays) || memory.forgettingDays.length !== 3 || memory.forgettingDays.some((v,i,a) => !Number.isInteger(v) || v < 1 || v > 365 || (i > 0 && v <= a[i-1]))) errors.push('memory.forgettingDays：需要3个递增天数，如[7,15,30]');
  const memoryRanges = { maxRecordsPerGroup: [1, 900], maxRecordsPerUser: [1, memory.mode === 'impressions' ? 30 : 100], maxInjectChars: [0, 1200], maxHandoverEntries: [0, 20], handoverEntryChars: [20, 160], maxHandoverChars: [0, 1200], factTtlDays: [1, 365], handoverTtlDays: [1, 7] };
  for (const [key, [lo, hi]] of Object.entries(memoryRanges)) if (!Number.isInteger(memory[key]) || memory[key] < lo || memory[key] > hi) errors.push(`memory.${key}：需要 ${lo}～${hi} 的整数`);
  const media = { ...DEFAULT_MEDIA_OPTIONS, ...c.media };
  if (typeof media.enabled !== 'boolean' || typeof media.stickersEnabled !== 'boolean') errors.push('media.enabled/stickersEnabled：需要 true 或 false');
  if (typeof media.autoViewImages !== 'boolean') errors.push('media.autoViewImages：需要 true 或 false');
  const mediaRanges = { maxImagesPerDay: [1, 100], maxImagesTotal: [1, 1000], maxImageBytes: [1024, 5242880], maxCacheBytes: [1048576, 209715200], cacheTtlHours: [1, 72], stickerCooldownMs: [1000, 3600000] };
  for (const [key, [lo, hi]] of Object.entries(mediaRanges)) if (!Number.isInteger(media[key]) || media[key] < lo || media[key] > hi) errors.push(`media.${key}：需要 ${lo}～${hi} 的整数`);
  if (!Number.isFinite(media.stickerProbability) || media.stickerProbability < 0 || media.stickerProbability > 1) errors.push('media.stickerProbability：需要 0～1');
  const search = { ...DEFAULT_SEARCH, ...c.search };
  if (typeof search.enabled !== 'boolean') errors.push('search.enabled：需要 true 或 false');
  const searchRanges = { requestsPerDay: [1, 100], requestsTotal: [1, 10000], cooldownMs: [0, 3600000], timeoutMs: [1000, 30000], cacheHours: [0, 24], maxResults: [1, 5], maxInjectChars: [200, 2000] };
  for (const [key, [lo, hi]] of Object.entries(searchRanges)) if (!Number.isSafeInteger(search[key]) || search[key] < lo || search[key] > hi) errors.push(`search.${key}：需要 ${lo}～${hi} 的整数`);
  if (credentials && !secrets.apiKey?.trim()) errors.push('.env：尚未填写 HAKIMI_API_KEY');
  return errors;
}
export function load(root = ROOT) {
  const configFile = path.join(root, 'config.json');
  if (!fs.existsSync(configFile)) fs.copyFileSync(path.join(root, 'config.example.json'), configFile);
  const personaFile = path.join(root, 'persona.md');
  if (!fs.existsSync(personaFile)) fs.copyFileSync(path.join(root, 'persona.example.md'), personaFile);
  const envFile = path.join(root, '.env');
  if (!fs.existsSync(envFile)) fs.copyFileSync(path.join(root, '.env.example'), envFile);
  const env = {};
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(HAKIMI_API_KEY|HAKIMI_ONEBOT_TOKEN)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  const secrets = { apiKey: process.env.HAKIMI_API_KEY ?? env.HAKIMI_API_KEY ?? '', onebotToken: process.env.HAKIMI_ONEBOT_TOKEN ?? env.HAKIMI_ONEBOT_TOKEN ?? '' };
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
  config.memory = { ...DEFAULT_MEMORY_OPTIONS, ...config.memory };
  config.media = { ...DEFAULT_MEDIA_OPTIONS, ...config.media };
  config.search = { ...DEFAULT_SEARCH, ...config.search };
  return { config, secrets, persona: fs.readFileSync(path.join(root, 'persona.md'), 'utf8') };
}
