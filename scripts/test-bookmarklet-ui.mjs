// Exercise the actual javascript: bookmark in an isolated browser, without an extension.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile, mkdtemp} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {createBookmarklet} from '../src/bookmarklet.js';

const chrome=process.env.PI_TAB_TEST_CHROME;
if(!chrome)throw new Error('Set PI_TAB_TEST_CHROME to Chrome for Testing.');
const run=promisify(execFile);
const language=process.env.PI_TAB_TEST_LANGUAGE || 'zh-CN';
const session=`pi-tab-bookmark-${process.pid}`;
const directory=await mkdtemp(join(tmpdir(),'pi-tab-bookmark-'));
let bookmark, hold=false, requests=0;
const server=createServer((request,response)=>{
  if(request.url.endsWith('/chat/completions')){
    let body='';
    request.on('data',chunk=>body+=chunk);
    request.on('end',()=>{
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
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
const html=await readFile('pi-bookmarklet-chat-install.html','utf8');
bookmark=createBookmarklet(await readFile('dist/pi-console.js','utf8'),{
  openChat:html.match(/<script>\s*(async function openChat[\s\S]*?)\nconst PI_RUNTIME/)[1],
  config:{api:'openai-completions',baseUrl:url+'v1',apiKey:'test-only',model:'test-model',reasoning:false,thinking:'off'},
});
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
  const point=await evaluate(`(()=>{const r=${root}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
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
  await browser('open',url);
  await evaluate(`localStorage.setItem('pi-tab-language',${JSON.stringify(language)})`);
  await launch();
  assert.equal(await evaluate(`${root}.getElementById('message-input').placeholder`),language==='en'?'Message':'输入消息');
  const first=await evaluate(selected);
  assert.equal((await evaluate('pi.listChats()')).length,1);
  await send('Completed conversation');
  await browser('wait','--fn',`${root}.getElementById('chat-messages').textContent.includes('Bookmark test reply') && !pi.busyFor(${first})`);
  console.log('PASS first launch and message');
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
  console.log(`Screenshots: ${directory}`);
}finally{
  await browser('close').catch(()=>{});
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
