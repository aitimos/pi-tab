// Test-only controller helper. Runs the shipped public content API in its isolated
// world; no test bridge or controller is included in the extension package.
export async function extensionTestRpc({tabId,site,method,args=[],chatId,name}) {
  try {
    if(method==='createChat'){
      for(let i=0;i<50;i++){
        try{const response=await chrome.tabs.sendMessage(tabId,{type:'activate'});if(response?.ok)break;}catch{}
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    }
    const [result]=await chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',func:async({site,method,args,chatId,name})=>{
      try { return {value:await (async()=>{
      const pi=window.__piTabAgent;
      if(!pi)throw Error('Content API unavailable');
      const key=id=>JSON.stringify([site,id]);
      if(method==='initialize')return {activeId:JSON.parse(pi.conversation.id)[1]};
      if(method==='listChats')return (await pi.listChats()).map(chat=>({...chat,id:JSON.parse(chat.id)[1]}));
      if(method==='createChat')return JSON.parse(await pi.createChat({inheritFrom:args[0]?key(args[0]):undefined}))[1];
      if(method==='deleteChat'){const value=await pi.deleteChat(key(args[0]));return {...value,replacementId:JSON.parse(value.replacementId)[1]};}
      const agent=pi.agent(key(chatId??JSON.parse(pi.conversation.id)[1]));await agent.ready;
      if(method==='selectChat')return agent.selectChat(key(chatId));
      if(method==='recoverSource')return agent.recoverSource();
      if(method==='agent'){
        if(['prompt','steer','followUp','runTool','reset','changeQueuedMessage'].includes(name)&&!agent.authorized)await agent.continueHere();
        return agent[name](...args);
      }
      if(method==='readAgent'){const history=await agent.history();return history.entries;}
      return pi[method](...args);
      })()};}catch(error){return {error:error.message};}
    },args:[{site,method,args,chatId,name}]});
    if(result.error)throw Error(result.error.message||String(result.error));
    if(result.result?.error)throw Error(result.result.error);
    return {ok:true,value:result.result?.value};
  }catch(error){return {ok:false,error:error.message};}
}
