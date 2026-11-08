import {test} from 'node:test';
import assert from 'node:assert/strict';
import {changeMcpConfig,parseMcpImport,planMcpImport,readMcpJson,validateMcpEntry,mcpVersion,mcpPublicSummary,publicMcpPlan,mcpVariableReferences,mergeMcpBookmark} from '../src/mcp-config.js';
import {McpConfigStore} from '../src/mcp-store.js';

const url='https://example.com/mcp';
const entry={url};
const empty=()=>({mcpServers:{}});
const wrap=(name,config=entry)=>({name,config});

test('the four documented formats preserve raw server and global fields',()=>{
  const config={url,custom:{keep:true},headers:{Authorization:'Bearer ${TOKEN}'}};
  for(const input of [wrap('docs',config),[wrap('docs',config)],{mcpServers:{docs:config},env:{TOKEN:'synthetic'}},{docs:config,env:{TOKEN:'synthetic'},autoEnableCodemode:false}]){
    const parsed=parseMcpImport(JSON.stringify(input));
    assert.deepEqual(parsed.entries,[wrap('docs',config)]);
    if(input.autoEnableCodemode===false)assert.equal(parsed.globals.autoEnableCodemode,false);
  }
  assert.deepEqual(parseMcpImport({mcpServers:{name:entry,config:entry,mcpServers:entry}}).entries.map(item=>item.name),['name','config','mcpServers']);
});

test('strict JSON rejects syntax and duplicate keys, including escaped and nested equivalents, without echoing values',()=>{
  for(const input of ['{secret', '{"a":"SENTINEL",}', '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":[{"token":"SENTINEL","token":2}]}']){
    assert.throws(()=>readMcpJson(input),error=>!error.message.includes('SENTINEL'));
  }
  assert.deepEqual(readMcpJson('{"a":"a\\\"b","array":[true,null,1e3,{}]}'),{a:'a"b',array:[true,null,1000,{}]});
});

test('empty, ambiguous and malformed documents cannot clear saved servers',()=>{
  for(const input of ['',null,1,[],{}, {mcpServers:[]},[wrap('docs'),entry],{name:'docs',config:entry,extra:1}])assert.throws(()=>parseMcpImport(input));
});

test('conflicts retain existing data by default; replacement is explicit and replaces the whole entry',()=>{
  const current={mcpServers:{docs:{url,headers:{Authorization:'old-secret'},unknown:7}},env:{TOKEN:'old'}};
  const incoming={mcpServers:{docs:{url:url+'/new'},search:entry},env:{TOKEN:'new'},custom:{v:1}};
  const plan=planMcpImport(current,incoming);
  assert.equal(plan.rows.find(row=>row.id==='server.0').action,'keep');
  assert.deepEqual(plan.candidate.mcpServers.docs,current.mcpServers.docs);
  assert.equal(plan.candidate.env.TOKEN,'old');
  assert.equal(plan.candidate.custom.v,1);
  const replace=planMcpImport(current,incoming,{'server.0':{action:'replace'},'env.TOKEN':'replace'});
  assert.deepEqual(replace.candidate.mcpServers.docs,{url:url+'/new'});
  assert.equal(replace.candidate.env.TOKEN,'new');
  assert.equal(replace.counts.replaced,1);
  assert.equal(current.env.TOKEN,'old');
});

test('batch collisions and alias collisions cannot silently overwrite, rename and skip resolve existing aliases',()=>{
  assert.ok(planMcpImport(empty(),[wrap('dev-x'),wrap('DEV_x')]).errors.length);
  const current={mcpServers:{'dev-x':entry}};
  assert.ok(planMcpImport(current,wrap('DEV_x')).errors.length);
  const skip=planMcpImport(current,wrap('DEV_x'),{'server.0':{action:'skip'}});
  assert.equal(skip.errors.length,0);assert.equal(skip.changed,false);
  const rename=planMcpImport(current,wrap('DEV_x'),{'server.0':{name:'other'}});
  assert.equal(rename.errors.length,0);assert.ok(rename.candidate.mcpServers.other);
});

test('invalid fields reject the whole batch even when some entries were selected to skip',()=>{
  const cases=[{url:'ftp://example.com'}, {url:'https://u:p@example.com'}, {url:url+'#fragment'}, {url:url+'#'}, {url,enabled:'false'}, {url,timeout:0.1}, {url,timeout:601}, {url,exposure:'no'}, {url,toolExposure:{'*':'no'}}, {url,headers:{Accept:'x'}}, {url,headers:{Authorization:1}}, {url,headers:{x:'a\nb'}}, {url,headers:{x:'!command'}}, {url,headers:{x:'${MISSING}'}}, {url,headers:{X:'1',x:'2'}}];
  for(const config of cases){
    const plan=planMcpImport(empty(),[wrap('good'),wrap('bad',config)],{'server.1':{action:'skip'}});
    assert.ok(plan.errors.length,JSON.stringify(config));
    assert.throws(()=>changeMcpConfig(empty(),{kind:'import',input:[wrap('good'),wrap('bad',config)]}));
  }
});

test('unsupported but well formed servers are retained, never advertised as connectable',()=>{
  for(const config of [{command:'npx',args:['server'],env:{TOKEN:'sample'}},{url,type:'sse'},{url,oauth:{clientId:'example'}}]){
    const plan=planMcpImport(empty(),wrap('local',config));
    assert.deepEqual(plan.errors,[]);assert.equal(plan.counts.unsupported,1);
    assert.deepEqual(plan.candidate.mcpServers.local,config);
  }
  assert.ok(validateMcpEntry('local',{type:'stdio'}).errors.length);
});

test('CRUD preserves other servers, unknown fields, globals, raw placeholders and defaults absent from storage',()=>{
  const current={mcpServers:{docs:{url,headers:{Authorization:'Bearer ${TOKEN}'},custom:{keep:1}},broken:{url:3},local:{command:'npx',args:['fixture']}},env:{TOKEN:'sample'},rootUnknown:[1]};
  const next=changeMcpConfig(current,{kind:'upsert',name:'docs-new',previousName:'docs',patch:{description:'changed'}}).value;
  assert.equal(next.mcpServers.docs,undefined);
  assert.equal(next.mcpServers['docs-new'].timeout,undefined);
  assert.equal(next.mcpServers['docs-new'].headers.Authorization,'Bearer ${TOKEN}');
  assert.deepEqual(next.mcpServers['docs-new'].custom,{keep:1});
  assert.deepEqual(next.mcpServers.broken,current.mcpServers.broken);
  assert.deepEqual(next.rootUnknown,[1]);
  const removed=changeMcpConfig(next,{kind:'delete',name:'local'}).value;
  assert.equal(removed.mcpServers.local,undefined);
  assert.throws(()=>changeMcpConfig(current,{kind:'upsert',name:'local',previousName:'local',patch:{url}}));
  assert.throws(()=>changeMcpConfig(current,{kind:'upsert',name:'DOCS',patch:entry}));
  assert.deepEqual(JSON.parse(JSON.stringify(next)),next);
});

test('environment changes validate affected references, preserve unrelated legacy problems, and preview their impact',()=>{
  const current={mcpServers:{docs:{url,headers:{Authorization:'Bearer ${TOKEN}'}},broken:{url:1}},env:{TOKEN:'old'}};
  assert.throws(()=>changeMcpConfig(current,{kind:'variables',env:{}}));
  assert.equal(changeMcpConfig(current,{kind:'variables',env:{TOKEN:'new'}}).value.env.TOKEN,'new');
  assert.throws(()=>changeMcpConfig(current,{kind:'variables',env:{TOKEN:'a\nb'}}));
  const plan=planMcpImport(current,{mcpServers:{new:entry},env:{TOKEN:'new'}},{'env.TOKEN':'replace'});
  assert.deepEqual(plan.rows.find(row=>row.id==='env.TOKEN').affected,['docs']);assert.equal(plan.errors.length,0);
  assert.deepEqual(mcpVariableReferences(current),{TOKEN:['docs']});
});

test('bookmark snapshots preserve site preferences, skipped aliases, unknown globals and legacy unsupported entries',()=>{
  const current={mcpServers:{docs:{url:url+'/site'}},env:{TOKEN:'site'},siteOnly:7};
  const incoming={mcpServers:{DOCS:{url},local:{command:'npx'},broken:{url:3}},env:{TOKEN:'bookmark',NEW:'example'},customRoot:{keep:true}};
  const {value,result}=mergeMcpBookmark(current,incoming);
  assert.deepEqual(result.skipped,['DOCS']);assert.deepEqual(value.mcpServers.docs,current.mcpServers.docs);
  assert.deepEqual(value.mcpServers.broken,{url:3});assert.deepEqual(value.customRoot,{keep:true});
  assert.deepEqual(value.env,{TOKEN:'site',NEW:'example'});assert.equal(value.siteOnly,7);
  assert.deepEqual(changeMcpConfig(current,{kind:'bootstrap',input:incoming}).value,value);
});

test('public summary and import plans exclude credentials, query values, raw text and remote error text',()=>{
  const current={mcpServers:{docs:{url:url+'?key=QUERY_SENTINEL',headers:{Authorization:'HEADER_SENTINEL'},env:{PRIVATE:'ENTRY_SENTINEL'}},bad:{url:null},local:{command:'npx'}},env:{TOKEN:'ENV_SENTINEL'}};
  const summary=mcpPublicSummary(current,[{name:'docs',status:'error',error:'failure HEADER_SENTINEL ENV_SENTINEL QUERY_SENTINEL ENTRY_SENTINEL'}]);
  const plan=publicMcpPlan(planMcpImport(empty(),current));
  for(const sentinel of ['QUERY_SENTINEL','HEADER_SENTINEL','ENV_SENTINEL','ENTRY_SENTINEL']){assert.ok(!JSON.stringify(summary).includes(sentinel));assert.ok(!JSON.stringify(plan).includes(sentinel));}
  assert.equal(summary.servers.length,3);assert.equal(summary.servers[0].url,url);assert.equal(summary.raw,undefined);assert.equal(summary.text,undefined);
});

test('special object keys remain JSON data and do not modify prototypes',()=>{
  const input=readMcpJson('{"mcpServers":{"__proto__":{"url":"https://example.com/mcp"},"constructor":{"url":"https://example.com/mcp"}},"env":{"__proto__":"x"}}');
  const plan=planMcpImport(empty(),input);
  assert.equal(plan.errors.length,0);assert.ok(Object.hasOwn(plan.candidate.mcpServers,'__proto__'));assert.equal({}.url,undefined);
});

function fixture(){
  let saved={mcp:{mcpServers:{docs:entry}}},fail=false,busy=false,notifications=0;
  const store=new McpConfigStore({read:()=>structuredClone(saved),write:next=>{if(fail)throw Error('disk');saved={...saved,...structuredClone(next)};},guard:()=>{if(busy)throw Error('busy');},onSaved:()=>{notifications++;}});
  return {store,get saved(){return saved;},setFail:value=>{fail=value;},setBusy:value=>{busy=value;},get notifications(){return notifications;}};
}

test('preview is read only; a failed save never changes data or notifies the runtime',async()=>{
  const f=fixture(),before=structuredClone(f.saved),plan=await f.store.preview(wrap('new'));
  assert.deepEqual(f.saved,before);assert.equal(f.notifications,0);
  f.setFail(true);
  await assert.rejects(f.store.change({expectedVersion:plan.version,operation:{kind:'import',input:wrap('new')}}),/尚未写入/);
  assert.deepEqual(f.saved,before);assert.equal(f.notifications,0);
});

test('stale previews, including writes by an old runtime without a revision, are rejected',async()=>{
  const f=fixture(),old=await f.store.snapshot();f.saved.mcp.env={TOKEN:'different'};
  await assert.rejects(f.store.change({expectedVersion:old.version,operation:{kind:'delete',name:'docs'}}),/配置已变化/);
  assert.ok(f.saved.mcp.mcpServers.docs);assert.equal(f.notifications,0);
});

test('owner serializes competing edits, increments revision, and rejects changes while a task is running',async()=>{
  const f=fixture(),state=await f.store.snapshot();
  const results=await Promise.allSettled(['one','two'].map(name=>f.store.change({expectedVersion:state.version,operation:{kind:'upsert',name,patch:entry}})));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(f.saved.mcpRevision,1);assert.equal(f.notifications,1);
  f.setBusy(true);await assert.rejects(f.store.change({operation:{kind:'delete',name:'docs'}}),/busy/);
});

test('a broadcast failure reports saved data separately from synchronization failure',async()=>{
  let saved={};const store=new McpConfigStore({read:()=>saved,write:next=>{saved=next;},onSaved:()=>{throw Error('no engine');}});
  const result=await store.change({operation:{kind:'upsert',name:'docs',patch:entry}});
  assert.equal(result.saved,true);assert.match(result.syncError,/已保存/);assert.ok(saved.mcp.mcpServers.docs);
  assert.equal(result.version,mcpVersion(saved.mcp,1));
});
