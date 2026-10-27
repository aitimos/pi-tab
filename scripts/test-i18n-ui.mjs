// Installer localization and live switching in a separate browser session.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile,mkdtemp} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
const chrome=process.env.PI_TAB_TEST_CHROME;
if(!chrome)throw new Error('Set PI_TAB_TEST_CHROME.');
const run=promisify(execFile),session=`pi-tab-language-${process.pid}`;
const directory=await mkdtemp(join(tmpdir(),'pi-tab-language-'));
const html=await readFile('pi-bookmarklet-chat-install.html');
const requests=[];
const server=createServer((request,response)=>{
  if(request.url.endsWith('/models')){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({data:[{id:'test-model',reasoning:false}]}));return;}
  if(request.url.endsWith('/chat/completions')){
    let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
      requests.push(JSON.parse(body));response.writeHead(200,{'Content-Type':'text/event-stream'});
      for(const choice of [{delta:{role:'assistant',content:'English reply / 中文回复'},finish_reason:null},{delta:{},finish_reason:'stop'}])response.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,...choice}]})+'\n\n');
      response.end('data: [DONE]\n\n');
    });return;
  }
  response.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});response.end(html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
async function browser(...args){const {stdout}=await run('agent-browser',['--headed','false','--executable-path',chrome,'--args','--headless=new,--no-sandbox','--session',session,'--json',...args],{maxBuffer:5*1024*1024});const r=JSON.parse(stdout);if(!r.success)throw new Error(JSON.stringify(r.error));return r.data;}
const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
const root=`document.querySelector('[data-pi-overlay]').shadowRoot`;
const click=async id=>evaluate(`${root}.getElementById(${JSON.stringify(id)}).click()`);
async function ready(){try{await browser('wait','--fn',`${root}.getElementById('api').options.length>0`);}catch(error){console.log(await browser('errors'));console.log(await evaluate('document.body.innerText'));throw error;}}
async function scanEnglish(){
  const remaining=await evaluate(`(()=>{const out=[];for(const scope of [document.body,${root}]){const w=document.createTreeWalker(scope,NodeFilter.SHOW_TEXT);while(w.nextNode()){const n=w.currentNode,p=n.parentElement;if(!p||p.closest('script,style,textarea,pre')||!p.getClientRects().length)continue;const text=n.textContent.trim();if(/[\\u3400-\\u9fff]/.test(text)&&text!=='中文'&&!text.includes('English reply')&&!text.includes('中文消息'))out.push(text)}}return out})()`);
  assert.deepEqual(remaining,[],'visible English interface has no untranslated Chinese');
}
try{
  await browser('open',url);await ready();
  assert.equal(await evaluate('pi.i18n.mode'),'auto');
  assert.equal(await evaluate('document.documentElement.lang'),await evaluate(`(navigator.languages.find(x=>/^(zh|en)(-|$)/i.test(x))||'en').toLowerCase().startsWith('zh')?'zh-CN':'en'`));
  for(const languages of [['zh-TW','en-US'],['en-GB','zh-CN']]){
    await evaluate(`Object.defineProperty(navigator,'languages',{value:${JSON.stringify(languages)},configurable:true});window.dispatchEvent(new Event('languagechange'))`);
    assert.equal(await evaluate('document.documentElement.lang'),languages[0].startsWith('zh')?'zh-CN':'en');
  }
  console.log('PASS installer auto follows browser language order and languagechange');
  for(const locale of ['zh-CN','en']){
    if(locale==='en'){await browser('open',url.replace('127.0.0.1','localhost'));await ready();}
    await evaluate(`document.querySelector('.site-language [data-language="${locale}"]').click()`);
    assert.equal(await evaluate('document.documentElement.lang'),locale);
    assert.equal(await evaluate(`${root}.getElementById('base-url').placeholder`),locale==='en'?'Enter or select a Base URL':'输入或选择 Base URL');
    if(locale==='en')await scanEnglish();
    await browser('screenshot',join(directory,`${locale}-installer.png`));
    await evaluate(`(()=>{const r=${root};r.getElementById('base-url').value=location.origin+'/v1';r.getElementById('api-key').value='test-only';r.getElementById('discover-models').click()})()`);
    await browser('wait','--fn',`${root}.getElementById('setup-model-select').value==='test-model'`);
    await click('start');await browser('wait','--fn',`${root}.getElementById('chat').style.display==='flex'`);
    await evaluate(`${root}.getElementById('message-input').value='English / 中文消息';${root}.getElementById('message-input').dispatchEvent(new Event('input',{bubbles:true}))`);
    await click('send');await browser('wait','--fn',`${root}.getElementById('chat-messages').textContent.includes('English reply / 中文回复')&&!pi.busy`);
    await click('settings');
    assert.equal(await evaluate(`${root}.getElementById('settings-general-tab').textContent`),locale==='en'?'General':'常规');
    for(const tab of ['general','instructions','execution']){
      await click('settings-'+tab+'-tab');
      if(locale==='en')await scanEnglish();
      await browser('screenshot',join(directory,`${locale}-${tab}.png`));
    }
    assert.ok((await evaluate(`${root}.getElementById('setting-prompt').value`)).includes(locale==='en'?'user':'用户'));
    await click('preferences-back');
    await click('model-settings');await click('model-menu-add');
    await browser('wait','--fn',`${root}.querySelectorAll('#manual-model-results button').length===1`);
    if(locale==='en')await scanEnglish();
    await browser('screenshot',join(directory,`${locale}-model.png`));
    await click('manual-add-provider');
    if(locale==='en')await scanEnglish();
    await browser('screenshot',join(directory,`${locale}-provider.png`));
    await click('model-dialog-close');await click('model-dialog-close');
    for(const theme of ['light','dark']){
      await evaluate(`localStorage.setItem('pi-tab-theme','${theme}');window.dispatchEvent(new Event('pi-tab-theme-change'))`);
      await browser('set','viewport','390','844');
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
      assert.equal(await evaluate(`(()=>{const r=${root}.getElementById('shell');return r.scrollWidth===r.clientWidth})()`),true);
      await browser('screenshot',join(directory,`${locale}-${theme}-mobile.png`));
    }
    await browser('set','viewport','1280','900');
    await browser('reload');await ready();
    assert.equal(await evaluate('pi.i18n.mode'),locale);
    assert.equal(await evaluate('document.documentElement.lang'),locale);
    console.log(`PASS ${locale}: configure, send, model/provider/settings, mobile themes and persisted language`);
  }
  assert.ok(requests.length>=2);
  console.log(`Screenshots: ${directory}`);
}finally{
  await browser('close').catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
