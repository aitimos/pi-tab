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
const directory=await mkdtemp(join(tmpdir(),'pi-tab-linux-tools-'));
const extension=join(directory,'extension');
const session=`pi-tab-linux-tools-${process.pid}`;
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
    const textOf=m=>typeof m.content==='string'?m.content:(m.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
    const marker=input.messages.findLastIndex(m=>m.role==='user'&&textOf(m).includes('PI_TAB_TOOL '));
    const completed=input.messages.slice(marker+1).some(m=>m.role==='tool');
    let delta,finish;
    if(completed) {delta={role:'assistant',content:'done'};finish='stop';}
    else {
      const text=textOf(input.messages[marker]);
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
  const {stdout}=await run('agent-browser',['--headed','false','--executable-path',chrome,'--args','--headless=new,--no-sandbox','--extension',extension,'--session',session,'--json',...args],{maxBuffer:4*1024*1024,timeout:120000});
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
    await browser('tab','1');
    const result=await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({target:'engine',site,tabId,method,args,chatId,name})})`);
    assert.equal(result.ok,true,result.error);return result.value;
  };
  const source=(await engine('listChats'))[0].id;
  await engine('agent',[{api:'openai-completions',baseUrl:new URL('/v1',url).href,apiKey:'test-only',model:'test-model',thinking:'off',reasoning:false,input:['text','image']}],source,'configure');
  await evaluate(`globalThis.toolEvents=[];chrome.runtime.onMessage.addListener(m=>{if(m.type==='engine-event')toolEvents.push(m.event);});`);
  const call=async(name,args={},chat=source)=>{
    await engine('agent',[command(name,args)],chat,'prompt');
    const history=await engine('agent',[],chat,'history');
    const result=history.entries.flatMap(entry=>entry.model||[]).findLast(m=>m.role==='toolResult');
    assert.equal(result.toolName,name);return result;
  };
  const text=result=>result.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');
  const path="/workspace/a ' quoted.txt",quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
  let result=await call('bash',{command:`printf 'one\\r\\n中文 needle\\r\\nthree\\r\\nneedle end\\r\\n' > ${quote(path)}; printf 'stream-first\\n'; sleep 0.3; printf 'stream-last\\n'`});
  assert.equal(result.isError,false);assert.match(text(result),/stream-first[\s\S]*stream-last/);
  assert.ok(['bash','read','grep','edit'].every(name=>requests[0].tools.some(t=>t.function.name===name)));
  assert.ok((await evaluate('toolEvents')).some(e=>e.type==='tool_execution_update'&&e.output));
  result=await call('read',{path,offset:2,limit:2});assert.equal(result.isError,false);assert.match(text(result),/中文 needle[\s\S]*three/);assert.doesNotMatch(text(result),/needle end/);
  result=await call('grep',{pattern:'NEEDLE',ignoreCase:true,glob:'*.txt',context:1});assert.equal(result.isError,false);assert.match(text(result),/quoted.txt:2: 中文 needle/);assert.match(text(result),/quoted.txt:4: needle end/);
  result=await call('edit',{path,edits:[{oldText:'中文 needle',newText:'中文 changed'}]});assert.equal(result.isError,false);assert.match(result.details.diff,/中文 changed/);
  result=await call('bash',{command:`base64 ${quote(path)}`});assert.equal(Buffer.from(text(result).trim(),'base64').toString(),'one\r\n中文 changed\r\nthree\r\nneedle end\r\n');
  result=await call('edit',{path,edits:[{oldText:'three',newText:'x'},{oldText:'three',newText:'y'}]});assert.equal(result.isError,true);
  result=await call('grep',{pattern:'does-not-exist'});assert.equal(result.isError,false);assert.match(text(result),/No matches/);
  await call('bash',{command:"mkdir empty; touch empty-file.txt; printf 'repeat repeat' > repeats.txt"});
  result=await call('edit',{path:'repeats.txt',edits:[{oldText:'repeat',newText:'x'}]});assert.equal(result.isError,true);
  result=await call('grep',{path:'empty',pattern:'['});assert.equal(result.isError,true);
  result=await call('grep',{path:'empty-file.txt',pattern:'['});assert.equal(result.isError,true);
  result=await call('grep',{path:'missing',pattern:'x'});assert.equal(result.isError,true);
  await call('bash',{command:`printf 'literal [ text\\n' > literal.txt; awk 'BEGIN { for (i=0;i<110;i++) { for (j=0;j<1000;j++) printf "x"; printf "\\n" } }' > long.txt`});
  result=await call('grep',{path:'literal.txt',pattern:'[',literal:true});assert.equal(result.isError,false);assert.match(text(result),/literal \[ text/);
  const capped=await engine('agent',['grep',{path:'long.txt',pattern:'x'}],source,'runTool');
  assert.ok(Buffer.byteLength(capped.output[0].text)<=51200);assert.equal(capped.isError,undefined);
  assert.ok(capped.diagnostics.some(d=>d.code==='truncated'));assert.ok(capped.diagnostics.some(d=>d.code==='match_limit'));
  result=await call('bash',{command:'exit 7'});assert.equal(result.isError,true);assert.match(text(result),/code 7/);
  result=await call('bash',{command:'printf before-timeout; sleep 20',timeout:0.2});assert.equal(result.isError,true);assert.match(text(result),/timed out/);
  result=await call('bash',{command:'printf alive'});assert.equal(text(result),'alive');
  result=await call('bash',{command:'seq 1 20000'});assert.equal(result.isError,false);assert.match(text(result),/20000/);
  const spill=/Full output: (\/tmp\/pi-output-[^\s<]+)/.exec(text(result))?.[1];assert.ok(spill,text(result).slice(-1000));
  result=await call('read',{path:spill,offset:19999,limit:2});assert.match(text(result),/19999\n20000/);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDSsAAAAASUVORK5CYII=';
  await call('bash',{command:`printf '%s' '${png}' | base64 -d > pixel.png`});
  result=await call('read',{path:'pixel.png'});assert.equal(result.isError,false);assert.equal(result.content.find(p=>p.type==='image')?.data,png);
  await evaluate(`globalThis.toolEvents=[];globalThis.pendingLinux=chrome.runtime.sendMessage(${JSON.stringify({target:'engine',site:'127.0.0.1',tabId:sourceTab,method:'agent',chatId:source,name:'prompt',args:[command('bash',{command:'printf before-stop; sleep 30'})]})});true`);
  await browser('wait','--fn',`toolEvents.some(e=>e.type==='tool_execution_update'&&JSON.stringify(e.output).includes('before-stop'))`);
  await engine('agent',[],source,'abort');
  await evaluate('pendingLinux');
  result=await call('bash',{command:'printf after-stop'});assert.equal(text(result),'after-stop');
  const direct=await engine('agent',['bash',{command:'printf direct; exit 9'}],source,'runTool');
  assert.equal(direct.structuredOutput.exitCode,9);assert.equal(direct.output[0].text,'direct');assert.equal(direct.isError,true);
  const second=await engine('createChat',[source]);
  result=await call('bash',{command:`test ! -e ${quote(path)}; printf isolated`},second);assert.equal(result.isError,false);assert.equal(text(result),'isolated');
  await call('bash',{command:`printf second > ${quote(path)}`},second);
  result=await call('read',{path,limit:1});assert.match(text(result),/^one/);
  const spawn=await call('agent_spawn',{task:command('bash',{command:`test ! -e ${quote(path)} && printf child-isolated`})});
  const child=JSON.parse(text(spawn)).id;
  await browser('wait','--fn',`(async()=>{const r=await chrome.runtime.sendMessage({target:'engine',site:'127.0.0.1',method:'listChats'});return r.ok&&r.value.some(c=>c.id===${child}&&!c.busy)})()`);
  const childHistory=await engine('agent',[],child,'history');
  assert.ok(childHistory.entries.flatMap(e=>e.model||[]).some(m=>m.role==='toolResult'&&text(m)==='child-isolated'));
  console.log('PASS model tools: bash → read → grep → edit, CRLF/quoted paths, errors, timeout, streaming, spill, image, direct results and child isolation');

  await engine('selectChat',[],source);
  await browser('tab','0');await browser('reload');
  const root=`document.querySelector('[data-pi-overlay]')?.shadowRoot`;
  await browser('wait','--fn',`!!${root}?.querySelector('.tool-row')`);
  // Extension scripts have an isolated JS world. Inspect rendered dialogs,
  // not their private properties on DOM objects from the page's JS world.
  const restored=await evaluate(`(()=>{const r=${root},rows=[...r.querySelectorAll('.tool-row')];let diff=false,image=false;for(const row of rows){row.querySelector('button').click();r.getElementById('tool-result-tab').click();diff ||= r.getElementById('tool-result-data').textContent.includes('中文 changed');image ||= !!r.querySelector('#tool-result-images img');r.getElementById('tool-dialog-close').click();}return {diff,image,error:rows.some(row=>row.dataset.state==='error')}})()`);
  assert.deepEqual(restored,{diff:true,image:true,error:true});
  await evaluate(`(()=>{const r=${root};for(const row of r.querySelectorAll('.tool-row')){row.querySelector('button').click();r.getElementById('tool-result-tab').click();if(r.querySelector('#tool-result-images img'))return;r.getElementById('tool-dialog-close').click();}})()`);
  await browser('wait','--fn',`${root}.querySelector('#tool-result-images img')?.naturalWidth===1`);
  await evaluate(`${root}.getElementById('tool-dialog-close').click()`);
  result=await call('read',{path,limit:1});assert.match(text(result),/^one/);
  await engine('agent',[],second,'reset');
  result=await call('bash',{command:`test ! -e ${quote(path)}`},second);assert.equal(result.isError,false);
  await engine('deleteChat',[child]);
  // Actual guest Wasm trap (not a mocked Worker). Built with pinned clang from:
  // volatile int marker; void _start(void) { marker=1; __builtin_trap(); }
  // -fPIC -O2 -nostdlib -Wl,-shared,--shared-memory,--export=_start,--strip-all
  const trap='AGFzbQEAAAAADwhkeWxpbmsuMAEECAIAAAEEAWAAAAI7AwNlbnYGbWVtb3J5AgMBgIAEA2Vudg1fX21lbW9yeV9iYXNlA38AA2VudgxfX3RhYmxlX2Jhc2UDfwADBQQAAAAABgYBfwFBAAsHOQMRX193YXNtX2NhbGxfY3RvcnMAABhfX3dhc21fYXBwbHlfZGF0YV9yZWxvY3MAAQZfc3RhcnQAAwgBAgpsBAIACwIAC00BAn8jAEEEaiEAAkACQAJAIABBAEEB/kgCAA4CAAECC0EAIwBqQQBBBPwLACAAQQL+FwIAIABBf/4AAgAaDAELIABBAUJ//gECABoLCxYAI4CAgIAAQYCAgIAAakEBNgIAAAAL';
  result=await call('bash',{command:`printf '%s' '${trap}' | base64 -d > crash; chmod +x crash; ./crash`});assert.equal(result.isError,true);assert.match(text(result),/unreachable/);assert.match(text(result),/临时文件已丢失/);
  result=await call('bash',{command:`test ! -e ${quote(path)}; printf recovered`});assert.equal(text(result),'recovered');
  await call('bash',{command:`printf temporary > ${quote(path)}`});
  await evaluate(`globalThis.toolEvents=[];globalThis.lostRun=chrome.runtime.sendMessage(${JSON.stringify({target:'engine',site:'127.0.0.1',tabId:sourceTab,method:'agent',chatId:source,name:'prompt',args:[command('bash',{command:'printf marker > /workspace/replayed; printf before-reload; sleep 30'})]})}).catch(error=>({error:error.message}));true`);
  await browser('wait','--fn',`toolEvents.some(e=>e.type==='tool_execution_update'&&JSON.stringify(e.output).includes('before-reload'))`);
  // Recreating the offscreen page has the same RAM reset as extension reload.
  await evaluate(`chrome.offscreen.closeDocument()`);
  await evaluate(`chrome.offscreen.createDocument({url:'engine.html',reasons:['WORKERS'],justification:'Verify Linux reset after background recreation'})`);
  await browser('wait','--fn',`(async()=>{try{return (await chrome.runtime.sendMessage({target:'engine',site:'127.0.0.1',method:'listChats'})).ok}catch{return false}})()`);
  await browser('wait','--fn',`(async()=>{const r=await chrome.runtime.sendMessage({target:'engine',site:'127.0.0.1',method:'listChats'});return r.ok&&r.value.some(c=>c.id===${source}&&!c.busy)})()`);
  result=await call('bash',{command:`test ! -e ${quote(path)} && test ! -e /workspace/replayed`});assert.equal(result.isError,false);
  console.log('PASS UI/history: image/diff/errors restored after refresh; reset/deletion, Wasm crash recovery, offscreen recreation and no replay of unfinished Linux calls');
}finally{
  await browser('close').catch(()=>{});
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await rm(directory,{recursive:true,force:true});
}
