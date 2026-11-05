// Exercises MCP support through the real bookmark: configuration UI, server
// connection, and a tool call driven by the model against a local MCP server.
import {agentBrowser} from './browser-cli.mjs';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile, mkdtemp} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

const chrome=process.env.PI_TAB_TEST_CHROME;
if(!chrome)throw new Error('Set PI_TAB_TEST_CHROME to Chrome for Testing.');
const run=promisify(execFile);
const session=`pi-tab-mcp-${process.pid}`;
const directory=await mkdtemp(join(tmpdir(),'pi-tab-mcp-'));
const html=await readFile('pi-bookmarklet-chat-install.html','utf8');
let bookmark='';
const mcpRequests=[], modelRequests=[], mcpHeaders=[];
const mcpTool={name:'search',description:'Search the documentation',inputSchema:{type:'object',properties:{q:{type:'string',description:'Query'}},required:['q'],additionalProperties:false}};

function cors(request,response){
  response.setHeader('Access-Control-Allow-Origin','*');
  response.setHeader('Access-Control-Allow-Headers',request.headers['access-control-request-headers'] || 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');
  response.setHeader('Access-Control-Expose-Headers','Mcp-Session-Id');
}

const mcp=createServer((request,response)=>{
  cors(request,response);
  if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
  let body='';
  request.on('data',chunk=>body+=chunk);
  request.on('end',()=>{
    const message=body?JSON.parse(body):null;
    mcpRequests.push(message);
    mcpHeaders.push(request.headers);
    if(request.method==='DELETE'){response.writeHead(204);response.end();return;}
    if(!message||message.id===undefined){response.writeHead(202);response.end();return;}
    const reply=result=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));};
    if(message.method==='initialize')return reply({protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'docs-fixture',version:'1.0.0'},instructions:'Search the documentation.'});
    if(message.method==='tools/list')return reply({tools:[mcpTool]});
    if(message.method==='tools/call')return reply({content:[{type:'text',text:`MCP answered ${message.params.arguments.q}`}]});
    response.writeHead(404);response.end();
  });
});

const app=createServer((request,response)=>{
  cors(request,response);
  if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
  if(request.url==='/install'){
    response.setHeader('Content-Type','text/html;charset=utf-8');
    response.end(html);return;
  }
  if(request.url.endsWith('/models')){
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({data:[{id:'test-model',reasoning:false}]}));return;
  }
  if(request.url.endsWith('/chat/completions')){
    let body='';
    request.on('data',chunk=>body+=chunk);
    request.on('end',()=>{
      const input=JSON.parse(body);
      const title=input.messages.some(item=>['system','developer'].includes(item.role)&&JSON.stringify(item.content).includes('你是会话标题生成器'));
      if(title){
        response.writeHead(200,{'Content-Type':'text/event-stream'});
        response.write('data: '+JSON.stringify({id:'title',object:'chat.completion.chunk',created:1,model:input.model,choices:[{index:0,delta:{role:'assistant',content:'MCP 测试'},finish_reason:null}]})+'\n\n');
        response.end('data: [DONE]\n\n');
        return;
      }
      modelRequests.push(input);
      const answered=input.messages.some(item=>item.role==='tool'||item.role==='toolResult');
      response.writeHead(200,{'Content-Type':'text/event-stream'});
      const chunks=answered
        ? [{delta:{role:'assistant',content:'Tool finished: '+JSON.stringify(input.messages.at(-1).content).slice(0,120)},finish_reason:null},{delta:{},finish_reason:'stop'}]
        : [{delta:{role:'assistant',tool_calls:[{index:0,id:'call_mcp_1',type:'function',function:{name:'mcp__docs__search',arguments:JSON.stringify({q:'pi tab'})}}]},finish_reason:'tool_calls'}];
      for(const choice of chunks)response.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:input.model,choices:[{index:0,...choice}]})+'\n\n');
      response.end('data: [DONE]\n\n');
    });
    return;
  }
  response.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
  response.end(`<title>MCP regression</title><a id="launch" href="${bookmark.replaceAll('&','&amp;').replaceAll('"','&quot;')}">Pi Tab</a>`);
});

await new Promise(resolve=>mcp.listen(0,'127.0.0.1',resolve));
await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${app.address().port}`;
const url=`${base}/`;
const installer=`http://localhost:${app.address().port}/install`;
const mcpUrl=`http://127.0.0.1:${mcp.address().port}/mcp`;

async function browser(...args){
  const {stdout}=await run(agentBrowser,['--headed','false','--executable-path',chrome,'--args','--headless=new,--no-sandbox,--no-proxy-server','--session',session,'--json',...args],{maxBuffer:4*1024*1024});
  const reply=JSON.parse(stdout);
  if(!reply.success)throw new Error(JSON.stringify(reply.error));
  return reply.data;
}
const evaluate=async script=>(await browser('eval','-b',Buffer.from(script).toString('base64'))).result;
const root="document.querySelector('[data-pi-overlay]')?.shadowRoot";
async function click(selector){
  const point=await evaluate(`(()=>{const element=${root}.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'nearest',inline:'nearest'});const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await browser('mouse','move',String(Math.round(point.x)),String(Math.round(point.y)));
  await browser('mouse','down','left');
  await browser('mouse','up','left');
}
async function wait(condition){
  await browser('wait','--fn',condition);
}
async function launch(){
  await browser('click','#launch');
  await wait(`${root}?.getElementById('message-input')?.offsetHeight>0 && ${root}.getElementById('settings').disabled===false`);
}
async function send(text){
  const replies=await evaluate(`${root}.querySelectorAll('.message.ai').length`);
  await click('#message-input');
  await browser('keyboard','inserttext',text);
  await browser('press','Enter');
  await wait(`${root}.querySelectorAll('.message.ai').length>${replies} && ${root}.getElementById('shell').dataset.busy==='false'`);
}

try{
  await browser('open',installer);
  await browser('set','viewport','1440','1000');
  await wait(`${root}?.getElementById('api')?.options.length>0 && document.getElementById('pi-bookmarklet').hasAttribute('href')`);
  await evaluate(`(()=>{const r=${root};r.getElementById('base-url').value=${JSON.stringify(url+'v1')};r.getElementById('api-key').value='test-only';r.getElementById('discover-models').click()})()`);
  await wait(`${root}.getElementById('setup-model-select').value==='test-model'`);
  await click('#start');
  await wait(`${root}.getElementById('chat').style.display==='flex'`);

  await click('#settings');
  await click('#settings-mcp-tab');
  await evaluate(`(()=>{const field=${root}.getElementById('setting-mcp');field.value=${JSON.stringify(JSON.stringify({mcpServers:{docs:{url:mcpUrl,description:'Documentation',headers:{Authorization:'Bearer ${MCP_TOKEN}'}}},env:{MCP_TOKEN:'test-only'}}))};field.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await click('#preferences .form-footer [type=submit]');
  await wait(`${root}.getElementById('mcp-status').textContent.includes('已连接（1 个工具）')`);
  assert.ok(mcpRequests.some(message=>message?.method==='initialize'),'the page completed the MCP handshake');
  assert.ok(mcpRequests.some(message=>message?.method==='tools/list'),'the page listed the MCP tools');
  assert.equal(mcpHeaders.find(headers=>headers.authorization)?.authorization,'Bearer test-only','the configured header is sent');
  console.log('PASS MCP configuration connects a streamable HTTP server and lists its tools');

  await click('#preferences-back');
  await send('Search the docs');
  await wait(`${root}.getElementById('chat-messages').textContent.includes('MCP answered pi tab')`);
  const call=mcpRequests.find(message=>message?.method==='tools/call');
  assert.deepEqual(call.params,{name:'search',arguments:{q:'pi tab'}});
  const offered=JSON.stringify(modelRequests[0].tools);
  assert.ok(offered.includes('mcp__docs__search'),'the model receives the MCP tool declaration');
  assert.ok(!JSON.stringify(modelRequests[0].messages).includes('Search the docs'),'no instruction leak into the transcript');
  console.log('PASS the model calls mcp__docs__search and receives the server result');

  await wait("document.getElementById('pi-bookmarklet').hasAttribute('href')");
  bookmark=await evaluate("document.getElementById('pi-bookmarklet').getAttribute('href')");
  assert.ok(decodeURIComponent(bookmark).includes('importMcpConfig'),'the generated bookmark carries the MCP configuration');

  await browser('open',url);
  await launch();
  const saved=await evaluate('pi.mcpConfig()');
  assert.equal(saved.servers[0].status,'connected');
  assert.equal(saved.servers[0].url,mcpUrl);
  assert.ok(await evaluate("pi.tools().some(tool=>tool.name==='mcp__docs__search')"),'the imported bookmark registers the MCP tool');
  console.log('PASS the bookmark imports the MCP configuration and registers its tools');

  await click('#settings');
  await click('#settings-mcp-tab');
  await evaluate(`(()=>{const field=${root}.getElementById('setting-mcp');field.value='{"mcpServers":{"local":{"command":"npx","args":["-y","server"]}}}';field.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await click('#preferences .form-footer [type=submit]');
  await wait(`${root}.getElementById('mcp-status').textContent.includes('不支持')`);
  assert.equal(await evaluate("pi.tools().some(tool=>tool.name==='mcp__docs__search')"),false,'replaced configuration removes old tools');
  console.log('PASS stdio entries are reported as unsupported instead of failing the whole config');
} finally {
  await browser('close').catch(()=>{});
  await new Promise(resolve=>app.close(resolve));
  await new Promise(resolve=>mcp.close(resolve));
}
