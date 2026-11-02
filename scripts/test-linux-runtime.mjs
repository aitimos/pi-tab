// Exercises the real kernel in an extension offscreen document, without Pi.
import {agentBrowser} from './browser-cli.mjs';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {cp,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {build} from 'esbuild';

const chrome=process.env.PI_TAB_TEST_CHROME;
if(!chrome) throw new Error('Set PI_TAB_TEST_CHROME to Chrome for Testing.');
const directory=await mkdtemp(join(tmpdir(),'pi-tab-linux-test-'));
const session=`pi-tab-linux-${process.pid}`;
const run=promisify(execFile);
const httpRequests=[],closedStreams=new Set();
const binary=Buffer.from(Array.from({length:200000},(_,i)=>i%256));
const server=createServer(async(request,response)=>{
  const chunks=[];
  for await(const chunk of request)chunks.push(chunk);
  const body=Buffer.concat(chunks);
  httpRequests.push({url:request.url,method:request.method,headers:request.headers,body});
  // Deliberately no CORS headers: these requests belong to the extension host.
  if(request.url==='/redirect'){response.writeHead(302,{Location:'/hello'});response.end();return;}
  if(request.url==='/missing'){response.writeHead(404);response.end('missing');return;}
  if(request.url==='/binary'){response.end(binary);return;}
  if(request.url==='/echo'){response.end(body);return;}
  if(request.url.startsWith('/stream')){
    response.writeHead(200,{'Content-Type':'text/plain'});response.write('first\n');
    const timer=setInterval(()=>response.write('more\n'),50);
    response.on('close',()=>{clearInterval(timer);closedStreams.add(request.url);});return;
  }
  response.setHeader('X-Pi-Test','yes');response.end('hello 中文\n');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const httpUrl=`http://127.0.0.1:${server.address().port}`;
const key=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'});
const id=createHash('sha256').update(key).digest('hex').slice(0,32).replace(/[0-9a-f]/g,d=>String.fromCharCode(97+parseInt(d,16)));
await writeFile(join(directory,'manifest.json'),JSON.stringify({
  manifest_version:3,name:'Pi Tab Linux test',version:'1.0.0',key:key.toString('base64'),permissions:['offscreen'],
  host_permissions:['http://*/*','https://*/*'],
  content_security_policy:{extension_pages:"script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"},
  cross_origin_embedder_policy:{value:'require-corp'},cross_origin_opener_policy:{value:'same-origin'},
}));
await cp(resolve('linux/assets'),join(directory,'linux'),{recursive:true});
await cp(resolve('linux/vendor/linux-worker.js'),join(directory,'linux/linux-worker.js'));
await writeFile(join(directory,'controller.html'),'<!doctype html><title>Linux test controller</title>');
await writeFile(join(directory,'offscreen.html'),'<!doctype html><script src="test.js"></script>');
await build({stdin:{resolveDir:process.cwd(),contents:`
  import {LinuxMachine,operations as op} from './src/linux-machine.js';
  const machines=new Map();
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(message.type!=='linux-test')return;
    (async()=>{
      let machine=machines.get(message.id);
      if(message.name==='dispose'){machine?.dispose();machines.delete(message.id);return true;}
      if(!machine){machine=new LinuxMachine();machines.set(message.id,machine);}
      if(message.name==='exec'){
        let output='';const controller=new AbortController();let timer;
        await machine.start();
        if(message.cancelAfter)timer=setTimeout(()=>controller.abort(),message.cancelAfter);
        try{
          const result=await machine.request(op.exec,['/workspace','1','0','51200','2000','/bin/sh','-c',message.command],undefined,
            {signal:controller.signal,timeout:message.timeout,onOutput:text=>{output+=text;}});
          return {...result,data:new TextDecoder().decode(result.data),output};
        }finally{clearTimeout(timer);}
      }
      if(message.name==='chunks'){
        const bytes=new TextEncoder().encode(message.text);
        for(let at=0;at<bytes.length;at+=1028)await machine.request(op.write,[message.path,at?'1':'0'],bytes.subarray(at,at+1028));
        return true;
      }
      if(message.name==='write')return machine.request(op.write,[message.path,'0'],new TextEncoder().encode(message.text));
      if(message.name==='read'){
        const fd=(await machine.request(op.open,[message.path,'0'])).status;
        try{return new TextDecoder().decode((await machine.request(op.read,[fd,'0','65536'])).data);}
        finally{await machine.request(op.close,[fd]);}
      }
      throw new Error('Unknown test action');
    })().then(value=>respond({ok:true,value}),error=>respond({ok:false,error:error.message}));
    return true;
  });
`},bundle:true,format:'iife',platform:'browser',outfile:join(directory,'test.js')});
async function browser(args,input){
  const command=run(agentBrowser,['--headed','false','--executable-path',chrome,'--args','--headless=new,--no-sandbox','--extension',directory,'--session',session,'--json',...args],{maxBuffer:4*1024*1024,timeout:120000});
  command.child.stdin.end(input);
  const {stdout}=await command;
  const reply=JSON.parse(stdout);assert.equal(reply.success,true,JSON.stringify(reply.error));return reply.data;
}
// Large file fixtures exceed Linux's per-argument limit; send scripts over stdin.
const evaluate=async code=>(await browser(['eval','--stdin'],code)).result;
async function call(name,args={},machine='a'){
  const reply=await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({type:'linux-test',name,id:machine,...args})})`);
  assert.equal(reply.ok,true,reply.error);return reply.value;
}
try{
  await browser(['open',`chrome-extension://${id}/controller.html`]);
  assert.equal(await evaluate('crossOriginIsolated'),true);
  await browser(['set','offline','true']);
  await evaluate(`chrome.offscreen.createDocument({url:'offscreen.html',reasons:['WORKERS'],justification:'Test real Linux kernel'})`);
  assert.equal((await call('exec',{command:'printf "hello 世界\\n" | grep hello > test.txt; cat test.txt'})).output,'hello 世界\n');
  assert.equal((await call('exec',{command:'exit 7'})).status,7);
  const path="/workspace/a ' quoted.txt";
  await call('write',{path,text:'你好\r\nsecond\n'});
  assert.equal(await call('read',{path}),'你好\r\nsecond\n');
  const directText=Array.from({length:20000},(_,i)=>i+1).join('\n')+'\n';
  await call('write',{path:'/workspace/direct',text:directText});
  assert.equal(await call('read',{path:'/workspace/direct'}),directText.slice(0,65536));
  await call('chunks',{path:'/workspace/chunks',text:directText});
  assert.equal(await call('read',{path:'/workspace/chunks'}),directText.slice(0,65536));
  for(let i=0;i<5;i++){
    const x=await call('exec',{command:'cat direct'});
    assert.equal(x.output,directText);
  }
  assert.equal((await call('exec',{command:'sleep 20',cancelAfter:100})).cancelled,'aborted');
  assert.equal((await call('exec',{command:'sleep 20',timeout:0.1})).cancelled,'timeout');
  assert.equal((await call('exec',{command:'printf alive'})).output,'alive');
  assert.equal((await call('exec',{command:"trap '' TERM; while :; do sleep 1; done",timeout:0.1})).cancelled,'timeout');
  assert.equal((await call('exec',{command:'yes &',timeout:2})).status,0);
  for(let iteration=0;iteration<10;iteration++) {
    const large=await call('exec',{command:'seq 1 20000'});
    assert.equal(large.status,0);assert.match(large.data,/^\/tmp\/pi-output-/);
    assert.equal(large.output,Array.from({length:20000},(_,index)=>index+1).join('\n')+'\n',`stream, iteration ${iteration}`);
    const before=await call('read',{path:large.data});
    const at=[...before].findIndex((c,i)=>c!==large.output[i]);
    assert.equal(at,-1,JSON.stringify({iteration,at,length:before.length,snippet:before.slice(at-10,at+80)}));
    const stored=await call('exec',{command:`cat ${large.data}`});
    assert.equal(createHash('sha256').update(stored.output).digest('hex'),createHash('sha256').update(large.output).digest('hex'),`spill contents, iteration ${iteration}`);
    const wc=await call('exec',{command:`wc -l < ${large.data}; wc -c < ${large.data}; tail -3 ${large.data}`});
    assert.equal(wc.output,'20000\n108894\n19998\n19999\n20000\n',`spill check, iteration ${iteration}`);
  }
  assert.equal((await call('exec',{command:'test ! -e test.txt'},'b')).status,0);
  await browser(['reload']);
  assert.equal((await call('exec',{command:'cat test.txt'})).output,'hello 世界\n');
  await call('dispose');
  assert.equal((await call('exec',{command:'test ! -e test.txt'})).status,0);
  console.log('PASS real Linux: offscreen boot, pipes, UTF-8, byte reads/writes, exit status, cancellation, timeout, spill, isolation, refresh and reset');
  await browser(['set','offline','false']);
  assert.match((await call('exec',{command:'curl --version'})).output,/fetch adapter/);
  let result=await call('exec',{command:`curl -fsS ${httpUrl}/hello | grep 中文 > fetched.txt; cat fetched.txt`});
  assert.equal(result.status,0);assert.equal(result.output,'hello 中文\n');
  result=await call('exec',{command:`curl -sS --json '{"text":"中文"}' -H 'X-Test: spaced value' ${httpUrl}/echo`});
  assert.equal(result.output,'{"text":"中文"}');assert.equal(result.status,0);
  let request=httpRequests.at(-1);assert.equal(request.method,'POST');assert.equal(request.headers['content-type'],'application/json');assert.equal(request.headers['x-test'],'spaced value');assert.equal(request.headers.cookie,undefined);
  result=await call('exec',{command:`curl -X PUT -u user:pass --data-raw '@literal' ${httpUrl}/echo`});
  assert.equal(result.status,0);assert.equal(result.output,'@literal');
  request=httpRequests.at(-1);assert.equal(request.method,'PUT');assert.equal(request.headers.authorization,'Basic dXNlcjpwYXNz');
  result=await call('exec',{command:`printf 'stdin中文' | curl --data-binary @- ${httpUrl}/echo`});
  assert.equal(result.output,'stdin中文');assert.equal(result.status,0);
  result=await call('exec',{command:`mkdir -p 'dir space'; cd 'dir space'; curl -o "a ' file.bin" ${httpUrl}/binary; curl --data-binary "@a ' file.bin" ${httpUrl}/echo -o copy.bin; cmp "a ' file.bin" copy.bin; wc -c < copy.bin`});
  assert.equal(result.status,0);assert.equal(result.output,'200000\n');
  assert.deepEqual(httpRequests.findLast(r=>r.url==='/echo').body,binary);
  result=await call('exec',{command:`curl ${httpUrl}/binary | curl --data-binary @- ${httpUrl}/echo -o piped.bin; cmp piped.bin 'dir space/copy.bin'`});
  assert.equal(result.status,0);assert.equal(result.output,'');
  result=await call('exec',{command:'curl --version > /dev/null; seq 1 20000 | wc -l'});
  assert.equal(result.status,0);assert.equal(result.output,'20000\n');
  result=await call('exec',{command:`curl -I ${httpUrl}/hello`});
  assert.match(result.output,/HTTP 200/);assert.match(result.output,/x-pi-test: yes/);assert.doesNotMatch(result.output,/hello 中文/);assert.equal(httpRequests.at(-1).method,'HEAD');
  assert.equal((await call('exec',{command:`curl -L ${httpUrl}/redirect`})).output,'hello 中文\n');
  assert.equal((await call('exec',{command:`curl ${httpUrl}/redirect`})).status,47);
  result=await call('exec',{command:`curl -sf ${httpUrl}/missing`});assert.equal(result.status,22);assert.equal(result.output,'');
  result=await call('exec',{command:`curl --fail-with-body ${httpUrl}/missing`});assert.equal(result.status,22);assert.match(result.output,/missing/);
  assert.equal((await call('exec',{command:`curl ${httpUrl}/missing`})).status,0);
  assert.equal((await call('exec',{command:`curl -k ${httpUrl}/hello`})).status,2);
  assert.equal((await call('exec',{command:`curl -A custom ${httpUrl}/hello`})).status,2);
  assert.equal((await call('exec',{command:`curl -H 'User-Agent: custom' ${httpUrl}/hello`})).status,2);
  assert.equal((await call('exec',{command:`curl --data-binary @nonexistent ${httpUrl}/echo`})).status,26);
  assert.equal((await call('exec',{command:`curl -o /nonexistent/file ${httpUrl}/hello`})).status,23);
  result=await call('exec',{command:`curl -m .2 ${httpUrl}/stream-timeout`});assert.equal(result.status,28);assert.match(result.output,/first/);
  result=await call('exec',{command:`sleep 1 | curl -m .1 --data-binary @- ${httpUrl}/echo`});assert.equal(result.status,28);
  result=await call('exec',{command:`curl ${httpUrl}/stream-abort`,cancelAfter:300});assert.equal(result.cancelled,'aborted');
  result=await call('exec',{command:`curl ${httpUrl}/stream-pipe | head -n 1`});assert.equal(result.output,'first\n');assert.equal(result.status,0);
  for(let attempt=0;attempt<100 && closedStreams.size<3;attempt++)await new Promise(resolve=>setTimeout(resolve,20));
  for(const path of ['/stream-timeout','/stream-abort','/stream-pipe'])assert.ok(closedStreams.has(path),path+' fetch cancelled');
  await call('exec',{command:`curl ${httpUrl}/stream-background > background.txt & echo $! > background.pid`});
  for(let attempt=0;attempt<100 && !httpRequests.some(r=>r.url==='/stream-background');attempt++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(httpRequests.some(r=>r.url==='/stream-background'));
  await call('exec',{command:'sleep 20',timeout:0.1});
  assert.equal(closedStreams.has('/stream-background'),false,'stopping another process group leaves background curl running');
  result=await call('exec',{command:'read pid < background.pid; kill -9 "$pid"'});assert.equal(result.status,0,result.output);
  for(let attempt=0;attempt<100 && !closedStreams.has('/stream-background');attempt++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(closedStreams.has('/stream-background'),'reaping an orphaned curl cancels its fetch');
  assert.equal((await call('exec',{command:`curl ${httpUrl}/hello`})).output,'hello 中文\n');
  assert.equal((await call('exec',{command:'test ! -e fetched.txt'},'b')).status,0);
  await evaluate(`globalThis.curlDisposed=chrome.runtime.sendMessage(${JSON.stringify({type:'linux-test',name:'exec',id:'a',command:`curl ${httpUrl}/stream-dispose`})});true`);
  for(let attempt=0;attempt<100 && !httpRequests.some(r=>r.url==='/stream-dispose');attempt++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(httpRequests.some(r=>r.url==='/stream-dispose'));
  await call('dispose');assert.equal((await evaluate('curlDisposed')).ok,false);
  for(let attempt=0;attempt<100 && !closedStreams.has('/stream-dispose');attempt++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(closedStreams.has('/stream-dispose'));
  console.log('PASS real curl/fetch: GET, JSON, stdin, binary files, quoted paths/cwd, pipes, HEAD, redirects, HTTP/IO errors, timeout, abort, SIGPIPE and isolation');
}finally{
  await browser(['close']).catch(()=>{});
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await rm(directory,{recursive:true,force:true});
}
