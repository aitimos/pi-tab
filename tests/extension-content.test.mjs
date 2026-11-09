import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the shipped message listener while holding initialization asynchronous.
// Window rendering and persistence are covered by test-extension-ui.mjs.
async function fixture({ids=[],visible=[],activeId=1}={}) {
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
  const f=await fixture({ids:Array.from({length:total},(_,i)=>i+1),activeId:total});f.release();
  for(let i=0;i<10;i++){
    for(const instance of f.instances.values())instance.visible=false;
    assert.equal((await f.activate()).ok,true);
    assert.equal([...f.instances.values()].filter(instance=>instance.visible).length,1);
    assert.equal(f.opened.at(-1),total);
    assert.equal(f.instances.size,total);assert.equal(f.created,0);
  }
});

test('visible minimized window takes priority over hidden active chat',async()=>{
  const f=await fixture({ids:[1,2,3],visible:[2],activeId:3});f.release();
  f.instances.get(2).minimized=true;
  await f.activate();assert.deepEqual(f.opened,[2]);
  assert.equal(f.instances.get(2).minimized,false);
  assert.equal(f.instances.get(1).visible,false);assert.equal(f.instances.get(3).visible,false);
});

test('toolbar falls back to an existing window if active chat has no window',async()=>{
  const f=await fixture({ids:[2,3]});f.release();
  await f.activate();assert.deepEqual(f.opened,[2]);assert.equal(f.created,0);
});

test('concurrent activation shares initialization and creates only one window',async()=>{
  const f=await fixture();
  const pending=Array.from({length:10},()=>f.activate());
  assert.equal(f.initialized,1);assert.equal(f.created,0);
  f.release();assert.ok((await Promise.all(pending)).every(response=>response.ok));
  assert.equal(f.created,1);assert.equal(f.instances.size,1);
});

test('automatic activation preserves restored visible and hidden windows',async()=>{
  const f=await fixture({ids:[1,2,3],visible:[1,2]});f.release();
  f.instances.get(1).minimized=true;
  await f.activate(false);assert.deepEqual(f.opened,[]);assert.equal(f.created,0);
  assert.equal(f.instances.get(1).minimized,true);assert.equal(f.instances.get(2).visible,true);
  assert.equal(f.instances.get(3).visible,false);
});
