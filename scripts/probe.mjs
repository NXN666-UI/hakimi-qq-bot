import { load, validateConfig } from '../src/config.mjs';
import { OneBot } from '../src/onebot.mjs';
import { prepareLocalPaths } from '../src/paths.mjs';

const mode = process.argv[2];
prepareLocalPaths();
const { config, secrets } = load();
if (mode === 'models') {
  const errors = validateConfig(config, { secrets }).filter(x => x.startsWith('llm.') || x.startsWith('.env'));
  if (errors.length) { console.log(errors.join('\n')); process.exitCode = 2; }
  else {
    try {
      const response = await fetch(`${config.llm.baseUrl.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${secrets.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); throw Error(`HTTP ${response.status}`); }
      const body = await response.json(); const ids = (body.data ?? []).map(x => x.id).filter(x => typeof x === 'string');
      console.log(`令牌可见 ${ids.length} 个模型。目标 ${config.llm.model}：${ids.includes(config.llm.model) ? '已列出' : '未列出，请检查令牌分组'}`);
      if (!ids.includes(config.llm.model)) {
        process.exitCode = 2;
        console.log(ids.length ? '先核对目标模型权限；本检查不自动切换其他模型。' : '模型列表为空：请检查中转站令牌所属分组、模型限制、额度及通道状态。');
      }
      console.log('仅查询模型列表，未发送聊天生成请求；能否生成仍需后续实测。');
    } catch (e) { console.log(`模型列表检查失败：${/^HTTP \d+$/.test(e.message) ? e.message : '网络或响应异常'}`); process.exitCode = 1; }
  }
} else if (mode === 'qq') {
  const errors = validateConfig(config, { secrets, credentials: false }).filter(x => x.startsWith('botQQ') || x.startsWith('onebot') || x.includes('端口'));
  if (errors.length) { console.log(errors.join('\n')); process.exitCode = 2; }
  else {
    const bot = new OneBot(config.onebot, secrets.onebotToken, config.botQQ, console.log);
    const timeout = setTimeout(() => { bot.stop(); console.log('QQ 检查超时，未发送任何消息。'); process.exitCode = 1; }, 15000);
    bot.once('ready', async () => {
      clearTimeout(timeout);
      try {
        const groups = await bot.call('get_group_list', {});
        const missing = config.allowedGroups.filter(id => !Array.isArray(groups) || !groups.some(row => String(row.group_id) === String(id)));
        if (missing.length) { console.log(`小号身份正确，但有 ${missing.length} 个白名单群尚未加入。`); process.exitCode = 2; }
        else console.log('新小号身份与白名单群验证成功，未读取群历史、未发送任何 QQ 消息。');
      } catch { console.log('群列表检查失败，未发送任何 QQ 消息。'); process.exitCode = 1; }
      finally { bot.stop(); }
    });
    bot.once('fatal', () => { clearTimeout(timeout); process.exitCode = 1; });
    bot.connect();
  }
} else { console.log('用法：node scripts/probe.mjs models 或 qq'); process.exitCode = 2; }
