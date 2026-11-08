import {extensionTestRpc} from './extension-test-rpc.mjs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdtemp,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createBookmarklet} from '../src/bookmarklet.js';
import {join,resolve} from 'node:path';
const output=process.env.PI_TAB_EVIDENCE?resolve(process.env.PI_TAB_EVIDENCE):await mkdtemp(join(tmpdir(),'pi-tab-continuations-evidence-'));console.log('Evidence:',output);
await (await import('node:fs/promises')).mkdir(output,{recursive:true});
const directory=await mkdtemp(join(tmpdir(),'pi-tab-continuations-')),requests=[];let heldRequests=0;const requestWaiters=new Set();
function observeRequest(predicate){const found=requests.find(predicate);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{requestWaiters.delete(listener);reject(Error('Expected model context was not observed'));},15000);const listener=input=>{if(predicate(input)){clearTimeout(timeout);requestWaiters.delete(listener);resolve(input);}};requestWaiters.add(listener);});}
let bookmark;
const server=createServer((request,response)=>{
  if(!request.url.endsWith('/chat/completions')){response.setHeader('Content-Type','text/html;charset=utf-8');response.end('<title>Continuation fixture</title><h1>'+request.url+'</h1><p id="target">untouched</p>'+(bookmark?'<a id="bookmark" href="'+bookmark.replaceAll('&','&amp;').replaceAll('\"','&quot;')+'">Pi Tab</a>':''));return;}
  let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
    const input=JSON.parse(body),title=input.messages.some(m=>['system','developer'].includes(m.role)&&JSON.stringify(m.content).includes('你是会话标题生成器'));
    if(!title){requests.push(input);for(const listener of requestWaiters)listener(input);}
    const last=input.messages.at(-1),content=typeof last.content==='string'?last.content:JSON.stringify(last.content);
    if(!title&&last.role==='user'&&content.includes('HOLD_RECOVERY')){heldRequests++;return;}
    const command=content.includes('PI_TAB_TOOL ')?JSON.parse(content.slice(content.indexOf('PI_TAB_TOOL ')+12)):null;
    const delta=title?{role:'assistant',content:'Continuation fixture'}:last.role==='tool'?{role:'assistant',content}:command?{role:'assistant',tool_calls:[{index:0,id:'tab_'+requests.length,type:'function',function:{name:command.name,arguments:JSON.stringify(command.args)}}]}:content.includes('TOOL_PAGE')?{role:'assistant',tool_calls:[{index:0,id:'tool_'+requests.length,type:'function',function:{name:'js_eval',arguments:JSON.stringify({code:'return {url:location.href,h1:document.querySelector("h1").textContent}'})}}]}:{role:'assistant',content:'REMEMBERED_ORIGINAL_CONTEXT'};
    response.writeHead(200,{'Content-Type':'text/event-stream'});response.end('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
});
await new Promise(r=>server.listen(0,'0.0.0.0',r));const port=server.address().port,base=`http://127.0.0.1:${port}`;
const extension=join(directory,'extension');await cp(resolve('dist/extension'),extension,{recursive:true});
const browser=await chromium.launchPersistentContext(join(directory,'profile'),{headless:true,executablePath:process.env.PI_TAB_TEST_CHROME||chromium.executablePath(),viewport:{width:1280,height:1000},locale:'zh-CN',args:['--no-sandbox','--no-proxy-server',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
const worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker');
const view=page=>page.locator('[data-pi-overlay]').last();
worker.on('console',message=>console.log('WORKER',message.text()));
const errors=[];
async function engineDiagnostics(page){
  const cdp=await browser.newCDPSession(page);
  try{
    const {targetInfos}=await cdp.send('Target.getTargets');
    const target=targetInfos.find(item=>item.url.endsWith('/engine.html'));
    if(!target)return {targets:targetInfos.map(item=>({type:item.type,url:item.url}))};
    const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
    const response=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Engine diagnostics timed out')),5000);cdp.on('Target.receivedMessageFromTarget',event=>{if(event.sessionId!==sessionId)return;const message=JSON.parse(event.message);if(message.id===1){clearTimeout(timer);resolve(message);}});});
    await cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:1,method:'Runtime.evaluate',params:{awaitPromise:true,returnByValue:true,expression:`(async()=>({locks:await navigator.locks.query(),runtimes:await Promise.all(Object.keys(window).filter(key=>key.startsWith('__pi_site_')).map(async key=>{const pi=window[key];return {key,harness:Boolean(pi.harness),conversation:pi.conversation?.id,ready:await Promise.race([pi.ready.then(()=>true,error=>error.message),new Promise(resolve=>setTimeout(()=>resolve('pending'),1000))]),inspection:pi.harness?await Promise.race([PiConsolePlugin.inspectRuntime(pi),new Promise(resolve=>setTimeout(()=>resolve('pending'),1000))]):null};}))}))()`}})});
    return await response;
  }finally{await cdp.detach();}
}
browser.on('page',page=>{page.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message);});page.on('console',message=>{if(message.type()==='error')console.log('CONSOLE',message.text());});});
async function activate(page,url){
  await page.goto(url);await page.waitForTimeout(300);
  const result=await worker.evaluate(async url=>{const [tab]=await chrome.tabs.query({url});await chrome.storage.session.set({['active:'+tab.id]:true});return chrome.tabs.sendMessage(tab.id,{type:'activate',openWindow:true});},url);
  assert.equal(result.ok,true,result.error);await view(page).locator('#settings:enabled').waitFor();
}
async function send(page,text){await view(page).locator('#message-input').fill(text);await view(page).locator('#send').click();await view(page).locator('#abort').waitFor({state:'hidden'});}
try{
  await worker.evaluate(async base=>{await chrome.storage.local.set({profiles:[{id:'fixture',api:'openai-completions',baseUrl:base+'/v1',apiKey:'test-only',model:'fixture',thinking:'off',reasoning:false}],providers:[]});},base);
  const a=await browser.newPage();await activate(a,base+'/source');await view(a).locator('#continue-here').click();await send(a,'ORIGINAL_TASK_CONTEXT');
  await a.waitForFunction(()=>document.querySelector('[data-pi-overlay]')?.shadowRoot?.getElementById('chat-messages').textContent.includes('REMEMBERED_ORIGINAL_CONTEXT'));
  await a.screenshot({path:join(output,'source.png')});
  const sourceTab=await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0].id,base+'/source');
  const call=async(name,args={})=>{const response=await worker.evaluate(extensionTestRpc,{site:'127.0.0.1',tabId:sourceTab,method:'agent',chatId:1,name:'prompt',args:['PI_TAB_TOOL '+JSON.stringify({name,args})]});assert.ok(response.ok,response.error);try{return JSON.parse(response.value);}catch{throw Error(response.value);}};
  const independent=await call('tab_open',{url:`http://localhost:${port}/independent`});
  await call('tab_list');
  const sent=await call('tab_send',{tabId:independent.tabId,chatId:independent.chatId,message:'TOOL_PAGE'});assert.equal(sent.to,independent.chatId);
  await call('tab_read',{tabId:independent.tabId,chatId:independent.chatId});
  const sameSite=await call('tab_open',{url:base+'/independent-same'});
  const sameSent=await call('tab_send',{tabId:sameSite.tabId,chatId:sameSite.chatId,message:'TOOL_PAGE'});assert.equal(sameSent.to,sameSite.chatId);
  await call('tab_read',{tabId:sameSite.tabId,chatId:sameSite.chatId});
  console.log('PASS cross-site and same-site tab_open independent agents, legacy tab_send and tab_read');
  for(const host of ['127.0.0.1','sub.localhost','localhost']){
    const url=`http://${host}:${port}/target-${host}`,b=await browser.newPage();await activate(b,url);
    await view(b).locator('#choose-history').click();const picker=b.frameLocator('iframe[title="历史对话"]');
    await b.screenshot({path:join(output,`picker-${host}.png`)});
    await picker.locator('button[data-ref="'+encodeURIComponent(JSON.stringify(['127.0.0.1',1]))+'"]').click();
    await view(b).locator('#continuation-summary').filter({hasText:'Continuation fixture · 127.0.0.1'}).waitFor();
    const before=requests.length;await view(b).locator('#message-input').fill('TOOL_PAGE');await view(b).locator('#send').click();assert.equal(requests.length,before,'viewing must not submit');
    await view(b).locator('#continue-here').click();await view(b).locator('#send').click();
    await b.waitForFunction(url=>document.querySelector('[data-pi-overlay]')?.shadowRoot?.getElementById('chat-messages').textContent.includes(url),url);
    const observed=await observeRequest(input=>JSON.stringify(input.messages).includes('ORIGINAL_TASK_CONTEXT')&&input.messages.some(message=>message.role==='tool'&&JSON.stringify(message.content).includes(url)));
    assert.ok(observed.messages.some(message=>message.role==='tool'&&JSON.stringify(message.content).includes(url)));
    await b.screenshot({path:join(output,`continue-${host}.png`)});
    if(host==='localhost'){await worker.evaluate(()=>chrome.storage.local.set({'pi-tab-language':'en'}));await view(b).locator('#continuation-summary').filter({hasText:'Conversation:'}).waitFor();await b.setViewportSize({width:600,height:900});await b.screenshot({path:join(output,'continuation-en-narrow.png')});await b.setViewportSize({width:1280,height:1000});await worker.evaluate(()=>chrome.storage.local.set({'pi-tab-language':'zh-CN'}));}
    // Same-URL reload must revoke the old authorization, while history remains readable.
    await b.reload();await view(b).locator('#continue-here').waitFor();
    const count=requests.length;await view(b).locator('#message-input').fill('TOOL_PAGE');await view(b).locator('#send').click();assert.equal(requests.length,count);
    await b.screenshot({path:join(output,`reload-${host}.png`)});
    await b.close();console.log('PASS continuation',host);
  }
  // Rebuild history without a source tab or a live Harness.
  await a.close();await worker.evaluate(()=>chrome.offscreen.closeDocument());
  const cold=await browser.newPage();await activate(cold,`http://localhost:${port}/cold`);
  const coldTab=await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0].id,cold.url());
  await worker.evaluate(async tabId=>{await chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',func:()=>{
    const send=chrome.runtime.sendMessage.bind(chrome.runtime);let delayed=false;
    chrome.runtime.sendMessage=(message,callback)=>{
      if(!delayed&&message.type==='continuation-call'&&message.operation==='view'&&message.ref.ownerSite==='localhost'){
        delayed=true;return send(message,response=>{window.__releaseNativeView=()=>{chrome.runtime.sendMessage=send;callback({...response,value:{...response.value,title:'STALE_NATIVE_TITLE'}});};});
      }
      return send(message,callback);
    };
    const locale=window.__piTabAgent.i18n;locale.setMode(locale.mode,false);
  }});},coldTab);
  await worker.evaluate(async tabId=>{for(let i=0;i<100;i++){const [result]=await chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',func:()=>Boolean(window.__releaseNativeView)});if(result.result)return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Delayed view fixture did not start');},coldTab);
  const beforeCold=requests.length;await view(cold).locator('#choose-history').click();
  const picker=cold.frameLocator('iframe[title="历史对话"]');
  await picker.locator('button[data-ref="'+encodeURIComponent(JSON.stringify(['127.0.0.1',1]))+'"]').click();
  await Promise.race([view(cold).locator('#continuation-summary').filter({hasText:'Continuation fixture · 127.0.0.1'}).waitFor(),picker.locator('#error').filter({hasText:/\S/}).waitFor().then(async()=>{throw Error('Cold picker: '+await picker.locator('#error').innerText());}),view(cold).locator('#continuation-error').filter({hasText:/\S/}).waitFor().then(async()=>{throw Error('Cold view: '+await view(cold).locator('#continuation-error').innerText());})]);
  await worker.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',func:async()=>{window.__releaseNativeView();delete window.__releaseNativeView;await new Promise(requestAnimationFrame);}}),coldTab);
  assert.ok(!(await view(cold).locator('#continuation-summary').innerText()).includes('STALE_NATIVE_TITLE'),'late native view must not replace the selected conversation');
  assert.equal(requests.length,beforeCold);await view(cold).locator('#continue-here').click();await send(cold,'TOOL_PAGE');
  await cold.waitForFunction(()=>document.querySelector('[data-pi-overlay]')?.shadowRoot?.getElementById('chat-messages').textContent.includes('/cold'));
  await cold.screenshot({path:join(output,'cold-history.png')});console.log('PASS cold history with source tab closed');
  await cold.close();
  // Persist two real running conversations, recreate the background, and prove
  // reading/clearing cannot replay either interrupted model request.
  const interrupted=await browser.newPage();await activate(interrupted,base+'/recovery');
  let recoveryView=view(interrupted);await recoveryView.locator('#continue-here').click();
  await recoveryView.locator('#message-input').fill('HOLD_RECOVERY_1');await recoveryView.locator('#send').click();
  while(heldRequests<1)await interrupted.waitForTimeout(25);
  await recoveryView.locator('#new-agent').click();await interrupted.locator('[data-pi-overlay]').nth(1).waitFor();
  recoveryView=interrupted.locator('[data-pi-overlay]').nth(1);await recoveryView.locator('#continue-here').click();await recoveryView.locator('#message-input').fill('HOLD_RECOVERY_2');await recoveryView.locator('#send').click();
  while(heldRequests<2)await interrupted.waitForTimeout(25);
  await worker.evaluate(()=>chrome.offscreen.closeDocument());const recoveryCount=requests.length;
  await interrupted.reload();await view(interrupted).locator('#recover-source').waitFor();
  assert.equal(requests.length,recoveryCount,'cold reading resumed a model');
  await interrupted.screenshot({path:join(output,'recovery-required.png')});
  interrupted.once('dialog',dialog=>dialog.accept());await view(interrupted).locator('#recover-source').click();
  await view(interrupted).locator('#recover-source').waitFor({state:'hidden'});assert.equal(requests.length,recoveryCount,'recovery replayed a model');
  await view(interrupted).locator('#continue-here').click();await send(interrupted,'TOOL_PAGE');
  await view(interrupted).locator('#chat-messages').filter({hasText:'/recovery'}).waitFor();
  await interrupted.screenshot({path:join(output,'recovery-cleared.png')});await interrupted.close();console.log('PASS two interrupted conversations remain paused and clear without model replay');

  const installer=await readFile('pi-bookmarklet-chat-install.html','utf8');
  const runtime=JSON.parse(installer.match(/<script id="pi-runtime"[^>]*>(.*?)<\/script>/s)[1]);
  const profile={id:'bookmark',api:'openai-completions',baseUrl:base+'/v1',apiKey:'test-only',model:'fixture',thinking:'off',reasoning:false};
  bookmark=createBookmarklet(runtime);
  const parent=await browser.newPage();await parent.goto(base+'/bookmark-parent');await parent.locator('#bookmark').click();
  await parent.waitForFunction(()=>window.pi?.__piConsolePlugin);await parent.evaluate(async profile=>{await pi.ready;await pi.configure(profile);await pi.prompt('BOOKMARK_ORIGINAL_CONTEXT');},profile);
  const storageName=await parent.evaluate(()=>sessionStorage.getItem('pi-tab-storage-name'));
  const childPromise=browser.waitForEvent('page');await parent.evaluate(url=>window.open(url),base+'/bookmark-child');const child=await childPromise;await child.waitForLoadState();
  const started=Date.now();await child.locator('#bookmark').click();await child.getByRole('alert').waitFor();assert.ok(Date.now()-started<5000);
  assert.ok((await child.getByRole('alert').innerText()).includes('另一标签页'));assert.equal(await child.evaluate(()=>sessionStorage.getItem('pi-tab-storage-name')),storageName);
  assert.deepEqual(await child.evaluate(async()=> (await navigator.locks.query()).pending),[]);
  await child.screenshot({path:join(output,'bookmark-occupied.png')});
  await parent.evaluate(()=>pi.dispose());await child.getByRole('button',{name:'重试',exact:true}).click();
  await child.waitForFunction(()=>window.pi?.__piConsolePlugin);assert.ok(JSON.stringify(await child.evaluate(async()=>{await pi.ready;return pi.history();})).includes('BOOKMARK_ORIGINAL_CONTEXT'));
  await child.reload();await child.locator('#bookmark').click();await child.waitForFunction(()=>window.pi?.__piConsolePlugin);assert.ok(JSON.stringify(await child.evaluate(async()=>{await pi.ready;return pi.history();})).includes('BOOKMARK_ORIGINAL_CONTEXT'));
  await child.screenshot({path:join(output,'bookmark-reloaded.png')});console.log('PASS bookmark opener bounded lock, release retry and actual reload history');
  await child.close();await parent.close();
  const unsupported=await browser.newPage();await unsupported.goto(base+'/no-locks');await unsupported.evaluate(()=>Object.defineProperty(navigator,'locks',{value:undefined}));await unsupported.locator('#bookmark').click();
  await unsupported.getByRole('alert').waitFor();assert.ok((await unsupported.getByRole('alert').innerText()).includes('独占锁'));
  await unsupported.getByRole('button',{name:'新建独立对话'}).click();await unsupported.waitForFunction(()=>window.pi?.__piConsolePlugin);await unsupported.evaluate(()=>pi.ready);await unsupported.close();console.log('PASS no-Web-Locks explicit independent storage');
  assert.deepEqual(errors,[]);await writeFile(join(output,'continuations.json'),JSON.stringify({browser:browser.browser()?.version(),requests,errors},null,2));
}catch(error){console.log('ENGINE',JSON.stringify(await engineDiagnostics(browser.pages().at(-1)).catch(error=>({error:error.message}))));for(const [i,page]of browser.pages().entries()){await page.screenshot({path:join(output,'failure-'+i+'.png')}).catch(()=>{});console.log(JSON.stringify({url:page.url(),views:await page.locator('[data-pi-overlay]').evaluateAll(hosts=>hosts.map(host=>Object.fromEntries(['continuation-summary','continuation-error','status','setup-error'].map(id=>[id,host.shadowRoot?.getElementById(id)?.textContent])))).catch(()=>[]),frames:await Promise.all(page.frames().map(async frame=>({url:frame.url(),error:await frame.locator('#error').innerText({timeout:250}).catch(()=>null)})))}));}throw error;}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
