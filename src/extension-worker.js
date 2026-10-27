import { createI18n } from './i18n.js';

async function actionLocale() {
  const saved = await chrome.storage.local.get('pi-tab-language');
  return createI18n({mode:saved['pi-tab-language'] || 'auto',languages:await chrome.i18n.getAcceptLanguages()});
}

const activeKey = tabId => `active:${tabId}`;
const siteOf = url => {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Pi Tab 只能在普通网页使用。');
  return parsed.hostname.toLowerCase();
};
let openingEngine;
const pageTools = new Map();

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
  await chrome.storage.session.remove(activeKey(tabId));
  if (!await chrome.offscreen.hasDocument()) return;
  const response = await chrome.runtime.sendMessage({type:'tab-closed',tabId});
  if (!response?.ok) console.error('[Pi Tab]',response?.error || 'Could not stop closed tab tasks');
});
chrome.tabs.onUpdated.addListener((tabId,change) => {
  if(change.status!=='complete')return;
  void chrome.storage.session.get(activeKey(tabId)).then(saved=>{if(saved[activeKey(tabId)])return activate(tabId);}).catch(error=>console.error('[Pi Tab]',error));
});

chrome.runtime.onMessage.addListener((message,sender,respond) => {
  if(message.target==='engine'||message.type==='shared-config-updated'||message.type==='tab-closed')return false;
  (async()=>{
    if(message.type==='shared-config'){
      if(message.operation==='get')return chrome.storage.local.get(['profiles','providers']);
      const saved=await chrome.storage.local.get(['profiles','providers']);
      if(message.operation==='profile-save'){
        saved.profiles=[...(saved.profiles||[]).filter(item=>item.id!==message.profile.id),message.profile];
      }else if(message.operation==='provider-save'){
        saved.providers=[...(saved.providers||[]).filter(item=>item.id!==message.provider.id),message.provider];
      }else throw new Error('未知设置操作。');
      await chrome.storage.local.set(saved);
      await chrome.runtime.sendMessage({type:'shared-config-updated',profiles:saved.profiles||[],providers:saved.providers||[]});
      return true;
    }
    if(message.type==='identity'){
      const tabId=sender.tab?.id;
      if(!tabId)throw new Error('无法确定当前标签页。');
      const saved=await chrome.storage.session.get(activeKey(tabId));
      return {tabId,site:siteOf(sender.tab.url),active:Boolean(saved[activeKey(tabId)])};
    }
    if(message.type==='engine-call'){
      const tabId=sender.tab?.id;
      if(!tabId)throw new Error('无法确定当前标签页。');
      return engineCall(siteOf(sender.tab.url),tabId,message.method,message.args,message.chatId,message.name);
    }
    if(message.type==='cancel-page-tool'){
      pageTools.get(message.requestId)?.abort();
      await chrome.tabs.sendMessage(message.tabId,{type:'cancel-tool',requestId:message.requestId}).catch(()=>{});
      return true;
    }
    if(message.type==='page-tool'){
      const controller=new AbortController();
      pageTools.set(message.requestId,controller);
      try {
        for(let attempt=0;attempt<20;attempt++){
          controller.signal.throwIfAborted();
          const tab=await chrome.tabs.get(message.tabId);
          if(!tab?.url || siteOf(tab.url)!==message.site)throw new Error('目标网页已关闭或离开当前站点，请重新选择目标页面。');
          controller.signal.throwIfAborted();
          let response;
          try{
            response=await chrome.tabs.sendMessage(tab.id,{type:'execute-tool',requestId:message.requestId,name:message.name,args:message.args});
          }catch(error){
            if(attempt===19 || !/Receiving end does not exist|Could not establish connection|message port closed/i.test(error.message))throw error;
            await new Promise(resolve=>setTimeout(resolve,300));
            continue;
          }
          if(!response?.ok)throw new Error(response?.error||'网页工具执行失败。');
          return response.value;
        }
      } finally { pageTools.delete(message.requestId); }
    }
    if(message.type==='engine-event'){
      const tabs=await chrome.tabs.query({});
      await Promise.all(tabs.filter(tab=>tab.id&&tab.url&&(()=>{try{return siteOf(tab.url)===message.site;}catch{return false;}})())
        .map(tab=>chrome.tabs.sendMessage(tab.id,{type:'engine-event',event:message.event}).catch(()=>{})));
      return true;
    }
    if(message.type==='tabs-list'){
      const tabs=await chrome.tabs.query({});
      const listed=[];
      for(const tab of tabs){
        if(!tab.id||!tab.url)continue;
        let site;try{site=siteOf(tab.url);}catch{continue;}
        const saved=await chrome.storage.session.get(activeKey(tab.id));
        if(!saved[activeKey(tab.id)])continue;
        listed.push({tabId:tab.id,title:tab.title,url:tab.url,agents:await engineCall(site,tab.id,'listChats')});
      }
      return {tabs:listed};
    }
    if(message.type==='tabs-open'){
      const url=new URL(message.url);
      const site=siteOf(url.href);
      const tab=await chrome.tabs.create({url:'about:blank',active:false});
      const chatId=await engineCall(site,tab.id,'createChat',site===message.sourceSite?[message.fromChatId]:[]);
      await chrome.storage.session.set({[activeKey(tab.id)]:true});
      await chrome.tabs.update(tab.id,{url:url.href});
      return {tabId:tab.id,chatId,url:url.href,loading:true};
    }
    if(message.type==='tabs-send'||message.type==='tabs-read'){
      const tab=await chrome.tabs.get(message.tabId);
      const site=siteOf(tab.url);
      await activate(tab.id);
      return engineCall(site,tab.id,message.type==='tabs-send'?'receiveFromTab':'readAgent',
        message.type==='tabs-send'?[message.text,`标签页 ${sender.tab?.id||'其他'} 的 agent ${message.fromChatId}`]:[message.limit],message.chatId);
    }
    throw new Error('未知扩展消息。');
  })().then(value=>respond({ok:true,value}),error=>respond({ok:false,error:error.message||String(error)}));
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
