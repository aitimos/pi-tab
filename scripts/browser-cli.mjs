import {fileURLToPath} from 'node:url';

// Use the version in package-lock.json even when a different CLI is on PATH.
export const agentBrowser = fileURLToPath(new URL('../node_modules/.bin/agent-browser', import.meta.url));

// Exercise real user input. RPC helpers must never manufacture a page lease.
export async function sendFromOverlay(browser,evaluate,text,{chatId,wait=true}={}){
  const root="[...document.querySelectorAll('[data-pi-overlay]')].find(host=>host.getClientRects().length>0).shadowRoot";
  await browser('wait','--fn',`!!(${root})?.getElementById('message-input')?.getClientRects().length`);
  if(chatId!==undefined){
    await evaluate(`(()=>{const r=(${root});if(r.getElementById('chat-list').dataset.open!=='true')r.getElementById('chat-switch').click();})()`);
    const row=`(${root}).querySelector('[data-chat-id="'+encodeURIComponent(JSON.stringify(['127.0.0.1',${JSON.stringify(chatId)}]))+'"] .chat-select')`;
    await browser('wait','--fn',`!!${row}`);await evaluate(`${row}.click()`);
    try{await browser('wait','--fn',`(${root}).getElementById('chat-list').dataset.open!=='true'`);}catch(error){throw Error('Selecting chat '+chatId+' failed: '+JSON.stringify(await evaluate(`(()=>{const r=(${root});return {menu:r.getElementById('chat-list').textContent,setup:r.getElementById('setup-error').textContent,status:r.getElementById('status').textContent}})()`)),{cause:error});}
  }
  await evaluate(`(()=>{const input=(${root}).getElementById('message-input');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await browser('wait','--fn',`!(${root}).getElementById('send').disabled`);
  // Spawned agents can cover this window. Focus this window's native button
  // and use a trusted key so coordinates cannot activate a different overlay.
  await evaluate(`(${root}).getElementById('send').focus({preventScroll:true})`);
  await browser('wait','--fn',`(${root}).activeElement?.id==='send'`);
  await browser('press','Enter');
  await browser('wait','--fn',`(${root}).getElementById('message-input').value===''`);
  if(wait)await browser('wait','--fn',`(${root}).getElementById('abort').hidden`);
}
