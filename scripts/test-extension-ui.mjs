// Run against the built extension in a separate Chrome for Testing session.
// Requires agent-browser and PI_TAB_TEST_CHROME pointing to Chrome for Testing.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);
const chrome = process.env.PI_TAB_TEST_CHROME;
if (!chrome) throw new Error('Set PI_TAB_TEST_CHROME to the Chrome for Testing executable.');
const directory = await mkdtemp(join(tmpdir(), 'pi-tab-ui-'));
const extension = join(directory, 'extension');
const session = `pi-tab-ui-${process.pid}`;
let holdModel = false;
const server = createServer((request, response) => {
  if (request.url.endsWith('/chat/completions')) {
    if (holdModel) return; // Keep a real run pending until the test aborts it.
    response.writeHead(200, {'Content-Type':'text/event-stream'});
    for (const choice of [
      {delta:{role:'assistant',content:'Test reply'},finish_reason:null},
      {delta:{},finish_reason:'stop'},
    ]) response.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,...choice}]})+'\n\n');
    response.end('data: [DONE]\n\n');
    return;
  }
  response.writeHead(200, {'Content-Type':'text/html'});
  response.end('<!doctype html><title>Pi Tab regression</title><h1>Page content</h1>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const failures = [];
async function browser(...args) {
  const {stdout} = await run('agent-browser', ['--session', session, '--json', ...args], {maxBuffer:4*1024*1024});
  const response = JSON.parse(stdout);
  if (!response.success) throw new Error(JSON.stringify(response.error));
  return response.data;
}
const evaluate = async script => (await browser('eval', '-b', Buffer.from(script).toString('base64'))).result;
async function check(name, action) {
  try { await action(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
const root = `document.querySelector('[data-pi-overlay]').shadowRoot`;
async function click(id) {
  const point = await evaluate(`(()=>{const r=${root}.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await browser('mouse','move',String(Math.round(point.x)),String(Math.round(point.y)));
  await browser('mouse','down','left');
  await browser('mouse','up','left');
}
const box = async () => evaluate(`(()=>{const shell=${root}.getElementById('shell');const rect=shell.getBoundingClientRect();return {width:rect.width,height:rect.height,minimized:shell.classList.contains('minimized'),visible:!!shell.getClientRects().length};})()`);
let controller;
try {
  await cp(resolve('dist/extension'), extension, {recursive:true});
  // A blank extension page exercises messages without starting a second engine.
  await writeFile(join(extension, 'test-controller.html'), '<!doctype html><title>Extension test controller</title>');
  const key = generateKeyPairSync('rsa', {modulusLength:2048}).publicKey.export({type:'spki',format:'der'});
  const extensionId = createHash('sha256').update(key).digest('hex').slice(0,32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97+parseInt(digit,16)));
  const manifest = JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
  manifest.key = key.toString('base64');
  await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
  controller = `chrome-extension://${extensionId}/test-controller.html`;
  await browser('--headed','--executable-path',chrome,'--extension',extension,'open',url);
  // Match the user's existing saved large window before opening the extension.
  await evaluate(`localStorage.setItem('pi-tab-size',JSON.stringify({width:500,height:670}))`);
  await browser('tab','new',controller);
  async function activate(openWindow=true) {
    await browser('tab','t2');
    const response = await evaluate(`(async()=>{const [tab]=await chrome.tabs.query({url:${JSON.stringify(url+'*')}});await chrome.storage.session.set({['active:'+tab.id]:true});return chrome.tabs.sendMessage(tab.id,{type:'activate',openWindow:${openWindow}})})()`);
    assert.equal(response.ok,true,response.error);
    await browser('tab','t1');
    await browser('wait','[data-pi-overlay]');
  }
  await activate();
  await browser('wait','--fn',`${root}.getElementById('api').options.length>0`);
  await check('startup exposes model API choices',async()=>{
    assert.ok(await evaluate(`${root}.getElementById('api').options.length>0`));
    assert.equal(await evaluate(`${root}.getElementById('setup-error').hidden`),true);
  });
  const initial = await box();
  await click('minimize');
  await check('saved window minimizes to 52 × 52',async()=>{
    const size=await box();assert.equal(size.width,52);assert.equal(size.height,52);
  });
  await browser('screenshot',join(directory,'minimized.png'));
  await click('chat-ball');
  await check('ball restores the saved window dimensions',async()=>{assert.deepEqual(await box(),initial);});

  // Real pointer events verify the resize handler, not just pre-seeded storage.
  const handle=await evaluate(`(()=>{const r=${root}.getElementById('resize-handle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await browser('mouse','move',String(Math.round(handle.x)),String(Math.round(handle.y)));
  await browser('mouse','down','left');
  await browser('mouse','move',String(Math.round(handle.x-70)),String(Math.round(handle.y-80)));
  await browser('mouse','up','left');
  const resized = await box();
  await check('pointer resize updates the expanded dimensions',async()=>{
    assert.ok(resized.width<initial.width);assert.ok(resized.height<initial.height);
  });
  await click('minimize');
  await check('resized window also minimizes to 52 × 52',async()=>{
    const size=await box();assert.equal(size.width,52);assert.equal(size.height,52);
  });
  await activate(false);
  await check('automatic activation preserves minimized state',async()=>{assert.equal((await box()).minimized,true);});
  await activate();
  await check('toolbar activation restores an existing minimized window',async()=>{assert.deepEqual(await box(),resized);});
  if((await box()).minimized)await click('chat-ball');
  await click('close');
  await activate();
  await check('toolbar activation reopens a closed window without duplicates',async()=>{
    assert.equal((await box()).visible,true);
    assert.equal(await evaluate(`document.querySelectorAll('[data-pi-overlay]').length`),1);
  });
  await click('close');
  await browser('reload');
  await activate();
  await check('closed-window state can be reopened after refresh',async()=>{assert.equal((await box()).visible,true);});
  await browser('tab','t2');
  await evaluate(`(async()=>{const [tab]=await chrome.tabs.query({url:${JSON.stringify(url+'*')}});await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});})()`);
  await browser('tab','t1');
  await check('reinjecting the content bundle does not duplicate windows',async()=>{
    assert.equal(await evaluate(`document.querySelectorAll('[data-pi-overlay]').length`),1);
    assert.equal((await box()).visible,true);
  });
  await browser('screenshot',join(directory,'window.png'));
  await browser('tab','t2');
  const beforeChats = await evaluate(`chrome.runtime.sendMessage({target:'engine',site:'127.0.0.1',method:'listChats'})`);
  await browser('tab','t1');
  await click('chat-switch');
  await browser('screenshot',join(directory,'conversation-menu.png'));
  await click('chat-switch');
  await click('new-agent');
  await browser('wait','--fn',`document.querySelectorAll('[data-pi-overlay]').length===2`);
  await browser('tab','t2');
  const afterChats = await evaluate(`chrome.runtime.sendMessage({target:'engine',site:'127.0.0.1',method:'listChats'})`);
  await check('new window creates a separate empty conversation',async()=>{
    assert.equal(beforeChats.ok,true);assert.equal(afterChats.ok,true);
    assert.equal(afterChats.value.length,beforeChats.value.length+1);
    const created=afterChats.value.find(chat=>!beforeChats.value.some(old=>old.id===chat.id));
    assert.ok(created);
    const history=await evaluate(`chrome.runtime.sendMessage({target:'engine',site:'127.0.0.1',method:'agent',chatId:${created.id},name:'history'})`);
    assert.equal(history.ok,true);assert.equal(history.value.entries.length,0);
  });
  await browser('tab','t1');
  await click('settings');
  await browser('wait','--fn',`${root}.getElementById('preferences').style.display==='block'`);
  await check('theme belongs to settings and applies immediately',async()=>{
    assert.equal(await evaluate(`${root}.getElementById('theme').closest('form').id`),'preferences');
    const theme=await evaluate(`${root}.getElementById('shell').dataset.theme`);
    const next=theme==='light'?'dark':'light';
    await evaluate(`(()=>{const select=${root}.getElementById('theme');select.value='${next}';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    assert.equal(await evaluate(`${root}.getElementById('shell').dataset.theme`),next);
    assert.equal(await evaluate(`localStorage.getItem('pi-tab-theme')`),next);
  });
  await evaluate(`${root}.getElementById('preferences-back').scrollIntoView({block:'nearest'})`);
  await click('preferences-back');
  assert.equal(await evaluate(`${root}.getElementById('preferences').style.display`),'none');
  await click('chat-switch');
  await check('conversation menu contains only conversations',async()=>{
    assert.equal(await evaluate(`${root}.getElementById('chat-menu-error').hidden`),true);
    assert.equal(await evaluate(`${root}.getElementById('chat-entries').children.length`),afterChats.value.length);
  });
  const backgroundChat=afterChats.value.find(chat=>!beforeChats.value.some(old=>old.id===chat.id));
  // Inject runtime boundary events to verify background-session UI updates.
  for(const type of ['run_start','run_end']) {
    await browser('tab','t2');
    await evaluate(`(async()=>{const [tab]=await chrome.tabs.query({url:${JSON.stringify(url+'*')}});await chrome.tabs.sendMessage(tab.id,{type:'engine-event',event:{type:'${type}',conversationId:${JSON.stringify(backgroundChat.id)}}});})()`);
    await browser('tab','t1');
    await check(`background conversation indicator follows ${type}`,async()=>{
      const indicators=await evaluate(`[...${root}.querySelectorAll('#chat-entries .chat-row')].map(row=>({id:row.dataset.chatId,running:!row.querySelector('.chat-running').hidden}))`);
      assert.equal(indicators.find(row=>row.id===String(backgroundChat.id)).running,type==='run_start');
      assert.ok(indicators.filter(row=>row.id!==String(backgroundChat.id)).every(row=>!row.running));
    });
    if(type==='run_start')await browser('screenshot',join(directory,'conversation-running.png'));
  }
  await browser('tab','t2');
  const currentId=beforeChats.value[0].id;
  const engine = async (method,args=[],chatId,name) => evaluate(`chrome.runtime.sendMessage(${JSON.stringify({target:'engine',site:'127.0.0.1',method,args,chatId,name})})`);
  const configuration = await engine('agent',[{api:'openai-completions',baseUrl:url+'v1',apiKey:'test-only',model:'test-model',reasoning:false,thinking:'off'}],currentId,'configure');
  assert.equal(configuration.ok,true,configuration.error);
  const reply=await engine('agent',['Keep this conversation'],currentId,'prompt');
  assert.equal(reply.ok,true,reply.error);
  const keptHistory=await engine('agent',[],currentId,'history');
  const keptModels=await engine('listModels');
  holdModel=true;
  await evaluate(`void chrome.runtime.sendMessage(${JSON.stringify({target:'engine',site:'127.0.0.1',method:'agent',chatId:currentId,name:'prompt',args:['Pending task']})});true`);
  await browser('wait','--fn',`(async()=>{const r=await chrome.runtime.sendMessage({target:'engine',site:'127.0.0.1',method:'listChats'});return r.value.some(c=>c.id===${currentId}&&c.busy)})()`);
  await check('running conversation refuses deletion',async()=>{
    const result=await engine('deleteChat',[currentId]);
    assert.equal(result.ok,false);assert.match(result.error,/先停止/);
    assert.ok((await engine('listChats')).value.some(c=>c.id===currentId));
  });
  await engine('agent',[],currentId,'abort');
  holdModel=false;
  await browser('tab','t1');
  // Removing the background conversation must not switch the current one.
  if(await evaluate(`${root}.getElementById('chat-list').dataset.open!=='true'`))await click('chat-switch');
  const removeSelector=`#chat-entries [data-chat-id="${backgroundChat.id}"] .chat-delete`;
  await evaluate(`${root}.querySelector(${JSON.stringify(removeSelector)}).click()`);
  await check('delete asks for inline confirmation',async()=>{
    assert.equal(await evaluate(`${root}.querySelector(${JSON.stringify(removeSelector)}).textContent`),'确认删除');
    assert.equal(await evaluate(`${root}.querySelectorAll('.chat-row').length`),2);
  });
  await browser('screenshot',join(directory,'delete-confirm.png'));
  await evaluate(`${root}.querySelector(${JSON.stringify(removeSelector)}).click()`);
  await browser('wait','--fn',`!${root}.querySelector(${JSON.stringify(removeSelector)})`);
  await browser('tab','t2');
  await check('deletion preserves other conversations and model profiles',async()=>{
    const chats=await engine('listChats');assert.equal(chats.value.length,1);assert.equal(chats.value[0].id,currentId);
    assert.deepEqual((await engine('listModels')).value,keptModels.value);
    assert.ok((await engine('agent',[],currentId,'history')).value.entries.length>=keptHistory.value.entries.length);
    assert.equal((await engine('receiveFromTab',['hello','test'],backgroundChat.id)).ok,false);
  });
  await browser('tab','t1');
  await browser('wait','--fn',`document.querySelectorAll('[data-pi-overlay]')[1].shadowRoot.getElementById('chat-messages').textContent.includes('Test reply')`);
  await check('other window viewing deleted conversation selects the remaining one',async()=>{
    assert.ok(await evaluate(`document.querySelectorAll('[data-pi-overlay]')[1].shadowRoot.getElementById('chat-messages').textContent.includes('Test reply')`));
    assert.equal(await evaluate(`${root}.querySelector('.chat-select[aria-current=true]').closest('.chat-row').dataset.chatId`),String(currentId));
  });
  await browser('tab','t2');
  await check('deleting the last conversation creates a blank one with the same model',async()=>{
    const removed=await engine('deleteChat',[currentId]);assert.equal(removed.ok,true,removed.error);
    const chats=(await engine('listChats')).value;assert.equal(chats.length,1);assert.notEqual(chats[0].id,currentId);
    assert.equal(chats[0].config.model,'test-model');
    assert.equal((await engine('agent',[],chats[0].id,'history')).value.entries.length,0);
  });
  // Restart the offscreen runtime, not only the UI, to exercise persisted data.
  await evaluate('chrome.offscreen.closeDocument()');
  await browser('tab','t1');
  await browser('reload');
  await activate();
  await click('chat-switch');
  await check('removed conversations stay removed after runtime restart and reload',async()=>{
    const ids=await evaluate(`[...${root}.querySelectorAll('.chat-row')].map(row=>Number(row.dataset.chatId))`);
    assert.equal(ids.length,1);assert.ok(!ids.includes(currentId));assert.ok(!ids.includes(backgroundChat.id));
  });
  console.log(`Screenshot: ${join(directory,'window.png')}`);
} finally {
  await browser('close').catch(()=>{});
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  await rm(extension,{recursive:true,force:true});
}
assert.deepEqual(failures,[],`Failed: ${failures.join(', ')}`);
