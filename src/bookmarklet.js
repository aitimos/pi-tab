export function createBookmarklet(source, { openChat, config, profiles = [], providers = [], mcp } = {}) {
  const code = `void(globalThis.__piTabRetryBookmark=async()=>{try{
    let pi=window.pi?.__piConsolePlugin?window.pi:window.__piTabAgent?.__piConsolePlugin?window.__piTabAgent:null;
    if(!pi){
      const deferred=globalThis.__piTabDeferredInstall;
      globalThis.__piTabDeferredInstall=true;
      try{${source}\n}finally{
        if(deferred===undefined)delete globalThis.__piTabDeferredInstall;
        else globalThis.__piTabDeferredInstall=deferred;
      }
      pi=PiConsolePlugin.install({globalName:'pi' in window?'__piTabAgent':'pi',independentStorage:globalThis.__piTabIndependentStorage===true});
      delete globalThis.__piTabIndependentStorage;
    }
    await pi.ready;
    ${profiles.length ? `pi.importProfiles(${JSON.stringify(profiles)});` : ''}
    ${providers.length ? `pi.importProviders(${JSON.stringify(providers)});` : ''}
    ${mcp && Object.keys(mcp.mcpServers || {}).length ? `await pi.importMcpConfig(${JSON.stringify(mcp)});` : ''}
    ${openChat ? `const launch={};
    if(!window.__piQuickChatOverlay){
      const chats=await pi.listChats();
      const openIds=JSON.parse(sessionStorage.getItem('pi-tab-open-chats')||'[]');
      const previous=chats.find(chat=>openIds.includes(chat.id))||chats.find(chat=>chat.active);
      const running=(previous?.busy&&previous)||chats.find(chat=>chat.busy);
      if(running)launch.chatId=running.id;
      else if(previous){
        if((await pi.agent(previous.id).history()).entries.length){launch.newAgent=true;launch.inheritFrom=previous.id;}
        else launch.chatId=previous.id;
      }
    }
    await (${openChat.toString()})(${JSON.stringify(config || {})},launch);` : ''}
  }catch(error){
    console.error('[Pi Tab]',error);
    const notice=document.createElement('div');
    notice.setAttribute('role','alert');
    notice.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:min(400px,calc(100vw - 32px));padding:12px 14px;border:.5px solid #484848;border-radius:10px;background:#191919;color:#eeeeee;font:13px/1.5 system-ui,sans-serif';
    const locale=window.pi?.i18n||window.__piTabAgent?.i18n;
    const language=localStorage.getItem('pi-tab-language')||'auto';
    const chinese=language==='zh-CN'||(language==='auto'&&(navigator.languages.find(value=>/^(zh|en)(-|$)/i.test(value))||'en').toLowerCase().startsWith('zh'));
    notice.textContent=(chinese?'Pi Tab 无法启动：':'Pi Tab could not start: ')+(locale?locale.t(error?.message||error):String(error?.message||error)).slice(0,240);
    if(['STORAGE_IN_USE_RETRY','STORAGE_LOCK_UNAVAILABLE'].includes(error.code)){
      const help=document.createElement('p');help.textContent=chinese?'书签历史仅限当前网站。跨站接续请点击扩展图标。':'Bookmark history belongs to this origin. Use the extension for cross-site continuation.';notice.append(help);
      const retry=document.createElement('button');retry.textContent=chinese?'重试':'Retry';retry.onclick=()=>{notice.remove();void globalThis.__piTabRetryBookmark();};notice.append(retry);
      const independent=document.createElement('button');independent.textContent=chinese?'新建独立对话':'New independent conversation';independent.onclick=()=>{globalThis.__piTabIndependentStorage=true;notice.remove();void globalThis.__piTabRetryBookmark();};notice.append(independent);
    }
    const close=document.createElement('button');
    close.type='button';close.textContent=chinese?'关闭':'Close';close.style.cssText='margin-left:12px;padding:4px 8px;border:.5px solid #484848;border-radius:6px;background:#2a2a2a;color:#eeeeee;cursor:pointer';
    close.onclick=()=>notice.remove();notice.append(close);
    (document.body||document.documentElement).append(notice);
  }})()`;
  // Keep the script in the URL's opaque path: a raw "?" makes the browser treat
  // the rest as a query and apply additional escaping, inflating its stored size.
  // Escape literal percent signs too, so "%xx" in strings survives execution.
  const url = new URL(`javascript:${code.replace(/[%?#\r\n\t]/g, char => encodeURIComponent(char))}`).href;
  // Chromium replaces URLs above this limit with an empty URL between processes.
  if (url.length > 2 * 1024 * 1024) throw new Error('书签内容过大，无法保存。');
  return url;
}
