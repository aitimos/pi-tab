import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {cp,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const output=process.env.PI_TAB_EVIDENCE?resolve(process.env.PI_TAB_EVIDENCE):await mkdtemp(join(tmpdir(),'pi-tab-worker-evidence-'));
await mkdir(output,{recursive:true});
const directory=await mkdtemp(join(tmpdir(),'pi-tab-worker-')),requests=[],held=[],cases=[],errors=[];
let callId=0;
function answer(response,input,title){
  const last=input.messages.at(-1),text=JSON.stringify(last.content);
  const code=text.includes('WAIT_TOOL')?'document.documentElement.dataset.waiting="yes";await new Promise(()=>{});':'document.querySelector("#target").textContent=location.href;return {url:location.href,businessState:document.documentElement.dataset.businessState}';
  const tool=!title&&last.role==='user'&&/WRITE_TARGET|WAIT_TOOL/.test(text);
  const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'worker_'+(++callId),type:'function',function:{name:'js_eval',arguments:JSON.stringify({code,timeoutMs:60000})}}]}:{role:'assistant',content:title?'Worker task':'WORKER_ACK'};
  response.writeHead(200,{'Content-Type':'text/event-stream'});response.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta,finish_reason:tool?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
}
const server=createServer((request,response)=>{
  if(!request.url.endsWith('/chat/completions')){response.setHeader('Content-Type','text/html;charset=utf-8');response.end('<title>Worker recovery</title><h1>Worker recovery fixture</h1><p id="target">untouched</p><button id="spa" onclick="history.pushState({},\'\',\'/after-restart-spa\');document.querySelector(\'#target\').textContent=\'untouched\'">SPA route</button>');return;}
  let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
    const input=JSON.parse(body),title=input.messages.some(m=>['system','developer'].includes(m.role)&&JSON.stringify(m.content).includes('你是会话标题生成器'));
    if(!title)requests.push(input);
    if(!title&&input.messages.at(-1).role==='user'&&JSON.stringify(input.messages.at(-1).content).includes('HOLD_WORKER'))held.push(()=>answer(response,input,title));
    else answer(response,input,title);
  });
});
await new Promise(done=>server.listen(0,'0.0.0.0',done));
const base=`http://127.0.0.1:${server.address().port}`,extension=join(directory,'extension');
await cp(resolve(process.env.PI_TAB_TEST_EXTENSION||'dist/extension'),extension,{recursive:true});
await writeFile(join(extension,'test-worker-controller.html'),'<!doctype html><title>Worker test controller</title>');
const browser=await chromium.launchPersistentContext(join(directory,'profile'),{headless:true,executablePath:process.env.PI_TAB_TEST_CHROME||chromium.executablePath(),viewport:{width:1400,height:1000},locale:'zh-CN',args:['--no-sandbox','--no-proxy-server',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
browser.setDefaultTimeout(10000);
browser.on('page',page=>page.on('pageerror',error=>errors.push({message:error.message,stack:error.stack,page:page.url()})));
const worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker'),workerUrl=worker.url();
// The controller has no picker initialization or pending grant requests.
// Chromium may retain the worker target ID across execution-context replacement.
const control=await browser.newPage();await control.goto(workerUrl.replace(/worker\.js$/,'test-worker-controller.html'));
const ui=page=>page.locator('[data-pi-overlay]').last(),versions=[];
const record=name=>{cases.push(name);console.log('PASS',name);};
async function send(page,text){await ui(page).locator('#message-input').fill(text);await ui(page).locator('#send').click();await ui(page).locator('#abort').waitFor({state:'hidden'});}
async function openChatMenu(page){const menu=ui(page).locator('#chat-list');if(await menu.getAttribute('data-open')!=='true')await ui(page).locator('#chat-switch').click();await menu.waitFor({state:'visible'});}
async function historyClosed(page){await page.locator('iframe[title="历史对话"]').waitFor({state:'detached'});await ui(page).locator('#chat-list').waitFor({state:'hidden'});}
async function openHistory(page){await openChatMenu(page);await ui(page).locator('#choose-history').click();}
async function waitUnbound(page){await openChatMenu(page);await ui(page).locator('#target-return').waitFor({state:'hidden'});await ui(page).locator('#chat-switch').click();await ui(page).locator('#chat-list').waitFor({state:'hidden'});}
async function activate(page,url){await page.goto(url);const result=await control.evaluate(async url=>{const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);await chrome.storage.session.set({['active:'+tab.id]:true});return chrome.tabs.sendMessage(tab.id,{type:'activate',openWindow:true});},url);assert.equal(result.ok,true,result.error);await ui(page).locator('#settings:enabled').waitFor();}
async function isolated(page,func,args){
  const tabId=await control.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,page.url());
  return control.evaluate('(async()=>{const [result]=await chrome.scripting.executeScript({target:{tabId:'+tabId+'},world:"ISOLATED",func:'+func.toString()+',args:['+JSON.stringify(args??null)+']});return {value:result.result,documentId:result.documentId};})()');
}
// Wake and reconnect through the shipped read-only content API. These restart
// cases verify execution ownership, independently of transient menu rendering.
async function readView(page){
  const result=await isolated(page,async()=>{
    const pi=window.__piTabAgent,agent=pi.agent(pi.conversation.id);
    await agent.ready;await agent.refreshBinding();return {authorized:agent.authorized};
  });
  assert.equal(result.value.authorized,false,'a reconnecting read cannot acquire execution authority');
}
async function choose(page,close=true){await openHistory(page);const picker=page.frameLocator('iframe[title="历史对话"]');await picker.locator('button[data-ref]').first().waitFor();await page.screenshot({path:join(output,'picker-'+cases.length+'.png')});if(close){await picker.locator('button[data-ref="'+encodeURIComponent(JSON.stringify(['127.0.0.1',1]))+'"]').click();await historyClosed(page);}}
async function closePicker(page){if(await page.locator('iframe[title="历史对话"]').count()){const close=page.frameLocator('iframe[title="历史对话"]').locator('#close');await close.focus();await close.screenshot({path:join(output,'picker-close-'+cases.length+'.png')});await close.press('Enter');await historyClosed(page);}}
let cdp;
async function restart(action,{closeEngine=false}={}){
  const before=(await cdp.send('Target.getTargets')).targetInfos,engine=before.find(target=>target.url.endsWith('/engine.html'));
  if(closeEngine)await control.evaluate(()=>chrome.offscreen.closeDocument());
  const version=versions.findLast(item=>item.scriptURL===workerUrl&&item.runningStatus==='running');assert.ok(version,'running worker version missing');
  const running=new Promise((resolve,reject)=>{
    let stopped=false;const cleanup=()=>{clearTimeout(timer);cdp.off('ServiceWorker.workerVersionUpdated',listener);};
    const listener=event=>{for(const item of event.versions)if(item.versionId===version.versionId){if(item.runningStatus==='stopped')stopped=true;if(stopped&&item.runningStatus==='running'){cleanup();resolve();}}};
    const timer=setTimeout(()=>{cleanup();reject(Error('worker did not restart'));},10000);cdp.on('ServiceWorker.workerVersionUpdated',listener);
  });
  void running.catch(()=>{});
  await cdp.send('ServiceWorker.stopWorker',{versionId:version.versionId});
  await action();await running;
  const after=(await cdp.send('Target.getTargets')).targetInfos;
  if(!closeEngine)assert.ok(after.some(target=>target.targetId===engine?.targetId),'offscreen identity changed');
  assert.ok(versions.some(item=>item.versionId===version.versionId&&item.runningStatus==='stopped'));
}
try{
  await control.evaluate(base=>chrome.storage.local.set({profiles:[{id:'worker',api:'openai-completions',baseUrl:base+'/v1',apiKey:'test-only',model:'fixture',thinking:'off',reasoning:false}],providers:[]}),base);
  const a=await browser.newPage(),b=await browser.newPage();await activate(a,base+'/execution');await activate(b,`http://localhost:${server.address().port}/observer`);
  await a.evaluate(()=>document.documentElement.dataset.businessState='kept');
  const identity=await isolated(a,()=>{window.__workerOriginalPi=window.__piTabAgent;const send=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=(message,callback)=>{if(message.workerEpoch)window.__workerCurrentEpoch=message.workerEpoch;if(!window.__workerOldMessage&&message.type==='continuation-call'&&message.name==='prompt')window.__workerOldMessage=structuredClone(message);return send(message,callback);};return true;});
  await send(a,'WORKER_ORIGINAL_CONTEXT');await choose(b);
  await choose(b,false);await closePicker(b);
  cdp=await browser.newCDPSession(a);cdp.on('ServiceWorker.workerVersionUpdated',event=>versions.push(...event.versions));await cdp.send('ServiceWorker.enable');
  // A picker open during restart must be closed; its grant cannot be revived.
  await choose(b,false);const before=requests.length;
  // Suppress the startup hint for A to exercise the bounded request fallback.
  await control.evaluate(async url=>{const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);await chrome.storage.session.set({['active:'+tab.id]:false});},a.url());
  await restart(async()=>{await ui(a).locator('#message-input').fill('UNSENT_AFTER_WORKER');await ui(a).locator('#send').click();});
  await waitUnbound(a);
  await ui(a).locator('#abort').waitFor({state:'hidden'});
  await historyClosed(b);
  assert.equal(requests.length,before,'restart blindly resubmitted a message');
  assert.equal(await ui(a).locator('#message-input').inputValue(),'UNSENT_AFTER_WORKER','a definitely rejected input should remain a draft');
  const retained=await isolated(a,()=>window.__workerOriginalPi===window.__piTabAgent);assert.equal(retained.documentId,identity.documentId);assert.equal(retained.value,true);assert.equal(await a.evaluate(()=>document.documentElement.dataset.businessState),'kept');
  const stale=await isolated(a,()=>{window.__workerRecoveredEpoch=window.__workerCurrentEpoch;return chrome.runtime.sendMessage(window.__workerOldMessage);});assert.equal(stale.value.ok,false);assert.equal(requests.length,before);
  const lease=await isolated(a,()=>chrome.runtime.sendMessage({...window.__workerOldMessage,workerEpoch:window.__workerRecoveredEpoch,clientRequestId:'stale-lease-new-worker'}));assert.equal(lease.value.code,'CONTINUE_HERE_REQUIRED');assert.equal(requests.length,before);
  await a.screenshot({path:join(output,'worker-reconnected-unbound.png')});
  await choose(b);
  await isolated(a,()=>{
    const send=chrome.runtime.sendMessage.bind(chrome.runtime);let delayed=false;
    chrome.runtime.sendMessage=(message,callback)=>{if(!delayed&&message.type==='continuation-call'&&message.operation==='view'&&message.ref.ownerSite==='127.0.0.1'){delayed=true;return send(message,response=>{chrome.runtime.sendMessage=send;window.__releaseWorkerView=()=>callback(response);});}return send(message,callback);};
    window.__staleWorkerView=window.__piTabAgent.agent(JSON.stringify(['127.0.0.1',1])).ready;
  });
  const delayed=await isolated(a,async()=>{for(let i=0;i<100;i++){if(window.__releaseWorkerView)return true;await new Promise(done=>setTimeout(done,20));}return false;});assert.equal(delayed.value,true);

  await send(a,'WORKER_NEW_SEND_AFTER_RESTART');
  await isolated(a,async()=>{window.__releaseWorkerView();await window.__staleWorkerView;delete window.__releaseWorkerView;delete window.__staleWorkerView;});
  const valid=await isolated(a,()=>window.__piTabAgent.agent(JSON.stringify(['127.0.0.1',1])).authorized);assert.equal(valid.value,true,'a delayed view must not erase a newer lease');
  await send(a,'WRITE_TARGET AFTER_RESTART');await a.locator('#target').filter({hasText:a.url()}).waitFor();
  await ui(b).locator('#chat-messages').filter({hasText:'AFTER_RESTART'}).waitFor();assert.equal(await b.locator('#target').innerText(),'untouched');
  assert.ok(requests.some(input=>JSON.stringify(input.messages).includes('WORKER_ORIGINAL_CONTEXT')&&input.messages.some(message=>message.role==='tool'&&JSON.stringify(message.content).includes(a.url()))));
  await a.screenshot({path:join(output,'worker-recontinued.png')});record('worker-only restart preserves document/offscreen, revokes lease and restores cross-site subscriptions and picker');
  await control.evaluate(async url=>{const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);await chrome.storage.session.set({['active:'+tab.id]:true});},a.url());

  await ui(a).locator('#message-input').fill('HOLD_WORKER accepted once');await ui(a).locator('#send').click();
  while(!held.length)await a.waitForTimeout(20);
  await ui(a).locator('#message-input').fill('QUEUED_WORKER accepted once');await ui(a).locator('#send').click();
  await ui(a).locator('[data-queue-id]').first().waitFor();
  const heldCount=requests.length;
  await restart(()=>readView(b));
  assert.equal(requests.length,heldCount,'an accepted request was replayed');
  await ui(a).locator('#message-input').fill('BUSY_MUST_NOT_SEND');await ui(a).locator('#send').click();await ui(a).locator('#chat-messages').filter({hasText:'任务正在运行'}).waitFor();assert.equal(await ui(a).locator('#message-input').inputValue(),'BUSY_MUST_NOT_SEND');assert.equal(requests.length,heldCount);await a.screenshot({path:join(output,'busy-draft-preserved.png')});
  held.shift()();await ui(a).locator('#abort').waitFor({state:'hidden'});await ui(a).locator('[data-queue-id]').waitFor({state:'detached'});
  const userContains=(input,text)=>input.messages.at(-1).role==='user'&&JSON.stringify(input.messages.at(-1).content).includes(text);
  assert.equal(requests.filter(input=>userContains(input,'HOLD_WORKER')).length,1);assert.equal(requests.filter(input=>userContains(input,'QUEUED_WORKER')).length,1);
  record('accepted prompt and queue survive worker restart without replay or busy-target switching');

  await ui(a).locator('#message-input').fill('WAIT_TOOL');await ui(a).locator('#send').click();await a.waitForFunction(()=>document.documentElement.dataset.waiting==='yes');
  await restart(()=>readView(b));await ui(a).locator('#abort').waitFor({state:'hidden'});await waitUnbound(a);
  record('in-flight tool wait and UI busy state recover after worker termination');

  await restart(()=>readView(a),{closeEngine:true});
  await send(a,'WRITE_TARGET AFTER_BOTH_RESTART');await a.locator('#target').filter({hasText:a.url()}).waitFor();
  assert.ok(requests.some(input=>input.messages.at(-1).role==='user'&&JSON.stringify(input.messages.at(-1).content).includes('AFTER_BOTH_RESTART')&&JSON.stringify(input.messages).includes('WORKER_ORIGINAL_CONTEXT')));
  const same=await isolated(a,()=>window.__workerOriginalPi===window.__piTabAgent);assert.equal(same.documentId,identity.documentId);assert.equal(same.value,true);
  await a.locator('#spa').click();await waitUnbound(a);await send(a,'WRITE_TARGET AFTER_RESTART_SPA');await a.locator('#target').filter({hasText:a.url()}).waitFor();
  await a.screenshot({path:join(output,'worker-and-engine-recovered-spa.png')});record('worker and offscreen recreation then SPA retain context and allow only a new user send');
  await a.close();await waitUnbound(b);await send(b,'WRITE_TARGET AFTER_EXECUTOR_CLOSE');await b.locator('#target').filter({hasText:b.url()}).waitFor();
  const c=await browser.newPage();await activate(c,`http://sub.localhost:${server.address().port}/protected-observer`);await choose(c);
  const protectedTab=await control.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,b.url()),protectedCount=requests.length;
  await b.goto('chrome://version');await waitUnbound(c);
  const refused=await control.evaluate(async tabId=>{try{await chrome.scripting.executeScript({target:{tabId},func:()=>document.title});return false;}catch{return true;}},protectedTab);assert.equal(refused,true);assert.equal(requests.length,protectedCount);
  await send(c,'WRITE_TARGET AFTER_PROTECTED_PAGE');await c.locator('#target').filter({hasText:c.url()}).waitFor();
  await c.screenshot({path:join(output,'worker-recovery-close-and-protected-page.png')});record('executor close and protected-page navigation revoke targets; only a new supported-page send writes DOM');
  assert.deepEqual(errors,[]);assert.ok(!requests.some(input=>JSON.stringify(input.messages).includes('UNSENT_AFTER_WORKER')));
}catch(error){for(const [i,page]of browser.pages().entries()){if(!page.url().startsWith('chrome://'))await page.screenshot({path:join(output,'failure-'+i+'.png')}).catch(()=>{});console.log('FAILURE',page.url(),await ui(page).locator('#chat-messages').innerText({timeout:250}).catch(()=>''),await ui(page).locator('#chat-menu-error').innerText({timeout:250}).catch(()=>''));}throw error;
}finally{await writeFile(join(output,'worker-recovery.json'),JSON.stringify({browser:browser.browser()?.version(),cases,versions,requests,errors},null,2));await cdp?.detach().catch(()=>{});await browser.close();server.closeAllConnections();await new Promise(done=>server.close(done));await rm(directory,{recursive:true,force:true});}
