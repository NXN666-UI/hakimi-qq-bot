let snapshot, working = false;
const $ = id => document.getElementById(id);
const modelFields = [['llm.baseUrl','API 地址'],['llm.model','首选模型','model'],['llm.fallbackModel','次选模型（留空关闭）','model'],['llm.lastResortModel','保底模型（留空关闭）','model'],['llm.reasoningEffort','思考强度','select'],['llm.maxTokens','输出 token 上限','number'],['llm.timeoutMs','请求超时（秒）','number',1000],['llm.primaryFailureCooldownMs','主模型故障后回试间隔（分钟）','number',60000]];
const chatFields = [['chat.followupMs','固定续聊窗口（分钟）','number',60000],['chat.maxReplyChars','单条正文字数上限','number'],['chat.mergeMs','连发合并等待（秒）','number',1000],['chat.cooldownMs','同群回复间隔（秒）','number',1000],['chat.spontaneousProbability','普通话题主动候选（%）','number',0.01],['chat.interestProbability','LOL话题主动候选（%）','number',0.01],['chat.spontaneousCooldownMs','主动候选冷却（分钟）','number',60000],['chat.maxSpontaneousDaily','主动候选每日次数（进程内）','number'],['media.stickerProbability','配表情概率（%）','number',0.01],['media.stickerCooldownMs','表情冷却（秒）','number',1000]];
chatFields.splice(2,0,['chat.maxContextChars','每轮聊天与记忆字符预算','number'],['chat.contextMessages','最近消息最多条数','number'],['memory.maxInjectChars','相关印象最多字符','number']);
const switches = [['chat.quoteReplies','允许引用消息'],['chat.allowMentions','允许真正 @'],['chat.ownerPrivateChat','主人私聊'],['media.enabled','图片理解'],['media.autoViewImages','低频主动看图'],['media.stickersEnabled','现成表情包'],['search.enabled','按需联网']];
function notice(text, error=false){$('notice').textContent=text;$('notice').style.display='block';$('notice').classList.toggle('error',error);}
async function api(route, body){const r=await fetch('/api/'+route,{cache:'no-store',...(body?{method:'POST',headers:{'content-type':'application/json','x-hakimi-csrf':document.body.dataset.csrf},body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw Error(data.error||'操作失败');return data;}
let modelIds=[], modelsLoading=false;
function syncModelPresets(){for(const select of document.querySelectorAll('[data-model-preset]')){const input=document.querySelector('[data-key="'+select.dataset.modelPreset+'"]');select.value=[...select.options].some(o=>o.value===input.value)?input.value:'custom';}}
function fields(target, rows){
  for(const [key,label,type='text',scale=1] of rows){
    const el=document.createElement('label');el.textContent=label;
    const input=document.createElement(type==='select'?'select':'input');input.dataset.key=key;input.dataset.scale=scale;
    if(type==='model'){
      const select=document.createElement('select');select.dataset.modelPreset=key;select.setAttribute('aria-label',label+'快捷选择');
      const choices=[...(key!=='llm.model'?[['','不启用此档']]:[]),...modelIds.map(id=>[id,id]),['custom','其他模型 · 手动输入']];
      for(const[value,text]of choices){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}
      input.type='text';input.setAttribute('aria-label',label);input.placeholder='模型完整ID，也可手动修改';
      input.addEventListener('input',syncModelPresets);
      select.onchange=()=>{if(select.value==='custom'){input.focus();return;}input.value=select.value;
        const fallback=document.querySelector('[data-key="llm.fallbackModel"]');
        if(key==='llm.model'&&fallback.value===input.value){fallback.value='';notice('首选与备用相同，已在页面中关闭备用。点击“保存并重启”后生效');}else notice('已在页面中选择模型，点击“保存并重启”后生效');syncModelPresets();};
      el.append(select);
    }else if(type==='select'){
      for(const value of ['low','medium','high']){const o=document.createElement('option');o.value=value;o.textContent=value;input.append(o);}
    }else{input.type=type;if(type==='number'){input.min=0;input.step='any';input.required=true;}}
    el.append(input);$(target).append(el);
  }
}
fields('model-fields',modelFields);fields('chat-fields',chatFields);for(const[key,label]of switches){const el=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.dataset.key=key;el.append(input,document.createTextNode(label));$('switch-fields').append(el);}
function get(object,key){return key.split('.').reduce((o,k)=>o?.[k],object);}
function set(object,key,value){const[a,b]=key.split('.');object[a]??={};object[a][b]=value;}
async function load(){snapshot=await api('settings');for(const input of document.querySelectorAll('[data-key]')){const v=get(snapshot.config,input.dataset.key)??({'llm.primaryFailureCooldownMs':300000,'chat.interestProbability':snapshot.config.chat.spontaneousProbability}[input.dataset.key]);if(input.type==='checkbox')input.checked=!!v;else input.value=v==null?'':typeof v==='number'?Number((v/Number(input.dataset.scale||1)).toFixed(4)):v;}populateModelOptions();$('persona-text').value=snapshot.persona;$('groups-text').value=snapshot.config.allowedGroups.join('\n');$('aliases-text').value=snapshot.config.aliases.join('\n');$('api-key').value='';$('key-status').textContent=snapshot.apiKeyConfigured?'· 已配置，不回显':'· 尚未配置';void readModels(false);}
async function poll(){try{const s=await api('status');$('state').textContent=!s.running?'已关闭':s.state.paused?'已闭麦':s.state.connected?'在线':'等待QQ连接';$('pid').textContent=s.running?'PID '+s.state.pid:'界面可独立运行';renderModelState(s);const u=s.usage;if(u){const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const used=u.day===today?u.dailyRequests-(u.ownerDailyRequests||0)-(u.ordinaryDailyResetBaseline||0):0;$('usage').textContent=used+' / '+(snapshot?.config.limits.requestsPerDay||100);}$('log-text').textContent=s.logs||'暂无运行日志';$('poll').textContent='刚刚同步';}catch(e){$('poll').textContent='连接中断 · 请重新打开入口';}}
async function save(){if(!$('settings').reportValidity())throw Error('请完整填写数字设置');if(!snapshot)throw Error('请先读取配置');const config=structuredClone(snapshot.config);for(const input of document.querySelectorAll('[data-key]')){const value=input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value)*Number(input.dataset.scale||1):input.value.trim();set(config,input.dataset.key,value);}config.allowedGroups=$('groups-text').value.split(/[\n,，]/).map(x=>x.trim()).filter(Boolean);config.aliases=$('aliases-text').value.split(/[\n,，]/).map(x=>x.trim()).filter(Boolean);const result=await api('save',{config,persona:$('persona-text').value,apiKey:$('api-key').value,revision:snapshot.revision});await load();return result.message;}
async function task(fn){if(working)return;working=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);try{notice(await fn());await poll();}catch(e){notice(e.message,true);}finally{working=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
$('settings').addEventListener('submit',e=>{e.preventDefault();task(save);});$('reload').onclick=()=>{if(confirm('重新读取会丢弃页面尚未保存的修改，继续吗？'))task(async()=>{await load();return'已重新读取';});};$('save-restart').onclick=()=>task(async()=>{await save();const r=await api('control',{action:'restart'});return'已保存并重启\n'+r.message;});document.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>{if(['stop','restart','refresh'].includes(button.dataset.action)&&!confirm('确认执行“'+button.textContent+'”？'))return;task(async()=> (await api('control',{action:button.dataset.action})).message);});
load().then(poll).catch(e=>notice(e.message,true));setInterval(poll,3000);

let memoryData;
const memoryTime = value => value == null ? '不自动到期' : new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
function memoryCards(){
  if(!memoryData?.selected)return;
  const filter=$('memory-filter').value.trim().toLowerCase();
  const match=row=>!filter||[row.qq,row.name,row.text].some(v=>String(v).toLowerCase().includes(filter));
  for(const[target,rows]of [['memory-records',memoryData.records],['memory-snippets',memoryData.snippets]]){
    const container=$(target);container.replaceChildren();
    for(const row of rows.filter(match)){
      const card=document.createElement('article');card.className='memory-item'+(row.active?'':' expired');
      const title=document.createElement('strong');title.textContent=row.name+' · '+row.qq;
      const text=document.createElement('p');text.className='memory-text';text.textContent=row.text;
      const meta=document.createElement('small');
      const kind={name:'名字（旧记录）',preference:'喜好（旧记录）',event:'临时事项',manual:'手动备注',impression:'机器人的印象'}[row.kind]||'聊天短摘';
      const tier=['name','preference','impression'].includes(row.kind)?' · '+row.strength+'档':'';
      meta.textContent=kind+tier+' · '+(row.active?'有效':'已过期，等待清理')+' · '+(row.updatedAt?'更新 ':'记录 ')+memoryTime(row.updatedAt??row.time)+' · 到期 '+memoryTime(row.expiresAt);
      card.append(title,text,meta);container.append(card);
    }
    if(!container.children.length){const empty=document.createElement('p');empty.className='hint';empty.textContent=filter?'没有匹配的记录':'当前没有保存记录';container.append(empty);}
  }
}
async function readMemory(){
  const selected=$('memory-scope').value;
  memoryData=undefined;$('memory-records').replaceChildren();$('memory-snippets').replaceChildren();$('memory-summary').textContent='正在读取本范围…';
  memoryData=await api('memory'+(selected?'?scope='+encodeURIComponent(selected):''));
  const dropdown=$('memory-scope');dropdown.replaceChildren();
  for(const scope of memoryData.scopes){const option=document.createElement('option');option.value=scope.key;option.textContent=scope.label+' · '+scope.activeRecords+'条 / '+scope.people+'人';dropdown.append(option);}
  if(!selected&&memoryData.scopes.length){dropdown.value=memoryData.scopes[0].key;return readMemory();}
  dropdown.value=selected;
  const scope=memoryData.scopes.find(s=>s.key===selected);
  $('memory-summary').textContent=scope?scope.label+'：有效记忆 '+scope.activeRecords+' 条，涉及 '+scope.people+' 个QQ，待清理 '+scope.pendingExpired+' 条':'';
  const l=memoryData.limits;
  $('memory-limits').textContent=(l.mode==='impressions'?'自主印象表：所有群合计 '+memoryData.groupUsage.people+' / '+l.maxPeople+' 人，'+memoryData.groupUsage.records+' 条；每QQ跨群合计最多 '+l.perUser+' 条，私聊独立。':'共用条数池：每群 '+l.perGroup+' 条，每QQ '+l.perUser+' 条；没有独立人数配额。')+' 保留档位 '+l.forgettingDays.join(' / ')+' 天，手动备注不自动过期。数据库 '+(memoryData.bytes/1024).toFixed(1)+' KB / '+(l.bytes/1000000000).toFixed(0)+' GB。读取时间 '+memoryTime(memoryData.readAt);
  $('memory-handover-hint').textContent=l.mode==='impressions'?'自主印象模式不再逐条保存聊天短摘；已有短摘最多保留1天，之后清理。':'短摘独立限制8段、共600字符、保留1天，不计入事实卡条数';
  memoryCards();return '已读取记忆（只读）';
}
$('memory-read').onclick=()=>task(readMemory);
$('memory-scope').onchange=()=>task(readMemory);
$('memory-filter').oninput=memoryCards;
if(location.hash==='#memory')task(readMemory);


function populateModelOptions(){
  for(const select of document.querySelectorAll('[data-model-preset]')){
    const input=document.querySelector('[data-key="'+select.dataset.modelPreset+'"]'),current=input.value.trim();
    const choices=[...(select.dataset.modelPreset!=='llm.model'?[['','不启用此档']]:[]),...modelIds.map(id=>[id,id])];
    if(current&&!modelIds.includes(current))choices.unshift([current,current+'（当前配置，列表未确认）']);
    choices.push(['custom','其他模型 · 手动输入']);select.replaceChildren();
    for(const[value,label]of choices){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option);}
  }
  syncModelPresets();
}
async function readModels(refresh){
  if(modelsLoading||!snapshot)return;modelsLoading=true;$('models-refresh').disabled=true;$('models-status').textContent='正在读取已保存地址和Key对应的上游模型列表…';
  const revision=snapshot.revision;
  try{
    const result=await api('models',{refresh});
    if(snapshot.revision!==revision||result.revision!==revision){$('models-status').textContent='配置已变化，请再刷新上游模型列表';return;}
    modelIds=result.ids;populateModelOptions();
    $('models-status').textContent='读到 '+modelIds.length+' 个模型 · '+(result.cached?'5分钟内本地缓存':'刚从上游读取')+' · 列表表示Key可见范围，不保证每个模型当前可用。当前输入与选择已保留';
  }catch(e){$('models-status').textContent=e.message+'；当前配置和手填入口保留';}
  finally{modelsLoading=false;$('models-refresh').disabled=false;}
}
$('models-refresh').onclick=()=>readModels(true);
function renderModelState(status){
  const r=status.state?.relay;
  $('model-label').textContent=r?.activeModel?'正在请求的模型':'最近成功请求的模型';
  $('model-state').textContent=!status.running?'未运行':!r?'等待运行状态更新':r.activeModel||r.lastSuccessfulModel||'尚无成功请求';
  $('fallback-state').textContent='运行首选 '+(r?.primaryModel||snapshot?.config.llm.model||'—')+' · 次选 '+(r?.fallbackModel||(!status.running?snapshot?.config.llm.fallbackModel:'')||'未启用')+' · 保底 '+(r?.lastResortModel||(!status.running?snapshot?.config.llm.lastResortModel:'')||'未启用');
  $('recent-model').textContent=r?.lastSuccessfulModel?'最近成功 '+r.lastSuccessfulModel+' · '+new Date(r.lastSuccessAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+(r.reportedModel&&r.reportedModel!==r.lastSuccessfulModel?' · 中转响应标识 '+r.reportedModel:''):status.running?'本次启动后尚无成功记录':'';
  $('route-state').textContent=r?'下次预计 '+(r.nextModel||'全部通道冷却中')+(r.primaryFallbackUntil>Date.now()?' · 主通道冷却至 '+new Date(r.primaryFallbackUntil).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):''):'显示中转请求ID，无法验证中转背后的底层模型';
  const e=r?.lastError;$('model-error').textContent=e?'最近失败 '+e.model+' · '+(e.status?'HTTP '+e.status:{timeout:'等待超时',network:'连接失败',format:'响应格式异常',cancelled:'已取消',cooldown:'冷却中',storage:'本地记账失败'}[e.kind]||'本地异常'):'';
}
