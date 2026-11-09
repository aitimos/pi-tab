// Real built bookmark/extension, including profiles-only bookmarks from before
// explicit provider records. Every endpoint and credential is a local fixture.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chromium,expect} from 'playwright/test';
import {createBookmarklet} from '../src/bookmarklet.js';
import {extensionTestRpc} from './extension-test-rpc.mjs';

const directory=process.env.PI_TAB_PROVIDER_EVIDENCE||await mkdtemp(join(tmpdir(),'pi-tab-model-providers-'));
await mkdir(directory,{recursive:true});
const html=await readFile('pi-bookmarklet-chat-install.html','utf8');
const runtime=JSON.parse(html.match(/<script id="pi-runtime"[^>]*>(.*?)<\/script>/s)[1]);
const chat=html.match(/<script>\s*(async function openChat[\s\S]*?)\nconst PI_RUNTIME/)[1];
const requests=[],results=[],screenshots=[];
const server=createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','*');
  if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
  if(req.url.endsWith('/models')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'qa-one'},{id:'qa-two'}]}));return;}
  if(req.url.endsWith('/chat/completions')){
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      const input=JSON.parse(body);requests.push({model:input.model,key:req.headers.authorization});
      res.writeHead(200,{'Content-Type':'text/event-stream'}).end('data: '+JSON.stringify({id:'provider-fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'Provider configuration verified'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    });return;
  }
  res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><title>Model provider regression</title><h1>Local test page</h1><a id="launch">Pi Tab</a>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let context;
try{
  for(const mode of ['bookmarklet','extension'])for(const shape of ['implicit','explicit']){
    const prefix=mode+'-'+shape,extension=resolve('dist/extension');
    const connection={api:'openai-completions',baseUrl:base+'/v1',apiKey:'primary-fixture-key',providerName:'Primary account'};
    const profiles=['qa-one','qa-two'].map(id=>({...connection,id,profileId:id,model:id,...(shape==='explicit'?{providerId:'primary-provider'}:{})}));
    profiles.push({...connection,id:'other-account',profileId:'other-account',model:'other-model',apiKey:'other-fixture-key',providerName:'Other account',...(shape==='explicit'?{providerId:'other-provider'}:{})});
    const providers=shape==='implicit'?[]:[{...connection,id:'primary-provider'},{...connection,id:'other-provider',apiKey:'other-fixture-key',providerName:'Other account'}];
    const bookmark=createBookmarklet(runtime,{openChat:chat,profiles,providers,config:profiles[0]});
    context=await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(),'pi-tab-provider-profile-')),{headless:true,executablePath:process.env.PI_TAB_TEST_CHROME||chromium.executablePath(),locale:'en',viewport:{width:1280,height:1000},args:['--no-sandbox','--no-proxy-server',...(mode==='extension'?[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]:[])]});
    await context.addInitScript(()=>{localStorage.setItem('pi-tab-language','en');localStorage.setItem('pi-tab-size',JSON.stringify({width:560,height:800}));});
    const worker=mode==='extension'?(context.serviceWorkers()[0]||await context.waitForEvent('serviceworker')):null;
    if(worker)await worker.evaluate(({profiles,providers})=>chrome.storage.local.set({profiles,providers,'pi-tab-language':'en'}),{profiles,providers});
    const page=await context.newPage(),root=page.locator('[data-pi-overlay]').last(),ui=selector=>root.locator(selector);
    const tabIds=new Map();
    const call=async(method,args=[])=>{
      if(!worker)return page.evaluate(({method,args})=>pi[method](...args),{method,args});
      const result=await worker.evaluate(extensionTestRpc,{tabId:tabIds.get(page),site:'127.0.0.1',method,args});assert.equal(result.ok,true,result.error);return result.value;
    };
    const activate=async(target,url)=>{
      await target.goto(url);
      if(worker){
        const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,url);tabIds.set(target,tabId);
        const result=await worker.evaluate(extensionTestRpc,{tabId,site:'127.0.0.1',method:'createChat'});assert.equal(result.ok,true,result.error);
      }else{await target.locator('#launch').evaluate((element,bookmark)=>element.href=bookmark,bookmark);await target.locator('#launch').click();}
      await target.locator('[data-pi-overlay]').last().locator('#settings:enabled').waitFor();
    };
    const settings=async()=>{await ui('#settings').click();await ui('#settings-models-tab').click();await ui('[data-model-id="qa-one"]').waitFor();};
    const shot=async name=>{const file=prefix+'-'+name+'.png';await root.screenshot({path:join(directory,file),animations:'disabled'});screenshots.push(file);};
    const send=async text=>{
      if(worker){if(await ui('#continuation-panel').getAttribute('data-authorized')!=='true')await ui('#continue-here').click();await expect(ui('#continuation-panel')).toHaveAttribute('data-authorized','true');}
      await ui('#message-input').fill(text);await ui('#send').click();await expect(ui('#chat-messages')).toContainText('Provider configuration verified');await expect(ui('#abort')).toBeHidden();
    };
    const edit=async()=>{await ui('[data-model-id="qa-one"] button').first().click();await expect(ui('#model-dialog-title')).toHaveText('Edit model');await expect(ui('#manual-model-id')).toHaveValue('qa-one');await expect(ui('#manual-model-form [type=submit]')).toBeEnabled();};
    try{
      await activate(page,base+'/'+prefix);await send('Initial provider context');await settings();await shot('01-before-second-tab');
      const before=(await call('listModels')).find(model=>model.id==='qa-one').providerId;
      const other=await context.newPage();await activate(other,base+'/'+prefix+'/second');
      await other.locator('[data-pi-overlay]').last().locator('#settings').click();
      const after=(await call('listModels')).find(model=>model.id==='qa-one').providerId;
      if(mode==='bookmarklet'&&shape==='implicit')assert.notEqual(before,after,'the fixture must exercise the derived provider ID change');
      await other.close();
      const original=await call('listModels');
      await edit();
      assert.equal(await ui('#manual-model-provider').inputValue(),after,'the stale row must resolve the current provider association');
      await shot('02-current-provider');
      await ui('#manual-model-id').fill('UNSAVED');await ui('#model-dialog-close').click();await ui('[data-model-id="qa-one"]').waitFor();
      assert.deepEqual(await call('listModels'),original,'cancel does not write the configuration');
      if(!worker){
        await page.evaluate(()=>{const original=pi.listProviders;pi.listProviders=()=>{pi.listProviders=original;return new Promise(resolve=>{window.releaseProviderRead=()=>original().then(resolve);});};});
        await ui('[data-model-id="qa-one"] button').first().click();await expect(ui('#manual-model-form')).toBeVisible();
        await expect(ui('#manual-model-form [type=submit]')).toBeDisabled();
        await ui('#model-dialog-close').click();await ui('[data-model-id="qa-one"]').waitFor();
        await page.evaluate(async()=>{await window.releaseProviderRead();delete window.releaseProviderRead;});
        await expect(ui('#model-dialog')).toBeHidden();await expect(ui('#settings-models')).toBeVisible();
        assert.deepEqual(await call('listModels'),original,'a cancelled provider read cannot reopen or save the editor');
      }
      await edit();await ui('#manual-model-id').fill('qa-revised');await ui('#manual-model-reasoning').check();await ui('#manual-model-vision').check();
      // A missing selection must produce visible feedback and preserve drafts.
      await ui('#manual-model-provider').evaluate(select=>{select.value='';});
      await ui('#manual-model-form [type=submit]').click();await expect(ui('#manual-model-error')).toHaveText('Select a provider.');
      assert.deepEqual(await call('listModels'),original);await expect(ui('#manual-model-id')).toHaveValue('qa-revised');await shot('03-missing-provider');
      await ui('#manual-model-provider').selectOption(after);await ui('#manual-model-id').fill('qa-revised');await ui('#manual-model-reasoning').check();await ui('#manual-model-vision').check();
      await ui('#manual-model-form [type=submit]').click();await expect(ui('[data-model-id="qa-one"] span')).toHaveText('qa-revised');
      const saved=await call('listModels'),model=saved.find(model=>model.id==='qa-one');
      assert.equal(model.reasoning,true);assert.ok(model.input.includes('image'));assert.equal(saved.find(model=>model.id==='qa-two').model,'qa-two');assert.equal(saved.find(model=>model.id==='other-account').model,'other-model');
      await shot('04-saved');await ui('#preferences-back').click();
      const requestCount=requests.length;await send('Use the edited provider');
      assert.ok(requests.slice(requestCount).some(request=>request.model==='qa-revised'&&request.key==='Bearer primary-fixture-key'),'the edited model must keep the correct account on a shared endpoint');
      await page.reload();
      if(!worker){await page.locator('#launch').evaluate((element,bookmark)=>element.href=bookmark,bookmark);await page.locator('#launch').click();}
      await ui('#settings:enabled').waitFor();await settings();await expect(ui('[data-model-id="qa-one"] span')).toHaveText('qa-revised');
      const reloaded=(await call('listModels')).find(model=>model.id==='qa-one');assert.equal(reloaded.reasoning,true);assert.ok(reloaded.input.includes('image'));await shot('05-reloaded');
      results.push({mode,shape,beforeProviderId:before,afterProviderId:after,checks:['second bookmark tab','current provider association','cancel','visible missing-provider error','model ID and capabilities preserved','same-endpoint account isolation','save and actual request','reload']});
      console.log('PASS '+prefix+': provider drift, cancel, missing selection, save, account isolation and reload');
    }catch(error){await shot('failure');throw error;}
    await context.close();context=null;
  }
}finally{
  await context?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  const hashes={};for(const file of ['pi-bookmarklet-chat-install.html','dist/extension/content.js','dist/pi-tab-extension.zip'])hashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
  await writeFile(join(directory,'manifest.json'),JSON.stringify({commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),node:process.version,hashes,results,screenshots},null,2));
  console.log('Evidence: '+directory);
}
