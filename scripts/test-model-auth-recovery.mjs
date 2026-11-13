import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chromium,expect} from 'playwright/test';

const directory=process.env.PI_TAB_AUTH_EVIDENCE||await mkdtemp(join(tmpdir(),'pi-tab-auth-recovery-'));
await mkdir(directory,{recursive:true});
const html=await readFile(process.env.PI_TAB_AUTH_HTML||'pi-bookmarklet-chat-install.html','utf8');
// CI always uses the local fixture. Real services require explicit environment
// variables; credentials are never included in screenshots or evidence files.
const live=Boolean(process.env.PI_TAB_AUTH_BASE_URL);
if(live&&!process.env.PI_TAB_AUTH_API_KEY)throw Error('PI_TAB_AUTH_API_KEY is required with PI_TAB_AUTH_BASE_URL');
const model=process.env.PI_TAB_AUTH_MODEL||'deepseek-chat';
const requests=[];
let titleRequests=0,cancelledTitles=0;
const server=createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers',req.headers['access-control-request-headers']||'*');
  if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
  if(req.url==='/install'){res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);return;}
  if(req.url.endsWith('/models')){
    res.setHeader('Content-Type','application/json');
    if(req.headers.authorization!=='Bearer corrected-test-key'){res.writeHead(401).end(JSON.stringify({error:{message:'Invalid API key'}}));return;}
    res.end(JSON.stringify({data:[{id:model}]}));return;
  }
  if(req.url.endsWith('/chat/completions')){
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      const input=JSON.parse(body),valid=req.headers.authorization==='Bearer corrected-test-key';
      requests.push({valid,model:input.model});
      if(!valid){res.writeHead(401,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message:'Authentication Fails, Invalid API key',type:'authentication_error',code:'invalid_api_key'}}));return;}
      // Keep the cosmetic background request pending after the visible task ends.
      if(JSON.stringify(input.messages).includes('你是会话标题生成器')){titleRequests++;res.on('close',()=>cancelledTitles++);return;}
      res.writeHead(200,{'Content-Type':'text/event-stream'}).end('data: '+JSON.stringify({id:'recovered',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'AUTH_RECOVERY_OK'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    });return;
  }
  res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><title>Bookmark auth recovery</title><h1>Auth recovery test</h1><a id="launch">Pi Tab</a>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const endpoint=process.env.PI_TAB_AUTH_BASE_URL||base+'/v1';
const correctedKey=live?process.env.PI_TAB_AUTH_API_KEY:'corrected-test-key';
let browser,page;
const checks=[];
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PI_TAB_TEST_CHROME||chromium.executablePath(),args:['--no-sandbox','--no-proxy-server']});
  const context=await browser.newContext({locale:'en',viewport:{width:1280,height:1000}});
  await context.addInitScript(()=>{localStorage.setItem('pi-tab-language','en');localStorage.setItem('pi-tab-size',JSON.stringify({width:560,height:800}));});
  const installer=await context.newPage();
  await installer.goto(base.replace('127.0.0.1','localhost')+'/install');
  const setup=installer.locator('[data-pi-overlay]');
  await setup.locator('#settings:enabled').waitFor();
  await setup.locator('#base-url').fill(endpoint);
  await setup.locator('#api-key').fill('invalid-initial-key');
  if(await setup.locator('#manual-model').isVisible())await setup.locator('#manual-model').click();
  await setup.locator('#model').fill(model);
  await setup.locator('#start').click();
  await expect(setup.locator('#chat')).toBeVisible();
  await expect(installer.locator('#pi-bookmarklet')).toHaveAttribute('href',/^javascript:/);
  const bookmark=await installer.locator('#pi-bookmarklet').getAttribute('href');
  page=await context.newPage();
  page.on('pageerror',e=>console.log('PAGE ERROR '+e.message.replaceAll(correctedKey,'[REDACTED]')));
  await page.goto(base+'/page');
  await page.locator('#launch').evaluate((node,url)=>node.href=url,bookmark);
  await page.locator('#launch').click();
  const root=page.locator('[data-pi-overlay]').last(),ui=selector=>root.locator(selector);
  const shot=async name=>root.screenshot({path:join(directory,name+'.png'),animations:'disabled'});
  await expect(ui('#chat')).toBeVisible();
  await ui('#message-input').fill('Reply with AUTH_RECOVERY_OK only.');await ui('#send').click();
  await expect(ui('#chat-messages')).toContainText(/401|Invalid API key|Authentication Fails/,{timeout:60000});
  await expect(ui('#abort')).toBeHidden({timeout:20000});
  await shot('01-invalid-key');
  console.log('PASS initial authentication fails and the task becomes idle');
  await ui('#settings').click();await ui('#settings-models-tab').click();
  // Editing and deleting must remain available while the saved key is invalid.
  await ui('[data-model-id] button').first().click();
  await expect(ui('#manual-model-form [type=submit]')).toBeEnabled();
  await ui('#manual-model-form [type=submit]').click();
  await expect(ui('#model-dialog')).toBeHidden();
  await ui('[data-model-id] button').last().click();await ui('.manager-confirm button').last().click();
  await expect(ui('[data-model-id]')).toHaveCount(0);
  await ui('#settings-model-add').click();
  await ui('#manual-model-id').fill(model);await ui('#manual-model-form [type=submit]').click();
  await expect(ui('#chat')).toBeVisible();
  await ui('#message-input').fill('Check the saved credential again.');await ui('#send').click();
  await expect(ui('#chat-messages')).toContainText(/401|Invalid API key|Authentication Fails/,{timeout:60000});
  await expect(ui('#abort')).toBeHidden({timeout:20000});
  console.log('PASS edit, delete and re-add a model while its provider key is invalid');
  await ui('#settings').click();await ui('#settings-models-tab').click();
  await ui('.manager-group>.manager-row:first-child button').first().click();
  await ui('#provider-key').fill(correctedKey);
  await ui('#provider-form [type=submit]').click();
  await expect(ui('#model-dialog')).toBeHidden();
  await shot('02-corrected-provider');
  await ui('#preferences-back').click();
  await ui('#message-input').fill('Reply with AUTH_RECOVERY_OK only.');await ui('#send').click();
  await expect(ui('.message.ai').last()).toContainText('AUTH_RECOVERY_OK',{timeout:60000});
  await expect(ui('#abort')).toBeHidden({timeout:20000});
  if(!live)await expect.poll(()=>titleRequests).toBeGreaterThan(0);
  await shot('03-recovered');
  checks.push('exported bookmark: initial 401 → provider key edit → same conversation request succeeds');
  console.log('PASS '+checks.at(-1));
  await ui('#settings').click();await ui('#settings-models-tab').click();
  const modelRow=ui('[data-model-id]').first();
  await modelRow.locator('button').first().click();
  await expect(ui('#manual-model-form [type=submit]')).toBeEnabled();
  await ui('#manual-model-vision').check();
  await ui('#manual-model-form [type=submit]').click();
  await expect(ui('#model-dialog')).toBeHidden();
  if(!live)await expect.poll(()=>cancelledTitles).toBeGreaterThan(0);
  await shot('04-edit-with-pending-title');
  console.log('PASS model editing after authentication recovery');
  await ui('#preferences-back').click();
  const replies=await ui('.message.ai').count();
  await ui('#message-input').fill('Continue with the updated model.');await ui('#send').click();
  await expect.poll(()=>ui('.message.ai').count(),{timeout:60000}).toBeGreaterThan(replies);
  await expect(ui('#abort')).toBeHidden({timeout:20000});
  if(!live)await expect.poll(()=>titleRequests).toBeGreaterThan(1);
  await ui('#settings').click();await ui('#settings-models-tab').click();
  await ui('.manager-group>.manager-row:first-child button').last().click();await ui('.manager-confirm button').last().click();
  await expect(ui('.manager-group')).toHaveCount(0);
  if(!live)await expect.poll(()=>cancelledTitles).toBeGreaterThan(1);
  await shot('05-delete-with-pending-title');
  console.log('PASS model and provider deletion');
  await ui('#settings-model-add').click();await ui('#manual-add-provider').click();
  await ui('#provider-api').selectOption('openai-completions');await ui('#provider-auth').selectOption('api_key');
  await ui('#provider-url').fill(endpoint);await ui('#provider-key').fill(correctedKey);
  await ui('#provider-form [type=submit]').click();
  await ui('#manual-model-id').fill(model);await ui('#manual-model-form [type=submit]').click();
  await expect(ui('#chat')).toBeVisible();
  await page.reload();await page.locator('#launch').evaluate((node,url)=>node.href=url,bookmark);await page.locator('#launch').click();
  await expect(ui('#chat')).toBeVisible();
  const restored=await page.evaluate(()=>pi.savedProfiles());
  assert.equal(restored.length,1);assert.ok(restored[0].apiKey===correctedKey,'the corrected credential is retained');
  console.log('PASS new provider/model and reloading the original bookmark retain the corrected key');
  checks.push('invalid-key model edit/delete/add; provider edit/delete/add; original bookmark reload preserves edited data and deletions');
}catch(error){
  if(page){
    await page.locator('[data-pi-overlay]').last().screenshot({path:join(directory,'failure.png'),animations:'disabled'}).catch(()=>{});
    console.log('Visible error: '+(await page.locator('[data-pi-overlay]').last().locator('#manual-model-error').textContent().catch(()=>''))?.replaceAll(correctedKey,'[REDACTED]'));
  }
  throw error;
}finally{
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await writeFile(join(directory,'result.json'),JSON.stringify({commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),htmlHash:createHash('sha256').update(html).digest('hex'),live,checks,requests,titleRequests,cancelledTitles},null,2));
  console.log('Evidence: '+directory);
}
