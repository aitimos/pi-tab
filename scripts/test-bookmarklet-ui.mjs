// Exercise the actual javascript: bookmark in an isolated browser, without an extension.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile, mkdtemp} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

const chrome=process.env.PI_TAB_TEST_CHROME;
if(!chrome)throw new Error('Set PI_TAB_TEST_CHROME to Chrome for Testing.');
const run=promisify(execFile);
const language=process.env.PI_TAB_TEST_LANGUAGE || 'zh-CN';
const session=`pi-tab-bookmark-${process.pid}`;
const directory=await mkdtemp(join(tmpdir(),'pi-tab-bookmark-'));
const html=await readFile('pi-bookmarklet-chat-install.html','utf8');
let bookmark='', hold=false, requests=0;
const authorizations=[];
const handler=(request,response)=>{
  response.setHeader('Access-Control-Allow-Origin','*');
  response.setHeader('Access-Control-Allow-Headers',request.headers['access-control-request-headers'] || 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
  if(request.url==='/install'){response.setHeader('Content-Type','text/html;charset=utf-8');response.end(html);return;}
  if(request.url.endsWith('/models')){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({data:[{id:'test-model',reasoning:false}]}));return;}
  if(request.url.endsWith('/chat/completions')){
    let body='';
    request.on('data',chunk=>body+=chunk);
    request.on('end',()=>{
      authorizations.push(request.headers.authorization);
      const input=JSON.parse(body);
      const title=input.messages.some(item=>['system','developer'].includes(item.role)&&JSON.stringify(item.content).includes('你是会话标题生成器'));
      if(!title){requests++;if(hold)return;}
      response.writeHead(200,{'Content-Type':'text/event-stream'});
      for(const choice of [{delta:{role:'assistant',content:title?'书签测试':'Bookmark test reply'},finish_reason:null},{delta:{},finish_reason:'stop'}]){
        response.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,...choice}]})+'\n\n');
      }
      response.end('data: [DONE]\n\n');
    });
    return;
  }
  response.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
  response.end(`<title>Bookmark regression</title><a id="launch" href="${bookmark.replaceAll('&','&amp;').replaceAll('"','&quot;')}">Pi Tab</a>`);
};
const server=createServer(handler), otherSite=createServer(handler);
await Promise.all([server,otherSite].map(server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))));
const url=`http://127.0.0.1:${server.address().port}/`;
const installer=url.replace('127.0.0.1','localhost')+'install';
const otherUrl=`http://127.0.0.1:${otherSite.address().port}/`;
async function browser(...args){
  const {stdout}=await run('agent-browser',['--headed','false','--executable-path',chrome,'--args','--headless=new,--no-sandbox','--session',session,'--json',...args],{maxBuffer:4*1024*1024});
  const reply=JSON.parse(stdout);
  if(!reply.success)throw new Error(JSON.stringify(reply.error));
  return reply.data;
}
const evaluate=async script=>(await browser('eval','-b',Buffer.from(script).toString('base64'))).result;
const root="document.querySelector('[data-pi-overlay]')?.shadowRoot";
const selected="[...window.__piQuickChatOverlay.instances.values()][0].id";
async function launch(){
  await browser('click','#launch');
  await browser('wait','--fn',`${root}?.getElementById('message-input')?.offsetHeight>0 && ${root}.getElementById('settings').disabled===false`);
}
async function click(selector){
  const point=await evaluate(`(()=>{const element=${root}.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'nearest',inline:'nearest'});const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await browser('mouse','move',String(Math.round(point.x)),String(Math.round(point.y)));
  await browser('mouse','down','left');
  await browser('mouse','up','left');
}
async function send(text){
  await click('#message-input');
  await browser('keyboard','inserttext',text);
  await browser('press','Enter');
}
try{
  await browser('open',installer);
  await browser('set','viewport','1440','1000');
  await browser('wait','--fn',`${root}?.getElementById('api')?.options.length>0 && document.getElementById('pi-bookmarklet').hasAttribute('href')`);
  await evaluate(`(()=>{const r=${root};r.getElementById('base-url').value=${JSON.stringify(url+'v1')};r.getElementById('api-key').value='test-only';r.getElementById('discover-models').click()})()`);
  await browser('wait','--fn',`${root}.getElementById('setup-model-select').value==='test-model'`);
  await click('#start');
  await browser('wait','--fn',`${root}.getElementById('chat').style.display==='flex'`);
  await browser('wait','--fn',"document.getElementById('pi-bookmarklet').hasAttribute('href')");
  const firstBookmark=await evaluate("document.getElementById('pi-bookmarklet').getAttribute('href')");
  await browser('reload');
  await browser('wait','--fn',`${root}?.getElementById('chat')?.style.display==='flex' && document.getElementById('pi-bookmarklet').hasAttribute('href')`);
  await browser('wait','--fn',"document.getElementById('pi-bookmarklet').hasAttribute('href')");
  bookmark=await evaluate("document.getElementById('pi-bookmarklet').getAttribute('href')");
  console.log('PASS installer restores configured chat and generates bookmark after reload');

  await browser('open',otherUrl);
  await launch();
  await send('Use restored installer credentials on another site');
  await browser('wait','--fn',`${root}.getElementById('chat-messages').textContent.includes('Bookmark test reply') && !pi.busy`);
  assert.equal(await evaluate('pi.config.model'),'test-model');
  assert.equal(authorizations.at(-1),'Bearer test-only');
  console.log('PASS generated bookmark sends an authenticated request on a separate origin');

  await browser('open',installer);
  await browser('wait','--fn',`${root}?.getElementById('chat')?.style.display==='flex'`);
  await click('#model-settings');await click('#model-menu-add');
  await browser('wait','--fn',`${root}.querySelectorAll('#manual-model-results button').length===1`);
  await evaluate(`(()=>{const input=${root}.getElementById('manual-model-id');input.value='other-model';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await click('#manual-model-form [type=submit]');
  await browser('wait','--fn',`${root}.getElementById('chat-model').textContent==='other-model'`);
  await browser('wait','--fn',"document.getElementById('pi-bookmarklet').hasAttribute('href')");
  const otherBookmark=await evaluate("document.getElementById('pi-bookmarklet').getAttribute('href')");
  assert.ok(firstBookmark!==otherBookmark,'saving a different model updates the generated bookmark');
  await click('#model-settings');
  await browser('wait','--fn',`${root}.querySelectorAll('#model-menu-list button').length===2`);
  await click('#model-menu-list button:nth-child(2)');
  await browser('wait','--fn',`${root}.getElementById('chat-model').textContent==='test-model'`);
  await browser('wait','--fn',"document.getElementById('pi-bookmarklet').hasAttribute('href')");
  bookmark=await evaluate("document.getElementById('pi-bookmarklet').getAttribute('href')");
  assert.ok(bookmark!==otherBookmark,'selecting a saved model updates the generated bookmark');
  console.log('PASS selecting a saved model updates the bookmark');

  await click('#model-settings');await click('#model-menu-add');
  await click('#manual-add-provider');
  await evaluate(`(()=>{const r=${root};r.getElementById('provider-name').value='Second provider';r.getElementById('provider-url').value=${JSON.stringify(url+'second-v1')};r.getElementById('provider-key').value='test-secondary'})()`);
  await click('#provider-form [type=submit]');
  await browser('wait','--fn',`${root}.getElementById('provider-form').hidden && ${root}.querySelectorAll('#manual-model-results button').length===1`);
  await evaluate(`(()=>{const input=${root}.getElementById('manual-model-id');input.value='provider-model';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await click('#manual-model-form [type=submit]');
  await browser('wait','--fn',`${root}.getElementById('chat-model').textContent==='provider-model'`);
  await click('#model-settings');
  await browser('wait','--fn',`${root}.querySelectorAll('#model-menu-list button:has(small)').length===3`);
  // Find the saved default by name instead of relying on its sort position.
  const defaultIndex=await evaluate(`[...${root}.querySelectorAll('#model-menu-list button')].findIndex(button=>button.querySelector('span').textContent==='test-model')+1`);
  await click(`#model-menu-list button:nth-child(${defaultIndex})`);
  await browser('wait','--fn',`${root}.getElementById('chat-model').textContent==='test-model'`);
  await click('#model-settings');await click('#model-menu-add');await click('#manual-add-provider');
  await evaluate(`(()=>{const r=${root};r.getElementById('provider-name').value='Unused provider';r.getElementById('provider-url').value=${JSON.stringify(url+'unused-v1')};r.getElementById('provider-key').value='test-unused'})()`);
  await click('#provider-form [type=submit]');
  await browser('wait','--fn',`${root}.getElementById('provider-form').hidden && document.getElementById('pi-bookmarklet').hasAttribute('href')`);
  await browser('wait','--fn',"document.getElementById('pi-bookmarklet').hasAttribute('href')");
  bookmark=await evaluate("document.getElementById('pi-bookmarklet').getAttribute('href')");
  await browser('reload');
  await browser('wait','--fn',`${root}?.getElementById('chat')?.style.display==='flex' && document.getElementById('pi-bookmarklet').hasAttribute('href')`);
  assert.equal(await evaluate(`pi.agent(${selected}).config.model`),'test-model');
  await browser('wait','--fn',"document.getElementById('pi-bookmarklet').hasAttribute('href')");
  bookmark=await evaluate("document.getElementById('pi-bookmarklet').getAttribute('href')");
  console.log('PASS installer exports three saved models and providers, including an unused provider');

  await browser('open',url);
  await evaluate(`localStorage.setItem('pi-tab-language',${JSON.stringify(language)})`);
  await launch();
  assert.equal(await evaluate(`${root}.getElementById('message-input').placeholder`),language==='en'?'Message':'输入消息');
  const first=await evaluate(selected);
  assert.equal((await evaluate('pi.listChats()')).length,1);
  await send('Completed conversation');
  await browser('wait','--fn',`${root}.getElementById('chat-messages').textContent.includes('Bookmark test reply') && !pi.busyFor(${first})`);
  assert.equal((await evaluate('pi.listModels()')).length,3);
  assert.equal((await evaluate('pi.listProviders()')).length,3);
  assert.ok(await evaluate("pi.listProviders().then(items=>items.some(item=>item.providerName==='Unused provider'&&item.apiKey==='test-unused'))"));
  console.log('PASS first launch includes all models and providers and sends with the selected default');
  await click('#settings');
  for(const locale of ['en','zh-CN',language]) {
    await click(`[data-language="${locale}"]`);
    assert.equal(await evaluate('pi.i18n.language'),locale);
    assert.equal(await evaluate(`${root}.getElementById('message-input').placeholder`),locale==='en'?'Message':'输入消息');
    assert.ok(await evaluate(`${root}.getElementById('chat-messages').textContent.includes('Completed conversation')`));
  }
  await click('#preferences-back');
  console.log('PASS bookmark switches both languages without changing messages');

  await browser('reload');
  await launch();
  assert.equal(await evaluate('pi.i18n.language'),language);
  const second=await evaluate(selected);
  assert.notEqual(second,first);
  assert.equal(await evaluate(`${root}.getElementById('chat-messages').textContent.includes('Completed conversation')`),false);
  assert.equal(await evaluate(`pi.agent(${second}).config.model`),'test-model');
  assert.ok((await evaluate(`pi.agent(${first}).history()`)).entries.length>0);
  assert.equal((await evaluate('pi.listChats()')).length,2);
  await browser('screenshot',join(directory,'fresh-after-reload.png'));
  console.log('PASS completed history stays saved; reload opens a blank conversation with inherited model');

  await click('#chat-switch');
  await click(`[data-chat-id="${first}"] .chat-select`);
  await browser('wait','--fn',`${root}.getElementById('chat-messages').textContent.includes('Completed conversation')`);
  assert.equal(await evaluate(selected),first);
  console.log('PASS previous conversation is selectable');

  hold=true;
  await send('Continue after reload');
  await browser('wait','--fn',`pi.busyFor(${first})`);
  const countBefore=await evaluate('pi.listChats().then(chats=>chats.length)');
  // Keep the model pending across reload so recovery is observable before completion.
  await browser('reload');
  await launch();
  assert.equal(await evaluate(selected),first);
  assert.equal(await evaluate('pi.listChats().then(chats=>chats.length)'),countBefore);
  await browser('wait','--fn',`${root}.getElementById('shell').dataset.busy==='true'`);
  console.log('PASS unfinished task resumes in its original conversation');

  // A second reload lets the protocol service complete the persisted task.
  hold=false;
  await browser('reload');
  await launch();
  await browser('wait','--fn',`!pi.busyFor(${first})`);
  assert.equal((await evaluate(`pi.agent(${first}).history()`)).entries.filter(entry=>entry.kind==='pi.assistant'&&JSON.stringify(entry).includes('Bookmark test reply')).length,2);
  assert.ok(requests>=3,'model request is retried after document reload');
  console.log('PASS recovered task completes');

  hold=true;
  await send('Stop before reload');
  await browser('wait','--fn',`pi.busyFor(${first})`);
  await click('#abort');
  await browser('wait','--fn',`!pi.busyFor(${first})`);
  const stoppedRequests=requests;
  await browser('reload');await launch();
  assert.equal(await evaluate(`pi.busyFor(${first})`),false);
  assert.notEqual(await evaluate(selected),first);
  assert.equal(requests,stoppedRequests,'cancelled task must not restart after reload');
  hold=false;
  console.log('PASS stopped bookmark task does not resume after reload');

  // Reopening an empty conversation must not accumulate unused history entries.
  await browser('reload');
  await launch();
  const empty=await evaluate(selected);
  const count=await evaluate('pi.listChats().then(chats=>chats.length)');
  await browser('reload');
  await launch();
  assert.equal(await evaluate(selected),empty);
  assert.equal(await evaluate('pi.listChats().then(chats=>chats.length)'),count);
  console.log('PASS empty conversation reused without accumulating empty history');
  assert.ok(authorizations.length>0 && authorizations.every(value=>value==='Bearer test-only'),'all model requests use the saved credential');
  await click('#model-settings');
  await browser('wait','--fn',`${root}.querySelectorAll('#model-menu-list button:has(small)').length===3`);
  const providerIndex=await evaluate(`[...${root}.querySelectorAll('#model-menu-list button')].findIndex(button=>button.querySelector('span').textContent==='provider-model')+1`);
  await click(`#model-menu-list button:nth-child(${providerIndex})`);
  await browser('wait','--fn',`${root}.getElementById('chat-model').textContent==='provider-model'`);
  await send('Use the second provider without entering its key');
  await browser('wait','--fn',`${root}.getElementById('chat-messages').textContent.includes('Bookmark test reply') && !pi.busyFor(${selected})`);
  assert.equal(authorizations.at(-1),'Bearer test-secondary');
  await browser('reload');await launch();
  assert.equal(await evaluate(`pi.agent(${selected}).config.model`),'provider-model');
  assert.equal((await evaluate('pi.listModels()')).length,3);
  console.log('PASS another provider works without reconfiguration and its selection survives reload');

  // A site's explicit settings take priority over the bookmark's default.
  await click('#model-settings');await click('#model-menu-add');
  await browser('wait','--fn',`${root}.querySelectorAll('#manual-model-results button').length===1`);
  await click('#manual-add-provider');
  await evaluate(`(()=>{const r=${root};r.getElementById('provider-name').value='Site override';r.getElementById('provider-url').value=${JSON.stringify(url+'site-v1')};r.getElementById('provider-key').value='site-only'})()`);
  await click('#provider-form [type=submit]');
  await browser('wait','--fn',`${root}.getElementById('provider-form').hidden && ${root}.querySelectorAll('#manual-model-results button').length===1`);
  await evaluate(`(()=>{const input=${root}.getElementById('manual-model-id');input.value='site-model';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await click('#manual-model-form [type=submit]');
  await browser('wait','--fn',`${root}.getElementById('chat-model').textContent==='site-model'`);
  await browser('reload');await launch();
  assert.equal(await evaluate(`pi.agent(${selected}).config.model`),'site-model');
  await send('Keep this site override');
  await browser('wait','--fn',`${root}.getElementById('chat-messages').textContent.includes('Bookmark test reply') && !pi.busyFor(${selected})`);
  assert.equal(authorizations.at(-1),'Bearer site-only');
  console.log('PASS site-specific model and key survive reopening the default bookmark');

  await browser('open',otherUrl);await launch();
  assert.equal(await evaluate(`pi.agent(${selected}).config.model`),'test-model');
  await send('Other site still uses the default');
  await browser('wait','--fn',`${root}.getElementById('chat-messages').textContent.includes('Bookmark test reply') && !pi.busyFor(${selected})`);
  assert.equal(authorizations.at(-1),'Bearer test-only');
  await browser('open',installer);
  await browser('wait','--fn',`${root}?.getElementById('chat')?.style.display==='flex'`);
  assert.equal(await evaluate(`pi.agent(${selected}).config.model`),'test-model');
  assert.equal(await evaluate(`pi.agent(${selected}).savedConfig().then(config=>config.apiKey)`),'test-only');
  console.log('PASS site override does not change another site or installer defaults');
  console.log(`Screenshots: ${directory}`);
}catch(error){
  await browser('screenshot',join(directory,'failure.png')).catch(()=>{});
  console.log(await browser('errors'));
  console.log('Setup error:',await evaluate(`${root}?.getElementById('setup-error')?.textContent`));
  throw error;
}finally{
  await browser('close').catch(()=>{});
  for(const site of [server,otherSite])site.closeAllConnections();
  await Promise.all([server,otherSite].map(site=>new Promise(resolve=>site.close(resolve))));
}
