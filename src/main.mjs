import fs from 'node:fs';
import path from 'node:path';
import { ROOT, load, validateConfig } from './config.mjs';
import { acquireLock, Budget } from './storage.mjs';
import { Relay } from './relay.mjs';
import { OneBot } from './onebot.mjs';
import { Chat } from './chat.mjs';
import { MemoryStore } from './memory.mjs';
import { prepareLocalPaths } from './paths.mjs';
import { MediaStore, StickerLibrary } from './media.mjs';
import { Lifecycle } from './lifecycle.mjs';
import { Search } from './search.mjs';
import { PersonaFile } from './persona-file.mjs';
import { ChatControl } from './chat-control.mjs';
import { AiPeers } from './ai-peers.mjs';

let unlock, bot, chat, lifecycle, memoryCleanup;
function shutdown() { clearInterval(memoryCleanup); chat?.stop(); bot?.stop(); lifecycle?.close(); chat?.memory?.close(); chat?.privateMemory?.close(); unlock?.(); }
try {
  prepareLocalPaths();
  const { config, secrets, persona } = load();
  const errors = validateConfig(config, { secrets });
  if (errors.length) {
    console.log('哈基米：配置尚未完成，没有连接 QQ 或调用模型。\n' + errors.map(x => `  - ${x}`).join('\n'));
    console.log(`\n配置位置：${ROOT}\n请编辑 config.json 和 .env，填好后运行“检查配置.cmd”。`);
    process.exitCode = 2;
  } else if (process.argv.includes('--check')) {
    console.log('配置检查通过（离线检查，未连接 QQ，未调用模型）。');
  } else {
    unlock = acquireLock(ROOT);
    fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
    const logFile = path.join(ROOT, 'logs', 'hakimi.log');
    const log = message => {
      let safe = String(message);
      for (const secret of Object.values(secrets)) if (secret) safe = safe.replaceAll(secret, '[已隐藏]');
      safe = safe.replace(/(?:https?|wss?):\/\/\S+/gi, '[连接地址]').replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]');
      const line = `[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}] ${safe}`;
      console.log(line);
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
      fs.appendFileSync(logFile, `${line}\n`, { mode: 0o600 });
    };
    const budget = new Budget(path.join(ROOT, 'data', 'usage.json'), config.limits);
    const relay = new Relay(config.llm, secrets.apiKey, budget, { log });
    bot = new OneBot(config.onebot, secrets.onebotToken, config.botQQ, log);
    const memory = new MemoryStore(path.join(ROOT, 'data', 'memory.json'), config.memory, config.ownerQQ);
    const privateMemory = new MemoryStore(path.join(ROOT, 'data', 'private-memory.json'), config.memory, config.ownerQQ);
    memoryCleanup = setInterval(() => { try { memory.prune(); privateMemory.prune(); } catch { log('过期记忆清理失败，稍后再试，原库保留'); } }, 600000);
    const control = new ChatControl(path.join(ROOT, 'data', 'chat-control.json'));
    const aiPeers = new AiPeers(path.join(ROOT, 'data', 'ai-peer-usage.json'), config.aiPeers);
    const media = config.media.enabled ? new MediaStore(ROOT, config.media) : null;
    const stickers = config.media.stickersEnabled ? new StickerLibrary(ROOT, config.media) : null;
    const search = config.search.enabled ? new Search(ROOT, config.search) : null;
    const personaFile = new PersonaFile(path.join(ROOT, 'persona.md'), persona, log);
    chat = new Chat(config, persona, bot, relay, budget, log, { memory, privateMemory, control, aiPeers, media, stickers, search, getPersona: () => personaFile.read() });
    lifecycle = new Lifecycle(ROOT, {
      state: () => ({ botQQ: config.botQQ, connected: bot.ready, paused: chat.paused, relay: relay.status() }),
      control: action => {
        if (action === 'pause') { chat.paused = true; chat.invalidate(); control.setPaused(true); }
        if (action === 'resume') { control.setPaused(false); chat.paused = false; }
        if (action === 'refresh') { budget.refreshDailyAllowance(); chat.ownerNotices.delete('budget'); }
        log(`本地设置界面操作：${action}`);
      },
      stop: () => { log('收到本地关闭指令，取消待处理回复并退出'); shutdown(); }
    });
    bot.on('fatal', () => { shutdown(); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { console.log('正在停止哈基米……'); shutdown(); });
    process.on('exit', () => unlock?.());
    console.log('哈基米 · 独立聊天\n只连接配置的小号、白名单群与主人私聊；按 Ctrl+C 停止。\n记忆、图片缓存、日志与用量全部保存在本项目目录。');
    log(budget.summary()); bot.connect();
  }
} catch (error) {
  shutdown(); console.error(`哈基米没有启动：${error instanceof SyntaxError ? '配置或用量 JSON 格式错误' : error.message}`); process.exitCode = 1;
}
