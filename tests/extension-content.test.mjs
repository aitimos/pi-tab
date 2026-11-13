import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {conversationRef,refKey,parseRef} from '../src/conversation-ref.js';
import {createId} from '../src/id.js';

async function fixture(){
  const calls=[];
  let seq=1,busy=false,changeAfterView=false,hook,listener,worker='worker';
  const target=()=>({tabId:10,documentId:'doc',nonce:'nonce',routeEpoch:0,url,origin:new URL(url).origin});
  const url='https://example.com/page';
  const state=()=>({version:{epoch:'engine',seq},busy,target:seq>1?target():null,config:{model:'fixture'}});
  const route=async message=>{
    calls.push(message);
    if(hook)await hook(message);
    if(message.type==='document-hello')return {...message,origin:new URL(message.url).origin,workerEpoch:worker,tabId:10,documentId:'doc'};
    if(message.type==='identity')return {active:true,site:'example.com'};
    if(message.type==='document-status')return true;
    if(message.type==='engine-call'&&message.method==='listChats')return [{id:1,config:{model:'fixture'},busy:false},{id:2,config:{model:'fixture'},busy:false}];
    if(message.type==='engine-call'&&message.method==='initialize')return {activeId:1,chats:[{id:1,config:{model:'fixture'},busy:false}]};
    if(message.type==='continuation-call'&&message.operation==='view'){
      const value=state();if(changeAfterView){seq++;changeAfterView=false;}return value;
    }
    if(message.type==='continuation-call'&&message.operation==='continue'){
      if(message.expectedVersion.epoch!=='engine'||message.expectedVersion.seq!==seq)throw Object.assign(Error('Binding changed'),{code:'BINDING_CONFLICT'});
      if(busy)throw Object.assign(Error('Task running'),{code:'CONVERSATION_BUSY'});
      seq++;return {...state(),target:{tabId:10},leaseToken:'lease'};
    }
    if(message.type==='continuation-call'&&message.operation==='agent')return 'accepted';
    throw Error('Unexpected request: '+JSON.stringify(message));
  };
  const chrome={runtime:{onMessage:{addListener(f){listener=f;}},sendMessage(message,callback){
    void route(message).then(value=>callback({ok:true,value}),error=>callback({ok:false,error:error.message,code:error.code,notSubmitted:error.notSubmitted}));
  }},storage:{local:{get:async()=>({'pi-tab-language':'en'})},onChanged:{addListener(){}}}};
  const locale={mode:'en',setMode(){},onChange(){}};
  const context={chrome,console,Map,Set,URL,AbortController,Promise,
    location:{href:url,origin:new URL(url).origin},sessionStorage:{getItem:()=>null},
    setInterval(){},addEventListener(){},openChat:async()=>{},
    PiConsolePlugin:{conversationRef,refKey,parseRef,createId,getI18n:()=>locale,install:()=>({}),loadModelCatalog:async()=>({}),createModelConfig:()=>({apis:[],describe:()=>({})})},
  };
  context.window=context;
  vm.runInNewContext(await readFile('src/extension-content.js','utf8')+'\nglobalThis.started=startExtension();',context,{filename:new URL('../src/extension-content.js',import.meta.url).pathname});
  await context.started;
  const agent=context.pi.agent(refKey(conversationRef('example.com',1)));await agent.ready;
  return {agent,calls,context,setHook:f=>{hook=f;},restart:async()=>{worker+='-new';await new Promise(resolve=>listener({type:'worker-connected',workerEpoch:worker},{id:chrome.runtime.id},resolve));},advance:()=>seq++,hold:()=>{busy=true;},race:()=>{changeAfterView=true;}};
}

test('sending a new message reads the current binding after its cached snapshot becomes stale',async()=>{
  const f=await fixture();f.advance();f.hold();
  await assert.rejects(()=>f.agent.prepareSubmission({type:'click',isTrusted:true}),error=>error.code==='CONVERSATION_BUSY');
  assert.equal(f.agent.authorized,false,'a busy conversation never grants a lease');
});

test('a competing bind after the fresh read still conflicts without retrying the mutation',async()=>{
  const f=await fixture();f.race();
  await assert.rejects(()=>f.agent.prepareSubmission({type:'click',isTrusted:true}),error=>error.code==='BINDING_CONFLICT');
  assert.equal(f.calls.filter(message=>message.operation==='continue').length,1);
  assert.equal(f.agent.authorized,false);
});

const trusted={type:'click',isTrusted:true};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function holdNext(f,predicate){
  const entered=deferred(),release=deferred();let held=false;
  f.setHook(async message=>{if(!held&&predicate(message)){held=true;entered.resolve();await release.promise;}});
  return {entered:entered.promise,release:release.resolve};
}
test('only a trusted new send prepares a lease, exactly once, and keeps normal queue semantics',async()=>{
  const f=await fixture();await f.agent.history();await f.agent.refreshBinding();
  assert.equal(f.calls.filter(m=>m.operation==='continue').length,0);
  await assert.rejects(()=>f.agent.prepareSubmission({type:'click',isTrusted:false}),e=>e.notSubmitted);
  const send=await f.agent.prepareSubmission(trusted);assert.equal(await send('prompt','new input'),'accepted');
  assert.throws(()=>send('prompt','duplicate'),e=>e.notSubmitted);
  f.hold();const queue=await f.agent.prepareSubmission({type:'keydown',isTrusted:true});await queue('followUp','queued');
  assert.equal(f.calls.filter(m=>m.operation==='continue').length,1,'queue must reuse the same document lease');
  assert.equal(f.calls.filter(m=>m.name==='followUp').length,1);
});
test('double send cannot start a second asynchronous preparation',async()=>{
  const f=await fixture(),gate=holdNext(f,m=>m.type==='document-status');
  const pending=f.agent.prepareSubmission(trusted);await gate.entered;
  await assert.rejects(()=>f.agent.prepareSubmission(trusted),e=>e.notSubmitted);
  gate.release();await pending;assert.equal(f.calls.filter(m=>m.operation==='continue').length,1);
});
for(const stage of ['document-status','view','continue'])test('navigation during '+stage+' rejects the old input without rebinding or sending',async()=>{
  const f=await fixture(),gate=holdNext(f,m=>m.type===stage||m.operation===stage);
  const pending=f.agent.prepareSubmission(trusted);await gate.entered;
  f.context.location.href+='?changed';gate.release();
  await assert.rejects(()=>pending,e=>e.notSubmitted);
  assert.equal(f.calls.filter(m=>m.name==='prompt').length,0);
  assert.ok(f.calls.filter(m=>m.operation==='continue').length<=1);
});
for(const roundTrip of [false,true])test('selection changes during preparation reject intent, including A to B to A: '+roundTrip,async()=>{
  const f=await fixture(),gate=holdNext(f,m=>m.type==='document-status');
  const pending=f.agent.prepareSubmission(trusted);await gate.entered;
  await f.agent.selectChat(refKey(conversationRef('example.com',2)));
  if(roundTrip)await f.agent.selectChat(refKey(conversationRef('example.com',1)));
  gate.release();await assert.rejects(()=>pending,e=>e.notSubmitted);
  assert.equal(f.calls.filter(m=>m.operation==='continue').length,0);
});
test('worker reconstruction during preparation cannot restore an old intent',async()=>{
  const f=await fixture(),gate=holdNext(f,m=>m.type==='document-status');
  const pending=f.agent.prepareSubmission(trusted);await gate.entered;await f.restart();gate.release();
  await assert.rejects(()=>pending,e=>e.notSubmitted);
  assert.equal(f.calls.filter(m=>m.operation==='continue').length,0);
});
test('final closure checks intent again after preparation',async()=>{
  const f=await fixture(),send=await f.agent.prepareSubmission(trusted);
  await f.agent.selectChat(refKey(conversationRef('example.com',2)));
  assert.throws(()=>send('prompt','old input'),e=>e.notSubmitted);
  assert.equal(f.calls.filter(m=>m.name==='prompt').length,0);
});
test('unknown write result and accepted execution errors are never marked safe to resend',async()=>{
  const f=await fixture();
  f.setHook(m=>{if(m.name==='prompt')throw Object.assign(Error('unknown result'),{code:'EXTENSION_TRANSPORT_ERROR'});});
  const send=await f.agent.prepareSubmission(trusted);
  await assert.rejects(()=>send('prompt','once'),e=>e.code==='RECONNECT_REVIEW_HISTORY'&&!e.notSubmitted);
  assert.equal(f.calls.filter(m=>m.name==='prompt').length,1);
  f.setHook(m=>{if(m.name==='prompt')throw Error('execution failed');});
  const again=await f.agent.prepareSubmission(trusted);
  await assert.rejects(()=>again('prompt','new request'),e=>!e.notSubmitted);
});

test('a prepared input cannot use a lease revoked before submission',async()=>{
  const f=await fixture(),send=await f.agent.prepareSubmission(trusted);
  f.advance();await f.agent.refreshBinding();
  assert.throws(()=>send('prompt','stale lease'),e=>e.notSubmitted);
  assert.equal(f.calls.filter(m=>m.name==='prompt').length,0);
});
test('permission rejection preserves input and never attempts binding',async()=>{
  const f=await fixture();f.setHook(m=>{if(m.type==='document-status')throw Object.assign(Error('Permission removed'),{code:'TARGET_PERMISSION_OR_UNSUPPORTED'});});
  await assert.rejects(()=>f.agent.prepareSubmission(trusted),e=>e.notSubmitted);
  assert.equal(f.calls.filter(m=>m.operation==='continue').length,0);
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
