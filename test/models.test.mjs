import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelCatalog } from '../src/model-catalog.mjs';
import { Relay } from '../src/relay.mjs';

const budget=()=>({reserve(){},recordUsage(){}});
const llm={model:'first',fallbackModel:'second',lastResortModel:'third',primaryFailureCooldownMs:300000,baseUrl:'https://relay.test/v1',maxTokens:128,timeoutMs:1000,reasoningEffort:'low'};
const response=(text='在线',model)=>new Response(JSON.stringify({model,choices:[{message:{content:text}}]}),{status:200});

test('三档按优先级降级，每档只试一次；冷却期间跳过失败档，高档恢复再优先',async()=>{
  const calls=[];let healthy='third',fallbacks=0;
  const relay=new Relay(llm,'fake',budget(),{fetchImpl:async(url,options)=>{
    const model=JSON.parse(options.body).model;calls.push(model);
    return model===healthy?response('在线',model):new Response('{}',{status:503});
  }});
  await relay.generate([{role:'user',content:'test'}],undefined,{onFallbackAttempt:()=>{fallbacks++;return true;}});
  assert.deepEqual(calls,['first','second','third']);assert.equal(fallbacks,2);
  assert.equal(relay.status().lastSuccessfulModel,'third');assert.equal(relay.status().reportedModel,'third');
  assert.equal(relay.status().nextModel,'third');assert.equal(relay.status().activeModel,'');
  await relay.generate([]);assert.deepEqual(calls,['first','second','third','third']);
  healthy='second';relay.modelCooldowns.set('second',0);relay.children.get('second').blockedUntil=0;
  await relay.generate([]);assert.equal(calls.at(-1),'second');assert.equal(relay.status().lastSuccessfulModel,'second');
  healthy='first';relay.primaryFallbackUntil=0;relay.children.get('first').blockedUntil=0;
  await relay.generate([]);assert.equal(calls.at(-1),'first');assert.equal(relay.status().lastSuccessfulModel,'first');
});

test('进行中的请求与最近成功分开：失败尝试不伪装为成功，不记录正文/凭据',async()=>{
  let finish;
  const relay=new Relay({...llm,fallbackModel:'',lastResortModel:''},'private-key',budget(),{fetchImpl:()=>new Promise(resolve=>{finish=resolve;})});
  const waiting=relay.generate([{role:'user',content:'private-message'}]);
  assert.equal(relay.status().activeModel,'first');assert.equal(relay.status().lastSuccessfulModel,'');
  finish(response('secret-answer','reported-id'));await waiting;
  assert.equal(relay.status().activeModel,'');assert.equal(relay.status().lastSuccessfulModel,'first');
  assert.equal(relay.status().reportedModel,'reported-id');
  relay.fetchImpl=async()=>new Response('{}',{status:404});
  await assert.rejects(()=>relay.generate([]));
  assert.equal(relay.status().lastSuccessfulModel,'first');assert.equal(relay.status().lastError.status,404);
  assert.doesNotMatch(JSON.stringify(relay.status()),/private-key|private-message|secret-answer/);
});

test('三档全失败仅三次，全部冷却不重刷；钥匙/余额失败及降级限速拒绝不继续',async()=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;return new Response('{}',{status:503});};
  const relay=new Relay(llm,'fake',budget(),{fetchImpl});
  await assert.rejects(()=>relay.generate([]));assert.equal(calls,3);assert.equal(relay.status().lastSuccessfulModel,'');
  await assert.rejects(()=>relay.generate([]),e=>e.kind==='cooldown');assert.equal(calls,3);
  for(const status of [401,402]){
    let count=0;const r=new Relay(llm,'fake',budget(),{fetchImpl:async()=>{count++;return new Response('{}',{status});}});
    await assert.rejects(()=>r.generate([]));assert.equal(count,1);
  }
  const denied=new Relay(llm,'fake',budget(),{fetchImpl});const before=calls;
  await assert.rejects(()=>denied.generate([],undefined,{onFallbackAttempt:()=>false}));assert.equal(calls,before+1);
});

test('模型目录只读取models，不发生成请求；去重过滤、缓存、Key变化与强制刷新',async()=>{
  let calls=0,now=1000;
  const catalog=new ModelCatalog({clock:()=>now,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'https://relay.test/v1/models');assert.match(options.headers.authorization,/^Bearer /);assert.equal(options.redirect,'error');
    return new Response(JSON.stringify({data:[{id:'model-b'},{id:'model-a'},{id:'model-a'},{id:'bad model'},{id:'sk-secret-secret'}]}));
  }});
  const first=await catalog.get(llm.baseUrl,'key-a');assert.deepEqual(first.ids,['model-a','model-b']);
  assert.equal((await catalog.get(llm.baseUrl,'key-a')).cached,true);assert.equal(calls,1);
  await catalog.get(llm.baseUrl,'key-b');assert.equal(calls,2);
  await catalog.get(llm.baseUrl,'key-b',{refresh:true});assert.equal(calls,3);
  now+=300001;await catalog.get(llm.baseUrl,'key-b');assert.equal(calls,4);
  assert.doesNotMatch(JSON.stringify(first),/key-a|authorization|sk-secret/);
});

test('目录拒绝地址注入、重定向/错误和异常数据，失败不泄露上游正文或Key',async()=>{
  const catalog=new ModelCatalog({fetchImpl:async()=>new Response('secret-body',{status:403})});
  await assert.rejects(()=>catalog.get('https://evil:password@relay.test/v1','fake'));
  await assert.rejects(()=>catalog.get(llm.baseUrl,''));
  await assert.rejects(()=>catalog.get(llm.baseUrl,'fake'),e=>/403/.test(e.message)&&!/secret-body|fake/.test(e.message));
  const malformed=new ModelCatalog({fetchImpl:async()=>new Response(JSON.stringify({data:[{id:'<script>'}]}))});
  await assert.rejects(()=>malformed.get(llm.baseUrl,'fake'),/格式不兼容或为空/);
});
