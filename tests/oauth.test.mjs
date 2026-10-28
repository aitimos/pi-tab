import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createModels} from '@earendil-works/pi-ai/models';
import {builtinProviders} from '@earendil-works/pi-ai/providers/all';

const bundle=await readFile(new URL('../dist/oauth.js',import.meta.url),'utf8');
const catalog=builtinProviders().flatMap(p=>p.getModels());
function setup(fetch) {
  const data=new Map(),locks=new Map();
  const localStorage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
  const navigator={locks:{request:async(key,options,fn)=>{
    const previous=locks.get(key)||Promise.resolve();
    const next=previous.catch(()=>{}).then(()=>{options.signal?.throwIfAborted();return fn();});locks.set(key,next);return next;
  }}};
  const env={console,performance,crypto,FormData,Blob,File,URL,URLSearchParams,Headers,Request,Response,AbortController,AbortSignal,TextEncoder,TextDecoder,ReadableStream,TransformStream,Uint8Array,ArrayBuffer,atob,btoa,setTimeout,clearTimeout,fetch,localStorage,navigator};
  const api=runInNewContext(bundle+';PiTabOAuth',env);
  const credentials=api.browserCredentials('pi-tab-oauth');
  const models=createModels({credentials,authContext:{env:async()=>undefined,fileExists:async()=>false}});
  const {action}=api.installOAuth(models,catalog);
  return {action,models,credentials,localStorage};
}
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const device={device_code:'test-device',user_code:'TEST-123',verification_uri:'https://auth.kimi.com/activate',verification_uri_complete:'https://auth.kimi.com/activate?code=TEST-123',interval:.001,expires_in:60};
const token=(access='test-access',expires=3600)=>({access_token:access,refresh_token:'test-refresh',expires_in:expires});
async function promptReady(action,id){for(let i=0;i<100;i++){const status=await action('status',{id});if(status.prompt)return status;if(status.state==='error')throw Error(status.error);await new Promise(r=>setTimeout(r,5));}throw Error('Missing OAuth prompt');}
async function settled(action,id){for(let i=0;i<100;i++){const status=await action('status',{id});if(status.state!=='pending')return status;await new Promise(r=>setTimeout(r,10));}throw Error('OAuth did not settle');}

test('Pi native device login persists, refreshes once and streams with provider authentication',async()=>{
  let refreshes=0,authorization;
  const {action,models,credentials}=setup(async(input,init)=>{
    const url=String(input);
    if(url.endsWith('/device_authorization'))return json(device);
    if(url.endsWith('/oauth/token')){
      const fields=new URLSearchParams(init.body);
      assert.equal(fields.get('client_id'),'17e5f671-d194-4dfb-9706-5516cb48c098');
      if(fields.get('grant_type')==='refresh_token'){refreshes++;assert.equal(fields.get('refresh_token'),'test-refresh');return json(token('refreshed'));}
      assert.equal(fields.get('device_code'),'test-device');return json(token());
    }
    if(url.includes('/chat/completions')){
      authorization=new Headers(init.headers).get('authorization');
      return new Response('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'OAuth reply'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'test',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    }
    throw Error('Unexpected OAuth request '+url);
  });
  const {id}=await action('start',{providerId:'kimi-coding'});
  const result=await settled(action,id);assert.equal(result.state,'done',result.error);
  assert.equal(result.events[0].userCode,'TEST-123');
  assert.ok(!JSON.stringify(result).includes('test-access'));
  assert.equal((await credentials.read('kimi-coding')).type,'oauth');
  assert.ok((await action('list')).find(p=>p.id==='kimi-coding').connected);
  await credentials.modify('kimi-coding',async current=>({...current,expires:0}));
  const auth=await Promise.all([models.getAuth('kimi-coding'),models.getAuth('kimi-coding')]);
  assert.equal(refreshes,1);assert.equal(auth[0].auth.headers.Authorization,'Bearer refreshed');
  const available=await action('models',{providerId:'kimi-coding'});assert.ok(available.length);
  const response=await models.completeSimple(available[0],{messages:[{role:'user',content:'hello',timestamp:Date.now()}]},{transport:'sse'});
  assert.equal(response.stopReason,'stop',response.errorMessage);
  assert.equal(response.content.find(p=>p.type==='text')?.text,'OAuth reply');assert.equal(authorization,'Bearer refreshed');
  await action('logout',{providerId:'kimi-coding'});assert.equal(await credentials.read('kimi-coding'),undefined);
  assert.equal(await models.getAuth('kimi-coding'),undefined);
});

test('cancel aborts native polling and never stores a credential',async()=>{
  let tokenSignal;
  const {action,credentials}=setup(async(url,init)=>{
    if(String(url).endsWith('/device_authorization'))return json(device);
    tokenSignal=init.signal;
    return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
  });
  const {id}=await action('start',{providerId:'kimi-coding'});
  for(let i=0;!tokenSignal&&i<500;i++)await new Promise(r=>setTimeout(r,5));
  assert.ok(tokenSignal);await action('cancel',{id});assert.equal((await settled(action,id)).state,'error');
  assert.ok(tokenSignal.aborted);assert.equal(await credentials.read('kimi-coding'),undefined);
});

test('Anthropic uses Pi copy-code flow and Codex uses Pi device flow without loopback',async()=>{
  const urls=[];
  const {action}=setup(async(url)=>{urls.push(String(url));return json({error:'fixture failure'},400);});
  const anthropic=await action('start',{providerId:'anthropic'});
  for(let i=0;i<100;i++){
    const status=await action('status',anthropic);
    if(status.prompt){assert.equal(status.prompt.type,'manual_code');assert.ok(status.events.some(e=>e.type==='auth_url'));break;}
    if(i===99)assert.fail('Missing copy-code prompt');await new Promise(r=>setTimeout(r,5));
  }
  await action('cancel',anthropic);
  const codex=await action('start',{providerId:'openai-codex'});
  const choice=await promptReady(action,codex.id);
  await action('answer',{id:codex.id,promptId:choice.prompt.id,value:'device_code'});
  const status=await settled(action,codex.id);assert.equal(status.state,'error');
  assert.ok(urls.some(url=>url.includes('/deviceauth/')));assert.ok(!status.error.includes('loopback'));
});

test('native Copilot model filtering retains account entitlements',async()=>{
  const {action,credentials}=setup(()=>{throw Error('No network expected');});
  const id=catalog.find(m=>m.provider==='github-copilot').id;
  await credentials.modify('github-copilot',async()=>({type:'oauth',access:'test',refresh:'test',expires:Date.now()+3600000,availableModelIds:[id]}));
  const available=await action('models',{providerId:'github-copilot'});
  assert.deepEqual(available.map(m=>m.id),[id]);
});

test('native login and available models respect the selected API',async()=>{
 const {action,credentials}=setup(()=>{throw Error('No network expected');});
 const methods=await action('list',{api:'openai-codex-responses'});
 assert.deepEqual(Array.from(methods,m=>m.id),['openai-codex']);
 assert.deepEqual(Array.from(await action('list',{api:'google-generative-ai'})),[]);
 await assert.rejects(()=>action('start',{providerId:'kimi-coding',api:'anthropic-messages'}),/请选择/);
 await credentials.modify('github-copilot',async()=>({type:'oauth',access:'test',refresh:'test',expires:Date.now()+3600000}));
 const available=await action('models',{providerId:'github-copilot',api:'anthropic-messages'});
 assert.ok(available.length);assert.ok(available.every(m=>m.api==='anthropic-messages'));
});

for(const providerId of ['anthropic','openai-codex'])test(`${providerId}: native callback URL parsing, PKCE and state validation`,async()=>{
  let authorization,exchanges=0;
  const access=providerId==='openai-codex'?'e30.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture-account'}})).toString('base64url')+'.signature':'fixture-access';
  const {action,credentials}=setup(async(url,init)=>{
    exchanges++;
    assert.equal(String(url),providerId==='anthropic'?'https://platform.claude.com/v1/oauth/token':'https://auth.openai.com/oauth/token');
    const body=providerId==='anthropic'?JSON.parse(init.body):Object.fromEntries(new URLSearchParams(init.body));
    assert.equal(body.code,'fixture-code');
    assert.equal(body.redirect_uri,authorization.searchParams.get('redirect_uri'));
    const challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body.code_verifier))).toString('base64url');
    assert.equal(challenge,authorization.searchParams.get('code_challenge'));
    return json(token(access));
  });
  for(const failure of [true,false]){
    const {id}=await action('start',{providerId});
    let status=await promptReady(action,id);
    if(providerId==='openai-codex'){
      assert.equal(status.prompt.type,'select');
      await action('answer',{id,promptId:status.prompt.id,value:'browser'});
      status=await promptReady(action,id);
    }
    assert.equal(status.prompt.type,'manual_code');
    authorization=new URL(status.events.find(e=>e.type==='auth_url').url);
    const callback=new URL(authorization.searchParams.get('redirect_uri'));
    callback.searchParams.set('code','fixture-code');
    callback.searchParams.set('state',failure?'wrong-state':authorization.searchParams.get('state'));
    await action('answer',{id,promptId:status.prompt.id,value:callback.href});
    const result=await settled(action,id);
    if(failure){assert.equal(result.state,'error');assert.match(result.error,/state mismatch/i);assert.equal(exchanges,0);assert.equal(await credentials.read(providerId),undefined);}
    else{assert.equal(result.state,'done',result.error);assert.equal(exchanges,1);assert.equal((await credentials.read(providerId)).access,access);}
  }
});
