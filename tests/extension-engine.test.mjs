import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';

async function engineFixture() {
  const tools=new Map([['page_snapshot',{name:'page_snapshot'}]]);
  const requests=[];
  const listeners=[];
  const running=new Set();
  const stopped=[];
  let messageHandler;
  let failure;
  const emit=event=>listeners.forEach(listener=>listener(event));
  const pi={
    ready:Promise.resolve(),conversation:{id:1},config:{model:'test'},defaultPrompt:'test',
    Type:{Object:x=>x,String:()=>({}),Integer:()=>({}),Optional:x=>x},
    busyFor:id=>running.has(id),configFor:()=>({model:'test'}),
    importProfiles(){},importProviders(){},resume(){},
    tools:()=>[...tools.values()],unregisterTool:name=>tools.delete(name),registerTool:tool=>tools.set(tool.name,tool),
    onEvent:listener=>listeners.push(listener),listChats:async()=>[{id:1},{id:2}],
    selectChat:async id=>{pi.conversation={id};},
    deleteChat:async id=>{emit({type:'chat_deleted',conversationId:id,replacementId:2});return {replacementId:2};},
    receiveFromTab:async id=>tools.get('page_snapshot').execute({}, {conversationId:id},{abortSignal:new AbortController().signal}),
    agent:id=>({abort:async()=>{stopped.push(id);running.delete(id);},prompt:async()=>tools.get('page_snapshot').execute({}, {conversationId:id},{abortSignal:new AbortController().signal})}),
  };
  const chrome={runtime:{
    onMessage:{addListener:fn=>{messageHandler=fn;}},
    sendMessage:async request=>{
      requests.push(request);
      if(request.type==='shared-config')return {ok:true,value:{profiles:[],providers:[]}};
      if(request.type==='page-tool')return {ok:true,value:{tabId:request.tabId}};
      if(failure)return {ok:false,error:failure};
      return {ok:true,value:{tabs:[]}};
    },
  }};
  vm.runInNewContext(await readFile('src/extension-engine.js','utf8'),{PiConsolePlugin:{install:()=>pi},chrome,Map,Set,crypto:globalThis.crypto,AbortController,btoa:value=>Buffer.from(value).toString('base64')});
  const send=(method,chatId,tabId,args=[],name)=>new Promise(resolve=>messageHandler({target:'engine',site:'example.com',method,chatId,tabId,args,name},{},resolve));
  await send('initialize',undefined,10);
  return {send,tools,requests,emit,running,stopped,close:tabId=>new Promise(resolve=>messageHandler({type:'tab-closed',tabId},{},resolve)),setFailure:message=>{failure=message;}};
}

test('cross-tab delivery operates on the destination tab and preserves a running target',async()=>{
  const {send,running}=await engineFixture();
  await send('bind',2,20);
  assert.equal((await send('receiveFromTab',2,30,['task','sender'])).value.tabId,30);
  running.add(2);
  assert.equal((await send('receiveFromTab',2,40,['queued','sender'])).value.tabId,30);
});

test('deleting another conversation does not retarget a remaining agent',async()=>{
  const {send,tools}=await engineFixture();
  await send('bind',2,20);
  await send('deleteChat',undefined,10,[1]);
  assert.equal((await tools.get('page_snapshot').execute({}, {conversationId:2},{abortSignal:new AbortController().signal})).tabId,20);
});

test('a child conversation inherits its source page before receiving work',async()=>{
  const {send,emit,tools}=await engineFixture();
  await send('bind',2,20);
  emit({type:'chat_created',conversationId:2,chatId:3});
  assert.equal((await tools.get('page_snapshot').execute({}, {conversationId:3},{abortSignal:new AbortController().signal})).tabId,20);
});

test('tab tools preserve background errors',async()=>{
  const {tools,setFailure}=await engineFixture();
  setFailure('Tab is unavailable');
  await assert.rejects(()=>tools.get('tab_list').execute({}),/Tab is unavailable/);
  await assert.rejects(()=>tools.get('tab_open').execute({url:'https://example.com'},{conversationId:1}),/Tab is unavailable/);
});


test('viewing an existing conversation does not move its tools until a new task is sent',async()=>{
  const {send,tools}=await engineFixture();
  await send('bind',2,20);
  await send('selectChat',2,30);
  await send('bind',2,40);
  assert.equal((await tools.get('page_snapshot').execute({}, {conversationId:2},{abortSignal:new AbortController().signal})).tabId,20);
  assert.equal((await send('agent',2,30,['task'],'prompt')).value.tabId,30);
});

test('closing a tab stops only conversations bound to that page',async()=>{
  const {send,close,running,stopped}=await engineFixture();
  await send('bind',2,20);running.add(1);running.add(2);
  assert.equal((await close(20)).ok,true);
  assert.deepEqual(stopped,[2]);assert.equal(running.has(1),true);
});
