// PiConsolePlugin and openChat are bundled before this file by build.mjs.
const extensionRequest = message => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (!response?.ok) reject(new Error(response?.error || '扩展通信失败。'));
    else resolve(response.value);
  });
});
const engineCall = (method, args, chatId, name) => extensionRequest({type:'engine-call',method,args,chatId,name});
const listeners = new Set();
const configs = new Map();
const busy = new Map();
let extensionStarted = false;
let extensionStarting;
let pageTools;
let remotePi;
let site;
let activeId;

async function initializeExtension() {
  const identity = await extensionRequest({type:'identity'});
  if (!identity.active) return;
  site = identity.site;
  pageTools = PiConsolePlugin.install({globalName:'__piPageTools',toolOnly:true,log:false});
  const modelConfig = PiConsolePlugin.createModelConfig(await PiConsolePlugin.loadModelCatalog());
  const initial = await engineCall('initialize');
  activeId = initial.activeId;
  for (const chat of initial.chats) { configs.set(chat.id,chat.config); busy.set(chat.id,chat.busy); }
  remotePi = {
    __piConsolePlugin:true,
    ready:Promise.resolve(),
    defaultPrompt:initial.defaultPrompt,
    get conversation(){return {id:activeId};},
    get config(){return configs.get(activeId);},
    get busy(){return busy.get(activeId)===true;},
    apis:()=>structuredClone(modelConfig.apis),
    describeModel:config=>modelConfig.describe(config),
    onEvent(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    async listChats(){const chats=await engineCall('listChats');for(const chat of chats){configs.set(chat.id,chat.config);busy.set(chat.id,chat.busy);}return chats;},
    deleteChat:id=>engineCall('deleteChat',[id]),
    async createChat({inheritFrom=activeId}={}){
      const id=await engineCall('createChat',[inheritFrom]);
      activeId=id;
      const state=await engineCall('bind',[],id);
      configs.set(id,state.config);busy.set(id,state.busy);
      return id;
    },
    agent(initialId){
      let chatId=initialId;
      const bound=engineCall('bind',[],chatId).then(state=>{configs.set(chatId,state.config);busy.set(chatId,state.busy);});
      const invoke=(name,...args)=>engineCall('agent',args,chatId,name);
      return {
        get id(){return chatId;},get config(){return configs.get(chatId);},get busy(){return busy.get(chatId)===true;},
        get ready(){return bound;},
        apis:remotePi.apis,describeModel:remotePi.describeModel,
        onEvent(listener){return remotePi.onEvent(event=>{if(event.conversationId===chatId)listener(event);});},
        async configure(config){const result=await invoke('configure',config);configs.set(chatId,result);return result;},
        async selectModel(id){const result=await invoke('selectModel',id);configs.set(chatId,result);return result;},
        prompt:text=>invoke('prompt',text),steer:text=>invoke('steer',text),followUp:text=>invoke('followUp',text),
        history:()=>invoke('history'),queuedMessages:()=>invoke('queuedMessages'),changeQueuedMessage:(...args)=>invoke('changeQueuedMessage',...args),abort:()=>invoke('abort'),
        async savedConfig(){await bound;return invoke('savedConfig');},
        listModels:()=>engineCall('listModels'),listProviders:()=>engineCall('listProviders'),saveProvider:provider=>engineCall('saveProvider',[provider]),
        discoverModels:config=>invoke('discoverModels',config),
        sendToAgent:(...args)=>invoke('sendToAgent',...args),
        async listChats(){return (await remotePi.listChats()).map(chat=>({...chat,active:chat.id===chatId}));},
        async selectChat(id){
          const state=await engineCall('selectChat',[],id);
          chatId=id;activeId=id;configs.set(id,state.config);busy.set(id,state.busy);
          return this.listChats();
        },
        async newChat(){
          const id=await remotePi.createChat({inheritFrom:chatId});
          chatId=id;
          return this.listChats();
        },
      };
    },
    getPreferences:()=>engineCall('getPreferences'),
    setPreferences:settings=>engineCall('setPreferences',[settings]),
  };
  window.pi=remotePi;
  window.__piTabAgent=remotePi;
  const savedOpenIds=sessionStorage.getItem('pi-tab-open-chats');
  const openIds=savedOpenIds===null?[activeId]:JSON.parse(savedOpenIds);
  const chats=await remotePi.listChats();
  for(const chatId of openIds)if(chats.some(chat=>chat.id===chatId))openChat(undefined,{forceNew:true,chatId});
  extensionStarted=true;
}

function startExtension(){
  if(extensionStarted)return;
  if(extensionStarting)return extensionStarting;
  extensionStarting=initializeExtension().finally(()=>{extensionStarting=null;});
  return extensionStarting;
}

chrome.runtime.onMessage.addListener((message,_sender,respond)=>{
  if(message.type==='engine-event'){
    if(site) {
      if(message.event.type==='chat_deleted'){
        configs.delete(message.event.conversationId);busy.delete(message.event.conversationId);
        if(activeId===message.event.conversationId)activeId=message.event.replacementId;
      }
      if(message.event.type==='run_start')busy.set(message.event.conversationId,true);
      if(message.event.type==='run_end')busy.set(message.event.conversationId,false);
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
        }else openChat(undefined,{forceNew:true,chatId:activeId});
      }
      return {active:true};
    }
    if(!extensionStarted||!pageTools)throw new Error('Pi Tab 尚未在此网页启动。');
    return pageTools.runTool(message.name,message.args);
  })().then(value=>respond({ok:true,value}),error=>respond({ok:false,error:error.message||String(error)}));
  return true;
});
void startExtension().catch(error=>console.error('[Pi Tab]',error));
