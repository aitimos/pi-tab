import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stopColdRuntime} from '../src/source-directory.js';

test('recovery waits for background tasks as well as foreground and reinspects before unblocking',async()=>{
  const events=[],waits=new Map();let drained=false,started;
  const waiting=new Promise(r=>started=r);
  const pi={harness:{inspect:async()=>drained?{scheduling:'running',tasks:[],submissions:[]}:{scheduling:'paused',tasks:[{record:{id:1,background:false}},{record:{id:2,background:true}}],submissions:[{id:3,status:'queued'},{id:4,status:'placed'}]},
    abortSubmission:async id=>events.push('submission:'+id),abortTask:async id=>events.push('abort:'+id),resume:()=>events.push('resume'),
    waitForTask:id=>new Promise(r=>{waits.set(id,r);if(waits.size===2)started();}),
  }};
  let finished=false;const cleanup=stopColdRuntime(pi).then(()=>{finished=true;});await waiting;
  assert.deepEqual(events,['submission:3','abort:1','abort:2','resume']);
  waits.get(1)();await Promise.resolve();assert.equal(finished,false,'background task was not awaited');
  drained=true;waits.get(2)();await cleanup;assert.equal(finished,true);
});
test('failed inspection/remaining work cannot report successful recovery; retry cannot run unmarked live work',async()=>{
  const pi={harness:{inspect:async()=>({scheduling:'running',tasks:[{record:{id:1,abortRequested:false}}],submissions:[]})}};
  await assert.rejects(()=>stopColdRuntime(pi,{retry:true}),/RECOVERY_NOT_PAUSED/);
  let checks=0;
  const remaining={harness:{inspect:async()=>({scheduling:checks++?'running':'paused',tasks:[{record:{id:1,abortRequested:true}}],submissions:[]}),abortTask:async()=>{},resume(){},waitForTask:async()=>{}}};
  await assert.rejects(()=>stopColdRuntime(remaining),/RECOVERY_NOT_DRAINED/);
});
