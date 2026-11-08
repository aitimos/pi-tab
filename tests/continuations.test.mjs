import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Continuations} from '../src/continuations.js';
import {refKey,conversationRef,parseRef} from '../src/conversation-ref.js';
import {acquireStorage} from '../src/storage-lock.js';
const ref=conversationRef('a.example',1),target={tabId:1,documentId:'d1',url:'https://b.example/path?token=secret',origin:'https://b.example',nonce:'n',routeEpoch:0};
function fixture(){
  let busy=false,exists=true,valid=true;
  const events=[];
  const c=new Continuations({exists:async()=>{if(!exists)throw Error('deleted');},busy:async()=>busy,validateTarget:async()=>{if(!valid)throw Error('invalid');},emit:(...args)=>events.push(args)});
  const bind=()=>c.bind(ref,c.version(ref),'view',target);
  return {c,bind,events,setBusy:x=>busy=x,setExists:x=>exists=x,setValid:x=>valid=x};
}
test('composite identities isolate numeric collisions and reject invalid refs',()=>{
  assert.notEqual(refKey(ref),refKey(conversationRef('b.example',1)));assert.deepEqual(parseRef(refKey(ref)),ref);
  for(const bad of [{ownerSite:'A.example',conversationId:1},{ownerSite:'a.example',conversationId:0},{ownerSite:'a/example',conversationId:1}])assert.throws(()=>refKey(bad));
});
test('same-version concurrent continuation has one winner; epochs prevent ABA',async()=>{
  const {c}=fixture(),version=c.version(ref);
  const results=await Promise.allSettled([c.bind(ref,version,'one',target),c.bind(ref,version,'two',{...target,tabId:2})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/BINDING_CONFLICT/);
  const restarted=fixture().c;await assert.rejects(()=>restarted.bind(ref,c.version(ref),'three',target),/BINDING_CONFLICT/);
});
test('pending submission freezes target, deduplicates retry and preserves target for queue',async()=>{
  const {c,bind}=fixture(),binding=await bind();let release,started,requests=0;
  const ready=new Promise(r=>started=r),held=new Promise(r=>release=r),auth={target,viewId:'view',leaseToken:binding.leaseToken};
  const task=c.submit(ref,auth,'id',async()=>{requests++;started();await held;return 'done';});await ready;
  await assert.rejects(()=>c.bind(ref,c.version(ref),'other',{...target,tabId:2}),/BUSY/);
  await assert.rejects(()=>c.submit(ref,auth,'new',()=>{}),/BUSY/);
  const retry=c.submit(ref,auth,'id',()=>{requests++;});
  const queued=c.submit(ref,auth,'queue',async()=>{requests++;return 'queued';},{queue:true});
  assert.equal(await queued,'queued');release();assert.equal(await task,'done');assert.equal(await retry,'done');assert.equal(requests,2);
  assert.ok(!(JSON.stringify(await c.state(ref))).includes('secret'));
});
test('navigation revokes lease and tools cannot silently operate another document',async()=>{
  const {c,bind}=fixture(),binding=await bind();c.invalidate(1);let executed=false;
  await assert.rejects(()=>c.submit(ref,{target,viewId:'view',leaseToken:binding.leaseToken},'1',()=>{executed=true;}),/CONTINUE_HERE_REQUIRED/);
  await assert.rejects(()=>c.tool(ref,()=>{executed=true;}),/CONTINUE_HERE_REQUIRED/);assert.equal(executed,false);
});
test('in-flight tools and runtime busy prevent switching; deleted source prevents submission',async()=>{
  const f=fixture();await f.bind();let release,started;
  const ready=new Promise(r=>started=r),held=new Promise(r=>release=r);
  const tool=f.c.tool(ref,async()=>{started();await held;});await ready;
  await assert.rejects(()=>f.bind(),/BUSY/);release();await tool;
  f.setBusy(true);await assert.rejects(()=>f.bind(),/BUSY/);f.setBusy(false);f.setExists(false);await assert.rejects(()=>f.bind(),/deleted/);
});
test('lock acquisition timeout aborts queued writer; held lock survives acquisition timeout',async()=>{
  let queuedSignal,opened=0;
  const waiting={request:(_name,{signal})=>{queuedSignal=signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason)));}};
  await assert.rejects(()=>acquireStorage(waiting,'history',()=>opened++,{timeout:10}),e=>e.code==='STORAGE_IN_USE_RETRY');assert.equal(queuedSignal.aborted,true);assert.equal(opened,0);
  let held=false;
  const locks={request:async(_name,_options,work)=>{held=true;try{return await work({});}finally{held=false;}}};
  const acquired=await acquireStorage(locks,'history',async()=>({messages:['old']}),{timeout:10});
  await new Promise(r=>setTimeout(r,20));assert.equal(held,true);assert.deepEqual(acquired.value.messages,['old']);acquired.release();await acquired.done;assert.equal(held,false);
  await assert.rejects(()=>acquireStorage(null,'history',()=>{}),e=>e.code==='STORAGE_LOCK_UNAVAILABLE');
});
