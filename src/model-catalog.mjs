import { createHash } from 'node:crypto';

export class ModelCatalog {
  constructor({ fetchImpl = fetch, clock = Date.now, ttlMs = 300000, timeoutMs = 15000 } = {}) {
    Object.assign(this, { fetchImpl, clock, ttlMs, timeoutMs });
  }
  async get(baseUrl, apiKey, { refresh = false } = {}) {
    const url = new URL(baseUrl);
    if (!(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)) || url.username || url.password || url.search || url.hash || !/\/v1\/?$/.test(url.pathname)) throw Error('已保存API地址无效，请先保存正确地址');
    if (!apiKey?.trim() || /[\r\n\0]/.test(apiKey)) throw Error('请先保存API密钥，再读取上游模型');
    const fingerprint=createHash('sha256').update(baseUrl+'\0'+apiKey).digest('hex');
    if (!refresh && this.cached?.fingerprint===fingerprint && this.clock()-this.cached.fetchedAt<this.ttlMs) return { ids:this.cached.ids, fetchedAt:this.cached.fetchedAt, cached:true };
    if (this.pending?.fingerprint===fingerprint) return this.pending.promise;
    const promise=this.fetchList(baseUrl,apiKey).then(result=>{
      this.cached={...result,fingerprint};return {...result,cached:false};
    });
    this.pending={fingerprint,promise};
    try{return await promise;}finally{if(this.pending?.promise===promise)this.pending=null;}
  }
  async fetchList(baseUrl, apiKey) {
    let response;
    try { response=await this.fetchImpl(baseUrl.replace(/\/$/,'')+'/models',{headers:{authorization:'Bearer '+apiKey,accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(this.timeoutMs)}); }
    catch {throw Error('上游模型列表连接失败或超时，可保留当前选择或手填模型ID');}
    if(!response.ok){await response.body?.cancel();throw Error(`上游模型列表读取失败（HTTP ${response.status}），请检查渠道权限或手填模型ID`);}
    let text='';
    try{
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{while(true){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576){await reader.cancel();throw Error();}chunks.push(value);}}finally{reader.releaseLock();}
      text=Buffer.concat(chunks).toString('utf8');
      const body=JSON.parse(text);
      if(!Array.isArray(body.data)||body.data.length>5000)throw Error();
      const ids=[...new Set(body.data.map(r=>r?.id).filter(id=>typeof id==='string'&&/^[\w./:@+-]{1,150}$/.test(id)&&!/^sk-/i.test(id)))].sort();
      if(!ids.length)throw Error();
      return {ids,fetchedAt:this.clock()};
    }catch{throw Error('上游模型列表格式不兼容或为空，可继续手填模型ID');}
  }
}
