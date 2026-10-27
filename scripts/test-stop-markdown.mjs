// Real extension + Durable tool execution, with a deterministic local model server.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
const chrome=process.env.PI_TAB_TEST_CHROME;
if(!chrome)throw new Error('Set PI_TAB_TEST_CHROME to Chrome for Testing.');
const directory=await mkdtemp(join(tmpdir(),'pi-tab-stop-'));
const extension=join(directory,'extension');
const session=`pi-tab-stop-${process.pid}`;
const run=promisify(execFile);
const requests=[];
const pending=new Map();
let finishMarkdown;
const markdown='# 标题 Heading\n\n**粗体 Bold** and *italic* &amp; text\n\n- first\n  - nested\n- [x] done\n\n| Name | Value |\n| --- | --- |\n| one | two |\n\n```js\nconst x = "<img src=x onerror=alert(1)>";\n'+ 'a'.repeat(180)+'\n```\n\n[Safe](https://example.com/?a=1&amp;b=2) [Bad](javascript:alert(1))\n\n<img src=x onerror="window.MARKDOWN_EXECUTED=1">';
function reply(response,delta,finish='stop') {
  response.writeHead(200,{'Content-Type':'text/event-stream'});
  for(const choice of [{delta,finish_reason:null},{delta:{},finish_reason:finish}])response.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,...choice}]})+'\n\n');
  response.end('data: [DONE]\n\n');
}
const server=createServer((request,response)=>{
  if(!request.url.endsWith('/chat/completions')){response.writeHead(200,{'Content-Type':'text/html'});response.end('<!doctype html><title>Stop and Markdown</title><h1>Test page</h1>');return;}
  let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
    const input=JSON.parse(body);
    if(input.messages.some(m=>['system','developer'].includes(m.role)&&JSON.stringify(m.content).includes('你是会话标题生成器'))){reply(response,{role:'assistant',content:'Test conversation'});return;}
    requests.push(input);
    const last=input.messages.at(-1);
    const text=typeof last.content==='string'?last.content:last.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');
    if(text==='MARKDOWN_STREAM'){
      response.writeHead(200,{'Content-Type':'text/event-stream'});
      response.write('data: '+JSON.stringify({id:'md',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,delta:{role:'assistant',content:markdown},finish_reason:null}]})+'\n\n');
      finishMarkdown=()=>response.end('data: '+JSON.stringify({id:'md',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return;
    }
    if(text.startsWith('HOLD_')){const record={closed:false};pending.set(text,record);response.on('close',()=>{record.closed=true;});response.writeHead(200,{'Content-Type':'text/event-stream'});response.write('data: '+JSON.stringify({id:'hold',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,delta:{role:'assistant',content:'Waiting'},finish_reason:null}]})+'\n\n');return;}
    if(text==='LONG_TOOL') {reply(response,{role:'assistant',tool_calls:[{index:0,id:'long',type:'function',function:{name:'js_eval',arguments:JSON.stringify({code:'document.title="TOOL_WAITING";await new Promise(()=>{});return "finished"',timeoutMs:60000})}}]},'tool_calls');return;}
    reply(response,{role:'assistant',content:text==='MARKDOWN'?markdown:'finished'});
  });
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/source`;
async function browser(...args){
  const {stdout}=await run('agent-browser',['--headed','false','--session',session,'--json',...args],{maxBuffer:4*1024*1024});
  const reply=JSON.parse(stdout);assert.equal(reply.success,true,JSON.stringify(reply.error));return reply.data;
}
const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
const command=(name,args={})=>'PI_TAB_TOOL '+JSON.stringify({name,args});
try{
  await cp(resolve('dist/extension'),extension,{recursive:true});
  await writeFile(join(extension,'test-controller.html'),'<!doctype html><title>Tab test controller</title>');
  const key=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'});
  const id=createHash('sha256').update(key).digest('hex').slice(0,32).replace(/[0-9a-f]/g,d=>String.fromCharCode(97+parseInt(d,16)));
  const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));manifest.key=key.toString('base64');
  await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
  await browser('--args','--headless=new','--executable-path',chrome,'--extension',extension,'open',url);
  await browser('tab','new',`chrome-extension://${id}/test-controller.html`);
  const sourceTab=await evaluate(`(async()=>{const [tab]=await chrome.tabs.query({url:${JSON.stringify(url)}});await chrome.storage.session.set({['active:'+tab.id]:true});const r=await chrome.tabs.sendMessage(tab.id,{type:'activate'});if(!r.ok)throw new Error(r.error);return tab.id})()`);
  const engine=async(method,args=[],chatId,name,site='127.0.0.1',tabId=sourceTab)=>{
    await browser('tab','t2');
    const result=await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({target:'engine',site,tabId,method,args,chatId,name})})`);
    assert.equal(result.ok,true,result.error);return result.value;
  };
  const source=(await engine('listChats'))[0].id;
  await engine('agent',[{api:'openai-completions',baseUrl:new URL('/v1',url).href,apiKey:'test-only',model:'test-model',thinking:'off',reasoning:false}],source,'configure');
  const root=`document.querySelector('[data-pi-overlay]').shadowRoot`;
  async function start(chatId,text,tabId=sourceTab){
    await browser('tab','t2');
    await evaluate(`void chrome.runtime.sendMessage(${JSON.stringify({target:'engine',site:'127.0.0.1',tabId,method:'agent',args:[text],chatId,name:'prompt'})})`);
  }
  async function idle(chatId){for(let i=0;i<30;i++){if(!(await engine('listChats')).find(c=>c.id===chatId)?.busy)return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Conversation did not stop');}
  async function waitServer(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(predicate(),'server state reached');}
  async function stopButton(){
    await browser('tab','t1');await browser('wait','--fn',`!${root}.getElementById('abort').hidden`);
    const rect=await evaluate(`(()=>{const r=${root}.getElementById('abort').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await browser('mouse','move',String(Math.round(rect.x)),String(Math.round(rect.y)));await browser('mouse','down','left');await browser('mouse','up','left');
  }
  await browser('tab','t1');await browser('reload');await browser('wait','[data-pi-overlay]');
  await start(source,'HOLD_STOP');await waitServer(()=>pending.has('HOLD_STOP'));
  await browser('tab','t2');
  await evaluate(`void chrome.runtime.sendMessage(${JSON.stringify({target:'engine',site:'127.0.0.1',tabId:sourceTab,method:'agent',args:['QUEUED_MUST_NOT_RUN'],chatId:source,name:'followUp'})})`);
  await stopButton();await idle(source);await waitServer(()=>pending.get('HOLD_STOP').closed);
  assert.equal((await engine('agent',[],source,'queuedMessages')).length,0);
  assert.ok(!requests.some(r=>JSON.stringify(r.messages.at(-1)).includes('QUEUED_MUST_NOT_RUN')));
  console.log('PASS actual Stop button closes model connection and clears queued follow-ups');
  await start(source,'LONG_TOOL');await browser('tab','t1');await browser('wait','--fn',`document.title==='TOOL_WAITING'`);
  const started=Date.now();await stopButton();await idle(source);assert.ok(Date.now()-started<15000);
  console.log('PASS Stop interrupts the 60-second page tool wait promptly');
  await start(source,'HOLD_REFRESH');await waitServer(()=>pending.has('HOLD_REFRESH'));
  await browser('tab','t1');await browser('reload');await browser('wait','[data-pi-overlay]');
  assert.equal(pending.get('HOLD_REFRESH').closed,false);
  await stopButton();await idle(source);await waitServer(()=>pending.get('HOLD_REFRESH').closed);
  console.log('PASS navigation preserves running task; Stop after refresh cancels it');
  for(const language of ['zh-CN','en']){
    await browser('tab','t2');await evaluate(`chrome.storage.local.set({'pi-tab-language':${JSON.stringify(language)}})`);
    await start(source,'MARKDOWN_STREAM');await browser('tab','t1');
    await browser('set','media',language==='en'?'dark':'light');
    await browser('wait','--fn',`${root}.querySelector('.streaming table')!==null`);
    finishMarkdown();await idle(source);await browser('tab','t1');
    await browser('wait','--fn',`${root}.querySelector('.markdown table')!==null`);
    const rendered=await evaluate(`(()=>{const r=${root},m=[...r.querySelectorAll('.markdown')].at(-1);return {heading:!!m.querySelector('h1'),bold:!!m.querySelector('strong'),nested:!!m.querySelector('ul ul'),table:m.querySelectorAll('td').length,code:m.querySelector('pre code').textContent,links:[...m.querySelectorAll('a')].map(a=>a.href),unsafe:!!m.querySelector('img,script'),text:m.textContent,overflow:r.getElementById('shell').scrollWidth>r.getElementById('shell').clientWidth+1}})()`);
    assert.equal(rendered.heading,true);assert.equal(rendered.bold,true);assert.equal(rendered.nested,true);assert.equal(rendered.table,2);assert.equal(rendered.unsafe,false);assert.equal(rendered.overflow,false);
    assert.ok(rendered.code.includes('<img'));assert.ok(rendered.text.includes('& text'));assert.ok(!rendered.text.includes('[x]'));assert.deepEqual(rendered.links,['https://example.com/?a=1&b=2']);
    assert.equal(await evaluate('window.MARKDOWN_EXECUTED===undefined'),true);
    await browser('screenshot',`/tmp/pi-tab-markdown-${language}.png`);
    await browser('reload');await browser('wait','--fn',`document.querySelector('[data-pi-overlay]')?.shadowRoot.querySelector('.markdown table')!==null`);
    console.log(`PASS ${language}: Markdown headings/lists/tables/code/links, inert HTML, narrow layout, restored history`);
  }
  // Controller owns extension APIs; page JavaScript intentionally does not.
  await browser('tab','t2');
  const otherTab=await evaluate(`(async()=>{const t=await chrome.tabs.create({url:${JSON.stringify(new URL('/other',url).href)},active:false});return t.id})()`);
  const otherChat=await engine('createChat',[source],undefined,undefined,'127.0.0.1',otherTab);
  await start(source,'HOLD_CLOSE');await start(otherChat,'HOLD_OTHER',otherTab);
  await waitServer(()=>pending.has('HOLD_CLOSE')&&pending.has('HOLD_OTHER'));
  await browser('tab','t2');await evaluate(`chrome.tabs.remove(${sourceTab})`);await idle(source);
  await waitServer(()=>pending.get('HOLD_CLOSE').closed);assert.equal(pending.get('HOLD_OTHER').closed,false);
  await engine('agent',[],otherChat,'abort','127.0.0.1',otherTab);await waitServer(()=>pending.get('HOLD_OTHER').closed);
  console.log('PASS closing the owning tab cancels only its task; independent tab remains running');
}finally{
  await browser('close').catch(()=>{});
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await rm(directory,{recursive:true,force:true});
}
