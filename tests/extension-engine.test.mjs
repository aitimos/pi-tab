import {continuationErrorMessage} from '../src/continuation-errors.js';
import {Continuations} from '../src/continuations.js';
import {conversationRef,refKey} from '../src/conversation-ref.js';
import {createId} from '../src/id.js';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {readMcpJson,mcpVariableReferences} from '../src/mcp-config.js';
import {test} from 'node:test';

async function engineFixture() {
  const tools=new Map([['page_snapshot',{name:'page_snapshot'}]]);
  const requests=[];
  let sharedMcp=null;
  const listeners=[];
  const running=new Set();
  const stopped=[];
  let messageHandler;
  let failure;
  const emit=event=>listeners.forEach(listener=>listener(event));
  const mcp=[];
  const pi={
    ready:Promise.resolve(),conversation:{id:1},config:{model:'test'},defaultPrompt:'test',
    applyMcpConfig:(input,revision)=>{mcp.push({input,revision});return {};},
    mcpBusy:()=>running.size>0,setMcpUpdateGate(){},
    setMcpConfig:async(input,options)=>{mcp.push({input,options});return {raw:typeof input==='string'?JSON.parse(input):input,servers:[],problems:[]};},
    mcpConfig:async()=>({text:'{"mcpServers":{}}',raw:{mcpServers:{}},servers:[],problems:[]}),
    refreshMcp:async()=>({servers:[],problems:[]}),
    Type:{Object:x=>x,String:()=>({}),Integer:()=>({}),Optional:x=>x},
    busyFor:id=>running.has(id),configFor:()=>({model:'test'}),
    replaceModelSettings(){},resume(){},
    tools:()=>[...tools.values()],unregisterTool:name=>tools.delete(name),registerTool:tool=>tools.set(tool.name,tool),
    onEvent:listener=>listeners.push(listener),listChats:async()=>[{id:1},{id:2}],
    selectChat:async id=>{pi.conversation={id};},
    deleteChat:async id=>{emit({type:'chat_deleted',conversationId:id,replacementId:2});return {replacementId:2};},
    receiveFromTab:async id=>tools.get('page_snapshot').execute({}, {conversationId:id},{abortSignal:new AbortController().signal}),
    agent:id=>({queuedMessages:async()=>[],abort:async()=>{stopped.push(id);running.delete(id);},prompt:async()=>tools.get('page_snapshot').execute({}, {conversationId:id},{abortSignal:new AbortController().signal})}),
  };
  const chrome={runtime:{
    onMessage:{addListener:fn=>{messageHandler=fn;}},
    sendMessage:async request=>{
      requests.push(request);
      if(request.type==='shared-config'){if(request.operation==='mcp-change'){sharedMcp=request.request.operation.value;return {ok:true,value:{saved:true}};}return {ok:true,value:{profiles:[],providers:[],mcp:sharedMcp}};}
      if(request.type==='page-tool')return {ok:true,value:{tabId:request.tabId}};
      if(failure)return {ok:false,error:failure};
      return {ok:true,value:{tabs:[]}};
    },
  }};
  vm.runInNewContext((await readFile('src/extension-engine.js','utf8')).replace(/^import .*;$/gm,''),{continuationErrorMessage,Continuations,conversationRef,refKey,HistoryIndex:class {async reconcile(){}},readMcpJson,mcpVariableReferences,structuredClone,createLinuxEnvironments:()=>({get(){},delete(){},dispose(){}}),createLinuxTools:()=>[],PiConsolePlugin:{install:()=>pi,createId,inspectRuntime:async()=>({tasks:[],submissions:[]})},chrome,Map,Set,crypto:globalThis.crypto,AbortController,btoa:value=>Buffer.from(value).toString('base64')});
  const send=(method,chatId,tabId,args=[],name)=>new Promise(resolve=>messageHandler({target:'engine',site:'example.com',method,chatId,tabId,args,name},{},resolve));
  await send('initialize',undefined,10);
  const target=tabId=>({tabId,documentId:'doc-'+tabId,origin:'https://example.com',url:'https://example.com/',nonce:'nonce-'+tabId,routeEpoch:0});
  const ref=id=>conversationRef('example.com',id);
  const cont=(operation,id,extra={})=>new Promise(resolve=>messageHandler({...extra,target:'continuations',operation,ref:ref(id),pageTarget:extra.target},{},resolve));
  const bind=async(id,tabId)=>{const state=await cont('view',id);return cont('continue',id,{target:target(tabId),viewId:'view-'+tabId,expectedVersion:state.value.version});};
  const submit=async(id,tabId,lease,name='prompt')=>cont('agent',id,{name,args:['task'],authorization:{target:target(tabId),viewId:'view-'+tabId,leaseToken:lease},clientRequestId:createId()});
  return {cont,bind,submit,send,tools,requests,emit,running,stopped,mcp,broadcast:message=>new Promise(resolve=>messageHandler(message,{},resolve)),setSharedMcp:value=>{sharedMcp=value;},close:tabId=>new Promise(resolve=>messageHandler({type:'tab-closed',tabId},{},resolve)),setFailure:message=>{failure=message;}};
}

test('explicit continuation routes source tools to the selected document',async()=>{
  const {bind,submit,requests}=await engineFixture();
  const binding=await bind(2,20);assert.equal(binding.ok,true);
  assert.equal((await submit(2,20,binding.value.leaseToken)).ok,true);
  assert.equal(requests.findLast(item=>item.type==='page-tool').target.tabId,20);
});

test('viewing does not move tools and a second view needs its own lease',async()=>{
  const {bind,cont,submit,requests}=await engineFixture();
  const binding=await bind(2,20);await cont('view',2);
  assert.equal((await submit(2,30,binding.value.leaseToken)).ok,false);
  await submit(2,20,binding.value.leaseToken);
  assert.equal(requests.findLast(item=>item.type==='page-tool').target.tabId,20);
});

test('tab tools preserve background errors',async()=>{
  const {tools,setFailure}=await engineFixture();
  setFailure('Tab is unavailable');
  await assert.rejects(()=>tools.get('tab_list').execute({}),/Tab is unavailable/);
  await assert.rejects(()=>tools.get('tab_open').execute({url:'https://example.com'},{conversationId:1}),/Tab is unavailable/);
});


test('closing a tab stops only conversations bound to that page',async()=>{
  const {bind,close,running,stopped}=await engineFixture();
  await bind(2,20);running.add(1);running.add(2);
  assert.equal((await close(20)).ok,true);assert.deepEqual(stopped,[2]);assert.equal(running.has(1),true);
});

test('shared MCP configuration is applied to every site engine without touching site storage',async()=>{
  const {send,mcp,setSharedMcp,requests}=await engineFixture();
  const saved={mcpServers:{docs:{url:'https://example.com/mcp'}}};
  setSharedMcp(saved);
  await send('mcpConfig',undefined,10);
  const summary=await send('setMcpConfig',undefined,10,[JSON.stringify(saved)]);
  assert.equal(summary.ok,true);
  assert.deepEqual(mcp.at(-1).input,saved);
  const stored=requests.filter(request=>request.type==='shared-config'&&request.operation==='mcp-change');
  assert.equal(JSON.stringify(stored.at(-1).request.operation.value),JSON.stringify(saved));
});

test('a shared configuration update reconnects MCP servers in the running engine',async()=>{
  const {broadcast,mcp}=await engineFixture();
  const saved={mcpServers:{docs:{url:'https://example.com/mcp'}}};
  await broadcast({type:'shared-config-updated',profiles:[],providers:[],mcp:saved});
  assert.equal(JSON.stringify(mcp.at(-1)),JSON.stringify({input:saved,revision:0}));
});
