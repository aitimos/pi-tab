import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { createModelConfig, normalizeBaseUrl } from '../src/model-config.js';
const models=builtinProviders().flatMap(p=>p.getModels());
const apis=[...new Set(models.map(m=>m.api))].map(id=>({id}));
const service=createModelConfig({models,apis});
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});

test('thinking choices exactly follow the installed Pi catalog',()=>{
 for(const model of models)assert.deepEqual(service.describe({api:model.api,baseUrl:model.baseUrl,model:model.id,modelInfo:model}).thinkingLevels,getSupportedThinkingLevels(model));
 assert.deepEqual(service.describe({api:'openai-completions',model:'unknown-model'}).thinkingLevels,['off']);
});
test('URLs are validated before a credential-bearing request',async()=>{
 for(const value of ['javascript:alert(1)','https://user:pass@host/v1','https://host/v1?q=1','https://host/v1#secret'])assert.throws(()=>normalizeBaseUrl(value));
 let called=false;await assert.rejects(service.discover({api:'openai-completions',baseUrl:'https://host/?key=secret'},{fetch:()=>{called=true;}}));assert.equal(called,false);
});
for(const api of apis.filter(x=>!['bedrock-converse-stream','anthropic-messages','google-generative-ai','google-vertex'].includes(x.id)).map(x=>x.id)){
 test(`${api}: native model endpoint and credential headers`,async()=>{
  let seen;
  const result=await service.discover({api,baseUrl:'https://test.invalid/v1',apiKey:'test-key'},{fetch:async(url,options)=>{seen={url,options};return json(api==='openai-codex-responses'?{models:[{slug:'model-a',display_name:'Model A'}]}:{data:[{id:'model-a'},{id:'model-a'},{id:''},{id:123}]});}});
  assert.deepEqual(result.models.map(x=>x.id),['model-a']);assert.equal(result.source,'service');
  assert.equal(seen.options.headers[api==='azure-openai-responses'?'api-key':'Authorization'],api==='azure-openai-responses'?'test-key':'Bearer test-key');
  assert.equal(seen.options.redirect,'error');assert.match(seen.url,/models/);
 });
}
test('Anthropic pagination, native capabilities and request headers',async()=>{
 let count=0;
 const result=await service.discover({api:'anthropic-messages',baseUrl:'https://test.invalid/v1',apiKey:'key'},{fetch:async(url,{headers})=>{
  assert.equal(headers['x-api-key'],'key');assert.equal(headers['anthropic-version'],'2023-06-01');assert.equal(headers.Authorization,undefined);
  if(count++===0)return json({data:[{id:'model-a',capabilities:{thinking:{supported:true},effort:{supported:true,high:{supported:true},max:{supported:true}}}}],has_more:true,last_id:'model-a'});
  assert.match(url,/after_id=model-a/);return json({data:[{id:'model-b'}],has_more:false});
 }});
 assert.equal(result.models.length,2);assert.deepEqual(result.models[0].thinkingLevels,getSupportedThinkingLevels({reasoning:true}));
});
for(const api of ['google-generative-ai','google-vertex'])test(`${api}: model name normalization and paging`,async()=>{
 let count=0;const result=await service.discover({api,baseUrl:'https://test.invalid',apiKey:'key'},{fetch:async(url,{headers})=>{
  assert.equal(headers['x-goog-api-key'],'key');
  if(count++===0)return json({models:[{name:'models/model-a',thinking:true,supportedGenerationMethods:['generateContent']},{name:'models/embed',supportedGenerationMethods:['embedContent']}],nextPageToken:'page2'});
  assert.match(url,/pageToken=page2/);return json({models:[{name:'publishers/google/models/model-b'}]});
 }});assert.deepEqual(result.models.map(x=>x.id),['model-a','model-b']);
});
test('Ollama tags through the OpenAI-compatible API',async()=>{
 const result=await service.discover({api:'openai-completions',baseUrl:'http://localhost:11434/v1'},{fetch:async url=>{assert.equal(url,'http://localhost:11434/api/tags');return json({models:[{name:'local-model'}]});}});assert.equal(result.models[0].id,'local-model');
});
test('unverified catalog fallback stays distinguishable from discovery',async()=>{
 const result=await service.discover({api:'bedrock-converse-stream',baseUrl:'https://bedrock-runtime.us-east-1.amazonaws.com'});assert.equal(result.source,'catalog');assert.ok(result.models.length);assert.ok(result.warning);
 await assert.rejects(service.discover({api:'openai-completions',baseUrl:'https://unrecognized.invalid'},{fetch:async()=>new Response('',{status:401})}),/认证失败/);
});
test('cancellation does not turn into catalog success',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(service.discover({api:'openai-responses',baseUrl:'https://api.openai.com/v1'},{signal:controller.signal,fetch:async(_,options)=>{options.signal.throwIfAborted();}}),{name:'AbortError'});
});
