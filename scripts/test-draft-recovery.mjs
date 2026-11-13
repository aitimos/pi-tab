import assert from 'node:assert/strict';
import {chromium,expect} from 'playwright/test';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,cp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const directory=await mkdtemp(join(tmpdir(),'pi-tab-drafts-'));
const output=process.env.PI_TAB_DRAFT_EVIDENCE?resolve(process.env.PI_TAB_DRAFT_EVIDENCE):await mkdtemp(join(tmpdir(),'pi-tab-drafts-evidence-'));
await mkdir(output,{recursive:true});
const requests=[],cases=[],errors=[];
const server=createServer((request,response)=>{
  if(!request.url.endsWith('/chat/completions')){
    response.setHeader('Content-Type','text/html;charset=utf-8');
    response.end('<title>Draft recovery</title><h1>Draft recovery</h1><button id="navigate" onclick="history.pushState({},\'\',\'/route-\'+(++window.route))">Navigate</button><script>window.route=0</script>');return;
  }
  let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
    const input=JSON.parse(body),title=input.messages.some(m=>['system','developer'].includes(m.role)&&JSON.stringify(m.content).includes('你是会话标题生成器'));
    if(!title)requests.push(input);
    response.writeHead(200,{'Content-Type':'text/event-stream'});
    response.end('data: '+JSON.stringify({id:'draft',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:title?'Draft fixture':'DRAFT_ACK'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base=`http://127.0.0.1:${server.address().port}`,extension=join(directory,'extension');
await cp(resolve('dist/extension'),extension,{recursive:true});
let browser,page;
try{
  browser=await chromium.launchPersistentContext(join(directory,'profile'),{headless:true,executablePath:process.env.PI_TAB_TEST_CHROME||chromium.executablePath(),viewport:{width:1280,height:1000},args:['--no-sandbox','--no-proxy-server',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  browser.setDefaultTimeout(15000);
  const worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker');
  await worker.evaluate(base=>chrome.storage.local.set({profiles:[{id:'draft',api:'openai-completions',baseUrl:base+'/v1',apiKey:'test-only',model:'fixture',thinking:'off',reasoning:false,input:['text','image']}],providers:[],'pi-tab-language':'zh-CN'}),base);
  page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/source');
  const tabId=await worker.evaluate(async url=>{
    const [tab]=await chrome.tabs.query({url});await chrome.storage.session.set({['active:'+tab.id]:true});
    const result=await chrome.tabs.sendMessage(tab.id,{type:'activate',openWindow:true});assertResult(result);return tab.id;
    function assertResult(result){if(!result.ok)throw Error(result.error);}
  },page.url());
  const ui=page.locator('[data-pi-overlay]').last(),input=ui.locator('#message-input');
  const isolated=(func,args)=>worker.evaluate(`(async()=>{const [result]=await chrome.scripting.executeScript({target:{tabId:${tabId}},world:'ISOLATED',func:${func.toString()},args:[${JSON.stringify(args??null)}]});if(result.error)throw Error(result.error.message);return result.result;})()`);
  const currentRef=()=>isolated(()=>window.__piTabAgent.conversation.id);
  const record=name=>{cases.push(name);console.log('PASS',name);};
  const attach=async(name,content)=>{
    await ui.locator('#attachment-input').setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from(content)});
    await expect(ui.locator('#attachments')).toContainText(name);
  };
  const newChat=async()=>{
    await ui.locator('#new-chat').click();await expect(ui.locator('#new-chat')).toBeEnabled();await expect(input).toHaveValue('');return currentRef();
  };
  const select=async ref=>{
    await ui.locator('#chat-switch').click();await ui.locator('[data-chat-id="'+encodeURIComponent(ref)+'"] .chat-select').click();await ui.locator('#chat-list').waitFor({state:'hidden'});
  };
  const delayPreparation=()=>isolated(()=>{
    const send=chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage=(message,callback)=>{
      if(message.type==='document-status'){
        chrome.runtime.sendMessage=send;
        return send(message,response=>{window.__draftRelease=()=>{delete window.__draftRelease;callback(response);};});
      }
      return send(message,callback);
    };
  });
  const startRejected=async(text,file)=>{
    await delayPreparation();await input.fill(text);if(file)await attach(file.name,file.content);
    await ui.locator('#send').click();await expect.poll(()=>isolated(()=>Boolean(window.__draftRelease))).toBe(true);
  };
  const reject=async()=>{await page.locator('#navigate').click();await isolated(()=>window.__draftRelease());};
  const retained=text=>ui.locator('.retained-draft').filter({has:page.locator('pre').filter({hasText:text})});
  const recover=async text=>{await retained(text).locator('button').click();await expect(input).toHaveValue(text);};
  await expect(input).toBeVisible();

  // The review's original no-edit control still restores automatically.
  await startRejected('  CONTROL_ORIGINAL\n',{name:'control.txt',content:'control bytes'});await reject();
  await expect(input).toHaveValue('  CONTROL_ORIGINAL\n');await expect(ui.locator('#attachments')).toContainText('control.txt');
  await expect(ui.locator('.retained-draft')).toHaveCount(0);assert.equal(requests.length,0);
  record('empty composer restores exact rejected text and attachments');

  await newChat();
  await startRejected('ORIGINAL_UNSENT_INPUT',{name:'original.txt',content:'original bytes'});
  await input.fill('NEW_DRAFT_TYPED_DURING_PREPARATION');await attach('new.txt','new bytes');await reject();
  await expect(input).toHaveValue('NEW_DRAFT_TYPED_DURING_PREPARATION');await expect(ui.locator('#attachments')).toContainText('new.txt');
  await expect(retained('ORIGINAL_UNSENT_INPUT')).toContainText('original.txt');assert.equal(requests.length,0);
  await page.screenshot({path:join(output,'same-ref-new-edit-preserved.png')});
  await recover('ORIGINAL_UNSENT_INPUT');await expect(ui.locator('#attachments')).toContainText('original.txt');
  await expect(retained('NEW_DRAFT_TYPED_DURING_PREPARATION')).toContainText('new.txt');
  await recover('NEW_DRAFT_TYPED_DURING_PREPARATION');await expect(retained('ORIGINAL_UNSENT_INPUT')).toHaveCount(1);
  assert.equal(requests.length,0,'retrieving either draft must never submit');
  record('same-ref new editing and both attachment sets remain recoverable without submitting');

  // A file read belongs to the conversation that selected it, even across a switch.
  const attachmentRef=await currentRef();
  await isolated(()=>{
    const read=File.prototype.arrayBuffer;
    File.prototype.arrayBuffer=function(){
      File.prototype.arrayBuffer=read;
      return new Promise((resolve,reject)=>{window.__draftReadRelease=()=>{
        delete window.__draftReadRelease;read.call(this).then(resolve,reject);
      };});
    };
  });
  await ui.locator('#attachment-input').setInputFiles({name:'delayed.txt',mimeType:'text/plain',buffer:Buffer.from('delayed bytes')});
  await expect.poll(()=>isolated(()=>Boolean(window.__draftReadRelease))).toBe(true);
  await expect(retained('ORIGINAL_UNSENT_INPUT').locator('button')).toBeDisabled();
  await newChat();await input.fill('OTHER_REF_DURING_FILE_READ');
  await isolated(()=>window.__draftReadRelease());
  await expect(ui.locator('#send')).toBeEnabled();await expect(ui.locator('#attachments')).toBeEmpty();
  await select(attachmentRef);await expect(input).toHaveValue('NEW_DRAFT_TYPED_DURING_PREPARATION');
  await expect(ui.locator('#attachments')).toContainText('delayed.txt');
  await expect(retained('ORIGINAL_UNSENT_INPUT').locator('button')).toBeEnabled();assert.equal(requests.length,0);
  record('pending attachment reads disable restoration and stay with the selecting conversation');

  const refA=await newChat();
  await startRejected('CROSS_REF_ORIGINAL',{name:'cross-original.txt',content:'cross original bytes'});
  await input.fill('A_NEW_DRAFT');await attach('a-new.txt','A new bytes');
  const refB=await newChat();await input.fill('B_EDITING');await attach('b.txt','B bytes');await reject();
  await expect(input).toHaveValue('B_EDITING');await expect(ui.locator('#attachments')).toContainText('b.txt');await expect(ui.locator('.retained-draft')).toHaveCount(0);
  await select(refA);await expect(input).toHaveValue('A_NEW_DRAFT');await expect(retained('CROSS_REF_ORIGINAL')).toContainText('cross-original.txt');
  await recover('CROSS_REF_ORIGINAL');await expect(retained('A_NEW_DRAFT')).toContainText('a-new.txt');
  await select(refB);await expect(input).toHaveValue('B_EDITING');await expect(ui.locator('#attachments')).toContainText('b.txt');
  await select(refA);await expect(input).toHaveValue('CROSS_REF_ORIGINAL');assert.equal(requests.length,0);
  record('rejection stays with its original ref when both conversations already have drafts');

  await newChat();
  await startRejected('REPEATED_FIRST',{name:'first.txt',content:'first bytes'});await input.fill('REPEATED_SECOND');await attach('second.txt','second bytes');await reject();
  await expect(retained('REPEATED_FIRST')).toHaveCount(1);
  await delayPreparation();await ui.locator('#send').click();await expect.poll(()=>isolated(()=>Boolean(window.__draftRelease))).toBe(true);
  await input.fill('REPEATED_THIRD');await attach('third.txt','third bytes');await reject();
  await expect(ui.locator('.retained-draft')).toHaveCount(2);await expect(retained('REPEATED_SECOND')).toContainText('second.txt');
  await recover('REPEATED_FIRST');await expect(retained('REPEATED_THIRD')).toContainText('third.txt');
  await recover('REPEATED_SECOND');await expect(ui.locator('#attachments')).toContainText('second.txt');
  assert.equal(requests.length,0);
  await worker.evaluate(()=>chrome.storage.local.set({'pi-tab-language':'en'}));await expect(ui.locator('#retained-draft-summary')).toHaveText('Saved drafts (2)');
  await page.setViewportSize({width:600,height:960});await page.screenshot({path:join(output,'repeated-rejection-en-narrow.png')});await page.setViewportSize({width:1280,height:1000});
  record('repeated definite rejections retain all drafts and attachments; English narrow recovery is usable');

  // Intentionally submit a retrieved draft and verify the actual attachment data.
  await ui.locator('#send').click();await expect(ui.locator('#abort')).toBeHidden();
  assert.equal(requests.length,1);assert.ok(JSON.stringify(requests[0].messages.at(-1)).includes('second bytes'));
  await expect(retained('REPEATED_SECOND')).toHaveCount(0);
  record('only a new user send submits a recovered attachment with its original bytes');

  for(const outcome of ['accepted','unknown']){
    await newChat();const before=requests.length;
    await isolated(outcome=>{
      const send=chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage=(message,callback)=>{
        if(message.type==='continuation-call'&&message.operation==='agent'&&message.name==='prompt'){
          chrome.runtime.sendMessage=send;
          return send(message,response=>{window.__draftRelease=()=>{delete window.__draftRelease;callback(outcome==='unknown'?{ok:false,code:'RECONNECT_REVIEW_HISTORY',error:'Connection lost after submission',notSubmitted:false}:response);};});
        }
        return send(message,callback);
      };
    },outcome);
    await input.fill(outcome.toUpperCase()+'_ORIGINAL');await attach(outcome+'.txt',outcome+' bytes');await ui.locator('#send').click();
    await expect.poll(()=>isolated(()=>Boolean(window.__draftRelease))).toBe(true);
    await input.fill(outcome.toUpperCase()+'_NEW_EDIT');await attach(outcome+'-new.txt','new editing bytes');await isolated(()=>window.__draftRelease());
    await expect(ui.locator('#abort')).toBeHidden();await expect(input).toHaveValue(outcome.toUpperCase()+'_NEW_EDIT');
    await expect(ui.locator('.retained-draft')).toHaveCount(0);assert.equal(requests.length,before+1,'accepted/unknown requests must not replay');
    const ref=await currentRef();await newChat();await select(ref);await expect(input).toHaveValue(outcome.toUpperCase()+'_NEW_EDIT');await expect(ui.locator('.retained-draft')).toHaveCount(0);
    record(outcome+' result preserves later editing without restoring or replaying the submitted input');
  }
  assert.deepEqual(errors,[]);
  await writeFile(join(output,'result.json'),JSON.stringify({browser:browser.browser()?.version(),cases,businessRequests:requests.length,errors},null,2));
}catch(error){
  await page?.screenshot({path:join(output,'failure.png')}).catch(()=>{});
  throw error;
}finally{
  await browser?.close();server.closeAllConnections();await new Promise(done=>server.close(done));
  await rm(directory,{recursive:true,force:true});
}
