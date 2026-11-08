import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {McpConfigStore} from '../src/mcp-store.js';

async function fixture(){
  let listener,busy=false,fail=false,failBroadcast=false;
  const events=[],saved={profiles:[{id:'old'}],providers:[],mcp:{mcpServers:{docs:{url:'https://example.com/mcp'}}}};
  const chrome={
    offscreen:{hasDocument:async()=>true},
    action:{onClicked:{addListener(){}}},tabs:{onRemoved:{addListener(){}},onUpdated:{addListener(){}}},
    runtime:{onMessage:{addListener:fn=>{listener=fn;}},sendMessage:async message=>{
      events.push(structuredClone(message));
      if(message.type==='mcp-update-guard'&&message.value&&busy)return {ok:false,error:'running task'};
      if(message.type==='shared-config-updated'&&failBroadcast)throw Error('engine unavailable');
      return {ok:true};
    }},
    storage:{onChanged:{addListener(){}},local:{get:async keys=>Object.fromEntries(keys.filter(key=>Object.hasOwn(saved,key)).map(key=>[key,structuredClone(saved[key])])),set:async patch=>{if(fail)throw Error('quota');Object.assign(saved,structuredClone(patch));}}},
  };
  vm.runInNewContext((await readFile('src/extension-worker.js','utf8')).replace(/^import .*;$/gm,''),{chrome,McpConfigStore,URL,AbortController,setTimeout,createI18n(){},console});
  const send=message=>new Promise(resolve=>listener({type:'shared-config',...message},{},resolve));
  return {send,saved,events,setBusy:v=>{busy=v;},setFail:v=>{fail=v;},setBroadcastFail:v=>{failBroadcast=v;}};
}
const add=name=>({kind:'upsert',name,patch:{url:'https://example.com/mcp'}});

test('extension owner preview is read only and concurrent MCP/model saves preserve each other',async()=>{
  const f=await fixture(),preview=await f.send({operation:'mcp-preview',input:{name:'new',config:{url:'https://example.com/mcp'}}});
  assert.equal(preview.ok,true);assert.equal(f.events.length,0);assert.equal(f.saved.mcpRevision,undefined);
  const results=await Promise.all([
    f.send({operation:'mcp-change',request:{expectedVersion:preview.value.version,operation:add('new')}}),
    f.send({operation:'profile-save',profile:{id:'later'}}),
  ]);
  assert.ok(results.every(result=>result.ok));assert.ok(f.saved.mcp.mcpServers.new);assert.equal(f.saved.mcpRevision,1);assert.equal(f.saved.profiles.length,2);
  const event=f.events.find(event=>event.mcp);assert.deepEqual(event.mcp,f.saved.mcp);assert.equal(event.mcpRevision,1);
});

test('extension owner rejects busy, stale, invalid and failed writes without changing persisted config',async()=>{
  const f=await fixture(),initial=structuredClone(f.saved);
  f.setBusy(true);assert.equal((await f.send({operation:'mcp-change',request:{operation:add('new')}})).ok,false);assert.deepEqual(f.saved,initial);
  f.setBusy(false);f.setFail(true);
  const failure=await f.send({operation:'mcp-change',request:{operation:add('new')}});assert.equal(failure.ok,false);assert.match(failure.error,/尚未写入/);assert.deepEqual(f.saved,initial);
  f.setFail(false);
  const invalid=await f.send({operation:'mcp-change',request:{operation:{kind:'import',input:[{name:'good',config:{url:'https://example.com/mcp'}},{name:'bad',config:{url:'file:///bad'}}]}}});
  assert.equal(invalid.ok,false);assert.ok(invalid.diagnostics.length);assert.deepEqual(f.saved,initial);
  const stale=await f.send({operation:'mcp-change',request:{operation:add('new'),expectedVersion:'old'}});assert.equal(stale.ok,false);assert.match(stale.error,/配置已变化/);assert.deepEqual(f.saved,initial);
});

test('extension owner acknowledges persisted data even when engines cannot receive the update',async()=>{
  const f=await fixture();f.setBroadcastFail(true);
  const result=await f.send({operation:'mcp-change',request:{operation:add('new')}});
  assert.equal(result.ok,true);assert.equal(result.value.saved,true);assert.match(result.value.syncError,/已保存/);assert.ok(f.saved.mcp.mcpServers.new);
});
