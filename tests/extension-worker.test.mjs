import {continuationErrorMessage} from '../src/continuation-errors.js';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import {McpConfigStore} from '../src/mcp-store.js';
import {createI18n} from '../src/i18n.js';
import {conversationRef,refKey} from '../src/conversation-ref.js';
async function fixture(){
  const session=new Map(),calls=[],pageCalls=[];
  const tabs=new Map([[10,{id:10,windowId:100,url:'https://www.example.com/a',title:'A'}],[11,{id:11,windowId:101,url:'https://other.example/b',title:'B'}]]);
  let onMessage,onUpdated,onRemoved,onClick,focusTarget=null;const heldTools=new Map();
  const chrome={runtime:{id:'extension',getURL:path=>'chrome-extension://extension/'+path,onMessage:{addListener:f=>onMessage=f},sendMessage:async message=>{
    calls.push(message);
    if(message.method==='listChats')return {ok:true,value:[{id:1,title:'History'}]};
    if(message.operation==='view')return {ok:true,value:{version:{epoch:'e',seq:0},target:focusTarget}};
    if(message.operation==='list')return {ok:true,value:{rows:[{ref:{ownerSite:'www.example.com',conversationId:1},title:'History'}],sourceErrors:[]}};
    return {ok:true,value:true};
  }},i18n:{getAcceptLanguages:async()=>['en']},
  action:{onClicked:{addListener:f=>onClick=f},setBadgeText:async()=>{},setTitle:async()=>{}},
  windows:{update:async(id,change)=>{calls.push({windowId:id,change});}},
  offscreen:{hasDocument:async()=>true},scripting:{executeScript:async()=>{}},
  tabs:{onUpdated:{addListener:f=>onUpdated=f},onRemoved:{addListener:f=>onRemoved=f},query:async()=>[...tabs.values()],get:async id=>tabs.get(id),update:async(id,change)=>Object.assign(tabs.get(id),change),sendMessage:async(id,message,options)=>{pageCalls.push({id,message,options});if(message.type==='execute-tool'&&message.name==='held')return new Promise(resolve=>heldTools.set(message.requestId,resolve));if(message.type==='cancel-tool')heldTools.get(message.requestId)?.({ok:false,error:'cancelled'});return {ok:true,value:'result'};}},
  storage:{onChanged:{addListener(){}},local:{get:async()=>({})},session:{get:async key=>({[key]:session.get(key)}),set:async values=>{for(const [key,value]of Object.entries(values))session.set(key,value);},remove:async key=>session.delete(key)}}};
  const source=(await readFile('src/extension-worker.js','utf8')).replace(/^import .*;$/gm,'');
  const boot=()=>vm.runInNewContext(source,{continuationErrorMessage,chrome,McpConfigStore,conversationRef,refKey,createI18n,crypto:globalThis.crypto,URL,AbortController,setTimeout,console});boot();
  const sender=id=>({id:'extension',frameId:0,documentId:'doc-'+id,url:tabs.get(id).url,tab:tabs.get(id)});
  let epoch;
  const send=(message,from=10)=>new Promise(resolve=>onMessage({workerEpoch:epoch,...message},typeof from==='number'?sender(from):from,resolve));
  const internal={id:'extension',url:'chrome-extension://extension/engine.html'};
  const hello=async id=>{const response=await send({type:'document-hello',nonce:'nonce-'+id,routeEpoch:0,url:tabs.get(id).url},id);epoch=response.value?.workerEpoch;return response.value;};
  return {setFocusTarget:value=>{focusTarget=value;},send,hello,sender,internal,tabs,calls,pageCalls,onClick,onUpdated,onRemoved,heldTools,boot};
}
test('native paths share a source engine; document tools use documentId and never follow navigation',async()=>{
  const f=await fixture();const target=await f.hello(10);await f.hello(11);
  await f.onClick(f.tabs.get(10));assert.equal(f.pageCalls.at(-1).message.openWindow,true);
  await f.send({type:'engine-call',method:'initialize'});assert.equal(f.calls.at(-1).site,'www.example.com');
  const result=await f.send({type:'page-tool',target,requestId:'tool',name:'click',args:{}},f.internal);assert.equal(result.ok,true);
  assert.equal(f.pageCalls.at(-1).options.documentId,'doc-10');
  f.tabs.get(10).url='https://other.example/redirect';const before=f.pageCalls.length;
  assert.equal((await f.send({type:'page-tool',target,requestId:'tool-2',name:'click'},f.internal)).ok,false);assert.equal(f.pageCalls.length,before);
  await f.onRemoved(10);assert.equal(f.calls.at(-1).type,'tab-closed');
});
test('cross-source continuation requires picker selection and routes the real sender document',async()=>{
  const f=await fixture();await f.hello(10);await f.hello(11);
  const ref={ownerSite:'www.example.com',conversationId:1};
  assert.equal((await f.send({type:'continuation-call',operation:'view',ref,viewId:'v'},11)).ok,false);
  const opened=await f.send({type:'picker-open',viewId:'v'},11),url=opened.value.url,grant=url.split('#')[1];
  const picker={...f.sender(11),frameId:1,documentId:'picker',url};
  assert.equal((await f.send({type:'picker-list',grant},picker)).ok,true);
  assert.equal((await f.send({type:'picker-list',grant},{...picker,documentId:'other-picker'})).ok,false);
  assert.equal((await f.send({type:'picker-select',grant,ref},picker)).ok,true);
  assert.equal((await f.send({type:'picker-list',grant},picker)).ok,false);
  const continued=await f.send({type:'continuation-call',operation:'continue',ref,viewId:'v',expectedVersion:{epoch:'e',seq:0},tabId:999},11);
  assert.equal(continued.ok,true);assert.equal(f.calls.at(-1).pageTarget.tabId,11);assert.equal(f.calls.at(-1).pageTarget.documentId,'doc-11');
  assert.equal(f.calls.at(-1).ref.ownerSite,'www.example.com');assert.equal(f.calls.at(-1).target,'continuations');
});
test('host pages and ungranted iframes cannot list history or issue privileged tool calls',async()=>{
  const f=await fixture();await f.hello(10);
  for(const message of [{type:'picker-list',grant:'fake'},{type:'page-tool',target:{}},{type:'validate-target',target:{}},{type:'tabs-open',url:'https://example.com'},{type:'engine-call',method:'agent',chatId:1,name:'prompt'}])assert.equal((await f.send(message)).ok,false);
  const opened=await f.send({type:'picker-open',viewId:'v'}),url=opened.value.url,grant=url.split('#')[1];
  assert.equal((await f.send({type:'picker-list',grant},{...f.sender(10),frameId:1,url:'https://example.com/'})).ok,false);
  f.onUpdated(10,{status:'loading'});
  assert.equal((await f.send({type:'picker-list',grant},{...f.sender(10),frameId:1,documentId:'picker',url})).ok,false);
});


test('navigation cancels an in-flight tool on its original document',async()=>{
  const f=await fixture(),target=await f.hello(10);
  const running=f.send({type:'page-tool',target,requestId:'held',name:'held',args:{}},f.internal);
  for(let i=0;i<20&&!f.heldTools.has('held');i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.heldTools.has('held'),true);f.onUpdated(10,{status:'loading'});
  assert.equal((await running).ok,false);
  const cancelled=f.pageCalls.find(call=>call.message.type==='cancel-tool');assert.equal(cancelled.options.documentId,'doc-10');
});

test('SPA registration uses the verified live URL despite an immutable sender URL',async()=>{
  const f=await fixture(),originalSender=f.sender(10),old=await f.hello(10);
  f.tabs.get(10).url='https://www.example.com/after-spa#details';
  f.onUpdated(10,{url:f.tabs.get(10).url});
  const registered=await f.send({type:'document-hello',url:f.tabs.get(10).url,nonce:'nonce-10',routeEpoch:1},originalSender);
  assert.equal(registered.ok,true);assert.equal(registered.value.url,f.tabs.get(10).url);
  assert.equal(registered.value.documentId,originalSender.documentId);
  assert.equal((await f.send({type:'validate-target',target:registered.value},f.internal)).ok,true);
  f.onUpdated(10,{url:registered.value.url});
  assert.equal((await f.send({type:'validate-target',target:registered.value},f.internal)).ok,true,'a delayed URL event must not revoke an already verified route');
  assert.equal((await f.send({type:'validate-target',target:old},f.internal)).ok,false);
  const response=await f.send({type:'continuation-call',operation:'continue',ref:{ownerSite:'www.example.com',conversationId:1},viewId:'v'},originalSender);
  assert.equal(response.ok,true);assert.equal(f.calls.at(-1).pageTarget.routeEpoch,1);
  assert.equal(f.pageCalls.findLast(call=>call.message.type==='verify-target').options.documentId,originalSender.documentId);
  assert.equal((await f.send({type:'document-hello',url:'https://foreign.example/',nonce:'x',routeEpoch:2},originalSender)).ok,false);
  assert.equal((await f.send({type:'document-hello',url:old.url,nonce:'x',routeEpoch:2},originalSender)).ok,false);
  assert.equal((await f.send({type:'continuation-call',operation:'view',ref:{ownerSite:'www.example.com',conversationId:1},viewId:'v'},{...originalSender,documentId:'other-document'})).ok,false);
});

test('a new worker requires fresh document proof and restores only persisted viewing choices',async()=>{
  const f=await fixture(),old=await f.hello(10);await f.hello(11);
  const ref={ownerSite:'www.example.com',conversationId:1};
  const {value:{url}}=await f.send({type:'picker-open',viewId:'observer'},11),grant=url.split('#')[1];
  const picker={...f.sender(11),frameId:1,documentId:'picker',url};
  assert.equal((await f.send({type:'picker-select',grant,ref},picker)).ok,true);
  f.boot();const before=f.calls.length;
  const rejected=await f.send({type:'continuation-call',operation:'agent',name:'prompt',ref,viewId:'observer',leaseToken:'old-lease'},11);
  assert.equal(rejected.code,'DOCUMENT_RECONNECT_REQUIRED');assert.equal(rejected.notSubmitted,true);assert.equal(f.calls.length,before);
  const fresh=await f.hello(11);assert.notEqual(fresh.workerEpoch,old.workerEpoch);
  assert.equal((await f.send({type:'continuation-call',operation:'view',ref,viewId:'observer'},11)).ok,true);
  assert.equal((await f.send({type:'picker-list',grant},picker)).ok,false);
  assert.equal((await f.send({type:'continuation-call',operation:'agent',name:'prompt',ref,viewId:'observer',workerEpoch:old.workerEpoch},11)).code,'DOCUMENT_RECONNECT_REQUIRED');
  assert.equal((await f.send({type:'validate-target',target:old},f.internal)).ok,false);
});

test('return to execution page focuses its existing tab and window without binding or submitting',async()=>{
  const f=await fixture();await f.hello(10);await f.hello(11);
  const ref={ownerSite:'www.example.com',conversationId:1};
  await f.send({type:'continuation-call',operation:'view',ref,viewId:'v'},10);
  f.setFocusTarget({tabId:11});
  const before=f.calls.length,result=await f.send({type:'focus-target',ref,viewId:'v'},10);
  assert.equal(result.ok,true);assert.equal(f.tabs.get(11).active,true);
  assert.equal(f.calls.at(-1).windowId,101);assert.equal(f.calls.at(-1).change.focused,true);
  assert.equal(f.calls.slice(before).filter(m=>['continue','agent'].includes(m.operation)).length,0);
  assert.equal((await f.send({type:'focus-target',ref,viewId:'missing'},10)).ok,false);
});
