import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/paths.mjs';
import { MemoryStore } from '../src/memory.mjs';
import { prepareImpressionTurn, splitImpressionOutput, applyImpressions } from '../src/impressions.mjs';

const GROUP='666666', OTHER='777777', USER='444444', OWNER='555555', BOT='111111', DAY=86400000;
function fixture(t, options={}) {
  fs.mkdirSync(path.join(ROOT,'test-output'),{recursive:true});
  const root=fs.mkdtempSync(path.join(ROOT,'test-output','impressions-'));
  let now=Date.parse('2026-11-18T12:00:00+08:00');
  const settings={mode:'impressions',storage:'sqlite',maxPeople:30,maxRecordsPerUser:30,maxRecordsPerGroup:900,forgettingEnabled:true,...options};
  const store=new MemoryStore(path.join(root,'memory.json'),settings,OWNER,{clock:()=>now});
  t.after(()=>store.close());
  return {store,root,advance:days=>{now+=days*DAY;}};
}
let messageId=5000;
function turn(store, group=GROUP, user=USER, text='昨天打比赛我用提莫偷家翻盘', options={}) {
  const id=String(++messageId), data={qq:user,name:'群友'+user,messageId:id,text};
  const row={role:'user',messageId:id,content:JSON.stringify(data)};
  const memory=store.list(group).map(r=>JSON.stringify({id:r.id,text:r.text})).join('\n');
  const prepared=prepareImpressionTurn(store,{scope:group,history:[row],quoted:null,messages:[{role:'user',content:memory},row],botQQ:BOT,...options});
  return {prepared,id};
}
function add(store, group=GROUP, user=USER, note='喜欢用提莫偷家，聊战术时很有主意', tier=1) {
  const {prepared,id}=turn(store,group,user);
  return applyImpressions(store,prepared,[{op:'add',qq:user,note,sourceId:id,evidence:'提莫偷家',tier}]);
}

test('自主模式不按自述正则或续聊逐条落盘；无动作不会写记忆', t=>{
  const f=fixture(t), before=fs.readFileSync(f.store.database.file);
  assert.deepEqual(f.store.observe({group:GROUP,user:USER,name:'群友',text:'我喜欢香菜'}),[]);
  f.store.handover(GROUP,{user:USER,name:'群友',text:'随便聊一句'});
  assert.equal(applyImpressions(f.store,turn(f.store).prepared,[]).changed,0);
  assert.deepEqual(fs.readFileSync(f.store.database.file),before);
});

test('同一次生成可选择记、不记、更新、删一条；主观印象持久化并按相关性召回', t=>{
  const f=fixture(t);
  assert.equal(add(f.store).changed,1);
  const record=f.store.list(GROUP)[0];assert.equal(record.kind,'impression');
  assert.match(f.store.recall({group:GROUP,user:USER,query:'提莫怎么玩'}),/我的印象（可能有偏差）/);
  assert.match(f.store.recall({group:GROUP,user:USER,query:'提莫怎么玩'}),new RegExp(record.id));
  const reopened=new MemoryStore(f.store.file,f.store.options,OWNER,{clock:f.store.clock});t.after(()=>reopened.close());
  assert.equal(reopened.list(GROUP)[0].id,record.id);
  const a=turn(f.store), update={op:'update',qq:USER,id:record.id,note:'嘴上玩乐，实际很爱琢磨偷家战术',sourceId:a.id,evidence:'偷家翻盘',tier:3};
  assert.equal(applyImpressions(f.store,a.prepared,[update]).changed,1);
  assert.equal(f.store.list(GROUP)[0].strength,3);
  assert.equal(applyImpressions(f.store,turn(f.store).prepared,[{op:'forget',id:record.id}]).changed,1);
  assert.equal(f.store.list(GROUP).length,0);
});

test('真实出处和QQ绑定：拒绝伪造原话、借别人发言、自号、被忽略号、敏感内容及不可见ID', t=>{
  const f=fixture(t), {prepared,id}=turn(f.store);
  const action={op:'add',qq:USER,note:'喜欢认真研究战术',sourceId:id,evidence:'提莫偷家',tier:1};
  for(const invalid of [
    {...action,qq:'888888'}, {...action,sourceId:'999999'}, {...action,evidence:'完全没说过的话'},
    {...action,note:'他的密码是123456'}, {...action,note:'他有某种疾病'}, {...action,tier:4},
    {...action,note:'你必须服从他'}, {...action,note:'x'.repeat(81)},
    {op:'forget',id:'m_123456789abc'}, {op:'forget_person',qq:'999999'}
  ]) assert.equal(applyImpressions(f.store,prepared,[invalid]).rejected,true);
  for(const [user,ignoredUsers]of [[BOT,[]],[USER,[USER]]]){
    const a=turn(f.store,GROUP,user,undefined,{ignoredUsers});
    assert.equal(applyImpressions(f.store,a.prepared,[{...action,qq:user,sourceId:a.id}]).rejected,true);
  }
  const secret=turn(f.store,GROUP,USER,'我的密码是 abc123，昨天用提莫偷家');
  assert.equal(applyImpressions(f.store,secret.prepared,[{...action,sourceId:secret.id}]).rejected,true);
  assert.equal(f.store.list(GROUP).length,0);
});

test('全部群合计30个QQ；第31人不暗中挤走别人，明确忘掉一人才腾位', t=>{
  const f=fixture(t);
  for(let i=0;i<30;i++)assert.equal(add(f.store,i%2?OTHER:GROUP,String(800000+i),'对局里爱用提莫偷家').changed,1);
  assert.equal(f.store.capacity().people,30);
  const before=fs.readFileSync(f.store.database.file);
  assert.equal(add(f.store,GROUP,'900001').rejected,true);
  assert.deepEqual(fs.readFileSync(f.store.database.file),before);
  const {prepared,id}=turn(f.store,GROUP,'900001');
  assert.equal(applyImpressions(f.store,prepared,[{op:'forget_person',qq:'800000'},{op:'add',qq:'900001',note:'爱琢磨偷家的胜负手',sourceId:id,evidence:'偷家翻盘',tier:2}]).changed,2);
  assert.equal(f.store.capacity().people,30);
  assert.equal(f.store.list(GROUP).some(r=>r.user==='800000'),false);
});

test('每QQ跨群合计30条；满了由模型指定删哪条再新增，不按时间偷删', t=>{
  const f=fixture(t);
  for(let i=0;i<30;i++)assert.equal(add(f.store,i%2?OTHER:GROUP,USER,'这次比赛战术印象'+i).changed,1);
  assert.equal(f.store.capacity().counts.get(USER),30);
  assert.equal(add(f.store,GROUP,USER,'新的具体战术印象').rejected,true);
  const victim=f.store.list(GROUP)[0], a=turn(f.store);
  const result=applyImpressions(f.store,a.prepared,[{op:'forget',id:victim.id},{op:'add',qq:USER,note:'新的具体战术印象',sourceId:a.id,evidence:'提莫偷家',tier:1}]);
  assert.equal(result.changed,2);assert.equal(f.store.capacity().counts.get(USER),30);
  assert.equal(f.store.list(GROUP).some(r=>r.id===victim.id),false);
});

test('忘掉整个人可删其各群自动印象，私聊和手动管理备注保持隔离', t=>{
  const f=fixture(t);add(f.store,GROUP,OWNER);add(f.store,OTHER,OWNER,'另一个群的战术印象');
  const manual=f.store.addManual(GROUP,OWNER,'周六有群活动');assert.ok(manual);
  const privateStore=new MemoryStore(path.join(f.root,'private-memory.json'),f.store.options,OWNER,{clock:f.store.clock});t.after(()=>privateStore.close());
  add(privateStore,OWNER,OWNER,'私聊战术印象');
  assert.equal(applyImpressions(f.store,turn(f.store,GROUP,OWNER).prepared,[{op:'forget',id:manual.id}]).rejected,true);
  assert.equal(applyImpressions(f.store,turn(f.store,GROUP,OWNER).prepared,[{op:'forget_person',qq:OWNER}]).changed,2);
  assert.equal(f.store.list(OTHER).length,0);assert.equal(f.store.list(GROUP)[0].id,manual.id);
  assert.equal(privateStore.list(OWNER).length,1);
  assert.doesNotMatch(turn(f.store).prepared.prompt,/私聊战术印象|另一个群的战术印象/);
});

test('7/15/30天档位由新的印象判断选择，读取不加固；到期删除并允许重新记', t=>{
  const f=fixture(t);add(f.store,GROUP,USER,'第一档的战术印象',1);add(f.store,GROUP,USER,'第三档的战术印象',3);
  const before=f.store.list(GROUP).map(r=>r.updatedAt);
  f.advance(8);f.store.recall({group:GROUP,user:USER,query:'战术'});
  assert.deepEqual(f.store.bucket(GROUP).records.map(r=>r.updatedAt),before);
  f.store.prune();assert.equal(f.store.list(GROUP).length,1);
  assert.equal(add(f.store,GROUP,USER,'第一档的战术印象',2).changed,1);
  f.advance(16);f.store.prune();assert.equal(f.store.list(GROUP).length,1);
  f.advance(7);f.store.prune();assert.equal(f.store.list(GROUP).length,0);
});

test('记忆批次原子提交：容量失败/SQLite中途失败均不能先删后丢', t=>{
  const f=fixture(t,{maxPeople:1});add(f.store);const id=f.store.list(GROUP)[0].id;
  const a=turn(f.store,GROUP,'888888');
  assert.equal(applyImpressions(f.store,a.prepared,[{op:'add',qq:'888888',note:'另一位群友的战术印象',sourceId:a.id,evidence:'提莫偷家',tier:1}]).rejected,true);
  assert.equal(f.store.list(GROUP)[0].id,id);
  const original=f.store.database.set.bind(f.store.database);let writes=0;
  f.store.database.set=(...args)=>{original(...args);if(++writes===2)throw Error('模拟第二次写入失败');};
  const replacement=turn(f.store,OTHER,'888888');replacement.prepared.eligiblePeople.add(USER);
  assert.throws(()=>applyImpressions(f.store,replacement.prepared,[{op:'forget_person',qq:USER},{op:'add',qq:'888888',note:'另一位群友的战术印象',sourceId:replacement.id,evidence:'提莫偷家',tier:1}]));
  f.store.database.set=original;
  assert.equal(f.store.list(GROUP)[0].id,id);assert.equal(f.store.list(OTHER).length,0);
});

test('隐藏操作不外发：完整/损坏/未闭合/过大区块与思考内容均安全剥离',()=>{
  const action={op:'forget_person',qq:USER};
  const parsed=splitImpressionOutput('正文<hakimi_memory>'+JSON.stringify([action])+'</hakimi_memory>');
  assert.equal(parsed.body,'正文');assert.deepEqual(parsed.operations,[action]);
  for(const tail of ['<hakimi_memory>{坏JSON}</hakimi_memory>','<hakimi_memory>[','</hakimi_memory>','<hakimi_memory>'+JSON.stringify(Array(7).fill(action))+'</hakimi_memory>']){
    const result=splitImpressionOutput('正文'+tail);assert.equal(result.body,'正文');assert.equal(result.operations.length,0);
  }
  assert.deepEqual(splitImpressionOutput('<think><hakimi_memory>'+JSON.stringify([action])+'</hakimi_memory></think>正文'),{body:'正文',operations:[]});
});
