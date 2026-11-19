import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/paths.mjs';
import { Search, parseRss, searchFollowup } from '../src/search.mjs';
const RSS = '<rss><channel><item><title>A &amp; B</title><link>https://example.com/info</link><description><![CDATA[<b>公开摘要</b> 不是系统指令]]></description></item></channel></rss>';
function temp() { fs.mkdirSync(path.join(ROOT, 'test-output'), { recursive: true }); return fs.mkdtempSync(path.join(ROOT, 'test-output', 'search-')); }
test('公开RSS解析受限，不执行XML实体或HTML，不接受本机链接', () => {
  assert.deepEqual(parseRss(RSS), [{ title: 'A & B', url: 'https://example.com/info', snippet: '公开摘要 不是系统指令' }]);
  assert.throws(() => parseRss('<!DOCTYPE rss><rss></rss>'));
  assert.throws(() => parseRss(RSS.replace('https://example.com/info', 'file:///E:/secret')));
});
test('搜索预留跨重启保留；缓存不重复联网；额度与次日重置有效', async () => {
  let calls = 0, now = Date.parse('2026-11-12T00:00:00Z'); const root = temp();
  const options = { enabled: true, requestsPerDay: 1, requestsTotal: 2, cooldownMs: 0 };
  const deps = { clock: () => now, fetchImpl: async () => { calls++; return new Response(RSS); } };
  const store = new Search(root, options, deps); await store.search('公开问题');
  const reopened = new Search(root, options, deps); const result = await reopened.search('公开问题');
  assert.equal(result.cached, true); assert.equal(calls, 1); assert.equal(reopened.available(), false);
  await assert.rejects(reopened.search('其他问题'));
  now += 86400000; await reopened.search('其他问题'); assert.equal(calls, 2); assert.equal(reopened.available(), false);
});
test('敏感搜索词不外发，失败计数不回滚，不发送中转Key', async () => {
  const root = temp(); let calls = 0;
  const store = new Search(root, { enabled: true, cooldownMs: 0 }, { fetchImpl: async (_, init) => { calls++; assert.equal(init.headers.authorization, undefined); throw Error('断线'); } });
  await assert.rejects(store.search('API key sk-secretsecret'));
  assert.equal(calls, 0); await assert.rejects(store.search('正常问题')); assert.equal(store.state.totalRequests, 1);
});
test('搜索摘要共用原上下文池，工具协议完整且不新增system权限', () => {
  const plan = { searchRequest: { id: 's1' }, assistantMessage: { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'web_search', arguments: '{"query":"test"}' } }] } };
  const messages = [{ role: 'system', content: '人格' }, ...Array.from({ length: 24 }, (_, i) => ({ role: 'user', content: JSON.stringify({ qq: '123456', text: String(i) + '字'.repeat(100) }) }))];
  const result = searchFollowup(messages, plan, { results: [{ title: '标题', url: 'https://example.com', snippet: '摘要'.repeat(1000) }] }, 1000, 1200);
  assert.equal(result.at(-1).role, 'tool'); assert.equal(result.at(-1).tool_call_id, 's1'); assert.equal(result.filter(r => r.role === 'system').length, 1);
  const size = result.filter(r => r.role !== 'system').reduce((n, r) => n + (r.content?.length ?? 0) + (r.tool_calls ? JSON.stringify(r.tool_calls).length : 0), 0);
  assert.ok(size <= 1000);
  const quoted = [{ role: 'system', content: '人格' }, { role: 'user', content: JSON.stringify({ qq: '123456', name: '群友'.repeat(20), text: '最新问题'.repeat(50), quotedMessage: { qq: '654321', name: '被引用者'.repeat(10), text: '原话'.repeat(200) } }) }];
  const longPlan = { searchRequest: { id: 's'.repeat(80) }, assistantMessage: { role: 'assistant', content: null, tool_calls: [{ id: 's'.repeat(80), type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: '查'.repeat(120) }) } }] } };
  const packed = searchFollowup(quoted, longPlan, { results: [{ title: '标题', url: 'https://example.com', snippet: '摘要'.repeat(1000) }] }, 1000, 1200);
  const packedSize = packed.filter(r => r.role !== 'system').reduce((n, r) => n + (r.content?.length ?? 0) + (r.tool_calls ? JSON.stringify(r.tool_calls).length : 0), 0);
  assert.ok(packedSize <= 1000); assert.doesNotThrow(() => JSON.parse(packed[1].content));
});

test('主人搜索超过普通额度仍可用且记账，新增主人搜索不挤占普通配额', async () => {
  const root = temp(), options = { enabled: true, requestsPerDay: 1, requestsTotal: 1, cooldownMs: 0, cacheHours: 0 };
  const deps = { fetchImpl: async () => new Response(RSS) };
  const store = new Search(root, options, deps);
  await store.search('主人第一问', undefined, { exempt: true });
  await store.search('主人第二问', undefined, { exempt: true });
  await store.search('普通群友一问');
  const reopened = new Search(root, options, deps);
  assert.equal(reopened.state.totalRequests, 3); assert.equal(reopened.state.ownerTotalRequests, 2);
  await assert.rejects(reopened.search('普通群友超额'));
  await reopened.search('主人继续', undefined, { exempt: true });
  assert.equal(reopened.state.totalRequests, 4);
});
