// Exercise the shipped UI with local model responses and isolated browser data.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chromium,expect} from 'playwright/test';
import {createBookmarklet} from '../src/bookmarklet.js';
import {extensionTestRpc} from './extension-test-rpc.mjs';

const directory=process.env.PI_TAB_MODEL_EVIDENCE||await mkdtemp(join(tmpdir(),'pi-tab-model-settings-'));
await mkdir(directory,{recursive:true});
const html=await readFile('pi-bookmarklet-chat-install.html','utf8');
const runtime=JSON.parse(html.match(/<script id="pi-runtime"[^>]*>(.*?)<\/script>/s)[1]);
const chat=html.match(/<script>\s*(async function openChat[\s\S]*?)\nconst PI_RUNTIME/)[1];
const requests=[],screenshots=[],checks=[];
let held=false;
const server=createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers',req.headers['access-control-request-headers']||'*');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if(req.url.endsWith('/models')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'test-model'},{id:'second-model'}]}));return;}
  if(req.url.endsWith('/chat/completions')){
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      const input=JSON.parse(body),title=JSON.stringify(input.messages).includes('你是会话标题生成器');requests.push({url:req.url,key:req.headers.authorization,model:input.model,title});
      if(req.headers.authorization==='Bearer fixture-key'){
        res.writeHead(401,{'Content-Type':'application/json'});
        res.end(JSON.stringify({error:{message:'Invalid API key',type:'authentication_error',code:'invalid_api_key'}}));return;
      }
      if(held&&!JSON.stringify(input.messages).includes('你是会话标题生成器'))return;
      if(title)return;
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'Settings saved and read back'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    });return;
  }
  res.setHeader('Content-Type','text/html;charset=utf-8');
  res.end('<!doctype html><title>Pi Tab settings</title><h1>Local test page</h1><a id="launch">Pi Tab</a>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const profile={id:'fixture',profileId:'fixture',api:'openai-completions',baseUrl:base+'/v1',apiKey:'fixture-key',model:'test-model'};
const bookmark=createBookmarklet(runtime,{openChat:chat,profiles:[profile],config:profile});
const options={headless:true,executablePath:process.env.PI_TAB_TEST_CHROME||chromium.executablePath(),args:['--no-sandbox','--no-proxy-server']};
let context,browserVersion;
try{
  for(const mode of ['bookmarklet','extension'])for(const language of ['zh-CN','en']){
    held=false;
    const extension=resolve('dist/extension');
    context=await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(),'pi-tab-model-profile-')),{
      ...options,locale:language,viewport:{width:1280,height:1000},
      args:[...options.args,...(mode==='extension'?[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]:[])],
    });
    browserVersion=context.browser()?.version();
    await context.addInitScript(language=>{
      localStorage.setItem('pi-tab-language',language);
      localStorage.setItem('pi-tab-size',JSON.stringify({width:560,height:800}));
    },language);
    const worker=mode==='extension'?(context.serviceWorkers()[0]||await context.waitForEvent('serviceworker')):null;
    if(worker)await worker.evaluate(({profile,language})=>chrome.storage.local.set({profiles:[profile],providers:[],'pi-tab-language':language}),{profile,language});
    const page=await context.newPage();
    await page.goto(base+'/'+mode+'/'+language);
    const root=page.locator('[data-pi-overlay]').last();
    const ui=selector=>root.locator(selector);
    let tabId;
    const call=async(method,args=[],name)=>{
      if(!worker)return page.evaluate(async({method,args,name})=>{if(method!=='agent')return pi[method](...args);const agent=pi.agent(pi.conversation.id);await agent.ready;return agent[name](...args);},{method,args,name});
      const result=await worker.evaluate(extensionTestRpc,{tabId,site:'127.0.0.1',method,args,name});
      if(!result.ok)throw Error(result.error);
      return result.value;
    };
    const activate=async()=>{
      if(worker){
        tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,page.url());
        await call('createChat');
      }else{
        await page.locator('#launch').evaluate((element,bookmark)=>element.href=bookmark,bookmark);
        await page.locator('#launch').click();
      }
      await ui('#settings:enabled').waitFor();
    };
    const settings=async()=>{await ui('#settings').click();await expect(ui('#preferences')).toBeVisible();};
    const models=async()=>{await ui('#settings-models-tab').click();await expect(ui('#settings-models-tab')).toHaveAttribute('aria-selected','true');await ui('[data-model-id="fixture"]').waitFor();};
    let languagePage;
    const otherLanguage=language==='en'?'zh-CN':'en';
    const changeLanguage=async value=>{
      if(worker)await worker.evaluate(value=>chrome.storage.local.set({'pi-tab-language':value}),value);
      else{
        if(!languagePage){languagePage=await context.newPage();await languagePage.goto(base+'/language-preference');}
        await languagePage.evaluate(value=>localStorage.setItem('pi-tab-language',value),value);
      }
      await expect(ui('#settings-models-tab')).toHaveText(value==='en'?'Model':'模型');
    };
    const send=async text=>{

      await ui('#message-input').fill(text);await ui('#send').click();
    };
    const shot=async name=>{const file=`${mode}-${language}-${name}.png`;await root.screenshot({path:join(directory,file),animations:'disabled'});screenshots.push(file);};
    await activate();await ui('#chat').waitFor();
    await send('Check the invalid initial key');
    await expect(ui('#chat-messages')).toContainText('401');
    await expect(ui('#abort')).toBeHidden();
    await ui('#message-input').fill('Keep composer draft');
    await settings();await shot('01-settings');
    // The new category participates in the existing roving keyboard focus.
    await ui('#settings-general-tab').press('ArrowRight');
    await expect(ui('#settings-models-tab')).toBeFocused();
    await expect(ui('#settings-models-tab')).toHaveAttribute('aria-selected','true');
    await ui('[data-model-id="fixture"]').waitFor();
    assert.equal(await ui('#preferences .form-footer').isVisible(),false);
    assert.equal(await ui('#settings-models-tab').innerText(),language==='en'?'Model':'模型');
    await shot('02-models');
    await changeLanguage(otherLanguage);
    await expect(ui('[data-model-id="fixture"]')).toBeVisible();
    await shot('11-language-updated');
    await changeLanguage(language);
    await expect(ui('[data-model-id="fixture"]')).toBeVisible();
    await ui('#settings-instructions-tab').click();await ui('#setting-prompt').fill('Keep unsaved instructions');await models();
    await ui('.manager-group>.manager-row:first-child button').first().click();
    await expect(ui('#provider-name')).toBeFocused();
    await ui('#provider-name').fill('Work provider');await ui('#provider-url').fill('ftp://invalid.test');
    await ui('#provider-form [type=submit]').click();await expect(ui('#provider-error')).toBeVisible();
    assert.equal((await call('listModels'))[0].baseUrl,base+'/v1','invalid edits do not mutate saved settings');
    await shot('03-validation');
    await ui('#provider-url').fill(base+'/v2');await ui('#provider-key').fill('updated-fixture-key');
    if(!worker){
      await page.evaluate(()=>{const original=pi.manageModels;pi.manageModels=async()=>{pi.manageModels=original;throw Error('Settings could not be saved');};});
      await ui('#provider-form [type=submit]').click();await expect(ui('#provider-error')).toHaveText('Settings could not be saved');
      assert.equal((await call('listModels'))[0].baseUrl,base+'/v1');
      await shot('10-save-error');
    }
    await ui('#provider-form [type=submit]').click();await ui('[data-model-id="fixture"]').waitFor();
    await expect(ui('#model-dialog')).toBeHidden();
    await ui('[data-model-id="fixture"] button').first().click();await ui('#manual-model-id').fill('second-model');
    await ui('#manual-model-form [type=submit]').click();await expect(ui('[data-model-id="fixture"] span')).toHaveText('second-model');
    await shot('04-saved');
    await ui('#settings-instructions-tab').click();assert.equal(await ui('#setting-prompt').inputValue(),'Keep unsaved instructions');
    await ui('#preferences-back').click();await ui('#chat').waitFor();
    assert.equal(await ui('#message-input').inputValue(),'Keep composer draft');
    await expect(ui('#chat-model')).toHaveText('second-model');
    const titlesBefore=requests.filter(r=>r.title).length;
    await send('Read updated model settings');
    await expect(ui('#chat-messages')).toContainText('Settings saved and read back');
    await expect(ui('#abort')).toBeHidden();
    assert.ok(requests.some(r=>r.url==='/v2/chat/completions'&&r.key==='Bearer updated-fixture-key'&&r.model==='second-model'));
    await expect.poll(()=>requests.filter(r=>r.title).length).toBeGreaterThan(titlesBefore);
    await settings();await models();
    await ui('.manager-group>.manager-row:first-child button').first().click();
    await ui('#provider-name').fill('Renamed while title is pending');
    await ui('#provider-form [type=submit]').click();await expect(ui('#model-dialog')).toBeHidden();
    await ui('#preferences-back').click();
    await page.reload();if(!worker)await activate();
    await ui('#settings:enabled').waitFor();await settings();await models();
    assert.equal((await call('listModels'))[0].baseUrl,base+'/v2');
    await expect(ui('[data-model-id="fixture"] span')).toHaveText('second-model');await shot('05-reloaded');
    // Both legacy shortcuts converge on the settings category.
    await ui('#preferences-back').click();await ui('#model-settings').click();await ui('#model-manage').click();
    await expect(ui('#settings-models-tab')).toHaveAttribute('aria-selected','true');
    await ui('[data-model-id="fixture"]').waitFor();
    await ui('#settings-model-add').click();await ui('#model-dialog-close').click();
    await expect(ui('#settings-models-tab')).toBeFocused();
    await ui('#settings-models-tab').press('End');await expect(ui('#settings-mcp-tab')).toBeFocused();
    await ui('#settings-mcp-tab').press('Home');await expect(ui('#settings-general-tab')).toBeFocused();await models();
    // Narrow English labels wrap without losing any category or action.
    await page.setViewportSize({width:360,height:800});
    assert.equal(await ui('#preferences').evaluate(node=>node.scrollWidth>node.clientWidth+1),false);
    for(const id of ['settings-general-tab','settings-models-tab','settings-instructions-tab','settings-execution-tab','settings-mcp-tab'])await expect(ui('#'+id)).toBeInViewport();
    await shot('06-narrow');
    await page.setViewportSize({width:1280,height:1000});
    if(!worker){
      // A rejected read remains recoverable and never creates an empty config.
      await page.evaluate(()=>{const original=pi.listProviders;pi.listProviders=async()=>{pi.listProviders=original;throw Error('Settings temporarily unavailable');};});
      await ui('#settings-models-tab').click();await expect(ui('#model-settings-error')).toHaveText('Settings temporarily unavailable');
      await shot('07-load-error');
      await changeLanguage(otherLanguage);await expect(ui('#model-settings-retry')).toBeVisible();
      await changeLanguage(language);
      await ui('#model-settings-retry').click();await ui('[data-model-id="fixture"]').waitFor();
      await changeLanguage(otherLanguage);await expect(ui('[data-model-id="fixture"]')).toBeVisible();await changeLanguage(language);
    }
    // Busy configurations still reject destructive changes through this page.
    await ui('#preferences-back').click();await ui('#chat').waitFor();
    held=true;await send('Hold task');
    await expect(ui('#abort')).toBeVisible();await settings();await models();
    await ui('[data-model-id="fixture"] button').last().click();await ui('.manager-confirm button').last().click();
    await expect(ui('.manager-confirm span')).toContainText(language==='en'?'Stop':'停止');
    assert.equal((await call('listModels')).length,1);await shot('08-busy');
    await ui('#preferences-back').click();await ui('#abort').click();await expect(ui('#abort')).toBeHidden();held=false;
    await settings();await models();
    await ui('[data-model-id="fixture"] button').last().click();await ui('.manager-confirm button').first().click();
    assert.equal((await call('listModels')).length,1,'cancel preserves model');
    await ui('[data-model-id="fixture"] button').last().click();await ui('.manager-confirm button').last().click();
    await expect(ui('[data-model-id="fixture"]')).toHaveCount(0);
    await ui('.manager-group>.manager-row:first-child button').last().click();await ui('.manager-confirm button').last().click();
    await expect(ui('.manager-group')).toHaveCount(0);await shot('09-empty');
    await changeLanguage(otherLanguage);await expect(ui('.manager-group')).toHaveCount(0);
    assert.ok(!(await ui('#model-manager-list').innerText()).includes('Loading'));
    await changeLanguage(language);
    await ui('#preferences-back').click();await expect(ui('#setup')).toBeVisible();
    await ui('#setup-manage').click();await expect(ui('#settings-models-tab')).toHaveAttribute('aria-selected','true');
    // Initial setup can create a provider and model through the same category.
    await ui('#settings-model-add').click();await ui('#manual-add-provider').click();
    await ui('#provider-api').selectOption('openai-completions');await ui('#provider-auth').selectOption('api_key');
    await ui('#provider-url').fill(base+'/v3');await ui('#provider-key').fill('added-fixture-key');
    await ui('#provider-form [type=submit]').click();await ui('#manual-model-id').fill('test-model');
    await ui('#manual-model-form [type=submit]').click();await expect(ui('#chat-model')).toHaveText('test-model');
    assert.equal((await call('listModels')).length,1);assert.equal((await call('listModels'))[0].baseUrl,base+'/v3');
    checks.push(`${mode}/${language}: settings, keyboard, edit/validation/save, runtime request, reload, legacy links, add/cancel/delete, busy guard, narrow, empty, cross-tab language updates`);
    console.log('PASS '+checks.at(-1));
    await context.close();context=null;
  }
  const hashes={};for(const file of ['pi-bookmarklet-chat-install.html','dist/extension/content.js','dist/pi-tab-extension.zip'])hashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
  const manifest={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),node:process.version,chromium:browserVersion,platform:process.platform,hashes,checks,screenshots};
  await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2));
  console.log(JSON.stringify({evidence:directory,...manifest}));
}finally{await context?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
