import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, load, validateConfig } from './config.mjs';
import { atomicJson } from './storage.mjs';
import { prepareLocalPaths } from './paths.mjs';
import { memoryView } from './memory-view.mjs';
import { ModelCatalog } from './model-catalog.mjs';

export function createWebUI({ root = ROOT, control, modelCatalog = new ModelCatalog() } = {}) {
  const token = randomBytes(32).toString('hex'); let busy = false;
  const file = name => path.join(root, name);
  const readJson = name => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
  const revision = () => createHash('sha256').update(['config.json', 'persona.md', '.env'].map(name => fs.readFileSync(file(name))).join('\0')).digest('hex');
  const alive = state => { try { if (!state?.pid || state.stopped) return false; process.kill(state.pid, 0); return true; } catch { return false; } };
  const scrub = text => {
    let result = String(text);
    try { for (const secret of Object.values(load(root).secrets)) if (secret) result = result.replaceAll(secret, '[已隐藏]'); } catch {}
    return result.replace(/sk-[\w-]{6,}|Bearer\s+\S+/gi, '[已隐藏]');
  };
  const status = () => {
    const state = readJson('data/runtime-status.json'), running = alive(state), usage = readJson('data/usage.json');
    let logs = ''; try { const fd = fs.openSync(file('logs/hakimi.log'), 'r'); try { const size = fs.fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size, 16000)); fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length)); logs = scrub(buffer.toString('utf8')); } finally { fs.closeSync(fd); } } catch {}
    return { running, state: running ? state : null, usage, logs };
  };
  const runControl = control ?? (action => new Promise((resolve, reject) => {
    // Background children can inherit a Windows pipe. Wait for the controller's
    // exit, not for every inherited handle to close; never wait for the bot.
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file('scripts/control.ps1'), '-Action', action], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', size = 0, settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); error ? reject(error) : resolve(scrub(output || '已完成')); };
    const timer = setTimeout(() => { child.kill(); finish(Error('本地控制等待超时，请查看状态和日志后再操作')); }, 60000);
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding('utf8'); stream.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 256000) { child.kill(); finish(Error('本地控制输出过多，请查看日志')); } else output += chunk; }); }
    child.once('error', () => finish(Error('无法启动本地控制脚本，请查看日志')));
    child.once('exit', code => finish(code === 0 ? null : Error(scrub(output || '操作失败，请查看日志'))));
  }));
  const uiAction = async action => {
    const state = readJson('data/runtime-status.json'); if (!alive(state)) throw Error('哈基米未运行，请先启动');
    const id = randomBytes(16).toString('hex');
    atomicJson(file('data/ui-command.json'), { id, pid: state.pid, startedAt: state.startedAt, action });
    for (let n = 0; n < 80; n++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const result = readJson('data/ui-command-result.json');
      if (result?.id === id) { if (!result.success) throw Error('操作未完成，请查看日志'); return '已完成'; }
    }
    throw Error('未收到程序确认，运行中版本可能较旧，请重启哈基米');
  };
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = (code, data, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }); res.end(type.startsWith('application/json') ? JSON.stringify(data) : data); };
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) return send(403, { error: '仅允许本机访问' });
    let url; try { url = new URL(req.url, origin); } catch { return send(400, { error: '请求地址无效' }); }
    if (req.method === 'GET' && url.pathname === '/') {
      res.setHeader('set-cookie', `hakimi_ui=${token}; HttpOnly; SameSite=Strict; Path=/`);
      return send(200, fs.readFileSync(file('assets/settings/index.html'), 'utf8').replace('__TOKEN__', token), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && ['/app.js', '/style.css'].includes(url.pathname)) return send(200, fs.readFileSync(file(`assets/settings${url.pathname}`), 'utf8'), url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
    if (!(req.headers.cookie ?? '').split(';').some(part => part.trim() === `hakimi_ui=${token}`)) return send(403, { error: '请先打开控制台首页' });
    try {
      if (req.method === 'GET' && url.pathname === '/api/status') return send(200, status());
      if (req.method === 'GET' && url.pathname === '/api/memory') return send(200, memoryView(root, load(root).config, { scope: url.searchParams.get('scope') ?? '', scrub }));
      if (req.method === 'GET' && url.pathname === '/api/settings') {
        const { config, secrets, persona } = load(root);
        return send(200, { config, persona, apiKeyConfigured: !!secrets.apiKey, revision: revision() });
      }
      if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['x-hakimi-csrf'] !== token || !req.headers['content-type']?.startsWith('application/json')) return send(403, { error: '请求来源或令牌无效' });
      if (url.pathname === '/api/models') {
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>1024)throw Error('读取模型请求过大');chunks.push(chunk);}
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
        const {config,secrets}=load(root);
        const sourceRevision=revision();
        return send(200,{...await modelCatalog.get(config.llm.baseUrl,secrets.apiKey,{refresh:input.refresh===true}),revision:sourceRevision});
      }
      if (busy) return send(409, { error: '上个操作尚未完成' });
      busy = true;
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 98304) throw Error('提交内容太大'); chunks.push(chunk); }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (url.pathname === '/api/save') {
          if (input.revision !== revision()) return send(409, { error: '配置已被其他窗口或编辑器修改，请刷新页面后再保存' });
          const loaded = load(root), config = structuredClone(loaded.config);
          const sections = { llm: ['baseUrl', 'model', 'fallbackModel', 'lastResortModel', 'reasoningEffort', 'maxTokens', 'timeoutMs', 'primaryFailureCooldownMs'], chat: ['mergeMs', 'cooldownMs', 'followupMs', 'maxReplyChars', 'maxContextChars', 'contextMessages', 'spontaneousProbability', 'interestProbability', 'spontaneousCooldownMs', 'maxSpontaneousDaily', 'quoteReplies', 'allowMentions', 'ownerPrivateChat'], memory: ['maxInjectChars'], media: ['enabled', 'autoViewImages', 'stickersEnabled', 'stickerProbability', 'stickerCooldownMs'], search: ['enabled'] };
          for (const [section, keys] of Object.entries(sections)) for (const key of keys) if (Object.hasOwn(input.config?.[section] ?? {}, key)) config[section][key] = input.config[section][key];
          for (const key of ['allowedGroups', 'aliases']) if (Object.hasOwn(input.config ?? {}, key)) config[key] = input.config[key];
          const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : loaded.secrets.apiKey;
          if (/[\r\n\0]/.test(apiKey)) throw Error('密钥不能包含换行');
          if (apiKey !== loaded.secrets.apiKey && process.env.HAKIMI_API_KEY != null) throw Error('当前密钥由外部环境变量提供，请先取消该环境变量再修改本地密钥');
          const errors = validateConfig(config, { secrets: { ...loaded.secrets, apiKey } });
          if (errors.length) return send(400, { error: errors.join('\n') });
          if (typeof input.persona !== 'string' || !input.persona.trim() || Buffer.byteLength(input.persona) > 65536) throw Error('人设不能为空，且需小于64KiB');
          const backup = file(`data/backups/web-${Date.now()}-${randomBytes(4).toString('hex')}`); fs.mkdirSync(backup, { recursive: true });
          for (const name of ['config.json', 'persona.md', '.env']) fs.copyFileSync(file(name), path.join(backup, name));
          // Config is validated before any file changes. Restore all originals
          // if a write fails; backups are local and include the original key.
          try {
            if (apiKey !== loaded.secrets.apiKey) {
              let env = fs.readFileSync(file('.env'), 'utf8');
              const line = `HAKIMI_API_KEY=${apiKey}`;
              env = /^\s*HAKIMI_API_KEY\s*=.*$/m.test(env) ? env.replace(/^\s*HAKIMI_API_KEY\s*=.*$/m, () => line) : env + '\n' + line + '\n';
              fs.writeFileSync(file('.env.tmp'), env, { mode: 0o600 }); fs.renameSync(file('.env.tmp'), file('.env'));
            }
            atomicJson(file('config.json'), config);
            fs.writeFileSync(file('persona.md.tmp'), input.persona, { mode: 0o600 }); fs.renameSync(file('persona.md.tmp'), file('persona.md'));
          } catch (error) { for (const name of ['config.json', 'persona.md', '.env']) fs.copyFileSync(path.join(backup, name), file(name)); throw error; }
          return send(200, { message: '已保存并备份。人设下轮生效；模型和参数请重启生效。', revision: revision() });
        }
        if (url.pathname === '/api/control') {
          const actions = { start: 'Start', stop: 'Stop', restart: 'Restart', backup: 'Backup' };
          if (Object.hasOwn(actions, input.action)) return send(200, { message: await runControl(actions[input.action]) });
          if (['pause', 'resume', 'refresh'].includes(input.action)) return send(200, { message: await uiAction(input.action) });
          return send(400, { error: '未知操作' });
        }
        return send(404, { error: '页面不存在' });
      } finally { busy = false; }
    } catch (error) { return send(400, { error: scrub(error instanceof SyntaxError ? '数据格式错误' : error.message) }); }
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  prepareLocalPaths();
  const server = createWebUI(); server.listen(17863, '127.0.0.1', () => { atomicJson(path.join(ROOT, 'data', 'web-ui-status.json'), { pid: process.pid, startedAt: new Date().toISOString() }); console.log('哈基米设置：http://127.0.0.1:17863'); });
  server.on('error', () => { console.error('设置界面启动失败，17863端口可能被占用'); process.exitCode = 1; });
}
