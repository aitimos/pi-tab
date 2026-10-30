// Real Pi Durable and browser UI; model responses are controlled at each boundary.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {createBookmarklet} from '../src/bookmarklet.js';

const chrome=process.env.PI_TAB_TEST_CHROME;
if(!chrome)throw Error('PI_TAB_TEST_CHROME is required');
const directory=await mkdtemp(join(tmpdir(),'pi-tab-queue-'));
const run=promisify(execFile);
const html=await readFile('pi-bookmarklet-chat-install.html','utf8');
const runtime=JSON.parse(html.match(/<script id="pi-runtime"[^>]*>(.*?)<\/script>/s)[1]);
const chat=html.match(/<script>\s*(async function openChat[\s\S]*?)\nconst PI_RUNTIME/)[1];
let bookmark;
const requests=[];
function chunk(response,delta,finish=null){
  response.write('data: '+JSON.stringify({id:'queue',object:'chat.completion.chunk',model:'test-model',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');
}
function finish(response){chunk(response,{},'stop');response.end('data: [DONE]\n\n');}
const server=createServer((request,response)=>{
  if(!request.url.endsWith('/chat/completions')){
    response.setHeader('Content-Type','text/html;charset=utf-8');
    response.end(`<title>Queue test</title><a id="launch" href="${bookmark.replaceAll('&','&amp;').replaceAll('"','&quot;')}">Pi Tab</a>`);return;
  }
  let body='';request.on('data',data=>body+=data);request.on('end',()=>{
    const input=JSON.parse(body);
    response.writeHead(200,{'Content-Type':'text/event-stream'});
    if(input.messages.some(m=>['system','developer'].includes(m.role)&&JSON.stringify(m.content).includes('你是会话标题生成器'))){chunk(response,{role:'assistant',content:'Queue test'});finish(response);return;}
    requests.push({input,response});
    const last=input.messages.at(-1);
    if(last.role==='user'&&last.content==='START'){
      chunk(response,{role:'assistant',tool_calls:[{index:0,id:'hold',type:'function',function:{name:'js_eval',arguments:JSON.stringify({code:'document.documentElement.dataset.queueTool="waiting";await new Promise(resolve=>document.addEventListener("queue-tool-release",resolve,{once:true}));delete document.documentElement.dataset.queueTool;return "TOOL_DONE"',timeoutMs:60000})}}]});
      chunk(response,{},'tool_calls');response.end('data: [DONE]\n\n');
    }else chunk(response,{role:'assistant',content:({'FOLLOW':'FOLLOW_REPLY','PROMOTED':'PROMOTED_REPLY','TEXT_ONLY':'TEXT_REPLY','TEXT_FOLLOW':'TEXT_FOLLOW_REPLY'})[last.content]||'STEER_REPLY'});
  });
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const profile={id:'queue-test',profileId:'queue-test',api:'openai-completions',baseUrl:base+'/v1',apiKey:'test-only',model:'test-model',reasoning:false,thinking:'off'};
bookmark=createBookmarklet(runtime,{openChat:chat,profiles:[profile],config:profile});
try{
  for(const mode of (process.env.PI_TAB_TEST_MODE?[process.env.PI_TAB_TEST_MODE]:['bookmarklet','extension'])){
    requests.length=0;
    const session=`pi-tab-queue-${mode}-${process.pid}`;
    const extension=join(directory,'extension');
    let extensionId;
    if(mode==='extension'){
      await cp(resolve('dist/extension'),extension,{recursive:true});
      const key=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'});
      extensionId=createHash('sha256').update(key).digest('hex').slice(0,32).replace(/[0-9a-f]/g,d=>String.fromCharCode(97+parseInt(d,16)));
      const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));manifest.key=key.toString('base64');
      await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
      await writeFile(join(extension,'test-controller.html'),'<!doctype html><title>Queue controller</title>');
    }
    const browser=async(...args)=>{
      const {stdout}=await run('agent-browser',['--headed','false','--executable-path',chrome,'--args','--headless=new,--no-sandbox',...(mode==='extension'?['--extension',extension]:[]),'--session',session,'--json',...args],{maxBuffer:5*1024*1024});
      const reply=JSON.parse(stdout);assert.ok(reply.success,JSON.stringify(reply.error));return reply.data;
    };
    const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
    const root="document.querySelector('[data-pi-overlay]')?.shadowRoot";
    const wait=condition=>browser('wait','--fn',condition);
    const bubbles=()=>evaluate(`[...${root}.querySelectorAll('.message:not([data-queue-id]) .bubble')].map(node=>node.textContent.trim())`);
    async function send(text,steer=false){
      await evaluate(`(()=>{const r=${root},input=r.getElementById('message-input');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      if(steer){
        await evaluate(`${root}.getElementById('send').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
        assert.equal(await evaluate(`${root}.getElementById('send-menu').hidden`),false);
        assert.ok(['优先发送','Send with priority'].includes(await evaluate(`${root}.getElementById('send-steer').textContent`)));
      }
      await evaluate(`${root}.getElementById(${JSON.stringify(steer?'send-steer':'send')}).click()`);
    }
    try{
      await browser('open',base);
      if(mode==='extension'){
        await browser('tab','new',`chrome-extension://${extensionId}/test-controller.html`);
        await evaluate(`(async()=>{await chrome.storage.local.set({'pi-tab-language':'zh-CN'});const [tab]=await chrome.tabs.query({url:${JSON.stringify(base+'/')}});await chrome.storage.session.set({['active:'+tab.id]:true});const active=await chrome.tabs.sendMessage(tab.id,{type:'activate'});if(!active.ok)throw Error(active.error);const init=await chrome.runtime.sendMessage({target:'engine',site:'127.0.0.1',tabId:tab.id,method:'initialize'});const result=await chrome.runtime.sendMessage({target:'engine',site:'127.0.0.1',tabId:tab.id,method:'agent',chatId:init.value.activeId,name:'configure',args:[${JSON.stringify(profile)}]});if(!result.ok)throw Error(result.error);})()`);
        await browser('tab','0');await browser('reload');
      }else await browser('click','#launch');
      await wait(`${root}?.getElementById('chat')?.style.display==='flex'`);
      await send('START');
      await wait(`document.documentElement.dataset.queueTool==='waiting'`);
      await send('FOLLOW');
      await wait(`${root}.querySelectorAll('[data-queue-id]').length===1`);
      await send('STEER',true);
      await wait(`${root}.querySelectorAll('[data-queue-id]').length===2`);
      assert.equal(requests.length,1,'both messages wait while the tool is executing');
      await evaluate('document.dispatchEvent(new Event("queue-tool-release"))');
      await wait(`${root}.textContent.includes('STEER_REPLY')`);
      assert.ok(JSON.stringify(requests[1].input.messages).includes('STEER'));
      assert.ok(!JSON.stringify(requests[1].input.messages).includes('FOLLOW'));
      // Check during generation, not only once the whole run has finished.
      assert.deepEqual(await evaluate(`[...${root}.querySelectorAll('[data-queue-id] .bubble')].map(node=>node.textContent)`),['FOLLOW']);
      assert.equal((await bubbles()).filter(text=>text==='STEER').length,1);
      finish(requests[1].response);
      await wait(`${root}.textContent.includes('FOLLOW_REPLY')`);
      assert.ok(JSON.stringify(requests[2].input.messages).includes('FOLLOW'));
      assert.equal((await bubbles()).filter(text=>text==='STEER_REPLY').length,1,'shared submission results must not duplicate or overwrite replies');
      assert.equal((await bubbles()).filter(text=>text==='FOLLOW').length,1);
      assert.equal(await evaluate(`${root}.querySelectorAll('[data-queue-id]').length`),0);
      finish(requests[2].response);
      await wait(`${root}.getElementById('abort').hidden`);
      assert.equal((await bubbles()).filter(text=>text==='FOLLOW_REPLY').length,1);
      console.log(`PASS ${mode}: steer at tool boundary, follow-up after final answer, live queue state and unique messages`);

      await send('START');
      await wait(`document.documentElement.dataset.queueTool==='waiting'`);
      await send('CANCEL');await send('PROMOTED');
      await wait(`${root}.querySelectorAll('[data-queue-id]').length===2`);
      for(const [text,action] of [['CANCEL','cancel'],['PROMOTED','promote']]){
        await evaluate(`(()=>{const row=[...${root}.querySelectorAll('[data-queue-id]')].find(row=>row.querySelector('.bubble').textContent===${JSON.stringify(text)});row.querySelector('.queue-more').click();row.querySelector('[data-queue-action="${action}"]').click();})()`);
        await wait(action==='cancel'?`${root}.querySelectorAll('[data-queue-id]').length===1`:`${root}.querySelector('[data-queue-action="promote"]').hidden`);
      }
      await evaluate('document.dispatchEvent(new Event("queue-tool-release"))');
      await wait(`${root}.textContent.includes('PROMOTED_REPLY')`);
      assert.ok(JSON.stringify(requests.at(-1).input.messages).includes('PROMOTED'));
      assert.ok(!JSON.stringify(requests.at(-1).input.messages).includes('CANCEL'));
      assert.equal(await evaluate(`${root}.querySelectorAll('[data-queue-id]').length`),0);
      finish(requests.at(-1).response);
      await wait(`${root}.getElementById('abort').hidden`);
      assert.equal((await bubbles()).filter(text=>text==='PROMOTED_REPLY').length,1);
      console.log(`PASS ${mode}: canceled messages never reach the model; promoted messages arrive at the next tool boundary`);

      await send('TEXT_ONLY');
      await wait(`${root}.textContent.includes('TEXT_REPLY')`);
      const count=requests.length;
      await send('TEXT_STEER',true);await send('TEXT_FOLLOW');
      await wait(`${root}.querySelectorAll('[data-queue-id]').length===2`);
      assert.equal(requests.length,count,'steer does not interrupt a streaming text reply');
      finish(requests.at(-1).response);
      await wait(`${root}.textContent.includes('TEXT_FOLLOW_REPLY')`);
      const inputs=requests.at(-1).input.messages;
      assert.ok(inputs.some(message=>message.content==='TEXT_STEER'));
      assert.ok(inputs.some(message=>message.content==='TEXT_FOLLOW'));
      assert.equal(await evaluate(`${root}.querySelectorAll('[data-queue-id]').length`),0);
      finish(requests.at(-1).response);
      await wait(`${root}.getElementById('abort').hidden`);
      assert.equal((await bubbles()).filter(text=>text==='TEXT_FOLLOW_REPLY').length,1);
      console.log(`PASS ${mode}: both modes wait for a text-only reply to finish, then appear once`);
    }finally{
      await browser('close');
    }
  }
}finally{
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await rm(directory,{recursive:true,force:true});
}
