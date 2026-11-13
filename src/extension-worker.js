import {continuationErrorMessage} from './continuation-errors.js';
import {conversationRef,refKey} from './conversation-ref.js';
import {McpConfigStore} from './mcp-store.js';
import { createI18n } from './i18n.js';

async function actionLocale() {
  const saved = await chrome.storage.local.get('pi-tab-language');
  return createI18n({mode:saved['pi-tab-language'] || 'auto',languages:await chrome.i18n.getAcceptLanguages()});
}

const selectedKey=(tabId,origin)=>`selected:${tabId}:${origin}`;
const activeKey = tabId => `active:${tabId}`;
const siteOf = url => {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Pi Tab 只能在普通网页使用。');
  return parsed.hostname.toLowerCase();
};
let openingEngine;
const pageTools = new Map();
const workerEpoch=crypto.randomUUID();

const documents=new Map(), grants=new Map(), subscribers=new Map(), openedAgents=new Map(), revocations=new Map();
const internal=sender=>!sender.tab && sender.id===chrome.runtime.id;
async function coordinator(request) {
  await ensureEngine();
  const response=await chrome.runtime.sendMessage({...request,target:'continuations',pageTarget:request.target});
  if(!response?.ok)throw Object.assign(Error(response?.error||'ENGINE_UNAVAILABLE'),{code:response?.code,notSubmitted:response?.notSubmitted});
  return response.value;
}
async function verifyDocument(target) {
  const tab=await chrome.tabs.get(target.tabId);
  if(tab.url!==target.url)throw Error('TARGET_INVALIDATED');
  const reply=await chrome.tabs.sendMessage(target.tabId,{type:'verify-target',target},{documentId:target.documentId});
  if(!reply?.ok)throw Error(reply?.error||'TARGET_PERMISSION_OR_UNSUPPORTED');
  return true;
}
async function validTarget(target) {
  const matches=()=>target&&JSON.stringify(documents.get(target.tabId))===JSON.stringify(target);
  if(!matches())throw Error('TARGET_INVALIDATED');
  await verifyDocument(target);
  if(!matches())throw Error('TARGET_INVALIDATED');
  return true;
}
function senderTarget(sender,epoch) {
  if(sender.id!==chrome.runtime.id||sender.frameId!==0||!sender.documentId||!sender.tab?.id)throw Error('INVALID_TOP_DOCUMENT');
  const target=documents.get(sender.tab.id);
  if(!target||epoch!==workerEpoch)throw Error('DOCUMENT_RECONNECT_REQUIRED');
  // MessageSender.url is the document's initial URL even after pushState.
  // The registered live URL is verified against tabs.get and the exact document.
  if(!target||target.documentId!==sender.documentId||target.origin!==new URL(sender.url).origin)throw Error('TARGET_INVALIDATED');
  return target;
}
function revoke(tabId) {
  for(const [requestId,run]of pageTools)if(run.target.tabId===tabId){run.controller.abort();void chrome.tabs.sendMessage(tabId,{type:'cancel-tool',requestId},{documentId:run.target.documentId}).catch(()=>{});}
  documents.delete(tabId);
  for(const [key,grant]of grants)if(grant.target.tabId===tabId)grants.delete(key);
  for(const [key,views]of subscribers){for(const [id,view]of views)if(view.tabId===tabId)views.delete(id);if(!views.size)subscribers.delete(key);}
  const pending=(revocations.get(tabId)||Promise.resolve()).then(async()=>{
    if(chrome.offscreen&&await chrome.offscreen.hasDocument())await chrome.runtime.sendMessage({type:'target-invalidated',tabId});
  }).catch(()=>{});
  revocations.set(tabId,pending);
  void pending.finally(()=>{if(revocations.get(tabId)===pending)revocations.delete(tabId);});
  return pending;
}
function subscribe(ref,target,viewId) {
  const key=refKey(ref);if(!subscribers.has(key))subscribers.set(key,new Map());
  subscribers.get(key).set(viewId,{tabId:target.tabId,documentId:target.documentId});
}
function pickerGrant(message,sender,{allowExpired=false}={}) {
  const grant=grants.get(message.grant);
  if(!grant||(!allowExpired&&grant.expires<Date.now())||sender.id!==chrome.runtime.id||sender.tab?.id!==grant.target.tabId||sender.frameId===0||!sender.documentId||!sender.url?.startsWith(chrome.runtime.getURL('history-picker.html')+'#'))throw Error('PICKER_UNAUTHORIZED');
  if(grant.pickerDocumentId&&grant.pickerDocumentId!==sender.documentId)throw Error('PICKER_UNAUTHORIZED');
  grant.pickerDocumentId=sender.documentId;
  const current=documents.get(grant.target.tabId);
  if(JSON.stringify(current)!==JSON.stringify(grant.target))throw Error('PICKER_EXPIRED');
  return grant;
}

async function ensureEngine() {
  if (await chrome.offscreen.hasDocument()) return;
  openingEngine ??= chrome.offscreen.createDocument({url:'engine.html',reasons:['WORKERS'],justification:'让网页刷新和跳转后，Pi agent 继续运行。'}).finally(() => { openingEngine=null; });
  await openingEngine;
}

async function engineCall(site, tabId, method, args, chatId, name) {
  await ensureEngine();
  const response=await chrome.runtime.sendMessage({target:'engine',site,tabId,method,args,chatId,name});
  if(!response?.ok)throw new Error(response?.error||'Pi agent 没有响应。');
  return response.value;
}

async function activate(tabId, openWindow = false) {
  await chrome.storage.session.set({[activeKey(tabId)]:true});
  let response;
  try { response = await chrome.tabs.sendMessage(tabId,{type:'activate',openWindow}); }
  catch (error) {
    if(!/Receiving end does not exist|Could not establish connection/i.test(error.message))throw error;
    if(!openWindow)return; // Navigation will retry once the page is ready.
    await chrome.scripting.executeScript({target:{tabId},files:['content.js']});
    response = await chrome.tabs.sendMessage(tabId,{type:'activate',openWindow});
  }
  if(!response?.ok)throw new Error(response?.error||'Pi Tab 启动失败。');
}

chrome.action.onClicked.addListener(async tab => {
  if(!tab.id)return;
  try {
    siteOf(tab.url);
    await activate(tab.id,true);
    await chrome.action.setBadgeText({tabId:tab.id,text:''});
    await chrome.action.setTitle({tabId:tab.id,title:(await actionLocale()).t('打开 Pi Tab')});
  } catch (error) {
    console.error('[Pi Tab]',error);
    await chrome.action.setBadgeText({tabId:tab.id,text:'!'});
    await chrome.action.setTitle({tabId:tab.id,title:`Pi Tab: ${(await actionLocale()).t(error.message)}`});
  }
});
chrome.tabs.onRemoved.addListener(async tabId => {
  revoke(tabId);openedAgents.delete(tabId);
  const selected=await chrome.storage.session.get(null);
  for(const key of Object.keys(selected))if(key.startsWith(`selected:${tabId}:`))await chrome.storage.session.remove(key);
  await chrome.storage.session.remove(activeKey(tabId));
  if (!await chrome.offscreen.hasDocument()) return;
  const response = await chrome.runtime.sendMessage({type:'tab-closed',tabId});
  if (!response?.ok) console.error('[Pi Tab]',response?.error || 'Could not stop closed tab tasks');
});
chrome.tabs.onUpdated.addListener((tabId,change) => {
  if(change.status==='loading'||(change.url&&documents.get(tabId)?.url!==change.url))void revoke(tabId);
  if(change.status!=='complete')return;
  void chrome.storage.session.get(activeKey(tabId)).then(saved=>{if(saved[activeKey(tabId)])return activate(tabId);}).catch(error=>console.error('[Pi Tab]',error));
});

const mcpStore=new McpConfigStore({
  read:()=>chrome.storage.local.get(['mcp','mcpRevision']),
  write:next=>chrome.storage.local.set(next),
  guard:async()=>{
    if(!await chrome.offscreen.hasDocument())return;
    const reply=await chrome.runtime.sendMessage({type:'mcp-update-guard',value:true});
    if(!reply?.ok)throw Error(reply?.error||'无法确认 MCP 任务状态。');
  },
  release:async()=>{
    if(await chrome.offscreen.hasDocument())await chrome.runtime.sendMessage({type:'mcp-update-guard',value:false}).catch(()=>{});
  },
  onSaved:async(mcp,mcpRevision)=>{
    if(!await chrome.offscreen.hasDocument())return;
    const reply=await chrome.runtime.sendMessage({type:'shared-config-updated',mcp,mcpRevision});
    if(!reply?.ok)throw Error('连接同步失败。');
  },
});

chrome.runtime.onMessage.addListener((message,sender,respond) => {
  if(message.target==='engine'||message.type==='shared-config-updated'||message.type==='tab-closed'||message.type==='mcp-update-guard'||message.type==='target-invalidated'||message.target==='continuations')return false;
  let continuationForwarded=false;
  (async()=>{
    if(message.type==='document-hello') {
      if(sender.id!==chrome.runtime.id||sender.frameId!==0||!sender.documentId||!sender.tab?.id)throw Error('INVALID_TOP_DOCUMENT');
      siteOf(message.url);
      if(new URL(sender.url).origin!==new URL(message.url).origin||typeof message.nonce!=='string'||!message.nonce||!Number.isSafeInteger(message.routeEpoch)||message.routeEpoch<0)throw Error('INVALID_TOP_DOCUMENT');
      const target={tabId:sender.tab.id,documentId:sender.documentId,origin:new URL(message.url).origin,url:message.url,nonce:message.nonce,routeEpoch:message.routeEpoch,workerEpoch};
      await verifyDocument(target);
      if(JSON.stringify(documents.get(target.tabId))!==JSON.stringify(target))await revoke(target.tabId);
      await verifyDocument(target);
      documents.set(target.tabId,target);return target;
    }
    if(message.type==='validate-target'){if(!internal(sender))throw Error('INTERNAL_ONLY');return validTarget(message.target);}
    if(message.type==='document-status'){await validTarget(senderTarget(sender,message.workerEpoch));return true;}
    if(message.type==='picker-open') {
      const target=senderTarget(sender,message.workerEpoch);await validTarget(target);
      for(const [key,value]of grants)if(value.expires<Date.now()||(value.target.tabId===target.tabId&&value.viewId===message.viewId))grants.delete(key);
      const grant=crypto.randomUUID();grants.set(grant,{target,viewId:message.viewId,expires:Date.now()+120000});
      return {url:chrome.runtime.getURL('history-picker.html')+'#'+grant};
    }
    if(message.type==='picker-list'||message.type==='picker-select'||message.type==='picker-close') {
      const grant=pickerGrant(message,sender,{allowExpired:message.type==='picker-close'});await validTarget(grant.target);
      if(message.type==='picker-list')return coordinator({operation:'list',cursor:message.cursor,refresh:message.refresh,reset:message.reset});
      grants.delete(message.grant);
      if(message.type==='picker-select') {
        const ref=conversationRef(message.ref?.ownerSite,message.ref?.conversationId);
        await coordinator({operation:'view',ref});subscribe(ref,grant.target,grant.viewId);
        const key=selectedKey(grant.target.tabId,grant.target.origin),saved=await chrome.storage.session.get(key);
        await chrome.storage.session.set({[key]:[...new Set([...(saved[key]||[]),refKey(ref)])]});
        await chrome.tabs.sendMessage(grant.target.tabId,{type:'history-selected',ref,viewId:grant.viewId},{documentId:grant.target.documentId});
      }else await chrome.tabs.sendMessage(grant.target.tabId,{type:'history-picker-closed',viewId:grant.viewId},{documentId:grant.target.documentId});
      return true;
    }
    if(message.type==='focus-target'){
      const target=senderTarget(sender,message.workerEpoch);await validTarget(target);
      const ref=conversationRef(message.ref?.ownerSite,message.ref?.conversationId);
      const subscription=subscribers.get(refKey(ref))?.get(message.viewId);
      if(subscription?.documentId!==target.documentId)throw Error('CONVERSATION_NOT_SELECTED');
      const state=await coordinator({operation:'view',ref});
      if(!state.target)throw Error('TARGET_INVALIDATED');
      const tab=await chrome.tabs.update(state.target.tabId,{active:true});
      await chrome.windows.update(tab.windowId,{focused:true});
      return true;
    }
    if(message.type==='continuation-call') {
      const target=senderTarget(sender,message.workerEpoch), ref=conversationRef(message.ref?.ownerSite,message.ref?.conversationId);
      // A source becomes accessible only through its native list or a picker selection.
      const subscription=subscribers.get(refKey(ref))?.get(message.viewId);
      const selected=await chrome.storage.session.get(selectedKey(target.tabId,target.origin));
      if(ref.ownerSite!==siteOf(target.url)&&!selected[selectedKey(target.tabId,target.origin)]?.includes(refKey(ref))&&(!subscription||subscription.documentId!==target.documentId))throw Error('CONVERSATION_NOT_SELECTED');
      subscribe(ref,target,message.viewId);
      continuationForwarded=true;
      const value=await coordinator({operation:message.operation,ref,args:message.args,name:message.name,expectedVersion:message.expectedVersion,viewId:message.viewId,target,
        authorization:{target,viewId:message.viewId,leaseToken:message.leaseToken},clientRequestId:message.clientRequestId});
      if(message.operation==='continue'){try{await validTarget(target);}catch(error){await chrome.runtime.sendMessage({type:'target-invalidated',tabId:target.tabId});throw error;}}
      if(message.operation==='create')subscribe(value,target,message.viewId);
      if(message.operation==='delete'&&value.replacementRef)subscribe(value.replacementRef,target,message.viewId);
      return value;
    }
    if(message.type==='shared-config'){
      if(message.operation==='get')return chrome.storage.local.get(['profiles','providers','mcp','mcpRevision']);
      if(message.operation==='mcp-preview')return mcpStore.preview(message.input,message.choices);
      if(message.operation==='mcp-change')return mcpStore.change(message.request);
      // Only write fields owned by this operation: an old model snapshot must
      // never overwrite a newer MCP document during an asynchronous save.
      const saved=await chrome.storage.local.get(['profiles','providers']);
      let patch;
      if(message.operation==='profile-save')patch={profiles:[...(saved.profiles||[]).filter(item=>item.id!==message.profile.id),message.profile]};
      else if(message.operation==='provider-save')patch={providers:[...(saved.providers||[]).filter(item=>item.id!==message.provider.id),message.provider]};
      else if(message.operation==='replace')patch={profiles:message.profiles,providers:message.providers};
      else throw new Error('未知设置操作。');
      await chrome.storage.local.set(patch);
      await chrome.runtime.sendMessage({type:'shared-config-updated',...patch});
      return true;
    }
    if(message.type==='identity'){
      const tabId=sender.tab?.id;
      if(!tabId)throw new Error('无法确定当前标签页。');
      const saved=await chrome.storage.session.get(activeKey(tabId));
      return {tabId,site:siteOf(sender.tab.url),active:Boolean(saved[activeKey(tabId)])};
    }
    if(message.type==='engine-call'){
      const target=senderTarget(sender,message.workerEpoch),tabId=target.tabId;
      if(!['initialize','listChats','manageModels','auth','getPreferences','setPreferences','listModels','listProviders','saveProvider','mcpConfig','getMcpServer','getMcpVariables','refreshMcp','previewMcpImport','changeMcpConfig','setMcpConfig'].includes(message.method))throw Error('USE_CONVERSATION_REF');
      return engineCall(siteOf(sender.tab.url),tabId,message.method,message.args,message.chatId,message.name);
    }
    if(message.type==='cancel-page-tool'){
      if(!internal(sender))throw Error('INTERNAL_ONLY');
      pageTools.get(message.requestId)?.controller.abort();
      await chrome.tabs.sendMessage(message.tabId,{type:'cancel-tool',requestId:message.requestId},{documentId:message.documentId}).catch(()=>{});
      return true;
    }
    if(message.type==='page-tool'){
      if(!internal(sender))throw Error('INTERNAL_ONLY');
      const target=message.target;await validTarget(target);
      const controller=new AbortController();pageTools.set(message.requestId,{controller,target});
      try {
        controller.signal.throwIfAborted();
        const response=await chrome.tabs.sendMessage(target.tabId,{type:'execute-tool',target,requestId:message.requestId,name:message.name,args:message.args},{documentId:target.documentId});
        controller.signal.throwIfAborted();
        if(!response?.ok)throw Error(response?.error||'TARGET_INVALIDATED');
        return response.value;
      }finally {pageTools.delete(message.requestId);}
    }
    if(message.type==='engine-event'){
      if(!internal(sender))throw Error('INTERNAL_ONLY');
      const views=message.ref?subscribers.get(refKey(message.ref)):null;
      if(views&&message.event.type==='chat_deleted'&&message.event.replacementId){
        const replacement=conversationRef(message.ref.ownerSite,message.event.replacementId);
        for(const [viewId,view]of views){const target=documents.get(view.tabId);if(!target||target.documentId!==view.documentId)continue;subscribe(replacement,target,viewId);const key=selectedKey(view.tabId,target.origin),saved=await chrome.storage.session.get(key);await chrome.storage.session.set({[key]:[...new Set([...(saved[key]||[]),refKey(replacement)])]});}
      }
      if(views)await Promise.all([...views.values()].map(view=>chrome.tabs.sendMessage(view.tabId,{type:'engine-event',ref:message.ref,event:message.event,sequence:message.sequence,epoch:message.epoch,workerEpoch},{documentId:view.documentId}).catch(()=>{})));
      if(!message.ref)await Promise.all([...documents.values()].map(target=>chrome.tabs.sendMessage(target.tabId,{type:'engine-event',event:message.event,workerEpoch},{documentId:target.documentId}).catch(()=>{})));
      return true;
    }
    if(message.type==='tabs-list'){
      if(!internal(sender))throw Error('INTERNAL_ONLY');
      const tabs=await chrome.tabs.query({});
      const listed=[];
      for(const tab of tabs){
        if(!tab.id||!tab.url)continue;
        let site;try{site=siteOf(tab.url);}catch{continue;}
        const saved=await chrome.storage.session.get(activeKey(tab.id));
        if(!saved[activeKey(tab.id)])continue;
        listed.push({tabId:tab.id,title:tab.title,url:tab.url,agents:(await engineCall(site,tab.id,'listChats')).map(chat=>({...chat,conversationRef:conversationRef(site,chat.id)}))});
      }
      return {tabs:listed};
    }
    if(message.type==='tabs-open'){
      if(!internal(sender))throw Error('INTERNAL_ONLY');
      const url=new URL(message.url);
      const site=siteOf(url.href);
      const tab=await chrome.tabs.create({url:'about:blank',active:false});
      const chatId=await engineCall(site,tab.id,'createChat',site===message.sourceSite?[message.fromChatId]:[]);
      await chrome.storage.session.set({[activeKey(tab.id)]:true});
      await chrome.tabs.update(tab.id,{url:url.href});
      const ref=conversationRef(site,chatId);openedAgents.set(tab.id,{ref,url:url.href});
      return {tabId:tab.id,chatId,conversationRef:ref,url:url.href,loading:true};
    }
    if(message.type==='tabs-send'||message.type==='tabs-read'){
      if(!internal(sender))throw Error('INTERNAL_ONLY');
      let tab=await chrome.tabs.get(message.tabId);
      const openedRecord=openedAgents.get(tab.id);
      if(openedRecord){
        for(let attempt=0;attempt<30;attempt++){
          const current=await chrome.tabs.get(tab.id);
          if(current.status==='complete'&&documents.has(tab.id)){await activate(tab.id);break;}
          if(attempt===29)throw Error('TARGET_PERMISSION_OR_UNSUPPORTED');
          await new Promise(resolve=>setTimeout(resolve,100));
        }
      }else await activate(tab.id);
      tab=await chrome.tabs.get(message.tabId);siteOf(tab.url);
      const candidates=(await engineCall(siteOf(tab.url),tab.id,'tabCandidates')).filter(ref=>ref.conversationId===message.chatId);
      const opened=openedRecord?.ref;
      if(opened?.conversationId===message.chatId&&!candidates.some(ref=>refKey(ref)===refKey(opened)))candidates.push(opened);
      const matches=candidates.filter(ref=>!message.ownerSite||message.ownerSite===ref.ownerSite);
      if(matches.length!==1)throw Error(matches.length?'AMBIGUOUS_CONVERSATION_REF':'CONTINUE_HERE_REQUIRED');
      const ref=matches[0];
      if(message.type==='tabs-send'&&opened&&refKey(opened)===refKey(ref)) {
        const target=documents.get(tab.id);await validTarget(target);
        const state=await coordinator({operation:'view',ref});
        if(!state.target){if(target.url!==openedRecord.url)throw Error('TARGET_INVALIDATED');await coordinator({operation:'continue',ref,viewId:'tab-agent:'+tab.id,target,expectedVersion:state.version});}
      }
      return engineCall(ref.ownerSite,tab.id,message.type==='tabs-send'?'receiveFromTab':'readAgent',
        message.type==='tabs-send'?[message.text,`agent ${message.fromChatId}`]:[message.limit],ref.conversationId);
    }
    throw new Error('未知扩展消息。');
  })().then(value=>respond({ok:true,value}),error=>respond({ok:false,code:error.code||error.message,notSubmitted:error.notSubmitted||(message.type==='continuation-call'&&!continuationForwarded),error:continuationErrorMessage(error),diagnostics:error.diagnostics}));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes['pi-tab-language']) return;
  void (async () => {
    const title = (await actionLocale()).t('打开 Pi Tab');
    await chrome.action.setTitle({title});
    for (const tab of await chrome.tabs.query({})) await chrome.action.setTitle({tabId:tab.id,title});
  })();
});

// A startup notification requests a fresh proof from live content scripts. Only
// the enabled-tab flag survives; document identities, grants and leases do not.
void (async()=>{
  const saved=await chrome.storage.session.get(null);
  await Promise.allSettled((await chrome.tabs.query({})).filter(tab=>saved[activeKey(tab.id)]).map(tab=>chrome.tabs.sendMessage(tab.id,{type:'worker-connected',workerEpoch})));
})().catch(()=>{});
