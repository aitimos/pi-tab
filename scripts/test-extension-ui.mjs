// Run against the built extension in a separate Chrome for Testing session.
// Requires agent-browser and PI_TAB_TEST_CHROME pointing to Chrome for Testing.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);
const chrome = process.env.PI_TAB_TEST_CHROME;
if (!chrome) throw new Error('Set PI_TAB_TEST_CHROME to the Chrome for Testing executable.');
const directory = await mkdtemp(join(tmpdir(), 'pi-tab-ui-'));
const extension = join(directory, 'pi-tab-extension');
const session = `pi-tab-ui-${process.pid}`;
const language = process.env.PI_TAB_TEST_LANGUAGE || 'zh-CN';
const en = language === 'en';
let holdModel = false;
let lastModelRequest;
const titleRequests=[];
let releaseTitle;
let holdTitles=true;
let failModels = false;
const server = createServer((request, response) => {
  if (request.url.endsWith('/chat/completions')) {
    let body='';
    request.on('data',chunk=>body+=chunk);
    request.on('end',()=>{
    const input=JSON.parse(body);
    if (input.messages.some(message=>['system','developer'].includes(message.role) && JSON.stringify(message.content).includes('你是会话标题生成器'))) {
      titleRequests.push(input);
      const finish=()=>{
        response.writeHead(200,{'Content-Type':'text/event-stream'});
        for(const choice of [{delta:{role:'assistant',content:'附件内容分析'},finish_reason:null},{delta:{},finish_reason:'stop'}])response.write('data: '+JSON.stringify({id:'title',object:'chat.completion.chunk',created:1,model:input.model,choices:[{index:0,...choice}]})+'\n\n');
        response.end('data: [DONE]\n\n');
      };
      if(holdTitles)releaseTitle=finish;else finish();
      return;
    }
    lastModelRequest=input;
    if (holdModel) return; // Keep a real run pending until the test aborts it.
    response.writeHead(200, {'Content-Type':'text/event-stream'});
    for (const choice of [
      {delta:{role:'assistant',content:'Test reply'},finish_reason:null},
      {delta:{},finish_reason:'stop'},
    ]) response.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,...choice}]})+'\n\n');
    response.end('data: [DONE]\n\n');
    });
    return;
  }
  if(request.url.endsWith('/models')) {
    if(failModels){response.writeHead(401);response.end();return;}
    response.writeHead(200,{'Content-Type':'application/json'});
    response.end(JSON.stringify({data:[{id:'test-model',reasoning:false},{id:'test-reasoning',reasoning:true,input:['text','image']}]}));
    return;
  }
  response.writeHead(200, {'Content-Type':'text/html'});
  response.end('<!doctype html><title>Pi Tab regression</title><style>body{min-height:4000px}</style><h1>Page content</h1>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const failures = [];
async function browser(...args) {
  const {stdout} = await run('agent-browser', ['--headed','false','--executable-path',chrome,'--args','--headless=new,--no-sandbox','--extension',extension,'--session', session, '--json', ...args], {maxBuffer:4*1024*1024});
  const response = JSON.parse(stdout);
  if (!response.success) throw new Error(JSON.stringify(response.error));
  return response.data;
}
const evaluate = async script => (await browser('eval', '-b', Buffer.from(script).toString('base64'))).result;
// agent-browser's wheel command currently sends (0,0), ignoring the last mouse
// position. Use CDP coordinates so this tests real native scrolling over the UI.
async function wheel(point, deltaY) {
  const endpoint=new URL((await browser('get','cdp-url')).cdpUrl);
  endpoint.protocol='http:';endpoint.pathname='/json/list';
  const targets=await (await fetch(endpoint)).json();
  const page=targets.find(target=>target.type==='page'&&target.url===currentPage);
  assert.ok(page,'Current test page has a CDP target');
  const socket=new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    await new Promise((resolve,reject)=>{
      socket.addEventListener('message',event=>{const reply=JSON.parse(event.data);if(reply.id===1)reply.error?reject(new Error(reply.error.message)):resolve();});
      socket.send(JSON.stringify({id:1,method:'Input.dispatchMouseEvent',params:{type:'mouseWheel',x:Math.round(point.x),y:Math.round(point.y),deltaY,deltaX:0}}));
    });
  } finally { socket.close(); }
}
let currentPage=url;
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
const pixel = (await readFile('dist/extension/icon.png')).toString('base64');
async function attachFiles(image=true, text=true) {
  await evaluate(`(()=>{const r=${root},files=new DataTransfer();${text ? "files.items.add(new File(['attachment test <b>plain text</b>'],'notes.txt',{type:'text/plain'}));" : ''}${image ? `files.items.add(new File([Uint8Array.from(atob('${pixel}'),c=>c.charCodeAt(0))],'pixel.png',{type:'image/png'}));` : ''}r.getElementById('attachment-input').files=files.files;r.getElementById('attachment-input').dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
const box = async () => evaluate(`(()=>{const shell=${root}.getElementById('shell');const rect=shell.getBoundingClientRect();return {width:rect.width,height:rect.height,minimized:shell.classList.contains('minimized'),visible:!!shell.getClientRects().length};})()`);
let controller;
try {
  await run('unzip',['-q',resolve('dist/pi-tab-extension.zip'),'-d',directory]);
  // A blank extension page exercises messages without starting a second engine.
  await writeFile(join(extension, 'test-controller.html'), '<!doctype html><title>Extension test controller</title>');
  const key = generateKeyPairSync('rsa', {modulusLength:2048}).publicKey.export({type:'spki',format:'der'});
  const extensionId = createHash('sha256').update(key).digest('hex').slice(0,32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97+parseInt(digit,16)));
  const manifest = JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
  manifest.key = key.toString('base64');
  await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
  controller = `chrome-extension://${extensionId}/test-controller.html`;
  await browser('open',url);
  // Match the user's existing saved large window before opening the extension.
  await evaluate(`localStorage.setItem('pi-tab-size',JSON.stringify({width:500,height:670}))`);
  await browser('tab','new',controller);
  await evaluate(`chrome.storage.local.set({'pi-tab-language':${JSON.stringify(language)}})`);
  async function activate(openWindow=true) {
    await browser('tab','t2');
    const response = await evaluate(`(async()=>{const [tab]=await chrome.tabs.query({url:${JSON.stringify(url+'*')}});await chrome.storage.session.set({['active:'+tab.id]:true});return chrome.tabs.sendMessage(tab.id,{type:'activate',openWindow:${openWindow}})})()`);
    assert.equal(response.ok,true,response.error);
    await browser('tab','t1');
    await browser('wait','[data-pi-overlay]');
    await browser('wait','--fn',`${root}.getElementById('api').options.length>0 || !${root}.getElementById('setup-error').hidden`);
    assert.equal(await evaluate(`${root}.getElementById('setup-error').textContent`),'');
  }
  await activate();
  await browser('wait','--fn',`${root}.getElementById('api').options.length>0`);
  await check('startup exposes model API choices',async()=>{
    assert.ok(await evaluate(`${root}.getElementById('api').options.length>0`));
    assert.equal(await evaluate(`${root}.getElementById('setup-error').hidden`),true);
  });
  await check('theme defaults to following the page and tracks standard CSS changes',async()=>{
    assert.equal(await evaluate(`${root}.getElementById('theme').value`),'auto');
    for(const theme of ['dark','light']) {
      await evaluate(`document.documentElement.style.colorScheme='${theme}'`);
      await browser('wait','--fn',`${root}.getElementById('shell').dataset.theme==='${theme}'`);
      assert.equal(await evaluate(`${root}.getElementById('shell').dataset.theme`),theme);
    }
    await evaluate(`document.documentElement.style.colorScheme='normal';document.body.style.backgroundColor='rgb(25,25,25)'`);
    await browser('wait','--fn',`${root}.getElementById('shell').dataset.theme==='dark'`);
    await evaluate(`document.body.style.backgroundColor='white'`);
    await browser('wait','--fn',`${root}.getElementById('shell').dataset.theme==='light'`);
    await evaluate(`document.body.style.removeProperty('background-color');document.documentElement.style.removeProperty('color-scheme')`);
    for(const theme of ['dark','light']) {
      await browser('set','media',theme);
      await browser('wait','--fn',`${root}.getElementById('shell').dataset.theme==='${theme}'`);
      assert.equal(await evaluate(`${root}.getElementById('shell').dataset.theme`),theme);
    }
  });
  await check('window, header buttons and composer have aligned nested corners',async()=>{
    const corners=await evaluate(`(()=>{const r=${root};return ['shell','settings','composer'].map(id=>getComputedStyle(r.getElementById(id)).borderTopRightRadius)})()`);
    assert.deepEqual(corners,['12px','6px','10px']);
    const fit=await evaluate(`(()=>{const r=${root},top=r.getElementById('top').getBoundingClientRect(),button=r.getElementById('settings').getBoundingClientRect();return button.top>=top.top+5&&button.bottom<=top.bottom-5})()`);
    assert.equal(fit,true);
  });
  await check('typing remains editable and does not reach host shortcut handlers',async()=>{
    await evaluate(`window.hostInputEvents=[];for(const type of ['keydown','keyup','keypress','input','beforeinput'])document.addEventListener(type,event=>window.hostInputEvents.push(event.type));${root}.getElementById('base-url').focus()`);
    await browser('keyboard','type','/test');
    assert.equal(await evaluate(`${root}.getElementById('base-url').value`),'/test');
    assert.deepEqual(await evaluate('window.hostInputEvents'),[]);
    await evaluate(`${root}.getElementById('base-url').value=''`);
  });
  await check('inner scrolling works and never scrolls the host at the boundary or header',async()=>{
    await evaluate(`window.scrollTo(0,200);${root}.getElementById('shell').style.setProperty('--window-height','420px');${root}.getElementById('setup-fields').scrollTop=0`);
    const point=await evaluate(`(()=>{const r=${root}.getElementById('setup-fields').getBoundingClientRect();return {x:r.x+15,y:r.y+40}})()`);
    await browser('mouse','move',String(Math.round(point.x)),String(Math.round(point.y)));
    await wheel(point,300);
    await browser('wait','--fn',`${root}.getElementById('setup-fields').scrollTop>0`);
    assert.ok(await evaluate(`${root}.getElementById('setup-fields').scrollTop>0`));
    await evaluate(`${root}.getElementById('setup-fields').scrollTop=100000`);
    await wheel(point,600);
    await wheel({x:point.x,y:30},600);
    assert.equal(await evaluate('window.scrollY'),200);
    await evaluate(`window.scrollTo(0,0);${root}.getElementById('shell').style.setProperty('--window-height','670px');${root}.getElementById('setup-fields').scrollTop=0`);
  });
  await check('drag release docks to either side and follows viewport resize',async()=>{
    for(const side of ['left','right']) {
      const point=await evaluate(`(()=>{const r=${root}.getElementById('top').getBoundingClientRect();return {x:r.x+20,y:r.y+20,target:${JSON.stringify(side)}==='left'?2:innerWidth-2}})()`);
      await browser('mouse','move',String(Math.round(point.x)),String(Math.round(point.y)));
      await browser('mouse','down','left');
      await browser('mouse','move',String(Math.round(point.target)),String(Math.round(point.y+30)));
      const dragging=await evaluate(`(()=>{const r=document.querySelector('[data-pi-overlay]').getBoundingClientRect();return {x:r.left,right:r.right,w:innerWidth,rail:${root}.getElementById('edge-tab').hidden}})()`);
      assert.ok(Math.abs(dragging.x-(point.target-20))<1,JSON.stringify(dragging));
      assert.equal(dragging.rail,false);
      assert.ok(side==='left'?dragging.x<0:dragging.right>dragging.w);
      await browser('screenshot',join(directory,`drag-through-${side}.png`));
      await browser('mouse','move','640',String(Math.round(point.y+30)));
      assert.equal(await evaluate(`${root}.getElementById('edge-tab').hidden`),true);
      await browser('mouse','move',String(Math.round(point.target)),String(Math.round(point.y+30)));
      await browser('mouse','up','left');
      assert.equal(await evaluate(`${root}.getElementById('shell').inert`),true);
      await browser('wait','--fn',`getComputedStyle(${root}.getElementById('shell')).visibility==='hidden'`);
      const rail=await evaluate(`(()=>{const r=${root}.getElementById('edge-tab').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await browser('mouse','move',String(Math.round(rail.x)),String(Math.round(rail.y)));
      await browser('wait','--fn',`${root}.getElementById('edge-tab').hidden`);
      const edge=`(()=>{const r=document.querySelector('[data-pi-overlay]').getBoundingClientRect();return Math.abs(${JSON.stringify(side)}==='left'?r.left-24:innerWidth-r.right-24)<1})()`;
      await browser('wait','--fn',edge);
      assert.equal(await evaluate(edge),true);
    }
    await browser('set','viewport','1100','800');
    assert.ok(await evaluate(`Math.abs(innerWidth-document.querySelector('[data-pi-overlay]').getBoundingClientRect().right-24)<1`));
    await browser('set','viewport','1280','900');
  });

  await check('docked window folds on mouse leave and expands on hover without losing drafts',async()=>{
    await evaluate(`${root}.activeElement?.blur()`);
    const inside=await evaluate(`(()=>{const r=${root}.getElementById('top').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await browser('mouse','move',String(Math.round(inside.x)),String(Math.round(inside.y)));
    await browser('mouse','move','5','5');
    await browser('wait','--fn',`!${root}.getElementById('edge-tab').hidden`);
    await browser('wait','--fn',`getComputedStyle(${root}.getElementById('shell')).visibility==='hidden'`);
    const rail=await evaluate(`(()=>{const r=${root}.getElementById('edge-tab').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width}})()`);
    assert.equal(rail.width,12);
    await browser('screenshot',join(directory,'edge-collapsed.png'));
    await browser('mouse','move',String(Math.round(rail.x)),String(Math.round(rail.y)));
    await browser('wait','--fn',`${root}.getElementById('edge-tab').hidden`);
    assert.equal(await evaluate(`getComputedStyle(${root}.getElementById('shell')).visibility`),'visible');
    await browser('screenshot',join(directory,'edge-expanded.png'));
    await evaluate(`${root}.getElementById('base-url').value='draft';${root}.getElementById('base-url').focus()`);
    await browser('mouse','move','5','5');await browser('wait','500');
    assert.equal(await evaluate(`${root}.getElementById('edge-tab').hidden`),true);
    await evaluate(`${root}.getElementById('base-url').value='';${root}.activeElement?.blur()`);
  });
  await check('edge motion reverses from its current position without a jump',async()=>{
    const motion=await evaluate(`(async()=>{
      const host=document.querySelector('[data-pi-overlay]'),shell=${root}.getElementById('shell'),rail=${root}.getElementById('edge-tab');
      host.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'}));
      while(rail.hidden)await new Promise(requestAnimationFrame);
      await new Promise(resolve=>setTimeout(resolve,60));
      const before=shell.getBoundingClientRect().x,opacity=Number(getComputedStyle(shell).opacity);
      rail.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse'}));
      const after=shell.getBoundingClientRect().x;
      while(!rail.hidden)await new Promise(requestAnimationFrame);
      return {before,after,opacity,rest:shell.getBoundingClientRect().x,host:host.getBoundingClientRect().x,inert:shell.inert};
    })()`);
    assert.ok(motion.opacity>0&&motion.opacity<1,JSON.stringify(motion));
    assert.ok(Math.abs(motion.before-motion.after)<1,JSON.stringify(motion));
    assert.ok(Math.abs(motion.rest-motion.host)<1,JSON.stringify(motion));
    assert.equal(motion.inert,false);
  });
  await check('reduced motion skips the side slide',async()=>{
    await browser('set','media','light','reduced-motion');
    const result=await evaluate(`(async()=>{
      const host=document.querySelector('[data-pi-overlay]'),shell=${root}.getElementById('shell'),rail=${root}.getElementById('edge-tab');
      host.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'}));
      while(rail.hidden)await new Promise(requestAnimationFrame);
      const collapsed=getComputedStyle(shell).visibility==='hidden'&&!shell.style.transform;
      rail.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse'}));
      return {collapsed,expanded:rail.hidden&&!shell.inert&&!shell.style.transform};
    })()`);
    assert.deepEqual(result,{collapsed:true,expanded:true});
    await browser('set','media','light');
  });
  await check('dragging away from an edge leaves the window where it was released',async()=>{
    for(const placement of ['center','left','right']) {
      const point=await evaluate(`(()=>{const r=${root}.getElementById('top').getBoundingClientRect();return {x:r.x+20,y:r.y+20,left:${JSON.stringify(placement)}==='center'?(innerWidth-r.width)/2:${JSON.stringify(placement)}==='left'?60:innerWidth-r.width-60}})()`);
      await browser('mouse','move',String(Math.round(point.x)),String(Math.round(point.y)));
      await browser('mouse','down','left');
      await browser('mouse','move',String(Math.round(point.left+20)),String(Math.round(point.y)));
      const released=await evaluate(`document.querySelector('[data-pi-overlay]').getBoundingClientRect().left`);
      assert.ok(Math.abs(released-point.left)<=2);
      await browser('mouse','up','left');
      // Wait beyond the docking animation to catch any delayed pull to an edge.
      await browser('wait','700');
      const actual=await evaluate(`document.querySelector('[data-pi-overlay]').getBoundingClientRect().left`);
      assert.ok(Math.abs(actual-released)<.5,`${placement}: released at ${released}, ended at ${actual}`);
    }
    const left=await evaluate(`document.querySelector('[data-pi-overlay]').getBoundingClientRect().left`);
    await browser('set','viewport','1380','900');
    assert.equal(await evaluate(`document.querySelector('[data-pi-overlay]').getBoundingClientRect().left`),left);
    await browser('set','viewport','1280','900');
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
  await check('model setup discovers a model and keeps save actions visible',async()=>{
    await evaluate(`(()=>{const r=${root};r.getElementById('base-url').value=${JSON.stringify(url+'v1')};r.getElementById('api-key').value='test-only';r.getElementById('base-url').dispatchEvent(new Event('input',{bubbles:true}));r.getElementById('discover-models').click()})()`);
    await browser('wait','--fn',`${root}.getElementById('setup-model-select').options.length===2`);
    assert.equal(await evaluate(`${root}.getElementById('setup-model-select').value`),'test-model');
    assert.equal(await evaluate(`(()=>{const r=${root},shell=r.getElementById('shell').getBoundingClientRect(),save=r.getElementById('start').getBoundingClientRect();return save.bottom<=shell.bottom&&save.top>shell.top})()`),true);
    await click('start');
    await browser('wait','--fn',`${root}.getElementById('chat').style.display==='flex'`);
  });
  await check('text-only models reject images with an inline explanation',async()=>{
    await attachFiles(true,false);
    await browser('wait','--fn',`${root}.getElementById('attachment-error').textContent.includes(${JSON.stringify(en?'does not support images':'不支持图片')})`);
    assert.equal(await evaluate(`${root}.getElementById('attachments').children.length`),0);
  });
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
  await browser('wait','--fn',`${root}.getElementById('preferences').style.display==='flex'`);
  await check('theme belongs to settings and applies immediately',async()=>{
    assert.equal(await evaluate(`${root}.getElementById('theme').closest('form').id`),'preferences');
    const theme=await evaluate(`${root}.getElementById('shell').dataset.theme`);
    const next=theme==='light'?'dark':'light';
    await evaluate(`(()=>{const select=${root}.getElementById('theme');select.value='${next}';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    assert.equal(await evaluate(`${root}.getElementById('shell').dataset.theme`),next);
    assert.equal(await evaluate(`localStorage.getItem('pi-tab-theme')`),next);
    await evaluate(`document.documentElement.style.colorScheme='${theme}'`);
    assert.equal(await evaluate(`${root}.getElementById('shell').dataset.theme`),next);
    await evaluate(`(()=>{const select=${root}.getElementById('theme');select.value='auto';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await browser('wait','--fn',`${root}.getElementById('shell').dataset.theme==='${theme}'`);
    assert.equal(await evaluate(`${root}.getElementById('theme').value`),'auto');
    await evaluate(`document.documentElement.style.removeProperty('color-scheme')`);
  });
  await check('language changes update both windows without resetting drafts or settings',async()=>{
    await evaluate(`${root}.getElementById('message-input').value='Draft 中文 / English'`);
    for(const locale of ['en','zh-CN',language]) {
      await evaluate(`${root}.querySelector('[data-language="${locale}"]').click()`);
      assert.equal(await evaluate(`${root}.getElementById('settings-general-tab').textContent`),locale==='en'?'General':'常规');
      assert.equal(await evaluate(`${root}.getElementById('message-input').value`),'Draft 中文 / English');
      assert.equal(await evaluate(`document.querySelectorAll('[data-pi-overlay]')[1].shadowRoot.getElementById('message-input').placeholder`),locale==='en'?'Message':'输入消息');
      assert.equal(await evaluate(`${root}.getElementById('chat-model').textContent`),'test-model');
      await browser('screenshot',join(directory,`settings-${locale}.png`));
    }
    await evaluate(`${root}.getElementById('message-input').value=''`);
    await browser('tab','t2');
    await browser('wait','--fn',`(async()=> (await chrome.storage.local.get('pi-tab-language'))['pi-tab-language']===${JSON.stringify(language)})()`);
    await browser('tab','t1');
  });
  await check('settings tabs retain drafts and separate instructions from execution',async()=>{
    assert.equal(await evaluate(`${root}.getElementById('settings-instructions').hidden`),true);
    await click('settings-instructions-tab');
    await evaluate(`${root}.getElementById('setting-prompt').value='Draft instruction'`);
    await click('settings-execution-tab');
    assert.equal(await evaluate(`${root}.getElementById('settings-general').hidden`),true);
    await click('settings-instructions-tab');
    assert.equal(await evaluate(`${root}.getElementById('setting-prompt').value`),'Draft instruction');
    await click('restore-prompt');
    assert.ok((await evaluate(`${root}.getElementById('setting-prompt').value`)).length>100);
    await browser('screenshot',join(directory,'settings-instructions.png'));
  });
  await evaluate(`${root}.getElementById('preferences-back').scrollIntoView({block:'nearest'})`);
  await click('preferences-back');
  assert.equal(await evaluate(`${root}.getElementById('preferences').style.display`),'none');
  await check('provider creation leads to searchable models with reasoning defaults',async()=>{
    await click('model-settings');
    await click('model-menu-add');
    await browser('wait','--fn',`!${root}.getElementById('manual-model-discover').disabled`);
    assert.equal(await evaluate(`${root}.getElementById('manual-model-options').hidden`),true);
    assert.equal(await evaluate(`${root}.getElementById('manual-model-status').textContent`),'');
    await browser('screenshot',join(directory,'model-choices.png'));
    await click('manual-add-provider');
    await click('model-dialog-close');
    assert.equal(await evaluate(`${root}.getElementById('manual-model-form').hidden`),false);
    await click('manual-add-provider');
    await browser('screenshot',join(directory,'add-provider.png'));
    await evaluate(`(()=>{const r=${root};r.getElementById('provider-name').value='Local test';r.getElementById('provider-url').value=${JSON.stringify(url+'v1')};r.getElementById('provider-key').value='test-only';r.getElementById('provider-form').requestSubmit()})()`);
    await browser('wait','--fn',`${root}.querySelectorAll('#manual-model-results button').length===2`);
    assert.equal(await evaluate(`${root}.getElementById('manual-model-provider').selectedOptions[0].textContent`),'Local test');
    await evaluate(`(()=>{const input=${root}.getElementById('manual-model-id');input.value='reason';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    assert.equal(await evaluate(`${root}.querySelectorAll('#manual-model-results button').length`),1);
    await evaluate(`${root}.querySelector('#manual-model-results button').click()`);
    assert.equal(await evaluate(`${root}.getElementById('manual-model-reasoning').checked`),true);
    assert.ok(await evaluate(`${root}.getElementById('manual-model-thinking').options.length>1`));
    await browser('screenshot',join(directory,'add-model.png'));
    await evaluate(`${root}.getElementById('manual-model-reasoning').click()`);
    assert.equal(await evaluate(`${root}.getElementById('manual-model-thinking').closest('label').hidden`),true);
    await evaluate(`${root}.getElementById('manual-model-reasoning').click()`);
    assert.equal(await evaluate(`${root}.getElementById('manual-model-thinking').closest('label').hidden`),false);
    await click('manual-add-provider');await click('model-dialog-close');
    assert.equal(await evaluate(`${root}.getElementById('manual-model-id').value`),'test-reasoning');
    await browser('set','media','dark');
    await browser('screenshot',join(directory,'add-model-dark.png'));
    await browser('set','media','light');
    await click('manual-model-discover');
    await browser('wait','--fn',`!${root}.getElementById('manual-model-discover').disabled`);
    assert.equal(await evaluate(`${root}.getElementById('manual-model-id').value`),'test-reasoning');
    assert.equal(await evaluate(`${root}.getElementById('manual-model-vision').checked`),true);
    await evaluate(`${root}.getElementById('manual-model-form').requestSubmit()`);
    await browser('wait','--fn',`${root}.getElementById('chat-model').textContent==='test-reasoning'`);
  });
  await check('composer text and attachment icon share a left edge',async()=>{
    const delta=await evaluate(`(()=>{const r=${root};return Math.abs(r.getElementById('message-input').getBoundingClientRect().left-r.querySelector('#attach svg').getBoundingClientRect().left)})()`);
    assert.ok(delta<1);
    assert.equal(await evaluate(`${root}.getElementById('attachment-error').textContent`),'');
    await browser('screenshot',join(directory,'composer.png'));
  });
  await check('attachments, automatic title updates and persistence survive an engine restart',async()=>{
    await attachFiles();
    await browser('wait','--fn',`${root}.getElementById('attachments').children.length===2`);
    await browser('screenshot',join(directory,'attachments.png'));
    await click('chat-switch');
    const current=await evaluate(`${root}.querySelector('.chat-select[aria-current=true]').closest('.chat-row').dataset.chatId`);
    await evaluate(`${root}.querySelector('.chat-select[aria-current=false]').click()`);
    await browser('wait','--fn',`${root}.getElementById('attachments').children.length===0`);
    await click('chat-switch');
    await evaluate(`${root}.querySelector('[data-chat-id="${current}"] .chat-select').click()`);
    await browser('wait','--fn',`${root}.getElementById('attachments').children.length===2`);

    await evaluate(`${root}.getElementById('message-input').value='Describe these files';${root}.getElementById('message-input').dispatchEvent(new Event('input',{bubbles:true}))`);
    await click('send');
    await browser('wait','--fn',`${root}.getElementById('chat-messages').textContent.includes('Test reply')`);
    const user=lastModelRequest.messages.findLast(message=>message.role==='user');
    assert.ok(user.content.some(part=>part.type==='image_url'&&part.image_url.url==='data:image/png;base64,'+pixel));
    assert.ok(user.content.some(part=>part.type==='text'&&part.text.includes('attachment test <b>plain text</b>')));
    await click('chat-switch');
    for(let i=0;i<40&&!releaseTitle;i++)await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(releaseTitle,'first completed exchange requests an automatic title');
    assert.equal(titleRequests.length,1);
    assert.ok(titleRequests[0].max_tokens===1024 || titleRequests[0].max_completion_tokens===1024);
    assert.ok(!titleRequests[0].tools?.length);
    assert.equal(await evaluate(`${root}.getElementById('shell').dataset.busy`),'false');
    holdTitles=false;releaseTitle();
    await browser('wait','--fn',`${root}.querySelector('.chat-select[aria-current=true] .chat-title').textContent==='附件内容分析'`);
    await browser('screenshot',join(directory,'generated-title.png'));
    await browser('tab','t2');await evaluate('chrome.offscreen.closeDocument()');await browser('tab','t1');
    await browser('reload');await activate();
    await browser('wait','--fn',`${root}.querySelector('.message-image')?.complete`);
    await click('chat-switch');
    await browser('wait','--fn',`${root}.querySelector('.chat-select[aria-current=true] .chat-title').textContent==='附件内容分析'`);
    await click('chat-switch');
    assert.equal(titleRequests.length,1,'saved titles do not regenerate on reload');
    assert.equal(await evaluate(`${root}.querySelector('.message-file summary').textContent`),'notes.txt');
    assert.equal(await evaluate(`${root}.querySelector('.message-file pre').textContent`),'attachment test <b>plain text</b>');
    assert.equal(await evaluate(`${root}.querySelector('.message-file b')`),null);
  });
  await check('model discovery failure still permits manual entry and cancel returns to chat',async()=>{
    failModels=true;
    await click('model-settings');await click('model-menu-add');
    await browser('wait','--fn',`${root}.getElementById('manual-model-status').textContent.includes(${JSON.stringify(en?'Authentication failed':'认证失败')})`);
    await evaluate(`${root}.getElementById('manual-model-id').value='custom-model'`);
    assert.equal(await evaluate(`${root}.querySelector('#manual-model-form [type=submit]').disabled`),false);
    await click('model-dialog-close');
    assert.equal(await evaluate(`${root}.getElementById('model-dialog').hidden`),true);
    failModels=false;
  });
  await click('chat-switch');
  await check('conversation menu contains only conversations',async()=>{
    assert.equal(await evaluate(`${root}.getElementById('chat-menu-error').hidden`),true);
    assert.equal(await evaluate(`${root}.getElementById('chat-entries').children.length`),afterChats.value.length);
  });
  const backgroundChat=afterChats.value.find(chat=>!beforeChats.value.some(old=>old.id===chat.id));
  await browser('tab','t2');
  const currentId=beforeChats.value[0].id;
  const engine = async (method,args=[],chatId,name) => evaluate(`chrome.runtime.sendMessage(${JSON.stringify({target:'engine',site:'127.0.0.1',method,args,chatId,name})})`);
  const configuration = await engine('agent',[{api:'openai-completions',baseUrl:url+'v1',apiKey:'test-only',model:'test-model',reasoning:false,thinking:'off',input:['text','image']}],currentId,'configure');
  assert.equal(configuration.ok,true,configuration.error);
  const reply=await engine('agent',['Keep this conversation'],currentId,'prompt');
  assert.equal(reply.ok,true,reply.error);
  const keptHistory=await engine('agent',[],currentId,'history');
  const keptModels=await engine('listModels');
  holdModel=true;
  await evaluate(`void chrome.runtime.sendMessage(${JSON.stringify({target:'engine',site:'127.0.0.1',method:'agent',chatId:currentId,name:'prompt',args:['Pending task']})});true`);
  await browser('wait','--fn',`(async()=>{const r=await chrome.runtime.sendMessage({target:'engine',site:'127.0.0.1',method:'listChats'});return r.value.some(c=>c.id===${currentId}&&c.busy)})()`);
  await check('real background run stays visible when opening and reopening the conversation menu',async()=>{
    await browser('tab','t1');
    const indicator=`${root}.querySelector('[data-chat-id="${currentId}"] .chat-running')`;
    await browser('wait','--fn',`${indicator} && !${indicator}.hidden`);
    assert.equal(await evaluate(`getComputedStyle(${indicator}).display`),'flex');
    await evaluate(`${root}.querySelector('[data-chat-id="${backgroundChat.id}"] .chat-select').click()`);
    await click('chat-switch');
    await browser('wait','--fn',`${indicator} && !${indicator}.hidden`);
    await evaluate(`${root}.querySelector('[data-chat-id="${currentId}"] .chat-select').click()`);
    await click('chat-switch');
    await browser('wait','--fn',`${indicator} && !${indicator}.hidden`);
    await browser('screenshot',join(directory,'conversation-running.png'));
    await browser('tab','t2');
  });
  await check('switching language during a real run preserves history, attachments and busy state',async()=>{
    await browser('tab','t1');
    await click('chat-switch');
    await attachFiles(false,true);
    await evaluate(`${root}.getElementById('message-input').value='Pending draft 中文'`);
    const before=await evaluate(`${root}.getElementById('chat-messages').textContent`);
    await click('settings');
    for(const locale of ['en','zh-CN',language]) {
      await evaluate(`${root}.querySelector('[data-language="${locale}"]').click()`);
      assert.equal(await evaluate(`${root}.getElementById('shell').dataset.busy`),'true');
      assert.equal(await evaluate(`${root}.getElementById('message-input').value`),'Pending draft 中文');
      assert.equal(await evaluate(`${root}.getElementById('attachments').children.length`),1);
      assert.ok(await evaluate(`${root}.getElementById('attachments').textContent.includes('notes.txt')`));
    }
    assert.equal(await evaluate(`${root}.getElementById('chat-messages').textContent`),before);
    await click('preferences-back');
    await evaluate(`${root}.getElementById('message-input').value='';${root}.querySelector('#attachments button').click()`);
    await click('chat-switch');
    await browser('tab','t2');
  });
  await check('Durable snapshot with a live run preserves the running indicator',async()=>{
    await evaluate(`(async()=>{const [tab]=await chrome.tabs.query({url:${JSON.stringify(url+'*')}});await chrome.tabs.sendMessage(tab.id,{type:'engine-event',event:{type:'snapshot',conversationId:${currentId},run:{inputs:[1]}}});})()`);
    await browser('tab','t1');
    assert.equal(await evaluate(`${root}.querySelector('[data-chat-id="${currentId}"] .chat-running').hidden`),false);
    await browser('tab','t2');
  });
  await check('agent queue and delayed completion preserve a live run and its output',async()=>{
    const deliver=event=>evaluate(`(async()=>{const [tab]=await chrome.tabs.query({url:${JSON.stringify(url+'*')}});await chrome.tabs.sendMessage(tab.id,{type:'engine-event',event:${JSON.stringify({...event,conversationId:currentId})}});})()`);
    await deliver({type:'message_start',message:{role:'assistant',content:[{type:'text',text:'Before'}]}});
    await browser('tab','t1');
    try {
      await browser('wait','--fn',`${root}.querySelector('.streaming .bubble')?.textContent==='Before'`);
      await browser('tab','t2');
      await deliver({type:'agent_task_queued'});
      await deliver({type:'message_update',changes:[{type:'text_delta',contentIndex:0,delta:' after'}]});
      await deliver({type:'agent_task_done'});
      await browser('tab','t1');
      await browser('wait','--fn',`${root}.querySelector('.streaming .bubble')?.textContent==='Before after'`);
      assert.equal(await evaluate(`${root}.querySelectorAll('.streaming').length`),1);
      assert.equal(await evaluate(`${root}.getElementById('shell').dataset.busy`),'true');
      assert.equal(await evaluate(`${root}.getElementById('busy-text').hidden`),false);
    } finally { await browser('tab','t2'); }
  });
  await check('queued attachment editing keeps image and file contents',async()=>{
    await browser('tab','t1');
    await click('chat-switch');
    await attachFiles();
    await browser('wait','--fn',`${root}.getElementById('attachments').children.length===2`);
    await evaluate(`${root}.getElementById('message-input').value='Queued files';${root}.getElementById('message-input').dispatchEvent(new Event('input',{bubbles:true}))`);
    await click('send');
    await browser('wait','--fn',`${root}.querySelector('[data-queue-id] .message-image')!==null`);
    await browser('tab','t2');
    const queued=await engine('agent',[],currentId,'queuedMessages');
    assert.equal(queued.value.length,1);
    const item=queued.value[0];
    assert.ok(item.content.some(part=>part.type==='image'));
    assert.equal((await engine('agent',[item.id,'edit','Edited request'],currentId,'changeQueuedMessage')).ok,true);
    const edited=(await engine('agent',[],currentId,'queuedMessages')).value[0];
    assert.equal(edited.text,'Edited request');
    assert.deepEqual(edited.content.slice(1),item.content.slice(1));
    await engine('agent',[item.id,'cancel'],currentId,'changeQueuedMessage');
  });
  await check('running conversation refuses deletion',async()=>{
    const result=await engine('deleteChat',[currentId]);
    assert.equal(result.ok,false);assert.match(result.error,/先停止/);
    assert.ok((await engine('listChats')).value.some(c=>c.id===currentId));
  });
  await engine('agent',[],currentId,'abort');
  holdModel=false;
  await browser('tab','t1');
  await check('real run completion clears the conversation indicator',async()=>{
    if(await evaluate(`${root}.getElementById('chat-list').dataset.open!=='true'`))await click('chat-switch');
    await browser('wait','--fn',`${root}.querySelector('[data-chat-id="${currentId}"] .chat-running')?.hidden===true`);
  });
  // Removing the background conversation must not switch the current one.
  if(await evaluate(`${root}.getElementById('chat-list').dataset.open!=='true'`))await click('chat-switch');
  const removeSelector=`#chat-entries [data-chat-id="${backgroundChat.id}"] .chat-delete`;
  await evaluate(`${root}.querySelector(${JSON.stringify(removeSelector)}).click()`);
  await check('delete asks for inline confirmation',async()=>{
    assert.equal(await evaluate(`${root}.querySelector(${JSON.stringify(removeSelector)}).textContent`),en?'Delete':'确认删除');
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
  await check('closing one of two windows on the same conversation preserves restoration',async()=>{
    await evaluate(`document.querySelectorAll('[data-pi-overlay]')[1].shadowRoot.getElementById('close').click()`);
    assert.deepEqual(await evaluate(`JSON.parse(sessionStorage.getItem('pi-tab-open-chats'))`),[currentId]);
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
    assert.equal(await evaluate(`document.querySelectorAll('[data-pi-overlay]').length`),1);
  });
  await check('long conversation list scrolls over titles and contains boundary scrolling',async()=>{
    await browser('tab','t2');
    for(let i=0;i<16;i++)assert.equal((await engine('createChat')).ok,true);
    await browser('tab','t1');
    await click('chat-switch');await click('chat-switch');
    try { await browser('wait','--fn',`${root}.querySelectorAll('.chat-row').length===17`); }
    catch(error) { console.error('Menu state',await evaluate(`(()=>{const r=${root};return {rows:r.querySelectorAll('.chat-row').length,open:r.getElementById('chat-list').dataset.open,status:r.getElementById('status').textContent,error:r.getElementById('setup-error').textContent,windows:document.querySelectorAll('[data-pi-overlay]').length}})()`)); console.error('Browser errors',await browser('errors'));throw error; }
    const point=await evaluate(`(()=>{const title=${root}.querySelector('.chat-title').getBoundingClientRect();return {x:title.x+20,y:title.y+title.height/2}})()`);
    const before=await evaluate('window.scrollY');
    await wheel(point,300);
    try { await browser('wait','--fn',`${root}.getElementById('chat-list').scrollTop>0`); }
    catch(error) {
      console.error('Scroll geometry',await evaluate(`(()=>{const r=${root},menu=r.getElementById('chat-list'),hit=r.elementFromPoint(${point.x},${point.y});return {menu:menu.getBoundingClientRect().toJSON(),scrollHeight:menu.scrollHeight,clientHeight:menu.clientHeight,point:${JSON.stringify(point)},hit:hit?.outerHTML.slice(0,300)}})()`));
      await browser('screenshot',join(directory,'scroll-failure.png'));throw error;
    }
    await evaluate(`${root}.getElementById('chat-list').scrollTop=100000`);
    await wheel(point,600);
    assert.equal(await evaluate('window.scrollY'),before);
    const end=await evaluate(`${root}.getElementById('chat-list').scrollTop`);
    await wheel(point,-180);
    await browser('wait','--fn',`${root}.getElementById('chat-list').scrollTop<${end}`);
    const row=await evaluate(`(()=>{const row=${root}.querySelector('.chat-row'),button=row.querySelector('.chat-select'),remove=row.querySelector('.chat-delete');return {height:row.getBoundingClientRect().height,button:getComputedStyle(button).backgroundColor,remove:getComputedStyle(remove).backgroundColor}})()`);
    assert.equal(row.height,32);assert.equal(row.button,'rgba(0, 0, 0, 0)');assert.equal(row.remove,row.button);
    await browser('screenshot',join(directory,'conversation-scroll.png'));
  });
  await check('narrow windows keep header controls inside the frame',async()=>{
    await browser('set','viewport','360','740');
    assert.equal(await evaluate(`(()=>{const r=${root},shell=r.getElementById('shell').getBoundingClientRect();return [...r.querySelectorAll('#top .icon-button')].every(button=>{const b=button.getBoundingClientRect();return b.left>=shell.left&&b.right<=shell.right})})()`),true);
    assert.equal(await evaluate(`(()=>{const r=${root},shell=r.getElementById('shell').getBoundingClientRect(),menu=r.getElementById('chat-list').getBoundingClientRect();return menu.left>=shell.left+8&&menu.right<=shell.right-8})()`),true);
    await browser('screenshot',join(directory,'narrow.png'));
    await click('chat-switch');await click('settings');await click('settings-execution-tab');
    assert.equal(await evaluate(`(()=>{const r=${root},body=r.querySelector('.settings-body');return body.scrollWidth===body.clientWidth&&r.querySelector('#preferences .primary').getBoundingClientRect().bottom<=r.getElementById('shell').getBoundingClientRect().bottom})()`),true);
    await browser('screenshot',join(directory,'narrow-settings.png'));
    await click('preferences-back');
    await click('model-settings');await click('model-menu-add');await click('manual-add-provider');
    assert.equal(await evaluate(`(()=>{const r=${root},body=r.querySelector('#provider-form .form-body');return body.scrollWidth===body.clientWidth})()`),true);
    await browser('screenshot',join(directory,'narrow-provider.png'));
    await click('model-dialog-close');await click('model-dialog-close');
    await browser('set','viewport','1280','900');
  });
  await check('reduced motion docks without leaving an animation running',async()=>{
    await browser('set','media','light','reduced-motion');
    const point=await evaluate(`(()=>{const r=${root}.getElementById('top').getBoundingClientRect();return {x:r.x+20,y:r.y+20}})()`);
    await browser('mouse','move',String(Math.round(point.x)),String(Math.round(point.y)));
    await browser('mouse','down','left');
    await browser('mouse','move','60',String(Math.round(point.y+20)));
    await browser('mouse','up','left');
    assert.ok(await evaluate(`Math.abs(document.querySelector('[data-pi-overlay]').getBoundingClientRect().left-24)<1`));
  });
  await check('extension language preference is shared with another website',async()=>{
    const destination=url.replace('127.0.0.1','localhost');
    await browser('tab','new',destination);
    await browser('tab','t2');
    const result=await evaluate(`(async()=>{const [tab]=await chrome.tabs.query({url:${JSON.stringify(destination+'*')}});await chrome.storage.session.set({['active:'+tab.id]:true});return chrome.tabs.sendMessage(tab.id,{type:'activate',openWindow:true})})()`);
    assert.equal(result.ok,true,result.error);
    await browser('tab','t3');
    await browser('wait','[data-pi-overlay]');
    await browser('wait','--fn',`${root}.getElementById('api').options.length>0`);
    assert.equal(await evaluate(`document.querySelector('[data-pi-overlay]').lang`),language);
    assert.equal(await evaluate(`${root}.getElementById('message-input').placeholder`),en?'Message':'输入消息');
    await browser('tab','close');await browser('tab','t1');
  });
  if(process.env.PI_TAB_TEST_LIVE==='1') {
    for(const page of ['https://github.com/aitimos/pi-tab','https://www.bilibili.com/']) {
      await browser('tab','t1');
      await browser('open',page);
      currentPage=await evaluate('location.href');
      await browser('tab','t2');
      const activation=await evaluate(`(async()=>{const [tab]=await chrome.tabs.query({url:${JSON.stringify(new URL(page).origin+'/*')}});return chrome.tabs.sendMessage(tab.id,{type:'activate'});})()`);
      assert.equal(activation.ok,true,activation.error);
      await browser('tab','t1');
      await browser('wait','[data-pi-overlay]');
      await browser('wait','--fn',`${root}.getElementById('api').options.length>0`);
      await browser('wait','--fn',`${root}.getElementById('message-input').getClientRects().length>0`);
      await check(`${new URL(page).hostname}: theme, keyboard and scroll integration`,async()=>{
        assert.equal(await evaluate(`${root}.getElementById('theme').value`),'auto');
        await evaluate(`${root}.getElementById('message-input').focus()`);
        await browser('keyboard','type','/test');
        assert.equal(await evaluate(`${root}.getElementById('message-input').value`),'/test');
        assert.equal(await evaluate(`document.activeElement===document.querySelector('[data-pi-overlay]')`),true);
        const before=await evaluate('window.scrollY');
        const point=await evaluate(`(()=>{const r=${root}.getElementById('top').getBoundingClientRect();return {x:r.x+20,y:r.y+20}})()`);
        await browser('mouse','move',String(Math.round(point.x)),String(Math.round(point.y)));
        await wheel(point,600);
        assert.equal(await evaluate('window.scrollY'),before);
        await browser('screenshot',join(directory,new URL(page).hostname+'.png'));
        await click('settings');
        await browser('wait','--fn',`${root}.getElementById('preferences').style.display==='flex'`);
        for(const theme of ['dark','light','auto']) {
          await evaluate(`(()=>{const select=${root}.getElementById('theme');select.value='${theme}';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
          if(theme!=='auto')assert.equal(await evaluate(`${root}.getElementById('shell').dataset.theme`),theme);
          await browser('screenshot',join(directory,new URL(page).hostname+'-'+theme+'.png'));
        }
      });
    }
  }
  console.log(`Screenshot: ${join(directory,'window.png')}`);
} catch(error) {
  console.error('Page errors',await browser('errors'));
  console.error('Page state',await evaluate(`(()=>{const r=document.querySelector('[data-pi-overlay]')?.shadowRoot;return {error:r?.getElementById('setup-error')?.textContent,status:r?.getElementById('status')?.textContent}})()`));
  throw error;
} finally {
  await browser('close').catch(()=>{});
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  await rm(extension,{recursive:true,force:true});
}
assert.deepEqual(failures,[],`Failed: ${failures.join(', ')}`);
