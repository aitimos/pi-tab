// One durable Pi runtime owns each site's conversations. Page scripts only render
// the UI and execute page tools, so a navigation cannot close an active run.
const engines = new Map();
const pageToolNames = new Set(['page_snapshot', 'inspect_dom', 'js_eval', 'click', 'set_value', 'get_console', 'get_network']);

async function engineFor(site) {
  if (!engines.has(site)) engines.set(site, (async () => {
    const pi = PiConsolePlugin.install({
      globalName: `__pi_site_${btoa(site).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')}`,
      storageName: `pi-tab-site-${site}`,
      deferResume: true,
      log: false,
      pageContext: () => null,
    });
    await pi.ready;
    const targets = new Map();
    const bindTarget=(id,tabId)=>{if(!pi.busyFor(id)||!targets.has(id))targets.set(id,tabId);};
    const shared = await chrome.runtime.sendMessage({type:'shared-config',operation:'get'});
    if(!shared?.ok)throw new Error(shared?.error||'无法读取模型设置。');
    const saved = shared.value;
    pi.importProfiles(saved.profiles || []);
    pi.importProviders(saved.providers || []);
    if (!pi.config && saved.profiles?.length) await pi.configure({ ...saved.profiles[0], profileId:saved.profiles[0].id });

    for (const tool of pi.tools().filter(item => pageToolNames.has(item.name))) {
      pi.unregisterTool(tool.name);
      pi.registerTool({ ...tool, replay: ['page_snapshot', 'inspect_dom', 'get_console', 'get_network'].includes(tool.name) ? 'safe' : 'unsafe',
        execute: async (args, api) => {
          const tabId = targets.get(api.conversationId);
          if (!tabId) throw new Error('请先在网页中打开这个 agent，再操作页面。');
          const response = await chrome.runtime.sendMessage({ type:'page-tool', site, tabId, name:tool.name, args });
          if (!response?.ok) throw new Error(response?.error || '网页工具没有响应。');
          return response.value;
        },
      });
    }
    pi.registerTool({ name:'tab_list', description:'列出已启用 Pi Tab 的标签页及其 agent。', replay:'safe', parameters:pi.Type.Object({}),
      execute: async () => (await chrome.runtime.sendMessage({ type:'tabs-list' })).value.tabs });
    pi.registerTool({ name:'tab_open', description:'打开新标签页并启动 Pi Tab。', parameters:pi.Type.Object({url:pi.Type.String()}),
      execute: async ({url}) => (await chrome.runtime.sendMessage({type:'tabs-open',url})).value });
    pi.registerTool({ name:'tab_send', description:'向另一标签页的 agent 发送任务。先用 tab_list 查找。', parameters:pi.Type.Object({tabId:pi.Type.Integer(),chatId:pi.Type.Integer(),message:pi.Type.String()}),
      execute: async ({tabId,chatId,message},api) => {
        const response=await chrome.runtime.sendMessage({type:'tabs-send',tabId,chatId,text:message,fromChatId:api.conversationId});
        if(!response?.ok)throw new Error(response?.error||'目标 agent 没有响应。');
        return response.value;
      } });
    pi.registerTool({ name:'tab_read', description:'读取另一标签页中 agent 的最近消息。', replay:'safe', parameters:pi.Type.Object({tabId:pi.Type.Integer(),chatId:pi.Type.Integer(),limit:pi.Type.Optional(pi.Type.Integer({minimum:1,maximum:30}))}),
      execute: async ({tabId,chatId,limit=10}) => {
        const response=await chrome.runtime.sendMessage({type:'tabs-read',tabId,chatId,limit});
        if(!response?.ok)throw new Error(response?.error||'目标 agent 没有响应。');
        return response.value;
      } });
    pi.onEvent(event => {
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
  if (message.type === 'shared-config-updated') {
    for(const engine of engines.values())void engine.then(({pi})=>{
      pi.importProfiles(message.profiles);
      pi.importProviders(message.providers);
    });
    respond({ok:true});
    return false;
  }
  if (message.target !== 'engine') return false;
  (async () => {
    const {pi,targets,bindTarget} = await engineFor(message.site);
    const {method,chatId,args=[],tabId} = message;
    if (method === 'initialize') {
      bindTarget(pi.conversation.id, tabId);
      return {activeId:pi.conversation.id,config:pi.config,defaultPrompt:pi.defaultPrompt,
        chats:(await pi.listChats()).map(chat=>({...chat,busy:pi.busyFor(chat.id),config:pi.configFor(chat.id)}))};
    }
    if (method === 'bind') { bindTarget(chatId,tabId); return {config:pi.configFor(chatId),busy:pi.busyFor(chatId)}; }
    if (method === 'createChat') { const id=await pi.createChat({inheritFrom:args[0],activate:true}); targets.set(id,tabId); return id; }
    if (method === 'selectChat') { await pi.selectChat(chatId); bindTarget(chatId,tabId); return {config:pi.configFor(chatId),busy:pi.busyFor(chatId)}; }
    if (method === 'listChats') return (await pi.listChats()).map(chat=>({...chat,busy:pi.busyFor(chat.id),config:pi.configFor(chat.id)}));
    if (method === 'agent') {
      if (['prompt','steer','followUp'].includes(message.name)) bindTarget(chatId,tabId);
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
      if (['prompt','steer','followUp'].includes(message.name)) return agent[message.name](args[0]);
      throw new Error('未知 agent 操作。');
    }
    if (method === 'getPreferences') return pi.getPreferences();
    if (method === 'setPreferences') return pi.setPreferences(args[0]);
    if (method === 'listModels') return pi.listModels();
    if (method === 'listProviders') return pi.listProviders();
    if (method === 'saveProvider') return pi.saveProvider(args[0]);
    if (method === 'receiveFromTab') return pi.receiveFromTab(chatId,args[0],args[1]);
    if (method === 'readAgent') {
      const history=await pi.agent(chatId).history();
      return history.entries.slice(-(args[0]||10)).map(entry=>({kind:entry.kind,text:entry.model?.map(item=>typeof item.content==='string'?item.content:item.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')).filter(Boolean).join('\n')}));
    }
    throw new Error('未知引擎操作。');
  })().then(value=>respond({ok:true,value}),error=>respond({ok:false,error:error.message||String(error)}));
  return true;
});
