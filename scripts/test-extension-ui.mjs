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
const server = createServer((_request, response) => {
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
    assert.equal(await evaluate(`${root}.getElementById('chat-list').children.length`),1);
    assert.equal(await evaluate(`${root}.getElementById('chat-entries').children.length`),afterChats.value.length);
  });
  const backgroundChat=afterChats.value.find(chat=>!beforeChats.value.some(old=>old.id===chat.id));
  // Inject runtime boundary events to verify background-session UI updates.
  for(const type of ['run_start','run_end']) {
    await browser('tab','t2');
    await evaluate(`(async()=>{const [tab]=await chrome.tabs.query({url:${JSON.stringify(url+'*')}});await chrome.tabs.sendMessage(tab.id,{type:'engine-event',event:{type:'${type}',conversationId:${JSON.stringify(backgroundChat.id)}}});})()`);
    await browser('tab','t1');
    await check(`background conversation indicator follows ${type}`,async()=>{
      const indicators=await evaluate(`[...${root}.querySelectorAll('#chat-entries button')].map(row=>({id:row.dataset.chatId,running:!row.querySelector('.chat-running').hidden}))`);
      assert.equal(indicators.find(row=>row.id===String(backgroundChat.id)).running,type==='run_start');
      assert.ok(indicators.filter(row=>row.id!==String(backgroundChat.id)).every(row=>!row.running));
    });
    if(type==='run_start')await browser('screenshot',join(directory,'conversation-running.png'));
  }
  console.log(`Screenshot: ${join(directory,'window.png')}`);
} finally {
  await browser('close').catch(()=>{});
  await new Promise(resolve=>server.close(resolve));
  await rm(extension,{recursive:true,force:true});
}
assert.deepEqual(failures,[],`Failed: ${failures.join(', ')}`);
