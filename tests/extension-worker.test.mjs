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
  const tabs=new Map([[10,{id:10,url:'https://www.example.com/a',title:'A'}],[11,{id:11,url:'https://other.example/b',title:'B'}]]);
  let onMessage,onUpdated,onRemoved,onClick;
  const chrome={runtime:{id:'extension',getURL:path=>'chrome-extension://extension/'+path,onMessage:{addListener:f=>onMessage=f},sendMessage:async message=>{
    calls.push(message);
    if(message.method==='listChats')return {ok:true,value:[{id:1,title:'History'}]};
    if(message.operation==='view')return {ok:true,value:{version:{epoch:'e',seq:0},target:null}};
    if(message.operation==='list')return {ok:true,value:{rows:[{ref:{ownerSite:'www.example.com',conversationId:1},title:'History'}],sourceErrors:[]}};
    return {ok:true,value:true};
  }},i18n:{getAcceptLanguages:async()=>['en']},
  action:{onClicked:{addListener:f=>onClick=f},setBadgeText:async()=>{},setTitle:async()=>{}},
  offscreen:{hasDocument:async()=>true},scripting:{executeScript:async()=>{}},
  tabs:{onUpdated:{addListener:f=>onUpdated=f},onRemoved:{addListener:f=>onRemoved=f},query:async()=>[...tabs.values()],get:async id=>tabs.get(id),update:async(id,change)=>Object.assign(tabs.get(id),change),sendMessage:async(id,message,options)=>{pageCalls.push({id,message,options});return {ok:true,value:'result'};}},
  storage:{onChanged:{addListener(){}},local:{get:async()=>({})},session:{get:async key=>({[key]:session.get(key)}),set:async values=>{for(const [key,value]of Object.entries(values))session.set(key,value);},remove:async key=>session.delete(key)}}};
  vm.runInNewContext((await readFile('src/extension-worker.js','utf8')).replace(/^import .*;$/gm,''),{continuationErrorMessage,chrome,McpConfigStore,conversationRef,refKey,createI18n,crypto:globalThis.crypto,URL,AbortController,setTimeout,console});
  const sender=id=>({id:'extension',frameId:0,documentId:'doc-'+id,url:tabs.get(id).url,tab:tabs.get(id)});
  const send=(message,from=10)=>new Promise(resolve=>onMessage(message,typeof from==='number'?sender(from):from,resolve));
  const internal={id:'extension',url:'chrome-extension://extension/engine.html'};
  const hello=async id=>(await send({type:'document-hello',nonce:'nonce-'+id,routeEpoch:0},id)).value;
  return {send,hello,sender,internal,tabs,calls,pageCalls,onClick,onUpdated,onRemoved};
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
