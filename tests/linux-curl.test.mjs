import assert from 'node:assert/strict';
import test from 'node:test';
import {parseCurl,runCurl} from '../src/linux-curl.js';
import {LinuxCommand} from '../src/linux-command.js';

const encode=text=>new TextEncoder().encode(text);
function invocation(argv) {
  const stdout=[],stderr=[];
  return {argv,signal:new AbortController().signal,
    stdout:async bytes=>stdout.push(bytes),stderr:async bytes=>stderr.push(bytes),
    get output(){return Buffer.concat(stdout).toString();},get error(){return Buffer.concat(stderr).toString();}};
}

test('curl parses grouped flags, attached values and literal quoted arguments',()=>{
  const options=parseCurl(['-fsSL','-XPOST','-H','X-Test: value with spaces','--header=X-Next: yes','--data-raw=@literal','--url=https://example.test/a?x=1&y=2']);
  assert.equal(options.method,'POST');
  for(const flag of ['fail','silent','showError','location'])assert.equal(options[flag],true);
  assert.equal(options.headers.get('x-test'),'value with spaces');
  assert.equal(options.headers.get('x-next'),'yes');
  assert.deepEqual(options.data,[{kind:'data-raw',value:'@literal'}]);
  assert.equal(parseCurl(['-m0.5','https://example.test']).timeout,0.5);
});

test('curl rejects unavailable options and protocols before making requests',async()=>{
  for(const args of [['-k'],['-A','custom'],['-H','User-Agent: custom'],['--proxy','http://proxy.test'],['-H','Cookie: secret'],['-H','Content-Length: 3'],['--data'],['--location=yes'],['--max-time','NaN','https://example.test'],['file:///etc/passwd'],['https://one.test','https://two.test'],['-I','-d','x','https://example.test']]) {
    const call=invocation(args);
    const result=await runCurl(call,()=>assert.fail('Invalid command must not fetch'));
    assert.equal(result.exitCode,2);assert.match(call.error,/curl: \(2\)/);
  }
  const call=invocation(['--help']);
  assert.equal((await runCurl(call,()=>assert.fail())).exitCode,0);
  assert.match(call.output,/not libcurl|fetch adapter/);
});

test('curl JSON and Basic auth become fetch inputs without browser credentials',async()=>{
  const call=invocation(['--json','{"中文":true}','-u','user:pass','https://example.test']);
  const result=await runCurl(call,async(url,options)=>{
    assert.equal(url,'https://example.test/');assert.equal(options.method,'POST');
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');
    assert.equal(options.headers.get('authorization'),'Basic dXNlcjpwYXNz');
    assert.equal(options.headers.get('content-type'),'application/json');
    assert.equal(options.headers.get('accept'),'application/json');
    assert.equal(await options.body.text(),'{"中文":true}');
    return new Response('response');
  });
  assert.equal(result.exitCode,0);assert.equal(call.output,'response');
});

test('curl preserves binary uploads and streams response writes in order',async()=>{
  const call=invocation(['--data-binary','@-','https://example.test']);
  call.stdin=(async function*(){yield new Uint8Array([0,255,13,10]);yield encode('中文');})();
  const output=[];
  call.stdout=async bytes=>{await new Promise(resolve=>setTimeout(resolve,1));output.push(...bytes);};
  const result=await runCurl(call,async(url,options)=>{
    assert.deepEqual(new Uint8Array(await options.body.arrayBuffer()),new Uint8Array([0,255,13,10,...encode('中文')]));
    return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([255,0]));controller.enqueue(new Uint8Array([10,13]));controller.close();}}));
  });
  assert.equal(result.exitCode,0);assert.deepEqual(output,[255,0,10,13]);
});

test('curl data strips CR/LF/NUL from @file but preserves literal values',async()=>{
  const call=invocation(['-d','@file','-d','literal\n','https://example.test']);
  call.readFile=async function*(path){assert.equal(path,'file');yield encode('a\r\nb\0');};
  await runCurl(call,async(url,options)=>{assert.equal(await options.body.text(),'ab&literal\n');return new Response('ok');});
});

test('curl handles HTTP errors, silent mode and fetch redirect limitations explicitly',async()=>{
  for(const [args,body,code,showError] of [
    [[], 'missing',0,false],[['-f'],'',22,true],[['--fail-with-body'],'missing',22,true],
    [['-sf'],'',22,false],[['-sSf'],'',22,true],
  ]) {
    const call=invocation([...args,'https://example.test']);
    assert.equal((await runCurl(call,async()=>new Response('missing',{status:404}))).exitCode,code);
    assert.equal(call.output,body);assert.equal(!!call.error,showError);
  }
  const redirect=invocation(['https://example.test']);
  assert.equal((await runCurl(redirect,async()=>({type:'opaqueredirect'}))).exitCode,47);
  assert.match(redirect.error,/-L/);
});

test('curl timeout and external cancellation abort fetch',async()=>{
  const pending=async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  const call=invocation(['-m','0.01','https://example.test']);
  assert.equal((await runCurl(call,pending)).exitCode,28);assert.match(call.error,/timed out/);
  const cancelled=invocation(['https://example.test']),controller=new AbortController();
  cancelled.signal=controller.signal;
  const task=runCurl(cancelled,pending);controller.abort();
  assert.equal((await task).exitCode,130);assert.equal(cancelled.error,'');
});

test('command IO bounds buffers, resumes partial writes and retains invocation metadata',async()=>{
  const call=new LinuxCommand({mailbox:new SharedArrayBuffer(65552),argc:2,group:42,data:encode('/workspace\0curl\0--help\0HOME=/workspace\0TOKEN=a=b\0')},{site:'example.test',conversationId:3});
  assert.deepEqual(call.argv,['--help']);assert.equal(call.cwd,'/workspace');
  assert.equal(call.env.TOKEN,'a=b');assert.equal(call.site,'example.test');assert.equal(call.conversationId,3);
  const received=[];
  const worker=setInterval(()=>{
    if(!Atomics.load(call.control,0))return;
    assert.equal(call.control[1],2);
    const length=Math.min(call.control[3],12345);
    received.push(...call.data.slice(0,length));
    Atomics.store(call.control,0,0);
    call.receive({status:length,data:new Uint8Array()});
  },1);
  try {
    const data=Uint8Array.from({length:150000},(_,i)=>i%256);
    await call.stdout(data);assert.deepEqual(new Uint8Array(received),data);
  } finally {clearInterval(worker);call.close();}
  await assert.rejects(call.stdout(encode('closed')),/stopped/);
});
