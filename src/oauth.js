import {createId} from './id.js';
export * as bedrockApi from '@earendil-works/pi-ai/api/bedrock-converse-stream';
export {createOAuthUI} from './oauth-ui.js';
import {anthropicProvider} from '@earendil-works/pi-ai/providers/anthropic';
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex';
import {githubCopilotProvider} from '@earendil-works/pi-ai/providers/github-copilot';
import {kimiCodingProvider} from '@earendil-works/pi-ai/providers/kimi-coding';
import {metaProvider} from '@earendil-works/pi-ai/providers/meta';
import {xaiProvider} from '@earendil-works/pi-ai/providers/xai';
import {nativeCatalog} from '#native-catalog';

// Pi's CredentialStore contract serializes refresh-token rotation across tabs.
export function browserCredentials(key) {
  const read=()=>JSON.parse(localStorage.getItem(key)||'{}');
  const modify=(id,fn,options)=>navigator.locks.request(`${key}:${id}`,{signal:options?.signal},async()=>{
    const next=await fn(read()[id]);
    if(next!==undefined){const data=read();data[id]=next;localStorage.setItem(key,JSON.stringify(data));}
    return next===undefined?read()[id]:next;
  });
  return {
    read:async id=>read()[id],
    list:async()=>Object.entries(read()).map(([providerId,value])=>({providerId,type:value.type})),
    modify,
    delete:(id,options)=>navigator.locks.request(`${key}:${id}`,{signal:options?.signal},()=>{const data=read();delete data[id];localStorage.setItem(key,JSON.stringify(data));}),
  };
}

export function installOAuth(models, catalog) {
  const credentials=browserCredentials('pi-tab-oauth');
  for(const model of catalog)if(nativeCatalog[model.provider])nativeCatalog[model.provider][model.id]=model;
  const providers=[anthropicProvider(),openaiCodexProvider(),githubCopilotProvider(),kimiCodingProvider(),metaProvider(),xaiProvider()];
  for(const provider of providers){
    // Browser WebSocket cannot supply the provider's authorization headers.
    const {stream,streamSimple}=provider;
    models.setProvider({...provider,
      stream:(model,context,options)=>stream(model,context,{...options,transport:'sse'}),
      streamSimple:(model,context,options)=>streamSimple(model,context,{...options,transport:'sse'}),
    });
  }
  const sessions=new Map();
  const action = async (action,input={}) => {
    if(action==='list')return Promise.all(providers.filter(p=>!input.api||p.getModels().some(m=>m.api===input.api)).map(async p=>({id:p.id,name:p.auth.oauth.name,connected:(await credentials.read(p.id))?.type==='oauth'})));
    if(action==='start'){
      if(!navigator.locks)throw new Error('登录需要 HTTPS 网页。');
      const provider=providers.find(p=>p.id===input.providerId);
      if(!provider || input.api && !provider.getModels().some(m=>m.api===input.api))throw new Error('请选择支持浏览器登录的提供商。');
      const id=createId(),controller=new AbortController();
      const session={state:'pending',events:[],prompt:null,controller};sessions.set(id,session);
      const timer=setTimeout(()=>controller.abort(),900000);timer.unref?.();
      void models.login(provider.id,'oauth',{
        signal:controller.signal,
        notify:event=>session.events.push(event),
        prompt:prompt=>{
          // These are Pi's existing non-loopback flows, not replacement OAuth protocols.
          if(prompt.type==='select'&&provider.id==='anthropic')return Promise.resolve('copy_code');
          return new Promise((resolve,reject)=>{
            const {signal,...display}=prompt,promptId=createId();
            const cancel=()=>{cleanup();session.prompt=null;reject(new Error('登录已取消。'));};
            const cleanup=()=>{controller.signal.removeEventListener('abort',cancel);signal?.removeEventListener('abort',cancel);};
            session.prompt={...display,id:promptId};session.answer=value=>{cleanup();session.prompt=null;resolve(value);};
            controller.signal.addEventListener('abort',cancel,{once:true});signal?.addEventListener('abort',cancel,{once:true});
            if(controller.signal.aborted||signal?.aborted)cancel();
          });
        },
      },{agentName:'Pi Tab'}).then(()=>{session.state='done';},error=>{session.state='error';session.error=error.message;}).finally(()=>{clearTimeout(timer);session.prompt=null;setTimeout(()=>sessions.delete(id),60000).unref?.();});
      return {id};
    }
    if(action==='logout'){await models.logout(input.providerId);return {};}
    if(action==='models')return (await models.getAvailable(input.providerId)).filter(m=>!input.api||m.api===input.api);
    const session=sessions.get(input.id);
    if(!session)throw new Error('登录已结束，请重新开始。');
    if(action==='cancel'){session.controller.abort();return {};}
    if(action==='answer'){
      if(input.promptId!==session.prompt?.id||typeof input.value!=='string')throw new Error('登录步骤已更新，请重试。');
      session.answer(input.value);return {};
    }
    if(action==='status')return {state:session.state,events:session.events,prompt:session.prompt,error:session.error};
    throw new Error('未知登录操作。');
  };
  return {action,credentials};
}
