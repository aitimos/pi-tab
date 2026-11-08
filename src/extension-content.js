// PiConsolePlugin and openChat are bundled before this file by build.mjs.
const extensionRequest = message => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (!response?.ok) reject(Object.assign(new Error(response?.error || '扩展通信失败。'),{diagnostics:response?.diagnostics,code:response?.code}));
    else resolve(response.value);
  });
});
const engineCall = (method, args, chatId, name) => extensionRequest({type:'engine-call',method,args,chatId,name});
const {conversationRef,refKey,parseRef}=PiConsolePlugin;
const listeners = new Set();
const viewId=PiConsolePlugin.createId(),leases=new Map(),states=new Map(),pickers=new Map();
let targetNonce=PiConsolePlugin.createId(),routeEpoch=0,lastUrl=location.href;
async function hello(){return extensionRequest({type:'document-hello',nonce:targetNonce,routeEpoch});}
const documentReady=hello();
function checkTarget(target){if(!target||target.nonce!==targetNonce||target.routeEpoch!==routeEpoch||target.url!==location.href||target.origin!==location.origin)throw Error('TARGET_INVALIDATED');}
const continuationCall=(ref,operation,args=[],name,extra={})=>extensionRequest({type:'continuation-call',ref,operation,args,name,viewId,leaseToken:leases.get(refKey(ref)),clientRequestId:PiConsolePlugin.createId(),...extra});
const emitState=(id,state)=>{states.set(id,state);for(const listener of listeners)listener({type:'binding_state',conversationId:id,state});};
const refreshState=async ref=>{const id=refKey(ref),state=await continuationCall(ref,'view');emitState(id,state);return state;};
setInterval(()=>{if(location.href!==lastUrl){lastUrl=location.href;routeEpoch++;leases.clear();void hello().catch(()=>{});}},250);
const configs = new Map();
const eventSequences=new Map();
const busy = new Map();
const toolRuns = new Map();
let extensionStarted = false;
let extensionStarting;
let pageTools;
let remotePi;
let site;
let activeId;

async function initializeExtension() {
  await documentReady;
  const identity = await extensionRequest({type:'identity'});
  if (!identity.active) return;
  site = identity.site;
  const locale = PiConsolePlugin.getI18n();
  const languageKey = 'pi-tab-language';
  const storedLanguage = await chrome.storage.local.get(languageKey);
  locale.setMode(storedLanguage[languageKey] || 'auto', false);
  locale.onChange(() => {
    void chrome.storage.local.get(languageKey).then(saved => {
      if (saved[languageKey] !== locale.mode) return chrome.storage.local.set({[languageKey]:locale.mode});
    });
  });
  chrome.storage.onChanged.addListener((changes,area) => {
    if (area === 'local' && changes[languageKey] && changes[languageKey].newValue !== locale.mode) locale.setMode(changes[languageKey].newValue || 'auto', false);
  });
  pageTools = PiConsolePlugin.install({globalName:'__piPageTools',toolOnly:true,log:false});
  const modelConfig = PiConsolePlugin.createModelConfig(await PiConsolePlugin.loadModelCatalog());
  const initial = await engineCall('initialize');
  activeId = refKey(conversationRef(site,initial.activeId));
  for (const chat of initial.chats) { configs.set(refKey(conversationRef(site,chat.id)),chat.config); busy.set(refKey(conversationRef(site,chat.id)),chat.busy); }
  remotePi = {
    __piConsolePlugin:true, extension:true,
    parseConversationRef:parseRef,
    async chooseHistory(){
      if(pickers.has(viewId)){pickers.get(viewId).iframe.focus();return null;}
      const grant=await extensionRequest({type:'picker-open',viewId});
      const iframe=document.createElement('iframe');iframe.src=grant.url;iframe.title=locale.t('历史对话');
      iframe.style.cssText='position:fixed;inset:10vh auto auto 50%;transform:translateX(-50%);width:min(580px,90vw);height:75vh;border:1px solid #777;border-radius:12px;z-index:2147483647;background:#fff;color-scheme:light dark';
      document.documentElement.append(iframe);
      return new Promise((resolve,reject)=>pickers.set(viewId,{iframe,resolve,reject}));
    },
    i18n:locale,
    ready:Promise.resolve(),
    defaultPrompt:initial.defaultPrompt,
    oauthUI:async()=>PiTabOAuthUI.createOAuthUI,
    manageModels:change=>engineCall('manageModels',[change]),
    auth:(action,input)=>engineCall('auth',[action,input]),
    get conversation(){return {id:activeId};},
    get config(){return configs.get(activeId);},
    get busy(){return busy.get(activeId)===true;},
    apis:()=>structuredClone(modelConfig.apis),
    describeModel:config=>modelConfig.describe(config),
    onEvent(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    async listChats(){
      const chats=await engineCall('listChats');
      return chats.map(chat=>{const id=refKey(conversationRef(site,chat.id));configs.set(id,chat.config);busy.set(id,chat.busy);return {...chat,id};});
    },
    deleteChat:async id=>{const value=await continuationCall(parseRef(id),'delete');return {replacementId:refKey(value.replacementRef)};},
    async createChat({inheritFrom=activeId}={}){
      const ref=await continuationCall(parseRef(inheritFrom),'create');
      activeId=refKey(ref);const state=await refreshState(ref);configs.set(activeId,state.config);busy.set(activeId,state.busy);return activeId;
    },
    agent(initialId){
      let chatId=initialId;
      const invoke=async(name,...args)=>{try{return await continuationCall(parseRef(chatId),name==='abort'?'stop':'agent',args,name);}catch(error){if(['CONTINUE_HERE_REQUIRED','TARGET_INVALIDATED','RECONNECT_REVIEW_HISTORY'].includes(error.code)){leases.delete(chatId);void refreshState(parseRef(chatId)).catch(()=>{});}throw error;}};
      const bound=refreshState(parseRef(chatId)).then(state=>{configs.set(chatId,state.config);busy.set(chatId,state.busy);});
      return {
        get id(){return chatId;},get config(){return configs.get(chatId);},get busy(){return busy.get(chatId)===true;},get ready(){return bound;},
        get bindingState(){return states.get(chatId);},get authorized(){return leases.has(chatId);},
        async refreshBinding(){return refreshState(parseRef(chatId));},
        async continueHere(){
          const ref=parseRef(chatId),state=states.get(chatId)||await refreshState(ref);
          const value=await continuationCall(ref,'continue',[],undefined,{expectedVersion:state.version});
          leases.set(chatId,value.leaseToken);emitState(chatId,value);return value;
        },
        async recoverSource(){const state=await refreshState(parseRef(chatId));return continuationCall(parseRef(chatId),'recover',[state.recovery?.version]);},
        async returnToTarget(){return extensionRequest({type:'focus-target',ref:parseRef(chatId),viewId});},
        apis:remotePi.apis,describeModel:remotePi.describeModel,
        onEvent(listener){return remotePi.onEvent(event=>{if(event.conversationId===chatId)listener(event);});},
        async configure(config){const result=await invoke('configure',config);configs.set(chatId,result);return result;},
        async selectModel(id){const result=await invoke('selectModel',id);configs.set(chatId,result);return result;},
        runTool:(...args)=>invoke('runTool',...args),reset:()=>invoke('reset'),prompt:text=>invoke('prompt',text),steer:text=>invoke('steer',text),followUp:text=>invoke('followUp',text),
        history:()=>invoke('history'),queuedMessages:()=>invoke('queuedMessages'),changeQueuedMessage:(...args)=>invoke('changeQueuedMessage',...args),abort:()=>invoke('abort'),
        async savedConfig(){await bound;return invoke('savedConfig');},
        listModels:()=>engineCall('listModels'),listProviders:()=>engineCall('listProviders'),saveProvider:provider=>engineCall('saveProvider',[provider]),
        discoverModels:config=>invoke('discoverModels',config),sendToAgent:(...args)=>invoke('sendToAgent',...args),
        async listChats(){
          const ref=parseRef(chatId),chats=ref.ownerSite===site?await remotePi.listChats():[{id:chatId,title:ref.ownerSite,busy:busy.get(chatId)}];
          return chats.map(chat=>({...chat,active:chat.id===chatId}));
        },
        async selectChat(id){
          const state=await refreshState(parseRef(id));chatId=id;activeId=id;configs.set(id,state.config);busy.set(id,state.busy);return this.listChats();
        },
        async newChat(){chatId=await remotePi.createChat({inheritFrom:chatId});return this.listChats();},
      };
    },
    getPreferences:()=>engineCall('getPreferences'),
    setPreferences:settings=>engineCall('setPreferences',[settings]),
    mcpConfig:()=>engineCall('mcpConfig'),
    getMcpServer:name=>engineCall('getMcpServer',[name]),
    getMcpVariables:()=>engineCall('getMcpVariables'),
    previewMcpImport:(input,choices)=>engineCall('previewMcpImport',[input,choices]),
    changeMcpConfig:request=>engineCall('changeMcpConfig',[request]),
    setMcpConfig:input=>engineCall('setMcpConfig',[input]),
    refreshMcp:()=>engineCall('refreshMcp'),
  };
  window.pi=remotePi;
  window.__piTabAgent=remotePi;
  const savedOpenIds=sessionStorage.getItem('pi-tab-open-chats-v2');
  let openIds;
  try {openIds=savedOpenIds===null?JSON.parse(sessionStorage.getItem('pi-tab-open-chats')||'null')?.map(id=>conversationRef(site,id)):JSON.parse(savedOpenIds);}catch{openIds=null;}
  for(const ref of openIds||[parseRef(activeId)])try {await refreshState(ref);await openChat(undefined,{forceNew:true,chatId:refKey(ref)});}catch(error){console.error('[Pi Tab]',error.message);}
  extensionStarted=true;
}

function startExtension(){
  if(extensionStarted)return;
  if(extensionStarting)return extensionStarting;
  extensionStarting=initializeExtension().finally(()=>{extensionStarting=null;});
  return extensionStarting;
}

chrome.runtime.onMessage.addListener((message,_sender,respond)=>{
  if(message.type==='verify-target'){try{checkTarget(message.target);respond({ok:true});}catch(error){respond({ok:false,error:error.message});}return false;}
  if(message.type==='history-selected'||message.type==='history-picker-closed'){const picker=pickers.get(message.viewId);if(picker){picker.iframe.remove();pickers.delete(message.viewId);picker.resolve(message.ref?refKey(message.ref):null);}return false;}
  if(message.type==='cancel-tool'){
    toolRuns.get(message.requestId)?.abort();
    respond({ok:true});
    return false;
  }
  if(message.type==='engine-event'){
    if(site) {
      if(message.ref){
        const key=refKey(message.ref),previous=eventSequences.get(key);
        if(message.sequence){
          if(previous?.epoch===message.epoch&&message.sequence<=previous.sequence)return false;
          if(previous&&(previous.epoch!==message.epoch||message.sequence!==previous.sequence+1)){for(const listener of listeners)listener({type:'history_resync',conversationId:key});void refreshState(message.ref).catch(()=>{});}
          eventSequences.set(key,{epoch:message.epoch,sequence:message.sequence});
        }
        message.event={...message.event,conversationId:key,...(message.event.replacementId?{replacementId:refKey(conversationRef(message.ref.ownerSite,message.event.replacementId))}:{}),...(message.event.agentId?{agentId:refKey(conversationRef(message.ref.ownerSite,message.event.agentId))}: {})};
        if(['target_invalidated','binding_changed','run_end','recovery_complete'].includes(message.event.type)){if(message.event.type==='target_invalidated'||(message.event.type==='binding_changed'&&message.event.holderViewId!==viewId))leases.delete(key);void refreshState(message.ref).catch(()=>{});}
      }
      if(message.event.type==='chat_deleted'){
        configs.delete(message.event.conversationId);busy.delete(message.event.conversationId);
        if(activeId===message.event.conversationId)activeId=message.event.replacementId;
      }
      if(message.event.type==='run_start')busy.set(message.event.conversationId,true);
      if(message.event.type==='run_end')busy.set(message.event.conversationId,false);
      if(message.event.type==='snapshot')busy.set(message.event.conversationId,Boolean(message.event.run));
      for(const listener of listeners)listener(message.event);
    }
    return false;
  }
  if(message.type!=='activate'&&message.type!=='execute-tool')return false;
  (async()=>{
    if(message.type==='activate'){
      await startExtension();
      // Activation may arrive while the initial inactive identity check finishes.
      if(!extensionStarted)await startExtension();
      if(message.openWindow){
        const windows=window.__piQuickChatOverlay?.instances;
        if(windows?.size){
          for(const instance of windows.values())instance.open();
        }else await openChat(undefined,{forceNew:true,chatId:activeId});
      }
      return {active:true};
    }
    checkTarget(message.target);
    if(!extensionStarted||!pageTools)throw new Error('Pi Tab 尚未在此网页启动。');
    const controller=new AbortController();
    toolRuns.set(message.requestId,controller);
    try { return await pageTools.runTool(message.name,message.args,{signal:controller.signal}); }
    finally { toolRuns.delete(message.requestId); }
  })().then(value=>respond({ok:true,value}),error=>respond({ok:false,error:error.message||String(error)}));
  return true;
});
void startExtension().catch(error=>console.error('[Pi Tab]',error));
