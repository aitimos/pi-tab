import {extensionTestRpc} from './extension-test-rpc.mjs';
// Real built bookmark and unpacked extension, isolated browser profiles and local
// HTTP fixtures only. Screenshots contain synthetic values with masked secrets.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';

const directory=process.env.PI_TAB_MCP_EVIDENCE||await mkdtemp(join(tmpdir(),'pi-tab-mcp-'));
await mkdir(directory,{recursive:true});
const html=await readFile('pi-bookmarklet-chat-install.html','utf8');
const requests=[],headers=[],modelInputs=[],consoleText=[];
const unicodeText='订单已创建：上海 🧭';
let modelHeld=false,onModelHeld;
const server=createServer((request,response)=>{
  response.setHeader('Access-Control-Allow-Origin','*');
  response.setHeader('Access-Control-Allow-Headers',request.headers['access-control-request-headers']||'*');
  response.setHeader('Access-Control-Allow-Methods','POST,DELETE,GET,OPTIONS');
  response.setHeader('Access-Control-Expose-Headers','Mcp-Session-Id');
  if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
  if(request.url==='/install'){response.setHeader('Content-Type','text/html;charset=utf-8');response.end(html);return;}
  if(request.url.endsWith('/models')){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({data:[{id:'test-model',reasoning:false}]}));return;}
  if(request.method==='GET'){response.setHeader('Content-Type','text/html;charset=utf-8');response.end('<!doctype html><title>MCP settings regression</title><h1>Local test page</h1>');return;}
  let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
    const message=body?JSON.parse(body):null;
    if(request.url.endsWith('/chat/completions')){
      const title=JSON.stringify(message.messages).includes('你是会话标题生成器');
      modelInputs.push(message);if(modelHeld&&!title){onModelHeld?.();return;}
      const answered=message.messages.some(item=>item.role==='tool'||item.role==='toolResult');
      response.writeHead(200,{'Content-Type':'text/event-stream'});
      const choice=title?{delta:{role:'assistant',content:'MCP test'},finish_reason:'stop'}:answered?{delta:{role:'assistant',content:'MCP tool finished'},finish_reason:'stop'}:{delta:{role:'assistant',tool_calls:[{index:0,id:'call_mcp',type:'function',function:{name:'mcp__docs__search',arguments:'{"q":"test"}'}}]},finish_reason:'tool_calls'};
      response.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,...choice}]})+'\n\n');response.end('data: [DONE]\n\n');return;
    }
    requests.push({path:request.url,message});headers.push(request.headers);
    if(request.method==='DELETE'){response.writeHead(204);response.end();return;}
    if(request.url.startsWith('/denied')){response.writeHead(401);response.end('HEADER_SENTINEL ENV_SENTINEL');return;}
    if(!message||message.id===undefined){response.writeHead(202);response.end();return;}
    response.setHeader('Mcp-Session-Id','fixture-session');
    if(message.method==='tools/call'){
      const bytes=Buffer.from('data: '+JSON.stringify({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:unicodeText}]}})+'\n\n');
      const chinese=bytes.indexOf(Buffer.from('订'))+1,emoji=bytes.indexOf(Buffer.from('🧭'))+2;
      response.writeHead(200,{'Content-Type':'text/event-stream'});response.write(bytes.subarray(0,chinese));
      setTimeout(()=>{response.write(bytes.subarray(chinese,emoji));setTimeout(()=>response.end(bytes.subarray(emoji)),50);},50);return;
    }
    response.setHeader('Content-Type','application/json');
    const result=message.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:message.method==='tools/list'?{tools:[{name:'search',description:'Search fixture',inputSchema:{type:'object',properties:{q:{type:'string'}}}}]}:{content:[{type:'text',text:'MCP fixture answer'}]};
    response.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  });
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port,base=`http://127.0.0.1:${port}`,installer=`http://localhost:${port}/install`,mcpUrl=base+'/mcp';
const screenshots=[];
let browser,extensionContext,browserVersion;
const options={headless:true,executablePath:process.env.PI_TAB_TEST_CHROME||chromium.executablePath(),args:['--no-sandbox','--no-proxy-server']};
const overlay=page=>page.locator('[data-pi-overlay]').last();
const view=page=>overlay(page);
const primary=page=>view(page).locator('#mcp-editor .primary');
async function shot(page,name){
  await view(page).locator('#settings-mcp').scrollIntoViewIfNeeded();
  await overlay(page).screenshot({path:join(directory,name+'.png')});screenshots.push(name+'.png');
}
async function settings(page){
  await view(page).locator('#settings').click();await view(page).locator('#settings-mcp-tab').click();
  await view(page).locator('#mcp-list-view').waitFor();
}
async function waitConnected(page,name='docs'){
  await view(page).locator(`.mcp-server[data-server="${name}"] .mcp-state`).filter({hasText:/已连接|Connected/}).waitFor();
}
async function importJson(page,input,{confirm=true}={}){
  await view(page).locator('#mcp-import').click();await view(page).locator('#mcp-import-text').fill(typeof input==='string'?input:JSON.stringify(input));
  await primary(page).click();await view(page).locator('.mcp-preview-row').first().waitFor();
  if(confirm){await primary(page).click();await view(page).locator('#mcp-list-view').waitFor();}
}
async function waitMcp(page,previousVersion){
  await page.evaluate(previousVersion=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{off();reject(Error('MCP status did not settle'));},30000);
    const check=state=>{if(state&&!state.busy&&(previousVersion===undefined||state.version!==previousVersion)){clearTimeout(timer);off();resolve();}};
    const off=pi.onEvent(event=>{if(event.type==='mcp_changed')check(event);});
    pi.mcpConfig().then(check,reject);
  }),previousVersion);
}
async function checkUrlPrivacy(page,name,url,readConfig,picture){
  const original=JSON.stringify(await readConfig());
  await view(page).getByRole('button',{name:'编辑服务器：'+name,exact:true}).click();
  const input=view(page).locator('#mcp-url'),toggle=view(page).locator('#mcp-url-visibility');
  assert.equal(await input.getAttribute('type'),'password','saved URL queries must be hidden before reveal');
  assert.equal(await input.inputValue(),url,'masking must not replace the original URL');
  assert.equal(await toggle.getAttribute('aria-pressed'),'false');
  await shot(page,picture);
  await toggle.click();assert.equal(await input.getAttribute('type'),'text');
  assert.equal(await input.inputValue(),url);await input.fill(url+'&cancelled=1');
  await view(page).getByRole('button',{name:'取消',exact:true}).first().click();
  assert.equal(JSON.stringify(await readConfig()),original,'cancelled URL edits must not write data');
}
async function changeUrl(page,name,url){
  await view(page).getByRole('button',{name:'编辑服务器：'+name,exact:true}).click();
  assert.equal(await view(page).locator('#mcp-url').getAttribute('type'),'password');
  await view(page).locator('#mcp-url-visibility').click();
  await view(page).locator('#mcp-url').fill(url);
  await view(page).locator('#mcp-url-visibility').click();
  assert.equal(await view(page).locator('#mcp-url').getAttribute('type'),'password');
  await primary(page).click();await view(page).locator('#mcp-list-view').waitFor();await waitConnected(page,name);
}
async function tools(page){return page.evaluate(()=>window.pi.tools().map(tool=>tool.name));}
async function configure(page){
  await page.evaluate(async base=>{
    await pi.configure({api:'openai-completions',baseUrl:base+'/v1',apiKey:'test-only',model:'test-model'});
  },base);
}
try{
  browser=await chromium.launch(options);browserVersion=browser.version();
  const context=await browser.newContext({viewport:{width:1280,height:1050},locale:'zh-CN'});
  await context.addInitScript(()=>{localStorage.setItem('pi-tab-language','zh-CN');localStorage.setItem('pi-tab-size',JSON.stringify({width:600,height:880}));});
  const page=await context.newPage();page.on('console',message=>consoleText.push(message.text()));
  page.on('pageerror',error=>consoleText.push(error.message));
  await page.goto(installer);await view(page).locator('#settings:enabled').waitFor();
  await configure(page);await settings(page);
  await view(page).locator('#mcp-add').click();await view(page).locator('#mcp-name').fill('docs');await view(page).locator('#mcp-url').fill(mcpUrl);
  await shot(page,'01-add-server');
  await primary(page).click();await waitConnected(page);assert.ok((await tools(page)).includes('mcp__docs__search'));
  await shot(page,'02-server-list');
  await view(page).getByRole('button',{name:'编辑服务器：docs',exact:true}).click();
  await view(page).locator('#mcp-description').fill('Documentation fixture');await shot(page,'03-edit-server');
  await primary(page).click();await waitConnected(page);
  await importJson(page,{name:'search',config:{url:mcpUrl,description:'Search fixture'}},{confirm:false});
  await shot(page,'04-single-import');await primary(page).click();await waitConnected(page,'search');
  const before=requests.length;
  await importJson(page,[{name:'docs',config:{url:mcpUrl,description:'Replacement fixture'}},{name:'local',config:{command:'npx',args:['fixture']}}],{confirm:false});
  assert.equal(requests.length,before,'preview does not connect or mutate runtime');
  await shot(page,'05-batch-conflict');
  await view(page).locator('[data-import-id="server.0"] select').selectOption('replace');
  await primary(page).click();await waitConnected(page);
  assert.match((await page.evaluate(()=>pi.getMcpServer('docs'))).config.description,/Replacement/);
  await importJson(page,[{name:'valid',config:{url:mcpUrl}},{name:'invalid',config:{url:'file:///not-supported'}}],{confirm:false});
  assert.equal(await primary(page).isDisabled(),true);await shot(page,'06-batch-validation');
  assert.equal((await page.evaluate(()=>pi.mcpConfig())).servers.some(server=>server.name==='valid'),false);
  await view(page).getByRole('button',{name:'取消',exact:true}).first().click();
  await view(page).locator('#mcp-import').click();await view(page).locator('#mcp-import-text').fill('{"SENTINEL":');await primary(page).click();
  assert.match(await view(page).locator('#mcp-error').innerText(),/JSON/);assert.ok(!(await view(page).locator('#mcp-error').innerText()).includes('SENTINEL'));
  await shot(page,'07-invalid-json');await view(page).getByRole('button',{name:'取消',exact:true}).first().click();
  // Old raw data, placeholders and unknown fields survive edits and reloads.
  const legacyUrl=mcpUrl+'?token=BOOKMARK_URL_SENTINEL&encoded=%2f%2B';
  const editedUrl=legacyUrl+'&scope=orders%2Fsearch';
  const legacy={mcpServers:{docs:{url:legacyUrl,headers:{Authorization:'Bearer ${TOKEN}'},custom:{keep:1}},broken:{url:17},local:{command:'npx'}},env:{TOKEN:'ENV_SENTINEL'},customRoot:{keep:true}};
  await page.evaluate(value=>{
    const saved=JSON.parse(localStorage.getItem('pi-tab-site-settings'));saved.mcp=value;localStorage.setItem('pi-tab-site-settings',JSON.stringify(saved));
  },legacy);
  await page.reload();await view(page).locator('#settings:enabled').waitFor();await settings(page);await waitConnected(page);
  await checkUrlPrivacy(page,'docs',legacyUrl,()=>page.evaluate(()=>pi.exportMcpConfig()),'12-bookmark-url-hidden');
  await view(page).getByRole('button',{name:'编辑服务器：docs',exact:true}).click();
  assert.equal(await view(page).locator('.mcp-pair input[type=password]').count(),2,'URL and header credentials both start hidden');
  await view(page).locator('#mcp-description').fill('Edited legacy server');await primary(page).click();await waitConnected(page);
  let raw=await page.evaluate(()=>pi.exportMcpConfig());
  assert.deepEqual(raw.mcpServers.docs.custom,{keep:1});assert.equal(raw.mcpServers.docs.timeout,undefined);
  assert.deepEqual(raw.mcpServers.broken,{url:17});assert.deepEqual(raw.customRoot,{keep:true});assert.equal(raw.env.TOKEN,'ENV_SENTINEL');
  assert.equal(raw.mcpServers.docs.url,legacyUrl,'saving another field must preserve the exact raw URL');
  await changeUrl(page,'docs',editedUrl);await waitMcp(page);
  await page.reload();await view(page).locator('#settings:enabled').waitFor();await settings(page);await waitConnected(page);
  raw=await page.evaluate(()=>pi.exportMcpConfig());assert.equal(raw.mcpServers.docs.url,editedUrl);
  assert.ok(headers.some(value=>value.authorization==='Bearer ENV_SENTINEL'));
  // The real model sees the registered tool and calls the local HTTP server.
  await page.evaluate(()=>pi.prompt('Use docs search'));
  assert.ok(requests.some(item=>item.message?.method==='tools/call'));
  assert.ok(modelInputs.some(input=>JSON.stringify(input.messages).includes(unicodeText)),'the model receives the exact SSE Unicode tool result');
  await view(page).locator('#preferences-back').click();
  assert.ok((await view(page).locator('#chat-messages').innerText()).includes(unicodeText));
  await overlay(page).screenshot({path:join(directory,'13-sse-unicode-result.png')});screenshots.push('13-sse-unicode-result.png');
  await settings(page);
  for(const input of modelInputs)assert.ok(!JSON.stringify(input).includes('ENV_SENTINEL'));
  // A real in-flight model request blocks configuration changes until aborted.
  modelHeld=true;await page.evaluate(()=>{window.fixtureTask=pi.prompt('Hold the request').catch(()=>{});});
  await page.waitForFunction(()=>pi.busy);
  const denied=await page.evaluate(async()=>{try{await pi.changeMcpConfig({operation:{kind:'delete',name:'docs'}});return '';}catch(error){return error.message;}});
  assert.match(denied,/先停止/);await page.evaluate(async()=>{await pi.abort();await window.fixtureTask;});modelHeld=false;
  // A stale preview from another same-origin tab cannot overwrite a newer edit.
  const other=await context.newPage();await other.goto(installer);await view(other).locator('#settings:enabled').waitFor();
  await waitMcp(other);
  const state=await page.evaluate(()=>pi.mcpConfig());
  await other.evaluate(async()=>pi.changeMcpConfig({operation:{kind:'upsert',name:'other',patch:{url:'http://127.0.0.1:1/mcp',enabled:false}}}));
  await waitMcp(page,state.version);
  const stale=await page.evaluate(async version=>{try{await pi.changeMcpConfig({expectedVersion:version,operation:{kind:'delete',name:'docs'}});return '';}catch(error){return error.message;}},state.version);
  assert.match(stale,/配置已变化/);await other.close();
  await page.reload();await view(page).locator('#settings:enabled').waitFor();await settings(page);await waitConnected(page);
  const failure=await page.evaluate(async url=>{const state=await pi.mcpConfig();return pi.changeMcpConfig({expectedVersion:state.version,operation:{kind:'upsert',name:'denied',patch:{url:url+'/denied?token=QUERY_SENTINEL',headers:{Authorization:'HEADER_SENTINEL'}}}});},base);
  assert.equal(failure.saved,true);
  await view(page).locator('[data-server="denied"] .mcp-state').filter({hasText:/401/}).waitFor();
  await shot(page,'08-safe-connection-error');
  const publicState=JSON.stringify(await page.evaluate(()=>pi.mcpConfig()));
  for(const secret of ['HEADER_SENTINEL','ENV_SENTINEL','QUERY_SENTINEL','BOOKMARK_URL_SENTINEL','EXTENSION_URL_SENTINEL']){assert.ok(!publicState.includes(secret));assert.ok(!consoleText.join('\n').includes(secret));assert.ok(!(await view(page).locator('#settings-mcp').innerText()).includes(secret));}
  // Generated bookmarks carry the original raw config, including unknown keys.
  const bookmark=await page.locator('#pi-bookmarklet').getAttribute('href');assert.ok(decodeURIComponent(bookmark).includes('importMcpConfig'));
  const target=await context.newPage();await target.goto(base+'/target');
  await target.evaluate(bookmark=>{const link=document.createElement('a');link.href=bookmark;link.id='fixture-launch';link.textContent='Launch';document.body.append(link);},bookmark);
  await target.locator('#fixture-launch').click();await view(target).locator('#settings:enabled').waitFor();
  await waitMcp(target);assert.equal((await target.evaluate(()=>pi.mcpConfig())).servers.find(server=>server.name==='docs').status,'connected');
  raw=await target.evaluate(()=>pi.exportMcpConfig());assert.deepEqual(raw.mcpServers.docs.custom,{keep:1});assert.equal(raw.env.TOKEN,'ENV_SENTINEL');assert.equal(raw.mcpServers.docs.url,editedUrl,'generated bookmarks retain the complete edited URL');
  // Delete and disable remove tools; a later reconnect does not duplicate them.
  const current=await page.evaluate(()=>pi.mcpConfig());
  await page.evaluate(version=>pi.changeMcpConfig({expectedVersion:version,operation:{kind:'upsert',name:'docs',previousName:'docs',patch:{enabled:false}}}),current.version);
  await page.waitForFunction(()=>!pi.tools().some(tool=>tool.name==='mcp__docs__search'));
  await waitMcp(page);
  await view(page).getByRole('button',{name:'删除服务器：docs',exact:true}).click();await primary(page).click();await view(page).locator('#mcp-list-view').waitFor();
  assert.equal((await page.evaluate(()=>pi.mcpConfig())).servers.some(server=>server.name==='docs'),false);
  await page.evaluate(()=>pi.i18n.setMode('en'));
  assert.equal(await view(page).locator('#mcp-add').innerText(),'Add server');
  await view(page).locator('#mcp-add').click();
  assert.equal(await view(page).locator('#mcp-editor h3').innerText(),'Add server');
  await page.setViewportSize({width:390,height:900});
  const overflow=await view(page).locator('#mcp-editor').evaluate(node=>node.scrollWidth>node.clientWidth+1);
  assert.equal(overflow,false,'the editor fits a narrow viewport');
  await page.evaluate(()=>{localStorage.setItem('pi-tab-theme','dark');window.dispatchEvent(new Event('pi-tab-theme-change'));});
  await shot(page,'11-english-narrow-dark');
  await view(page).locator('#mcp-name').press('Escape');
  assert.equal(await view(page).locator('#mcp-editor').isVisible(),false);
  await browser.close();browser=null;
  console.log('PASS built bookmark CRUD/import/atomic validation/legacy reload/secrets/model call/busy/stale preview/cross-origin injection');

  // Launch the exact built unpacked extension. The worker triggers the same
  // activation message as the toolbar action, without modifying packaged files.
  const extension=resolve('dist/extension'),profile=await mkdtemp(join(tmpdir(),'pi-tab-mcp-extension-'));
  extensionContext=await chromium.launchPersistentContext(profile,{...options,viewport:{width:1280,height:1000},locale:'zh-CN',args:[...options.args,`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const worker=extensionContext.serviceWorkers()[0]||await extensionContext.waitForEvent('serviceworker');
  await worker.evaluate(()=>chrome.storage.local.set({'pi-tab-language':'zh-CN'}));
  async function activate(page,url){
    await page.goto(url);
    const result=await worker.evaluate(async url=>{
      const tabs=await chrome.tabs.query({});const tab=tabs.find(tab=>tab.url===url);
      await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});
      await chrome.storage.session.set({['active:'+tab.id]:true});return chrome.tabs.sendMessage(tab.id,{type:'activate',openWindow:true});
    },url);assert.equal(result.ok,true,result.error);
    await view(page).locator('#settings:enabled').waitFor();
  }
  const extCall=async(page,method,args=[],name)=>{
    const tab=await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0],page.url());
    const reply=await worker.evaluate(extensionTestRpc,{site:new URL(page.url()).hostname,tabId:tab.id,method,args,name});
    assert.equal(reply.ok,true,reply.error);return reply.value;
  };
  const first=await extensionContext.newPage();await first.addInitScript(()=>localStorage.setItem('pi-tab-size',JSON.stringify({width:600,height:880})));
  await activate(first,base+'/extension');await settings(first);
  const extensionUrl=mcpUrl+'?token=EXTENSION_URL_SENTINEL&encoded=%2F%2b';
  await importJson(first,{mcpServers:{docs:{url:extensionUrl,headers:{Authorization:'Bearer ${TOKEN}'},custom:{keep:true}}},env:{TOKEN:'ENV_SENTINEL'}});await waitConnected(first);
  await shot(first,'09-extension-list');
  await checkUrlPrivacy(first,'docs',extensionUrl,async()=>(await worker.evaluate(()=>chrome.storage.local.get('mcp'))).mcp,'14-extension-url-hidden');
  const second=await extensionContext.newPage();await activate(second,`http://localhost:${port}/other`);await settings(second);await waitConnected(second);
  await view(second).getByRole('button',{name:'编辑服务器：docs',exact:true}).click();await view(second).locator('#mcp-description').fill('Unsaved draft');
  await extCall(first,'agent',[{api:'openai-completions',baseUrl:base+'/v1',apiKey:'test-only',model:'test-model'}],'configure');
  const modelInputsBefore=modelInputs.length;
  const callsBefore=requests.filter(item=>item.message?.method==='tools/call').length;
  await extCall(first,'agent',['Use docs search'],'prompt');
  assert.ok(requests.filter(item=>item.message?.method==='tools/call').length>callsBefore,'the extension model uses its registered MCP tool');
  assert.ok(modelInputs.slice(modelInputsBefore).some(input=>JSON.stringify(input.messages).includes(unicodeText)),'extension tool results preserve split UTF-8');
  modelHeld=true;
  const held=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('The extension model task did not start')),15000);onModelHeld=()=>{clearTimeout(timer);resolve();};});
  const pending=extCall(first,'agent',['Hold this task'],'prompt').catch(()=>{});
  await held;onModelHeld=null;
  await assert.rejects(extCall(second,'changeMcpConfig',[{operation:{kind:'delete',name:'docs'}}]),/先停止/);
  await extCall(first,'agent',[],'abort');await pending;modelHeld=false;
  assert.equal(await view(second).locator('#mcp-editor').isVisible(),true,'model notifications keep the MCP editor open');
  assert.equal(await view(second).locator('#mcp-description').inputValue(),'Unsaved draft');
  await view(second).getByRole('button',{name:'取消',exact:true}).first().click();
  const shared=await worker.evaluate(()=>chrome.storage.local.get(['mcp','mcpRevision']));
  assert.equal(shared.mcp.env.TOKEN,'ENV_SENTINEL');assert.deepEqual(shared.mcp.mcpServers.docs.custom,{keep:true});assert.equal(shared.mcpRevision,1);
  await view(second).getByRole('button',{name:'编辑服务器：docs',exact:true}).click();await view(second).locator('#mcp-description').fill('Across sites');await primary(second).click();await waitConnected(second);
  await first.reload();await view(first).locator('#settings:enabled').waitFor();await settings(first);await waitConnected(first);
  const savedAcross=await extCall(first,'getMcpServer',['docs']);
  assert.equal(savedAcross.config.description,'Across sites');assert.equal(savedAcross.config.url,extensionUrl,'an unrelated extension edit preserves query credentials');
  const stateBefore=await extCall(first,'mcpConfig');
  await importJson(first,[{name:'never-written',config:{url:mcpUrl}},{name:'bad',config:{url:'file:///bad'}}],{confirm:false});assert.equal(await primary(first).isDisabled(),true);
  assert.equal((await worker.evaluate(()=>chrome.storage.local.get('mcpRevision'))).mcpRevision,2);
  assert.equal(JSON.stringify(await extCall(first,'mcpConfig')),JSON.stringify(stateBefore));
  await shot(first,'10-extension-validation');
  await view(first).getByRole('button',{name:'取消',exact:true}).first().click();
  const editedExtensionUrl=extensionUrl+'&scope=orders%2Fsearch';
  await changeUrl(first,'docs',editedExtensionUrl);
  await first.reload();await view(first).locator('#settings:enabled').waitFor();await settings(first);await waitConnected(first);
  assert.equal((await extCall(first,'getMcpServer',['docs'])).config.url,editedExtensionUrl);
  await checkUrlPrivacy(first,'docs',editedExtensionUrl,async()=>(await worker.evaluate(()=>chrome.storage.local.get('mcp'))).mcp,'15-extension-url-reloaded');
  for(const input of modelInputs)for(const secret of ['ENV_SENTINEL','HEADER_SENTINEL','QUERY_SENTINEL','BOOKMARK_URL_SENTINEL','EXTENSION_URL_SENTINEL'])assert.ok(!JSON.stringify(input).includes(secret));
  for(const secret of ['ENV_SENTINEL','EXTENSION_URL_SENTINEL'])assert.ok(!JSON.stringify(await extCall(first,'mcpConfig')).includes(secret));
  await extensionContext.close();extensionContext=null;
  console.log('PASS built extension shared CRUD/import/atomic validation/cross-site synchronization/reload');
  const manifest={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),node:process.version,chromium:browserVersion,executable:options.executablePath.split('/').at(-1),platform:process.platform,arch:process.arch,screenshots,checks:['bookmark','extension','R1-url-privacy-and-roundtrip','R2-utf8-sse-model-results']};
  await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({evidence:directory,...manifest}));
}finally{
  await browser?.close();await extensionContext?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
