// Exercises the real kernel in an extension offscreen document, without Pi.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {cp,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {build} from 'esbuild';

const chrome=process.env.PI_TAB_TEST_CHROME;
if(!chrome) throw new Error('Set PI_TAB_TEST_CHROME to Chrome for Testing.');
const directory=await mkdtemp(join(tmpdir(),'pi-tab-linux-test-'));
const session=`pi-tab-linux-${process.pid}`;
const run=promisify(execFile);
const key=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'});
const id=createHash('sha256').update(key).digest('hex').slice(0,32).replace(/[0-9a-f]/g,d=>String.fromCharCode(97+parseInt(d,16)));
await writeFile(join(directory,'manifest.json'),JSON.stringify({
  manifest_version:3,name:'Pi Tab Linux test',version:'1.0.0',key:key.toString('base64'),permissions:['offscreen'],
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
async function browser(...args){
  const {stdout}=await run('agent-browser',['--headed','false','--executable-path',chrome,'--args','--headless=new,--no-sandbox','--extension',directory,'--session',session,'--json',...args],{maxBuffer:4*1024*1024,timeout:120000});
  const reply=JSON.parse(stdout);assert.equal(reply.success,true,JSON.stringify(reply.error));return reply.data;
}
const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
async function call(name,args={},machine='a'){
  const reply=await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({type:'linux-test',name,id:machine,...args})})`);
  assert.equal(reply.ok,true,reply.error);return reply.value;
}
try{
  await browser('open',`chrome-extension://${id}/controller.html`);
  assert.equal(await evaluate('crossOriginIsolated'),true);
  await browser('set','offline','true');
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
  await browser('reload');
  assert.equal((await call('exec',{command:'cat test.txt'})).output,'hello 世界\n');
  await call('dispose');
  assert.equal((await call('exec',{command:'test ! -e test.txt'})).status,0);
  console.log('PASS real Linux: offscreen boot, pipes, UTF-8, byte reads/writes, exit status, cancellation, timeout, spill, isolation, refresh and reset');
}finally{
  await browser('close').catch(()=>{});
  await rm(directory,{recursive:true,force:true});
}
