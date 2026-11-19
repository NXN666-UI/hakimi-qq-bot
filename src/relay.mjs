import { SEARCH_TOOL } from './search.mjs';
export class RelayError extends Error {
  constructor(message, { status = 0, retryAfterMs = 0, kind = 'response' } = {}) { super(message); this.status = status; this.retryAfterMs = retryAfterMs; this.kind = kind; }
}
export class Relay {
  constructor(config, apiKey, budget, { fetchImpl = fetch, log = () => {} } = {}) { this.config = config; this.apiKey = apiKey; this.budget = budget; this.fetchImpl = fetchImpl; this.blockedUntil = 0; this.log = log; this.children = new Map(); this.primaryFallbackUntil = 0; this.lastModel = ''; this.modelCooldowns = new Map(); }
  models() { return [...new Set([this.config.model,this.config.fallbackModel,this.config.lastResortModel].filter(Boolean))]; }
  readyAt(model) { return Math.max(model===this.config.model?this.primaryFallbackUntil:this.modelCooldowns.get(model)||0,this.models().length===1?this.blockedUntil:this.children.get(model)?.blockedUntil||0); }
  preferredModel() { return this.models().find(model=>this.readyAt(model)<=Date.now()) || ''; }
  status() {
    return { primaryModel: this.config.model, fallbackModel: this.config.fallbackModel || '', lastResortModel: this.config.lastResortModel || '', cooldowns: this.models().map(model=>({model,until:this.readyAt(model)||null})), nextModel: this.preferredModel(), activeModel: this.activeModel || '', requestStartedAt: this.requestStartedAt || null, lastAttemptedModel: this.lastModel, lastAttemptedAt: this.lastAttemptedAt || null, lastSuccessfulModel: this.lastSuccessfulModel || '', lastSuccessAt: this.lastSuccessAt || null, reportedModel: this.reportedModel || '', lastError: this.lastError || null, primaryFallbackUntil: this.primaryFallbackUntil || null };
  }
  async track(model, generate) {
    this.activeModel = model; this.lastModel = model; this.requestStartedAt = this.lastAttemptedAt = Date.now();
    try {
      const result = await generate();
      this.lastSuccessfulModel = model; this.lastSuccessAt = Date.now(); this.lastError = null;
      this.reportedModel = this.children.get(model)?.responseModel || this.responseModel || '';
      return result;
    } catch (error) {
      this.lastError = { model, status: Number.isInteger(error.status) ? error.status : 0, kind: ['timeout','network','format','cooldown','cancelled','response','storage'].includes(error.kind) ? error.kind : 'local', at: Date.now() };
      throw error;
    } finally { this.activeModel = ''; this.requestStartedAt = null; }
  }
  async generate(messages, signal, options = {}) {
    if (signal?.aborted) throw new RelayError('本轮已取消', { kind: 'cancelled' });
    if (this.models().length===1) return this.track(this.config.model, () => this.generateOne(messages, signal, options));
    const candidates=this.models().filter(model=>this.readyAt(model)<=Date.now());
    if (!candidates.length) throw new RelayError('所有配置通道仍在冷却，稍后按优先级重试', { kind: 'cooldown' });
    let previous;
    for (const model of candidates) {
      if (signal?.aborted) throw new RelayError('本轮已取消', { kind: 'cancelled' });
      if (previous && options.onFallbackAttempt && !options.onFallbackAttempt()) throw previous;
      if (!this.children.has(model)) this.children.set(model,new Relay({...this.config,model,fallbackModel:'',lastResortModel:''},this.apiKey,this.budget,{fetchImpl:this.fetchImpl}));
      const actualMessages=messages.map(m=>m.role==='system'?{...m,content:m.content+'\n程序本次实际调用的模型标识：'+model+'，角色设定不变。'}:m);
      try { return await this.track(model,()=>this.children.get(model).generateOne(actualMessages,signal,options)); }
      catch (error) {
        const switchable=error instanceof RelayError && ([400,403,404,408,429].includes(error.status)||error.status>=500||['network','timeout','format'].includes(error.kind));
        if (!switchable || signal?.aborted) throw error;
        const until=Date.now()+(this.config.primaryFailureCooldownMs??300000);
        if(model===this.config.model)this.primaryFallbackUntil=until;else this.modelCooldowns.set(model,until);
        previous=error;
        const next=candidates[candidates.indexOf(model)+1];
        if(next)this.log('当前模型 '+model+' 暂不可用，切换备用 '+next+'；冷却到期后按优先级重新尝试');
      }
    }
    throw previous;
  }
  async generateOne(messages, signal, { allowSearch = false, budgetExempt = false } = {}) {
    if (Date.now() < this.blockedUntil) throw new RelayError('中转接口冷却中，稍后再试', { kind: 'cooldown' });
    const c = this.config;
    // UTF-8 bytes plus schema overhead is deliberately conservative. Failed/uncertain calls keep the reservation.
    let imageTokens = 0;
    const textOnly = messages.map(message => ({ ...message, content: Array.isArray(message.content) ? message.content.map(part => {
      if (part.type === 'image_url') { imageTokens += 1120; return { type: 'image_url' }; }
      return part;
    }) : message.content }));
    // Image base64 bytes are upload size, not textual tokens. Reserve visual input separately.
    this.budget.reserve(Buffer.byteLength(JSON.stringify(textOnly), 'utf8') + imageTokens + c.maxTokens + 512 + (allowSearch ? Buffer.byteLength(JSON.stringify(SEARCH_TOOL), 'utf8') : 0), { exempt: budgetExempt });
    let response;
    try {
      response = await this.fetchImpl(`${c.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: c.model, messages, stream: false, reasoning_effort: c.reasoningEffort, max_tokens: c.maxTokens, ...(allowSearch ? { tools: [SEARCH_TOOL], tool_choice: 'auto', parallel_tool_calls: false } : {}) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(c.timeoutMs)]) : AbortSignal.timeout(c.timeoutMs)
      });
    } catch (error) {
      if (signal?.aborted) throw new RelayError('本轮已由程序取消；本次不自动重试', { kind: 'cancelled' });
      const timedOut = error?.name === 'TimeoutError';
      this.blockedUntil = Date.now() + 15000;
      throw new RelayError(timedOut ? `等待中转超过 ${Math.round(c.timeoutMs / 1000)} 秒；本次不自动重试` : '中转网络请求失败或已取消；本次不自动重试', { kind: timedOut ? 'timeout' : 'network' });
    }
    if (!response.ok) {
      await response.body?.cancel();
      const status = response.status;
      const reason = ({ 400: '请求参数或模型不兼容', 401: 'API Key 无效', 402: '中转余额或额度不足', 403: '中转拒绝访问，请检查令牌、模型及通道权限', 404: '模型或接口不存在', 429: '中转限速或额度不足' })[status] ?? '中转服务暂不可用';
      const raw = response.headers.get('retry-after');
      const retryAfterMs = raw ? (/^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now()) : 0;
      const delay = [401, 402, 403, 404].includes(status) ? 300000 : Math.max(30000, Math.min(300000, retryAfterMs || 30000));
      this.blockedUntil = Date.now() + delay;
      throw new RelayError(`${reason}（HTTP ${status}），已暂停请求一段时间`, { status, retryAfterMs: delay });
    }
    const reader = response.body.getReader(); let bytes = 0; const chunks = [];
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 1024 * 1024) { await reader.cancel(); throw Error(); } chunks.push(value); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      this.responseModel = typeof body.model === 'string' && /^[\w./:@+-]{1,150}$/.test(body.model) ? body.model : '';
      try { this.budget.recordUsage(body.usage); } catch { throw new RelayError('用量保存失败', { kind: 'storage' }); }
      const calls = body.choices?.[0]?.message?.tool_calls;
      if (allowSearch && Array.isArray(calls) && calls.length) {
        if (calls.length !== 1 || calls[0]?.type !== 'function' || calls[0]?.function?.name !== 'web_search' || !/^[\w-]{1,80}$/.test(calls[0].id) || typeof calls[0].function.arguments !== 'string' || calls[0].function.arguments.length > 2048) throw Error();
        const args = JSON.parse(calls[0].function.arguments);
        if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 120) throw Error();
        return { searchRequest: { id: calls[0].id, query: args.query }, assistantMessage: { role: 'assistant', content: null, tool_calls: [calls[0]] } };
      }
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw Error();
      // Never transmit reasoning_content or tool_calls to QQ.
      return text.trim();
    } catch (error) { if (error instanceof RelayError) throw error; throw new RelayError('中转返回空回复或格式异常', { kind: 'format' }); }
  }
}
