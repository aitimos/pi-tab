import {continuationErrorMessage} from './continuation-errors.js';
import {conversationRef, refKey} from './conversation-ref.js';
import {HistoryIndex} from './history-index.js';
import {Continuations} from './continuations.js';
import {readMcpJson,mcpVariableReferences} from './mcp-config.js';
import {createLinuxEnvironments} from './linux-env.js';
import {createLinuxTools} from './linux-tools.js';

// One durable Pi runtime owns each site's conversations. Page scripts only render
// the UI and execute page tools, so a navigation cannot close an active run.
const engines = new Map();
let sharedMcpGate=false;
const pageToolNames = new Set(['page_snapshot', 'inspect_dom', 'js_eval', 'click', 'set_value', 'get_console', 'get_network']);

async function background(request) {
  const response = await chrome.runtime.sendMessage(request);
  if (!response?.ok) throw Object.assign(new Error(response?.error || '后台没有响应。'),{diagnostics:response?.diagnostics,code:response?.code});
  return response.value;
}

const eventSequences=new Map();
const emitRef = (ref, event) => { const key=refKey(ref),sequence=(eventSequences.get(key)||0)+1;eventSequences.set(key,sequence);void chrome.runtime.sendMessage({type:'engine-event', site:ref.ownerSite, ref, event:{...event,conversationId:ref.conversationId}, sequence, epoch:continuations.epoch, protocolVersion:1}).catch(()=>{}); };
const historyIndex = new HistoryIndex({
  readSource:site=>PiConsolePlugin.readSourceDirectory(site),
  activeSource:async site=>engines.has(site)?(await engines.get(site)).pi:null,
});
let rebuild;
const rebuildIndex = () => rebuild ??= historyIndex.rebuild().finally(()=>{rebuild=null;});
async function existing(ref) {
  if(!engines.has(ref.ownerSite)&&!(await PiConsolePlugin.readSourceDirectory(ref.ownerSite)).some(chat=>chat.id===ref.conversationId))throw Error('CONVERSATION_DELETED');
  const engine=await engineFor(ref.ownerSite);
  if (!(await engine.pi.listChats()).some(chat=>chat.id===ref.conversationId)) throw Error('CONVERSATION_DELETED');
  return engine;
}
function requireOwner(engine) { if(engine.recovery)throw Error('OWNER_RECOVERY_REQUIRED'); }
const continuations = new Continuations({
  validateTarget:target=>background({type:'validate-target',target}),
  exists:async ref=>{requireOwner(await existing(ref));},
  busy:async ref=>{
    const {pi}=await engineFor(ref.ownerSite);
    return pi.busyFor(ref.conversationId) || (await pi.agent(ref.conversationId).queuedMessages()).length>0;
  }, emit:emitRef,
});
async function sourceState(ref) {
  const engine=await existing(ref);
  const state=await continuations.state(ref);
  return {...state,title:(await engine.pi.listChats()).find(chat=>chat.id===ref.conversationId)?.title, config:engine.pi.configFor(ref.conversationId), recovery:engine.recovery};
}
async function protocol(message) {
  const {operation,ref,args=[],authorization={}}=message;
  if(operation==='list') {
    if(message.reset){if(rebuild)await rebuild;await historyIndex.reset();}
    if(!historyIndex.scanComplete||message.refresh)await rebuildIndex();
    return historyIndex.list(message);
  }
  if(!ref)throw Error('INVALID_CONVERSATION_REF');
  refKey(ref);
  const engine=await existing(ref), {pi}=engine, id=ref.conversationId;
  if(operation==='view')return sourceState(ref);
  if(operation==='recover')return continuations.serial(ref.ownerSite,async()=>{
    if(!engine.recovery || args[0]!==engine.recovery.version)throw Error('RECOVERY_VERSION_CHANGED');
    const retry=Boolean(engine.recovery.attempted);engine.recovery.attempted=true;
    await PiConsolePlugin.stopColdRuntime(pi,{retry});
    engine.recovery=null;pi.resume();emitRef(ref,{type:'recovery_complete'});
    return sourceState(ref);
  });
  if(operation==='agent'&&message.name==='savedConfig')return pi.configFor(id);
  if(operation==='agent'&&['history','queuedMessages','discoverModels'].includes(message.name))return pi.agent(id)[message.name](...args);
  requireOwner(engine);
  if(operation==='continue'){
    const binding=await continuations.bind(ref,message.expectedVersion,message.viewId,message.pageTarget);
    try{
      const snapshot=await continuations.tool(ref,target=>background({type:'page-tool',ref,target,requestId:PiConsolePlugin.createId(),name:'page_snapshot',args:{}}));
      if(continuations.version(ref).seq!==binding.version.seq)throw Error('BINDING_CONFLICT');
      continuations.row(ref).snapshot=snapshot;emitRef(ref,{type:'binding_ready'});return binding;
    }catch(error){continuations.invalidate(message.pageTarget.tabId);throw error;}
  }
  if(operation==='stop')return continuations.stop(ref,()=>pi.agent(id).abort());
  if(operation==='create')return continuations.serial(ref.ownerSite,async()=>{
    const created=await pi.createChat({inheritFrom:id,activate:false});
    const createdRef=conversationRef(ref.ownerSite,created);
    try{await historyIndex.reconcile(ref.ownerSite);return createdRef;}catch{return {...createdRef,directoryError:true};}
  });
  if(operation==='delete')return continuations.serial(ref.ownerSite,async()=>{
    if((await continuations.state(ref)).busy)throw Error('CONVERSATION_BUSY');
    const value=await pi.deleteChat(id);continuations.forget(ref);
    try { await historyIndex.reconcile(ref.ownerSite); }catch { throw Error('SOURCE_DELETED_INDEX_DIRTY'); }
    return {replacementRef:conversationRef(ref.ownerSite,value.replacementId)};
  });
  if(operation==='agent') {
    const agent=pi.agent(id), name=message.name;
    if(['prompt','steer','followUp','runTool','sendToAgent','reset','changeQueuedMessage'].includes(name)) {
      return continuations.submit(ref,authorization,message.clientRequestId,()=>agent[name](...args),{queue:name!=='prompt'});
    }
    if(!['history','queuedMessages','savedConfig','configure','selectModel','discoverModels'].includes(name))throw Error('UNKNOWN_AGENT_OPERATION');
    return agent[name](...args);
  }
  throw Error('UNKNOWN_CONTINUATION_OPERATION');
}

async function engineFor(site,{defaults=false}={}) {
  let createdPi,createdLinux;
  if (!engines.has(site)) engines.set(site, (async () => {
    const linux=createdLinux=createLinuxEnvironments(site);
    const pi = createdPi=PiConsolePlugin.install({
      executionEnv:linux.get, nativeTools:createLinuxTools(),
      globalName: `__pi_site_${btoa(site).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')}`,
      storageName: `pi-tab-site-${site}`,
      deferResume: true, sharedMcp:true,
      log: false,
      pageContext: id => {const row=continuations.row(conversationRef(site,id));return row.target?{url:row.target.url,title:'',snapshot:row.snapshot}:null;},
    });
    await pi.ready;
    const inspection=await PiConsolePlugin.inspectRuntime(pi);
    const sourceChats=await pi.listChats();
    const recovery=inspection.tasks.length||inspection.submissions.length?{version:PiConsolePlugin.createId(),chats:[...new Set([...inspection.tasks.map(item=>item.record.conversationId),...inspection.submissions.map(item=>item.conversationId)])].map(id=>({id:id||null,title:sourceChats.find(chat=>chat.id===id)?.title||'来源后台任务'}))}:null;
    const saved = await background({type:'shared-config',operation:'get'});
    pi.replaceModelSettings({profiles:saved.profiles || [],providers:saved.providers || []});
    if (defaults && !pi.config && saved.profiles?.length) await pi.configure({ ...saved.profiles[0], profileId:saved.profiles[0].id });
    // MCP configuration is shared by every site; connecting happens in the background.
    pi.applyMcpConfig(saved.mcp||{mcpServers:{}},saved.mcpRevision||0);

    for (const tool of pi.tools().filter(item => pageToolNames.has(item.name))) {
      pi.unregisterTool(tool.name);
      pi.registerTool({ ...tool, replay: ['page_snapshot', 'inspect_dom', 'get_console', 'get_network'].includes(tool.name) ? 'safe' : 'unsafe',
        execute: async (args, api, context) => {
          const ref=conversationRef(site,api.conversationId);
          return continuations.tool(ref,async target=>{
            context.abortSignal?.throwIfAborted();
            const requestId=PiConsolePlugin.createId();
            const cancel=()=>{void background({type:'cancel-page-tool',tabId:target.tabId,documentId:target.documentId,requestId}).catch(()=>{});};
            context.abortSignal?.addEventListener('abort',cancel,{once:true});
            try { return await background({type:'page-tool',ref,target,requestId,name:tool.name,args}); }
            finally {context.abortSignal?.removeEventListener('abort',cancel);}
          });
        },
      });
    }
    pi.registerTool({ name:'tab_list', description:'列出已启用 Pi Tab 的标签页及其 agent。', replay:'safe', parameters:pi.Type.Object({}),
      execute: async () => (await background({ type:'tabs-list' })).tabs });
    pi.registerTool({ name:'tab_open', description:'打开新标签页并创建独立 agent，返回 tabId 和 chatId；用 tab_send 向它发送任务。', parameters:pi.Type.Object({url:pi.Type.String()}),
      execute: async ({url},api) => background({type:'tabs-open',url,sourceSite:site,fromChatId:api.conversationId}) });
    pi.registerTool({ name:'tab_send', description:'向另一标签页的 agent 发送任务。先用 tab_list 查找。', parameters:pi.Type.Object({tabId:pi.Type.Integer(),chatId:pi.Type.Integer(),ownerSite:pi.Type.Optional(pi.Type.String()),message:pi.Type.String()}),
      execute: async ({tabId,chatId,ownerSite,message},api) => {
        return background({type:'tabs-send',tabId,chatId,ownerSite,text:message,fromChatId:api.conversationId});
      } });
    pi.registerTool({ name:'tab_read', description:'读取另一标签页中 agent 的最近消息。', replay:'safe', parameters:pi.Type.Object({tabId:pi.Type.Integer(),chatId:pi.Type.Integer(),ownerSite:pi.Type.Optional(pi.Type.String()),limit:pi.Type.Optional(pi.Type.Integer({minimum:1,maximum:30}))}),
      execute: async ({tabId,chatId,ownerSite,limit=10}) => {
        return background({type:'tabs-read',tabId,chatId,ownerSite,limit});
      } });
    pi.onEvent(event => {
      if(event.type==='chat_deleted'||event.type==='chat_reset')linux.delete(event.conversationId);
      if(event.type==='disposed')linux.dispose();
      if (event.type === 'chat_created') continuations.inherit(conversationRef(site,event.conversationId),conversationRef(site,event.chatId));
      if(['chat_created','chat_title_changed','chat_deleted'].includes(event.type))void historyIndex.reconcile(site).catch(()=>{});
      if (event.type === 'config_saved') {
        void chrome.runtime.sendMessage({type:'shared-config',operation:'profile-save',profile:event.profile}).catch(()=>{});
      }
      if (event.type === 'provider_saved') {
        void chrome.runtime.sendMessage({type:'shared-config',operation:'provider-save',provider:event.provider}).catch(()=>{});
      }
      if(['config_saved','provider_saved'].includes(event.type)){void chrome.runtime.sendMessage({type:'engine-event',site,event:{type:'models_changed'}}).catch(()=>{});return;}
      if(event.conversationId)emitRef(conversationRef(site,event.conversationId),event);
      else void chrome.runtime.sendMessage({type:'engine-event',site,event}).catch(()=>{});
    });
    if(sharedMcpGate)pi.setMcpUpdateGate(true);
    if(!recovery)pi.resume();
    return {pi,recovery};
  })().catch(async error=>{await createdPi?.dispose({abort:false}).catch(()=>{});createdLinux?.dispose();engines.delete(site);throw error;}));
  return engines.get(site);
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if(_sender.tab&&(_sender.frameId!==0||!_sender.url?.startsWith(chrome.runtime.getURL(''))||_sender.url.startsWith(chrome.runtime.getURL('history-picker.html'))))return false;
  if(message.type==='target-invalidated'||message.type==='tab-closed') {
    const owned=[...continuations.rows.values()].filter(row=>row.ownerTabId===message.tabId).map(row=>row.ref);
    continuations.invalidate(message.tabId);
    const stopping=message.type==='tab-closed'?Promise.all(owned.map(async ref=>{const e=await existing(ref);if(!e.recovery)await e.pi.agent(ref.conversationId).abort();})):Promise.resolve();
    stopping.then(()=>respond({ok:true}),error=>respond({ok:false,code:error.code||error.message,error:continuationErrorMessage(error)}));return true;
  }
  if(message.target==='continuations'){
    protocol(message).then(value=>respond({ok:true,value}),error=>respond({ok:false,code:error.code||error.message,error:continuationErrorMessage(error)}));return true;
  }
  if(message.type==='mcp-update-guard'){
    sharedMcpGate=message.value;
    Promise.all([...engines.values()]).then(values=>{
      try{
        for(const {pi} of values)pi.setMcpUpdateGate(message.value);
        respond({ok:true});
      }catch(error){sharedMcpGate=false;for(const {pi}of values)pi.setMcpUpdateGate(false);respond({ok:false,error:error.message});}
    },()=>{sharedMcpGate=false;respond({ok:false,error:'无法确认 MCP 任务状态。'});});
    return true;
  }
  if (message.type === 'shared-config-updated') {
    Promise.all([...engines.values()].map(async engine=>{
      const {pi}=await engine;
      if(message.profiles!==undefined||message.providers!==undefined){
        const saved=await background({type:'shared-config',operation:'get'});
        pi.replaceModelSettings({profiles:saved.profiles||[],providers:saved.providers||[]});
      }
      if(message.mcp!==undefined)pi.applyMcpConfig(message.mcp,message.mcpRevision||0);
    })).then(()=>respond({ok:true}),error=>respond({ok:false,error:error.message}));
    return true;
  }
  if (message.target !== 'engine') return false;
  (async () => {
    if(message.method==='tabCandidates')return [...continuations.rows.values()].filter(row=>row.target?.tabId===message.tabId).map(row=>row.ref);
    const engine=await engineFor(message.site,{defaults:['initialize','createChat'].includes(message.method)});
    const {pi}=engine;
    const {method,chatId,args=[],tabId} = message;
    if(['createChat','deleteChat','receiveFromTab'].includes(method)||(method==='agent'&&!['history','queuedMessages','savedConfig','discoverModels'].includes(message.name)))requireOwner(engine);
    if (method === 'initialize') {
      const activeId=[...continuations.rows.values()].find(row=>row.ref.ownerSite===message.site&&row.target?.tabId===tabId)?.ref.conversationId??pi.conversation.id;
      return {activeId,config:pi.configFor(activeId),defaultPrompt:pi.defaultPrompt,
        chats:(await pi.listChats()).map(chat=>({...chat,busy:pi.busyFor(chat.id),config:pi.configFor(chat.id)}))};
    }
    if (method === 'bind') { return {config:pi.configFor(chatId),busy:pi.busyFor(chatId)}; }
    if (method === 'createChat') { const id=await pi.createChat({inheritFrom:args[0],activate:true}); continuations.forget(conversationRef(message.site,id)); return id; }
    if (method === 'selectChat') { return {config:pi.configFor(chatId),busy:pi.busyFor(chatId)}; }
    if (method === 'listChats') return (await pi.listChats()).map(chat=>({...chat,busy:pi.busyFor(chat.id),config:pi.configFor(chat.id)}));
    if (method === 'deleteChat') {
      const result = await pi.deleteChat(args[0]);
      return result;
    }
    if (method === 'agent') {
      if (['prompt','steer','followUp','runTool','sendToAgent','reset','abort','changeQueuedMessage'].includes(message.name))throw Error('CONTINUE_HERE_REQUIRED');
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
    if(['mcpConfig','getMcpServer','getMcpVariables','refreshMcp'].includes(method)){
      const saved=await background({type:'shared-config',operation:'get'});
      pi.applyMcpConfig(saved.mcp||{mcpServers:{}},saved.mcpRevision||0);
      if(method==='getMcpServer')return {version:(await pi.mcpConfig()).version,config:structuredClone(saved.mcp?.mcpServers?.[args[0]])};
      if(method==='getMcpVariables')return {version:(await pi.mcpConfig()).version,env:saved.mcp?.env||{},references:mcpVariableReferences(saved.mcp||{})};
      if(method==='refreshMcp'){
        for(const engine of await Promise.all([...engines.values()]))if(engine.pi.mcpBusy())throw Error('请先停止运行中的任务，或等待连接完成。');
        return pi.refreshMcp();
      }
      return pi.mcpConfig();
    }
    if(method==='previewMcpImport')return background({type:'shared-config',operation:'mcp-preview',input:args[0],choices:args[1]});
    if(method==='changeMcpConfig'||method==='setMcpConfig'){
      const request=method==='setMcpConfig'?{operation:{kind:'replace',value:typeof args[0]==='string'?readMcpJson(args[0]):args[0]}}:args[0];
      const result=await background({type:'shared-config',operation:'mcp-change',request});
      return {...await pi.mcpConfig(),...result};
    }
    if (method === 'auth') return pi.auth(...args);
    if (method === 'getPreferences') return pi.getPreferences();
    if (method === 'setPreferences') return pi.setPreferences(args[0]);
    if (method === 'listModels') return pi.listModels();
    if (method === 'listProviders') return pi.listProviders();
    if (method === 'saveProvider') return pi.saveProvider(args[0]);
    if (method === 'receiveFromTab') {
      const ref=conversationRef(message.site,chatId),row=continuations.row(ref);
      if(!row.target||row.target.tabId!==tabId)throw Error('CONTINUE_HERE_REQUIRED');
      return continuations.submit(ref,{target:row.target,viewId:row.viewId,leaseToken:row.lease},PiConsolePlugin.createId(),()=>pi.receiveFromTab(chatId,args[0],args[1]),{queue:true});
    }
    if (method === 'readAgent') {
      const history=await pi.agent(chatId).history();
      return history.entries.slice(-(args[0]||10)).map(entry=>({kind:entry.kind,text:entry.model?.map(item=>typeof item.content==='string'?item.content:item.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')).filter(Boolean).join('\n')}));
    }
    throw new Error('未知引擎操作。');
  })().then(value=>respond({ok:true,value}),error=>respond({ok:false,code:error.code||error.message,error:continuationErrorMessage(error),diagnostics:error.diagnostics}));
  return true;
});
