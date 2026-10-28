// Linux CI only. Exercises the shipped bookmark and extension with Pi's real
// configuration UI; only model HTTP responses are fixtures.
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
const directory=await mkdtemp(join(tmpdir(),'pi-tab-management-'));
const run=promisify(execFile);
const html=await readFile('pi-bookmarklet-chat-install.html','utf8');
const runtime=JSON.parse(html.match(/<script id="pi-runtime"[^>]*>(.*?)<\/script>/s)[1]);
const chat=html.match(/<script>\s*(async function openChat[\s\S]*?)\nconst PI_RUNTIME/)[1];
let bookmark,hold=false,requests=[];
const server=createServer((req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers',req.headers['access-control-request-headers']||'*');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
 if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
 if(req.url.endsWith('/models')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'test-model'},{id:'second-model'}]}));return;}
 if(req.url.endsWith('/chat/completions')){
  let body='';req.on('data',c=>body+=c);req.on('end',()=>{
   const input=JSON.parse(body);requests.push({url:req.url,key:req.headers.authorization,input});
   if(hold)return;
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   for(const choice of [{delta:{role:'assistant',content:'Management reply'},finish_reason:null},{delta:{},finish_reason:'stop'}])res.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',choices:[{index:0,...choice}]})+'\n\n');
   res.end('data: [DONE]\n\n');
  });return;
 }
 res.setHeader('Content-Type','text/html;charset=utf-8');res.end(`<title>Model management</title><a id="launch" href="${(bookmark||'').replaceAll('&','&amp;').replaceAll('"','&quot;')}">Pi Tab</a>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const profile={id:'fixture',profileId:'fixture',api:'openai-completions',baseUrl:base+'/v1',apiKey:'old-key',model:'test-model'};
bookmark=createBookmarklet(runtime,{openChat:chat,profiles:[profile],config:profile});

try{
 for(const mode of ['bookmarklet','extension'])for(const language of ['zh-CN','en']){
  hold=false;requests=[];
  const session=`pi-tab-management-${mode}-${language}-${process.pid}`;
  const extension=join(directory,`extension-${language}`);
  let extensionId,tabId;
  if(mode==='extension'){
    await cp(resolve('dist/extension'),extension,{recursive:true});
    const key=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'});
    extensionId=createHash('sha256').update(key).digest('hex').slice(0,32).replace(/[0-9a-f]/g,d=>String.fromCharCode(97+parseInt(d,16)));
    const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));manifest.key=key.toString('base64');await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
    await writeFile(join(extension,'test-controller.html'),'<!doctype html><title>Management controller</title>');

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
  const call=async(method,args=[])=>{
    if(mode==='bookmarklet')return evaluate(`window.pi[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
    await browser('tab','t2');
    const result=await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({target:'engine',site:'127.0.0.1',tabId,method,args})})`);
    await browser('tab','t1');assert.ok(result.ok,result.error);return result.value;
  };
  try{
    await browser('open',base+'/'+mode+language);await browser('set','viewport','1280','1000');
    await evaluate(`localStorage.setItem('pi-tab-language',${JSON.stringify(language)})`);
    if(mode==='bookmarklet')await browser('click','#launch');
    else{
      await browser('tab','new',`chrome-extension://${extensionId}/test-controller.html`);
      await evaluate(`chrome.storage.local.set({'pi-tab-language':${JSON.stringify(language)},profiles:[${JSON.stringify(profile)}],providers:[]})`);
      tabId=await evaluate(`(async()=>{const [tab]=await chrome.tabs.query({url:${JSON.stringify(base+'/'+mode+language)}});await chrome.storage.session.set({['active:'+tab.id]:true});const r=await chrome.tabs.sendMessage(tab.id,{type:'activate'});if(!r.ok)throw Error(r.error);return tab.id})()`);
      await browser('tab','t1');
    }
    await wait(`${root}?.getElementById('chat')?.style.display==='flex'`);
    const otherSite=async method=>{
      await browser('tab','t2');const result=await evaluate(`chrome.runtime.sendMessage({target:'engine',site:'localhost',tabId:${tabId},method:${JSON.stringify(method)},args:[]})`);await browser('tab','t1');assert.ok(result.ok,result.error);return result.value;
    };
    if(mode==='extension')await otherSite('initialize');
    const fill=async(id,value)=>evaluate(`(()=>{const e=${root}.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const manage=async()=>{await click('#model-settings');await click('#model-manage');await wait(`${root}.querySelector('.manager-row button')`);};
    await manage();assert.equal(await evaluate(`${root}.getElementById('model-dialog-title').textContent`),language==='en'?'Manage models':'管理模型');
    await click('.manager-group>.manager-row:first-child button');
    await fill('provider-name','Updated provider');await fill('provider-url',base+'/v2');await fill('provider-key','new-key');await click('#provider-form [type=submit]');
    await wait(`!${root}.getElementById('model-manager').hidden`);
    let profiles=await call('listModels');assert.equal(profiles.length,1);assert.equal(profiles[0].id,'fixture');assert.equal(profiles[0].baseUrl,base+'/v2');
    await click('[data-model-id="fixture"] button');await fill('manual-model-id','second-model');await click('#manual-model-form [type=submit]');
    await wait(`!${root}.getElementById('model-manager').hidden`);
    assert.equal((await call('listModels'))[0].model,'second-model');
    if(mode==='extension'){const shared=await otherSite('listModels');assert.equal(shared[0].model,'second-model');assert.equal(shared[0].baseUrl,base+'/v2');}
    await browser('screenshot',join(directory,`${mode}-${language}-manager.png`));
    await click('#model-dialog-close');await wait(`${root}.getElementById('chat-model').textContent==='second-model'`);
    await click('#message-input');await browser('keyboard','inserttext','Test updated configuration');await browser('press','Enter');
    await wait(`${root}.getElementById('chat-messages').textContent.includes('Management reply')`);
    assert.ok(requests.some(r=>r.url==='/v2/chat/completions'&&r.key==='Bearer new-key'&&r.input.model==='second-model'));
    await browser('reload');if(mode==='bookmarklet')await browser('click','#launch');
    await wait(`${root}?.getElementById('chat')?.style.display==='flex'`);
    assert.equal((await call('listModels'))[0].baseUrl,base+'/v2');
    // Deleting an active configuration is rejected before mutation.
    hold=true;await click('#message-input');await browser('keyboard','inserttext','Hold request');await browser('press','Enter');
    await wait(`!${root}.getElementById('abort').hidden`);
    const error=mode==='bookmarklet'?await evaluate(`(async()=>{try{await pi.manageModels({action:'delete-model',id:'fixture'});return '';}catch(error){return error.message;}})()`):await (async()=>{try{await call('manageModels',[{action:'delete-model',id:'fixture'}]);return '';}catch(error){return error.message;}})();assert.match(error,/正在运行/);
    await click('#abort');hold=false;await wait(`${root}.getElementById('abort').hidden`);
    await manage();await click('[data-model-id="fixture"] button:last-child');await click('.manager-confirm button');
    assert.equal((await call('listModels')).length,1,'cancel keeps model');
    await click('[data-model-id="fixture"] button:last-child');await click('.manager-confirm button:last-child');
    await wait(`!${root}.querySelector('[data-model-id="fixture"]')`);assert.equal((await call('listModels')).length,0);
    await click('.manager-group>.manager-row:first-child button:last-child');await click('.manager-confirm button:last-child');
    await wait(`!${root}.querySelector('.manager-group')`);assert.equal((await call('listProviders')).length,0);
    await browser('reload');if(mode==='bookmarklet')await browser('click','#launch');
    await wait(`${root}?.getElementById('setup')?.style.display==='flex'`);
    assert.equal((await call('listModels')).length,0,'deleted defaults do not return on reload');assert.equal((await call('listProviders')).length,0);
    if(mode==='bookmarklet'){await browser('click','#launch');await wait(`${root}.getElementById('setup').style.display==='flex'`);assert.equal((await call('listModels')).length,0,'repeated activation cannot restore a deleted profile');}
    if(mode==='extension'){
      await browser('tab','t2');
      const remote=await evaluate(`chrome.runtime.sendMessage({target:'engine',site:'localhost',tabId:${tabId},method:'initialize',args:[]})`);assert.ok(remote.ok,remote.error);
      const models=await evaluate(`chrome.runtime.sendMessage({target:'engine',site:'localhost',method:'listModels',args:[]})`);assert.deepEqual(models.value,[]);
      await browser('tab','t1');
    }
    console.log(`PASS ${mode} ${language}: edit provider/model, send updated credentials, cancel/delete, busy guard, reload/import persistence`);
  }finally{await browser('close');}
 }
}finally{server.closeAllConnections();server.close();}
