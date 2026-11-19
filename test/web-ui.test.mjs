import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createWebUI } from '../src/web-ui.mjs';
import { ROOT } from '../src/paths.mjs';
import { Lifecycle } from '../src/lifecycle.mjs';
import { memoryView } from '../src/memory-view.mjs';
import { MemoryStore } from '../src/memory.mjs';
fs.mkdirSync(path.join(ROOT,'test-output'),{recursive:true});

test('本地网页保护密钥、验证来源、保存校验与冲突检测，不调用模型或真实进程控制', async t => {
  const root = fs.mkdtempSync(path.join(ROOT, 'test-output', 'ui-'));
  fs.mkdirSync(path.join(root, 'assets/settings'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets/settings/index.html'), '<body data-csrf="__TOKEN__">HAKIMI / SETTINGS</body>');
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  Object.assign(config, { botQQ: '111111', ownerQQ: '555555', allowedGroups: ['666666'] });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(root, 'persona.md'), '测试角色');
  fs.writeFileSync(path.join(root, '.env'), 'HAKIMI_API_KEY=fake-secret-key\nHAKIMI_ONEBOT_TOKEN=bridge-secret\n');
  const catalogCalls=[];
  const actions = [], server = createWebUI({ root, modelCatalog:{get:async(...args)=>{catalogCalls.push(args);return {ids:['upstream-test-model'],fetchedAt:123,cached:false};}}, control: async action => { actions.push(action); return 'mock only'; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin + '/api/settings')).status, 403);
  assert.equal((await fetch(origin + '/api/memory')).status, 403);
  const page = await fetch(origin), html = await page.text();
  const token = html.match(/data-csrf="([a-f0-9]+)"/)[1];
  const cookie = page.headers.get('set-cookie').split(';')[0];
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const get = route => fetch(origin + '/api/' + route, { headers: { cookie } });
  const post = (route, data, extra={}) => fetch(origin + '/api/' + route, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', 'x-hakimi-csrf': token, ...extra }, body: JSON.stringify(data) });
  assert.equal((await post('models',{}, {origin:'https://evil.test'})).status,403);assert.equal(catalogCalls.length,0);
  const catalog=await (await post('models',{refresh:true,baseUrl:'https://evil.test/v1',apiKey:'attacker'})).json();
  assert.deepEqual(catalog.ids,['upstream-test-model']);assert.equal(catalogCalls[0][0],config.llm.baseUrl);assert.equal(catalogCalls[0][1],'fake-secret-key');assert.equal(catalogCalls[0][2].refresh,true);
  assert.doesNotMatch(JSON.stringify(catalog),/fake-secret-key|bridge-secret/);
  const data = await (await get('settings')).json();
  assert.equal((await get('memory')).status, 200);
  assert.equal((await get('memory?scope=private/999999')).status, 400);
  assert.equal(data.apiKeyConfigured, true); assert.doesNotMatch(JSON.stringify(data), /fake-secret-key|bridge-secret/);
  assert.equal((await post('control', { action: 'start' }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await post('control', { action: 'start' }, { 'x-hakimi-csrf': '' })).status, 403);
  assert.equal((await post('control', { action: 'arbitrary.exe' })).status, 400); assert.equal(actions.length, 0);
  assert.equal((await post('control', { action: 'toString' })).status, 400); assert.equal(actions.length, 0);
  const original = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
  assert.equal((await post('save', { revision: data.revision, config: { chat: { followupMs: -1 } }, persona: '新角色' })).status, 400);
  assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), original);
  const result = await post('save', { revision: data.revision, config: { chat: { followupMs: 480000, maxContextChars: 9000, contextMessages: 32 }, memory: { maxInjectChars: 1200, maxPeople: 999 } }, persona: '新角色', apiKey: '' });
  assert.equal(result.status, 200); assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'))).chat.followupMs, 480000);
  const contextSaved=JSON.parse(fs.readFileSync(path.join(root,'config.json')));
  assert.equal(contextSaved.chat.maxContextChars,9000);assert.equal(contextSaved.chat.contextMessages,32);
  assert.equal(contextSaved.memory.maxInjectChars,1200);assert.equal(contextSaved.memory.maxPeople,30);
  assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /fake-secret-key/);
  assert.equal((await post('save', { revision: data.revision, config: {}, persona: '过时的修改' })).status, 409);
  const updated = await (await get('settings')).json();
  assert.equal((await post('save', { revision: updated.revision, config: { ownerQQ: '999999', onebot: { wsUrl: 'ws://127.0.0.1:3001/' } }, persona: '新角色', apiKey: 'new-fake-api-key' })).status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
  assert.equal(saved.ownerQQ, config.ownerQQ); assert.equal(saved.onebot.wsUrl, config.onebot.wsUrl);
  assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /HAKIMI_API_KEY=new-fake-api-key/);
  assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /HAKIMI_ONEBOT_TOKEN=bridge-secret/);
  assert.doesNotMatch(JSON.stringify(await (await get('settings')).json()), /new-fake-api-key|bridge-secret/);
  const backups = fs.readdirSync(path.join(root, 'data/backups'));
  assert.equal(backups.length, 2); assert.match(fs.readFileSync(path.join(root, 'data/backups', backups[0], '.env'), 'utf8'), /fake-secret-key/);
  const fresh = await (await get('settings')).json();
  const splitBody = Buffer.from(JSON.stringify({ revision: fresh.revision, config: {}, persona: '猫娘中文人设' }));
  const splitAt = splitBody.indexOf(Buffer.from('猫')) + 1;
  const splitStatus = await new Promise((resolve, reject) => {
    const req = http.request(origin + '/api/save', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', 'x-hakimi-csrf': token } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(splitBody.subarray(0, splitAt)); setTimeout(() => req.end(splitBody.subarray(splitAt)), 10);
  });
  assert.equal(splitStatus, 200); assert.equal(fs.readFileSync(path.join(root, 'persona.md'), 'utf8'), '猫娘中文人设');
  assert.equal((await post('control', { action: 'start' })).status, 200); assert.deepEqual(actions, ['Start']);
});

test('记忆查看只读，不续命/删除/迁移；私聊内容须明确选择且不与群记忆混显', () => {
  const root=fs.mkdtempSync(path.join(ROOT,'test-output','memory-view-'));
  fs.mkdirSync(path.join(root,'data'));
  let now=Date.parse('2026-11-18T12:00:00+08:00');
  const memoryOptions={enabled:true,storage:'sqlite',forgettingEnabled:true};
  const config={allowedGroups:['666666'],ownerQQ:'555555',memory:{...new MemoryStore('',{enabled:false}).options,...memoryOptions}};
  assert.equal(memoryView(root,config,{now}).records.length,0);
  assert.equal(fs.existsSync(path.join(root,'data/memory/memories.sqlite')),false);
  const group=new MemoryStore(path.join(root,'data/memory.json'),config.memory,'555555',{clock:()=>now});
  const priv=new MemoryStore(path.join(root,'data/private-memory.json'),config.memory,'555555',{clock:()=>now});
  try{
    group.observe({group:'666666',user:'444444',name:'群友',text:'我喜欢红茶'});
    group.addManual('666666','555555','群活动每周六');
    priv.observe({group:'555555',user:'555555',name:'管理员',text:'我喜欢私聊奶糖'});
    const file=group.database.file, before=fs.readFileSync(file);
    const summary=memoryView(root,config,{now});assert.equal(summary.records.length,0);assert.equal(summary.scopes[0].people,2);
    assert.deepEqual(summary.groupUsage,{people:2,records:2});
    assert.doesNotMatch(JSON.stringify(summary),/私聊奶糖|红茶/);
    const publicView=memoryView(root,config,{scope:'group/666666',now});assert.match(JSON.stringify(publicView.records),/红茶/);assert.doesNotMatch(JSON.stringify(publicView),/私聊奶糖/);
    const privateView=memoryView(root,config,{scope:'private/555555',now});assert.match(JSON.stringify(privateView.records),/私聊奶糖/);assert.doesNotMatch(JSON.stringify(privateView.records),/红茶/);
    now+=8*86400000;
    const expired=memoryView(root,config,{scope:'group/666666',now});
    assert.equal(expired.records.find(r=>r.kind==='preference').active,false);assert.equal(expired.records.find(r=>r.kind==='manual').expiresAt,null);
    assert.equal(expired.scopes[0].pendingExpired,1);assert.deepEqual(fs.readFileSync(file),before);
    assert.equal(fs.existsSync(path.join(root,'data/memory.json')),false);
    assert.throws(()=>memoryView(root,config,{scope:'group/777777',now}));
  }finally{group.close();priv.close();}
});

test('网页控制绑定进程实例，拒绝错PID、未知动作，仅执行一次且不发送QQ消息', () => {
  const root = fs.mkdtempSync(path.join(ROOT, 'test-output', 'ui-life-')); let calls = 0;
  const life = new Lifecycle(root, { pid: 123, startedAt: 'test-instance', state: () => ({}), stop: () => {}, control: () => calls++, intervalMs: 999999 });
  try {
    const request = { id: 'a'.repeat(32), pid: 999, startedAt: 'test-instance', action: 'pause' };
    const write = () => fs.writeFileSync(life.uiRequest, JSON.stringify(request));
    write(); life.poll(); assert.equal(calls, 0);
    request.pid=123; request.action='execute'; write(); life.poll(); assert.equal(calls, 0);
    request.action='pause'; write(); life.poll(); assert.equal(calls, 1); life.poll(); assert.equal(calls, 1);
    assert.equal(JSON.parse(fs.readFileSync(life.uiResult)).success, true);
  } finally { life.close(); }
});
