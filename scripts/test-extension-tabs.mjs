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
const directory=await mkdtemp(join(tmpdir(),'pi-tab-tabs-'));
const extension=join(directory,'extension');
const session=`pi-tab-tabs-${process.pid}`;
const run=promisify(execFile);
const requests=[];
const server=createServer((request,response)=>{
  if(!request.url.endsWith('/chat/completions')){
    response.writeHead(200,{'Content-Type':'text/html'});
    response.end(`<!doctype html><title>${request.url}</title><h1>${request.url}</h1>`);return;
  }
  let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
    const input=JSON.parse(body);
    if(input.messages.some(message=>['system','developer'].includes(message.role) && JSON.stringify(message.content).includes('你是会话标题生成器'))) {
      response.writeHead(200,{'Content-Type':'text/event-stream'});
      response.end('data: '+JSON.stringify({id:'title',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,delta:{role:'assistant',content:'标签页协作'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return;
    }
    requests.push(input);
    const last=input.messages.at(-1);
    let delta,finish;
    if(last.role==='tool') {delta={role:'assistant',content:typeof last.content==='string'?last.content:JSON.stringify(last.content)};finish='stop';}
    else {
      const text=typeof last.content==='string'?last.content:last.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');
      const call=JSON.parse(text.slice(text.indexOf('PI_TAB_TOOL ')+12));
      delta={role:'assistant',tool_calls:[{index:0,id:`call_${requests.length}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]};finish='tool_calls';
    }
    response.writeHead(200,{'Content-Type':'text/event-stream'});
    for(const choice of [{delta,finish_reason:null},{delta:{},finish_reason:finish}])response.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,...choice}]})+'\n\n');
    response.end('data: [DONE]\n\n');
  });
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/source`;
async function browser(...args){
  const {stdout}=await run('agent-browser',['--headed','false','--executable-path',chrome,'--args','--headless=new,--no-sandbox','--extension',extension,'--session',session,'--json',...args],{maxBuffer:4*1024*1024});
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
  await browser('open',url);
  await browser('tab','new',`chrome-extension://${id}/test-controller.html`);
  const sourceTab=await evaluate(`(async()=>{const [tab]=await chrome.tabs.query({url:${JSON.stringify(url)}});await chrome.storage.session.set({['active:'+tab.id]:true});const r=await chrome.tabs.sendMessage(tab.id,{type:'activate'});if(!r.ok)throw new Error(r.error);return tab.id})()`);
  const engine=async(method,args=[],chatId,name,site='127.0.0.1',tabId=sourceTab)=>{
    await browser('tab','t2');
    const result=await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({target:'engine',site,tabId,method,args,chatId,name})})`);
    assert.equal(result.ok,true,result.error);return result.value;
  };
  const source=(await engine('listChats'))[0].id;
  await engine('agent',[{api:'openai-completions',baseUrl:new URL('/v1',url).href,apiKey:'test-only',model:'test-model',thinking:'off',reasoning:false}],source,'configure');
  const call=async(name,args={})=>JSON.parse(await engine('agent',[command(name,args)],source,'prompt'));
  const page=()=>command('js_eval',{code:'return {url:location.href,title:document.title}'});
  const sourcePage=JSON.parse(await engine('agent',[page()],source,'prompt'));
  assert.equal(sourcePage.url,url);
  assert.ok(['tab_list','tab_open','tab_send','tab_read'].every(name=>requests[0].tools.some(t=>t.function.name===name)));
  assert.ok(requests[0].messages.some(m=>m.role==='system'&&m.content.includes('当前是 Chrome 扩展模式')));
  console.log('PASS model requests expose all four tab tools and identify extension mode');
  for(const host of ['localhost','127.0.0.1']){
    const targetUrl=new URL('/target-'+host,url);targetUrl.hostname=host;
    const opened=await call('tab_open',{url:targetUrl.href});
    await browser('tab','t2');
    await browser('wait','--fn',`(async()=>{const tab=await chrome.tabs.get(${opened.tabId});return tab.status==='complete'})()`);
    const tabs=await call('tab_list');
    const target=tabs.find(tab=>tab.tabId===opened.tabId);
    assert.ok(target,`Opened ${host} tab appears in tab_list`);
    const targetChat=opened.chatId??target.agents.find(chat=>chat.active)?.id??target.agents[0].id;
    if(host==='127.0.0.1')assert.notEqual(targetChat,source,'New tab must have a separate agent, not reuse the source conversation');
    assert.equal((await engine('initialize',[],undefined,undefined,host,opened.tabId)).activeId,targetChat);
    const sent=await call('tab_send',{tabId:opened.tabId,chatId:targetChat,message:page()});
    assert.equal(sent.to,targetChat);
    await browser('wait','--fn',`(async()=>{const r=await chrome.runtime.sendMessage({target:'engine',site:${JSON.stringify(host)},method:'listChats'});return r.ok&&r.value.some(c=>c.id===${targetChat}&&!c.busy)})()`);
    const history=await call('tab_read',{tabId:opened.tabId,chatId:targetChat});
    const answer=history.findLast(entry=>entry.kind==='pi.assistant'&&entry.text)?.text;
    assert.equal(JSON.parse(answer).url,targetUrl.href);
    assert.equal(JSON.parse(await engine('agent',[page()],source,'prompt')).url,url);
    console.log(`PASS ${host}: tab_open → tab_list → tab_send → destination js_eval → tab_read; source keeps its page`);
  }
}finally{
  await browser('close').catch(()=>{});
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await rm(directory,{recursive:true,force:true});
}
