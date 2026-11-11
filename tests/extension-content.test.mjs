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

// Exercise the shipped message listener while holding initialization asynchronous.
// Window rendering and persistence are covered by test-extension-ui.mjs.
async function toolbarFixture({ids=[],visible=[],activeId=1}={}) {
  const source=await readFile(new URL('../src/extension-content.js',import.meta.url),'utf8');
  const instances=new Map(),opened=[];
  let listener,created=0,initialized=0,release;
  const ready=new Promise(resolve=>release=resolve);
  const add=(id,shown=false)=>{
    const instance={id,visible:shown,minimized:false,open(){this.visible=true;this.minimized=false;opened.push(id);}};
    instances.set(id,instance);return instance;
  };
  for(const id of ids)add(id,visible.includes(id));
  const context=vm.createContext({
    window:{__piQuickChatOverlay:{instances},addEventListener(){}},
    location:{href:'https://example.com/'},setInterval(){},console,
    PiConsolePlugin:{createId:()=> 'id'},
    chrome:{runtime:{onMessage:{addListener:f=>listener=f},sendMessage:(_message,respond)=>respond({ok:true,value:{}})}},
    initialize:async()=>{initialized++;await ready;},
    create:()=>{created++;add(activeId,true);},
  });
  // Replace external engine initialization only; keep startExtension and the
  // actual activate handler, including their asynchronous ordering, intact.
  vm.runInContext(source.replace("void startExtension().catch(error=>console.error('[Pi Tab]',error));",`
    activeId=${JSON.stringify(activeId)};
    initializeExtension=async()=>{await initialize();extensionStarted=true;};
    openChat=async()=>{create();};
  `),context);
  const activate=(openWindow=true)=>new Promise(resolve=>listener({type:'activate',openWindow},{},resolve));
  return {instances,opened,release,activate,get created(){return created;},get initialized(){return initialized;}};
}

for(const total of [3,5])test(`toolbar reuses one of ${total} hidden windows over ten reopen cycles`,async()=>{
  const f=await toolbarFixture({ids:Array.from({length:total},(_,i)=>i+1),activeId:total});f.release();
  for(let i=0;i<10;i++){
    for(const instance of f.instances.values())instance.visible=false;
    assert.equal((await f.activate()).ok,true);
    assert.equal([...f.instances.values()].filter(instance=>instance.visible).length,1);
    assert.equal(f.opened.at(-1),total);
    assert.equal(f.instances.size,total);assert.equal(f.created,0);
  }
});

test('visible minimized window takes priority over hidden active chat',async()=>{
  const f=await toolbarFixture({ids:[1,2,3],visible:[2],activeId:3});f.release();
  f.instances.get(2).minimized=true;
  await f.activate();assert.deepEqual(f.opened,[2]);
  assert.equal(f.instances.get(2).minimized,false);
  assert.equal(f.instances.get(1).visible,false);assert.equal(f.instances.get(3).visible,false);
});

test('hidden active conversation reference takes priority over the first retained window',async()=>{
  const ids=[1,2,3].map(id=>refKey(conversationRef('example.com',id)));
  const f=await toolbarFixture({ids,activeId:ids[2]});f.release();
  await f.activate();
  assert.deepEqual(f.opened,[ids[2]]);
  assert.equal(f.instances.get(ids[0]).visible,false);
  assert.equal(f.created,0);
});

test('toolbar falls back to an existing window if active chat has no window',async()=>{
  const f=await toolbarFixture({ids:[2,3]});f.release();
  await f.activate();assert.deepEqual(f.opened,[2]);assert.equal(f.created,0);
});

test('concurrent activation shares initialization and creates only one window',async()=>{
  const f=await toolbarFixture();
  const pending=Array.from({length:10},()=>f.activate());
  assert.equal(f.initialized,1);assert.equal(f.created,0);
  f.release();assert.ok((await Promise.all(pending)).every(response=>response.ok));
  assert.equal(f.created,1);assert.equal(f.instances.size,1);
});

test('automatic activation preserves restored visible and hidden windows',async()=>{
  const f=await toolbarFixture({ids:[1,2,3],visible:[1,2]});f.release();
  f.instances.get(1).minimized=true;
  await f.activate(false);assert.deepEqual(f.opened,[]);assert.equal(f.created,0);
  assert.equal(f.instances.get(1).minimized,true);assert.equal(f.instances.get(2).visible,true);
  assert.equal(f.instances.get(3).visible,false);
});
