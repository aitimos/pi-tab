import {createLinuxEnvironments} from './linux-env.js';
import {createLinuxTools} from './linux-tools.js';

// One durable Pi runtime owns each site's conversations. Page scripts only render
// the UI and execute page tools, so a navigation cannot close an active run.
const engines = new Map();
const pageToolNames = new Set(['page_snapshot', 'inspect_dom', 'js_eval', 'click', 'set_value', 'get_console', 'get_network']);

async function background(request) {
  const response = await chrome.runtime.sendMessage(request);
  if (!response?.ok) throw new Error(response?.error || '后台没有响应。');
  return response.value;
}

async function engineFor(site) {
  if (!engines.has(site)) engines.set(site, (async () => {
    const linux=createLinuxEnvironments(site);
    const pi = PiConsolePlugin.install({
      executionEnv:linux.get, nativeTools:createLinuxTools(),
      globalName: `__pi_site_${btoa(site).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')}`,
      storageName: `pi-tab-site-${site}`,
      deferResume: true,
      log: false,
      pageContext: () => null,
    });
    await pi.ready;
    const targets = new Map();
    // Viewing a conversation must not move its tools to another window's page.
    const bindTarget=(id,tabId,forTask=false)=>{if(!targets.has(id)||(forTask&&!pi.busyFor(id)))targets.set(id,tabId);};
    const saved = await background({type:'shared-config',operation:'get'});
    pi.replaceModelSettings({profiles:saved.profiles || [],providers:saved.providers || []});
    if (!pi.config && saved.profiles?.length) await pi.configure({ ...saved.profiles[0], profileId:saved.profiles[0].id });

    for (const tool of pi.tools().filter(item => pageToolNames.has(item.name))) {
      pi.unregisterTool(tool.name);
      pi.registerTool({ ...tool, replay: ['page_snapshot', 'inspect_dom', 'get_console', 'get_network'].includes(tool.name) ? 'safe' : 'unsafe',
        execute: async (args, api, context) => {
          const tabId = targets.get(api.conversationId);
          if (!tabId) throw new Error('请先在网页中打开这个 agent，再操作页面。');
          const signal = context.abortSignal;
          signal?.throwIfAborted();
          const requestId = PiConsolePlugin.createId();
          let cancel;
          try {
            return await Promise.race([
              background({type:'page-tool',site,tabId,requestId,name:tool.name,args}),
              new Promise((_,reject) => {
                cancel = () => {
                  void background({type:'cancel-page-tool',tabId,requestId}).catch(error=>console.error('[Pi Tab]',error));
                  reject(signal.reason || new Error('Page tool cancelled'));
                };
                signal?.addEventListener('abort',cancel,{once:true});
                if(signal?.aborted)cancel();
              }),
            ]);
          } finally { signal?.removeEventListener('abort',cancel); }
        },
      });
    }
    pi.registerTool({ name:'tab_list', description:'列出已启用 Pi Tab 的标签页及其 agent。', replay:'safe', parameters:pi.Type.Object({}),
      execute: async () => (await background({ type:'tabs-list' })).tabs });
    pi.registerTool({ name:'tab_open', description:'打开新标签页并创建独立 agent，返回 tabId 和 chatId；用 tab_send 向它发送任务。', parameters:pi.Type.Object({url:pi.Type.String()}),
      execute: async ({url},api) => background({type:'tabs-open',url,sourceSite:site,fromChatId:api.conversationId}) });
    pi.registerTool({ name:'tab_send', description:'向另一标签页的 agent 发送任务。先用 tab_list 查找。', parameters:pi.Type.Object({tabId:pi.Type.Integer(),chatId:pi.Type.Integer(),message:pi.Type.String()}),
      execute: async ({tabId,chatId,message},api) => {
        return background({type:'tabs-send',tabId,chatId,text:message,fromChatId:api.conversationId});
      } });
    pi.registerTool({ name:'tab_read', description:'读取另一标签页中 agent 的最近消息。', replay:'safe', parameters:pi.Type.Object({tabId:pi.Type.Integer(),chatId:pi.Type.Integer(),limit:pi.Type.Optional(pi.Type.Integer({minimum:1,maximum:30}))}),
      execute: async ({tabId,chatId,limit=10}) => {
        return background({type:'tabs-read',tabId,chatId,limit});
      } });
    pi.onEvent(event => {
      if(event.type==='chat_deleted'||event.type==='chat_reset')linux.delete(event.conversationId);
      if(event.type==='disposed')linux.dispose();
      if (event.type === 'chat_created' && targets.has(event.conversationId)) {
        targets.set(event.chatId, targets.get(event.conversationId));
      }
      if (event.type === 'config_saved') {
        void chrome.runtime.sendMessage({type:'shared-config',operation:'profile-save',profile:event.profile}).catch(()=>{});
      }
      if (event.type === 'provider_saved') {
        void chrome.runtime.sendMessage({type:'shared-config',operation:'provider-save',provider:event.provider}).catch(()=>{});
      }
      void chrome.runtime.sendMessage({type:'engine-event',site,event}).catch(() => {});
    });
    pi.resume();
    return {pi,targets,bindTarget};
  })());
  return engines.get(site);
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === 'tab-closed') {
    Promise.all([...engines.values()].map(async engine => {
      const {pi,targets} = await engine;
      const owned = [...targets].filter(([,tabId])=>tabId===message.tabId).map(([id])=>id);
      for(const id of owned)targets.delete(id);
      await Promise.all(owned.map(id=>pi.agent(id).abort()));
    })).then(()=>respond({ok:true}),error=>respond({ok:false,error:error.message}));
    return true;
  }
  if (message.type === 'shared-config-updated') {
    Promise.all([...engines.values()].map(async engine=>{
      const {pi}=await engine;
      pi.replaceModelSettings({profiles:message.profiles,providers:message.providers});
    })).then(()=>respond({ok:true}),error=>respond({ok:false,error:error.message}));
    return true;
  }
  if (message.target !== 'engine') return false;
  (async () => {
    const {pi,targets,bindTarget} = await engineFor(message.site);
    const {method,chatId,args=[],tabId} = message;
    if (method === 'initialize') {
      const activeId=[...targets].find(([,target])=>target===tabId)?.[0]??pi.conversation.id;
      bindTarget(activeId, tabId);
      return {activeId,config:pi.configFor(activeId),defaultPrompt:pi.defaultPrompt,
        chats:(await pi.listChats()).map(chat=>({...chat,busy:pi.busyFor(chat.id),config:pi.configFor(chat.id)}))};
    }
    if (method === 'bind') { bindTarget(chatId,tabId); return {config:pi.configFor(chatId),busy:pi.busyFor(chatId)}; }
    if (method === 'createChat') { const id=await pi.createChat({inheritFrom:args[0],activate:true}); targets.set(id,tabId); return id; }
    if (method === 'selectChat') { await pi.selectChat(chatId); bindTarget(chatId,tabId); return {config:pi.configFor(chatId),busy:pi.busyFor(chatId)}; }
    if (method === 'listChats') return (await pi.listChats()).map(chat=>({...chat,busy:pi.busyFor(chat.id),config:pi.configFor(chat.id)}));
    if (method === 'deleteChat') {
      const result = await pi.deleteChat(args[0]);
      targets.delete(args[0]);
      return result;
    }
    if (method === 'agent') {
      if (['prompt','steer','followUp'].includes(message.name)) bindTarget(chatId,tabId,true);
      const agent=pi.agent(chatId);
      if (message.name === 'discoverModels') return agent.discoverModels(args[0]);
      if (message.name === 'savedConfig') return agent.savedConfig();
      if (message.name === 'history') return agent.history();
      if (message.name === 'queuedMessages') return agent.queuedMessages();
      if (message.name === 'changeQueuedMessage') return agent.changeQueuedMessage(...args);
      if (message.name === 'configure') return agent.configure(args[0]);
      if (message.name === 'selectModel') return agent.selectModel(args[0]);
      if (message.name === 'sendToAgent') return agent.sendToAgent(...args);
      if (message.name === 'abort') return agent.abort();
      if (message.name === 'reset') return agent.reset();
      if (message.name === 'runTool') return agent.runTool(...args);
      if (['prompt','steer','followUp'].includes(message.name)) return agent[message.name](args[0]);
      throw new Error('未知 agent 操作。');
    }
    if(method==='manageModels'){
      const busy=(await Promise.all([...engines.values()].map(async engine=>(await engine).pi.modelUsage()))).flat();
      await pi.manageModels(args[0],busy);
      await background({type:'shared-config',operation:'replace',profiles:await pi.savedProfiles(),providers:await pi.listProviders()});
      return true;
    }
    if (method === 'auth') return pi.auth(...args);
    if (method === 'getPreferences') return pi.getPreferences();
    if (method === 'setPreferences') return pi.setPreferences(args[0]);
    if (method === 'listModels') return pi.listModels();
    if (method === 'listProviders') return pi.listProviders();
    if (method === 'saveProvider') return pi.saveProvider(args[0]);
    if (method === 'receiveFromTab') { bindTarget(chatId,tabId,true); return pi.receiveFromTab(chatId,args[0],args[1]); }
    if (method === 'readAgent') {
      const history=await pi.agent(chatId).history();
      return history.entries.slice(-(args[0]||10)).map(entry=>({kind:entry.kind,text:entry.model?.map(item=>typeof item.content==='string'?item.content:item.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')).filter(Boolean).join('\n')}));
    }
    throw new Error('未知引擎操作。');
  })().then(value=>respond({ok:true,value}),error=>respond({ok:false,error:error.message||String(error)}));
  return true;
});
