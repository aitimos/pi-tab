import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {conversationRef,refKey,parseRef} from '../src/conversation-ref.js';
import {createId} from '../src/id.js';

async function fixture(){
  const calls=[];
  let seq=1,busy=false,changeAfterView=false;
  const url='https://example.com/page';
  const state=()=>({version:{epoch:'engine',seq},busy,target:null,config:{model:'fixture'}});
  const route=async message=>{
    calls.push(message);
    if(message.type==='document-hello')return {...message,workerEpoch:'worker',tabId:10,documentId:'doc'};
    if(message.type==='identity')return {active:true,site:'example.com'};
    if(message.type==='document-status')return true;
    if(message.type==='engine-call'&&message.method==='initialize')return {activeId:1,chats:[{id:1,config:{model:'fixture'},busy:false}]};
    if(message.type==='continuation-call'&&message.operation==='view'){
      const value=state();if(changeAfterView){seq++;changeAfterView=false;}return value;
    }
    if(message.type==='continuation-call'&&message.operation==='continue'){
      if(message.expectedVersion.epoch!=='engine'||message.expectedVersion.seq!==seq)throw Object.assign(Error('Binding changed'),{code:'BINDING_CONFLICT'});
      if(busy)throw Object.assign(Error('Task running'),{code:'CONVERSATION_BUSY'});
      seq++;return {...state(),target:{tabId:10},leaseToken:'lease'};
    }
    throw Error('Unexpected request: '+JSON.stringify(message));
  };
  const chrome={runtime:{onMessage:{addListener(){}},sendMessage(message,callback){
    void route(message).then(value=>callback({ok:true,value}),error=>callback({ok:false,error:error.message,code:error.code}));
  }},storage:{local:{get:async()=>({'pi-tab-language':'en'})},onChanged:{addListener(){}}}};
  const locale={mode:'en',setMode(){},onChange(){}};
  const context={chrome,console,Map,Set,URL,AbortController,Promise,
    location:{href:url,origin:new URL(url).origin},sessionStorage:{getItem:()=>null},
    setInterval(){},addEventListener(){},openChat:async()=>{},
    PiConsolePlugin:{conversationRef,refKey,parseRef,createId,getI18n:()=>locale,install:()=>({}),loadModelCatalog:async()=>({}),createModelConfig:()=>({apis:[],describe:()=>({})})},
  };
  context.window=context;
  vm.runInNewContext(await readFile('src/extension-content.js','utf8')+'\nglobalThis.started=startExtension();',context);
  await context.started;
  const agent=context.pi.agent(refKey(conversationRef('example.com',1)));await agent.ready;
  return {agent,calls,advance:()=>seq++,hold:()=>{busy=true;},race:()=>{changeAfterView=true;}};
}

test('explicit continuation reads the current binding after its cached snapshot becomes stale',async()=>{
  const f=await fixture();f.advance();f.hold();
  await assert.rejects(()=>f.agent.continueHere(),error=>error.code==='CONVERSATION_BUSY');
  assert.equal(f.agent.authorized,false,'a busy conversation never grants a lease');
});

test('a competing bind after the fresh read still conflicts without retrying the mutation',async()=>{
  const f=await fixture();f.race();
  await assert.rejects(()=>f.agent.continueHere(),error=>error.code==='BINDING_CONFLICT');
  assert.equal(f.calls.filter(message=>message.operation==='continue').length,1);
  assert.equal(f.agent.authorized,false);
});
