// Linux CI only. Exercises the shipped bookmark and extension with Pi's real
// OAuth/provider implementations; only the provider's HTTP responses are fixtures.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {cp,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {createBookmarklet} from '../src/bookmarklet.js';
if(process.platform!=='linux')throw Error('Run browser tests on Linux CI only.');
const chrome=process.env.PI_TAB_TEST_CHROME;
if(!chrome)throw Error('PI_TAB_TEST_CHROME is required');
const directory=await mkdtemp(join(tmpdir(),'pi-tab-oauth-'));
const run=promisify(execFile);
const html=await readFile('pi-bookmarklet-chat-install.html','utf8');
const runtime=JSON.parse(html.match(/<script id="pi-runtime"[^>]*>(.*?)<\/script>/s)[1]);
const chat=html.match(/<script>\s*(async function openChat[\s\S]*?)\nconst PI_RUNTIME/)[1];
const oauth=await readFile('dist/oauth.js','utf8');
let bookmark,prelude,approved=false,refreshes=0,modelRequests=[];
const server=createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers',req.headers['access-control-request-headers']||'*');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if(req.url==='/oauth.js'){res.setHeader('Content-Type','text/javascript');res.end(oauth);return;}
  if(req.url==='/prelude.js'){res.setHeader('Content-Type','text/javascript');res.end(prelude);return;}
  if(!req.url.startsWith('/mock?')){res.setHeader('Content-Type','text/html;charset=utf-8');res.end(`<title>OAuth integration test</title><script src="/prelude.js"></script><a id="launch" href="${(bookmark||'').replaceAll('&','&amp;').replaceAll('"','&quot;')}">Pi Tab</a>`);return;}
  const target=new URL(req.url,'http://test').searchParams.get('target');
  const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    if(target.endsWith('/device_authorization'))return json({device_code:'fixture-device',user_code:'TEST-123',verification_uri:'https://auth.kimi.com/activate',verification_uri_complete:'https://auth.kimi.com/activate?code=TEST-123',interval:1,expires_in:60});
    if(target.endsWith('/oauth/token')){
      const fields=new URLSearchParams(body);
      assert.equal(fields.get('client_id'),'17e5f671-d194-4dfb-9706-5516cb48c098');
      const refresh=fields.get('grant_type')==='refresh_token';
      if(!refresh&&!approved)return json({error:'authorization_pending'},400);
      if(refresh)refreshes++;
      return json({access_token:refresh?'fixture-refreshed':'fixture-access',refresh_token:'fixture-refresh',expires_in:refresh?3600:1});
    }
    if(target.includes('/chat/completions')){
      const input=JSON.parse(body);modelRequests.push({target,authorization:req.headers.authorization,input});
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      for(const choice of [{delta:{role:'assistant',content:'OAuth reply verified'},finish_reason:null},{delta:{},finish_reason:'stop'}])res.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',choices:[{index:0,...choice}]})+'\n\n');
      res.end('data: [DONE]\n\n');return;
    }
    json({error:'Unexpected provider URL: '+target},400);
  });
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
prelude=`(()=>{const original=fetch.bind(globalThis);globalThis.fetch=async(input,init)=>{const request=new Request(input,init);if(['auth.kimi.com','api.kimi.com'].includes(new URL(request.url).hostname))return original(${JSON.stringify(base+'/mock?target=')}+encodeURIComponent(request.url),{method:request.method,headers:request.headers,body:['GET','HEAD'].includes(request.method)?undefined:await request.text(),signal:request.signal});return original(input,init);};})();`;
bookmark=createBookmarklet(runtime.replace(/https:\/\/aitimos.github.io\/pi-tab\/oauth\/[\da-f]+\.js/g,base+'/oauth.js'),{openChat:chat});

try{
 for(const mode of ['bookmarklet','extension'])for(const language of ['zh-CN','en']){
  approved=false;const initialRefreshes=refreshes,initialRequests=modelRequests.length;
  const session=`pi-tab-oauth-${mode}-${language}-${process.pid}`;
  const extension=join(directory,`extension-${language}`);
  let extensionId,tabId;
  if(mode==='extension'){
    await cp(resolve('dist/extension'),extension,{recursive:true});
    const key=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'});
    extensionId=createHash('sha256').update(key).digest('hex').slice(0,32).replace(/[0-9a-f]/g,d=>String.fromCharCode(97+parseInt(d,16)));
    const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));manifest.key=key.toString('base64');await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
    await writeFile(join(extension,'test-controller.html'),'<!doctype html><title>OAuth controller</title>');
    await writeFile(join(extension,'oauth-fixture.js'),prelude);
    const engineHtml=await readFile(join(extension,'engine.html'),'utf8');await writeFile(join(extension,'engine.html'),engineHtml.replace('<script src="oauth.js">','<script src="oauth-fixture.js"></script><script src="oauth.js">'));
  }
  const browser=async(...args)=>{
    const {stdout}=await run('agent-browser',['--headed','false','--executable-path',chrome,'--args','--headless=new,--no-sandbox',...(mode==='extension'?['--extension',extension]:[]),'--session',session,'--json',...args],{maxBuffer:5*1024*1024});
    const result=JSON.parse(stdout);assert.ok(result.success,JSON.stringify(result.error));return result.data;
  };
  const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
  const root="document.querySelector('[data-pi-overlay]')?.shadowRoot";
  const wait=async expression=>browser('wait','--fn',expression);
  const click=async selector=>{
    const point=await evaluate(`(()=>{const e=${root}.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await browser('mouse','move',String(Math.round(point.x)),String(Math.round(point.y)));await browser('mouse','down','left');await browser('mouse','up','left');
  };
  const select=async(id,value)=>evaluate(`(()=>{const s=${root}.getElementById(${JSON.stringify(id)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const call=async(method,args=[])=>{
    if(mode==='bookmarklet')return evaluate(`window.pi[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
    await browser('tab','t2');
    const result=await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({target:'engine',site:'127.0.0.1',tabId,method,args})})`);
    await browser('tab','t1');assert.ok(result.ok,result.error);return result.value;
  };
  const api=(action,input={})=>call('auth',[action,input]);
  try{
    await browser('open',base+'/'+mode+language);await browser('set','viewport','1280','1000');
    await evaluate(`localStorage.setItem('pi-tab-language',${JSON.stringify(language)})`);
    if(mode==='bookmarklet')await browser('click','#launch');
    else{
      await browser('tab','new',`chrome-extension://${extensionId}/test-controller.html`);
      await evaluate(`chrome.storage.local.set({'pi-tab-language':${JSON.stringify(language)}})`);
      tabId=await evaluate(`(async()=>{const [tab]=await chrome.tabs.query({url:${JSON.stringify(base+'/'+mode+language)}});await chrome.storage.session.set({['active:'+tab.id]:true});const r=await chrome.tabs.sendMessage(tab.id,{type:'activate'});if(!r.ok)throw Error(r.error);return tab.id})()`);
      await browser('tab','t1');
    }
    await wait(`${root}?.getElementById('api')?.options.length>0`);
    // Test API/authentication as one connected form, including switching away
    // from an OAuth-only API and returning to a custom key-based endpoint.
    await select('api','openai-codex-responses');
    assert.deepEqual(await evaluate(`Array.from(${root}.getElementById('setup-auth').options,o=>o.value)`),['openai-codex']);
    assert.equal(await evaluate(`${root}.getElementById('api-key').disabled`),true);
    assert.equal(await evaluate(`${root}.getElementById('base-url').disabled`),true);
    await select('api','anthropic-messages');
    assert.ok((await evaluate(`Array.from(${root}.getElementById('setup-auth').options,o=>o.value)`)).includes('anthropic'));
    assert.ok(!(await evaluate(`Array.from(${root}.getElementById('setup-auth').options,o=>o.value)`)).includes('kimi-coding'));
    await select('api','google-generative-ai');
    assert.deepEqual(await evaluate(`Array.from(${root}.getElementById('setup-auth').options,o=>o.value)`),['api_key','none']);
    await select('setup-auth','none');assert.equal(await evaluate(`${root}.getElementById('api-key').disabled`),true);
    await select('api','openai-completions');
    assert.equal(await evaluate(`${root}.getElementById('api-key').disabled`),false);
    assert.equal(await evaluate(`${root}.getElementById('base-url').disabled`),false);
    const aligned=await evaluate(`(()=>{const r=${root};const title=r.getElementById('setup-title').getBoundingClientRect(),action=r.getElementById('setup-manage').getBoundingClientRect(),api=r.getElementById('api').getBoundingClientRect(),auth=r.getElementById('setup-auth').getBoundingClientRect();return {heading:Math.abs(title.y+title.height/2-action.y-action.height/2),fields:Math.abs(api.y-auth.y),fit:auth.right<=r.getElementById('shell').getBoundingClientRect().right}})()`);
    assert.ok(aligned.heading<2 && aligned.fields<2 && aligned.fit,JSON.stringify(aligned));
    await browser('screenshot',join(directory,`${mode}-${language}-setup.png`));
    const originalWidth=await evaluate(`document.querySelector('[data-pi-overlay]').style.width`);
    await evaluate(`document.querySelector('[data-pi-overlay]').style.width='340px'`);
    await browser('screenshot',join(directory,`${mode}-${language}-setup-narrow.png`));
    assert.equal(await evaluate(`(()=>{const r=${root},api=r.getElementById('api').getBoundingClientRect(),auth=r.getElementById('setup-auth').getBoundingClientRect();return auth.y>api.bottom && Math.abs(api.x-auth.x)<1 && auth.right<=r.getElementById('shell').getBoundingClientRect().right})()`),true);
    await evaluate(`document.querySelector('[data-pi-overlay]').style.width=${JSON.stringify(originalWidth)}`);
    await select('setup-auth','kimi-coding');await click('#start');await wait(`${root}.getElementById('oauth-form')?.dataset.provider==='kimi-coding'`);
    assert.equal(await evaluate(`${root}.getElementById('model-dialog-title').textContent`),'Kimi Code (subscription)');
    await click('#oauth-submit');
    await wait(`${root}.getElementById('oauth-events').textContent.includes('TEST-123')`);
    await browser('screenshot',join(directory,`${mode}-${language}-device.png`));
    assert.ok((await api('list')).every(p=>!p.connected));
    await click('#oauth-cancel');assert.equal((await api('list')).find(p=>p.id==='kimi-coding').connected,false);
    await click('#model-dialog-close');await click('#start');await wait(`${root}.getElementById('oauth-form')?.dataset.provider==='kimi-coding'`);
    assert.equal(await evaluate(`${root}.getElementById('oauth-events').textContent`),'');
    approved=true;await click('#oauth-submit');
    await wait(`!${root}.getElementById('manual-model-form').hidden && ${root}.getElementById('manual-model-results').querySelector('button')`);
    await click('#manual-model-results button');await click('#manual-model-form [type=submit]');
    await wait(`${root}.getElementById('chat').style.display==='flex'`);
    await new Promise(r=>setTimeout(r,1100));
    await click('#message-input');await browser('keyboard','inserttext','Hello OAuth');await browser('press','Enter');
    await wait(`${root}.getElementById('chat-messages').textContent.includes('OAuth reply verified')`);
    assert.ok(refreshes>initialRefreshes,'expired OAuth token refreshed by Pi');
    assert.ok(modelRequests.slice(initialRequests).some(r=>r.authorization==='Bearer fixture-refreshed'&&r.target.startsWith('https://api.kimi.com/coding/v1/')));
    const profiles=await call('listModels');assert.ok(!JSON.stringify(profiles).includes('fixture-access'));assert.ok(!JSON.stringify(profiles).includes('fixture-refresh'));
    await browser('screenshot',join(directory,`${mode}-${language}-reply.png`));
    await browser('reload');if(mode==='bookmarklet')await browser('click','#launch');
    await wait(`${root}?.getElementById('chat')?.style.display==='flex'`);
    assert.ok((await api('list')).find(p=>p.id==='kimi-coding').connected,'OAuth survives reload');
    if(mode==='extension')assert.equal(await evaluate("localStorage.getItem('pi-tab-oauth')"),null,'extension tokens stay in the extension origin');
    await click('#model-settings');await click('#model-manage');await wait(`${root}.querySelector('.manager-group>.manager-row button:last-child')`);await click('.manager-group>.manager-row button:last-child');await wait(`${root}.getElementById('oauth-form')?.dataset.provider==='kimi-coding'`);
    assert.equal(await evaluate(`${root}.getElementById('oauth-logout').hidden`),false);
    await click('#oauth-logout');await wait(`!${root}.getElementById('oauth-submit').disabled`);
    assert.equal((await api('list')).find(p=>p.id==='kimi-coding').connected,false);
    await click('#model-dialog-close');await click('#model-dialog-close');
    await click('#model-settings');await click('#model-menu-add');await click('#manual-add-provider');
    await select('provider-api','openai-codex-responses');
    assert.deepEqual(await evaluate(`Array.from(${root}.getElementById('provider-auth').options,o=>o.value)`),['openai-codex']);
    assert.equal(await evaluate(`${root}.getElementById('provider-url').disabled`),true);
    await select('provider-api','openai-completions');
    assert.equal(await evaluate(`${root}.getElementById('provider-key').disabled`),false);
    await browser('screenshot',join(directory,`${mode}-${language}-provider.png`));
    await select('provider-auth','kimi-coding');await click('#provider-form [type=submit]');
    await wait(`${root}.getElementById('oauth-form')?.dataset.provider==='kimi-coding'`);
    await click('#oauth-submit');await wait(`${root}.getElementById('manual-model-results').querySelector('button') && !${root}.getElementById('manual-model-form').hidden`);
    assert.ok((await api('list')).find(p=>p.id==='kimi-coding').connected);
    console.log(`PASS ${mode} ${language}: native login, cancel, models, send, refresh, persistence, sign out`);
  }finally{await browser('close');}
 }
}finally{server.closeAllConnections();server.close();}
