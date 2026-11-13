import {fileURLToPath} from 'node:url';

// Use the version in package-lock.json even when a different CLI is on PATH.
export const agentBrowser = fileURLToPath(new URL('../node_modules/.bin/agent-browser', import.meta.url));

// Exercise real user input. RPC helpers must never manufacture a page lease.
export async function sendFromOverlay(browser,evaluate,text,{chatId,wait=true}={}){
  const root="[...document.querySelectorAll('[data-pi-overlay]')].find(host=>host.getClientRects().length>0).shadowRoot";
  await browser('wait','--fn',`!!(${root})?.getElementById('message-input')?.getClientRects().length`);
  if(chatId!==undefined){
    await evaluate(`(${root}).getElementById('chat-switch').click()`);
    const row=`(${root}).querySelector('[data-chat-id="'+encodeURIComponent(JSON.stringify(['127.0.0.1',${JSON.stringify(chatId)}]))+'"] .chat-select')`;
    await browser('wait','--fn',`!!${row}`);await evaluate(`${row}.click()`);
    try{await browser('wait','--fn',`(${root}).getElementById('chat-list').dataset.open!=='true'`);}catch(error){throw Error('Selecting chat '+chatId+' failed: '+JSON.stringify(await evaluate(`(()=>{const r=(${root});return {menu:r.getElementById('chat-list').textContent,setup:r.getElementById('setup-error').textContent,status:r.getElementById('status').textContent}})()`)),{cause:error});}
  }
  await evaluate(`(()=>{const input=(${root}).getElementById('message-input');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await browser('wait','--fn',`!(${root}).getElementById('send').disabled`);
  const point=await evaluate(`(()=>{const r=(${root}).getElementById('send').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await browser('mouse','move',String(Math.round(point.x)),String(Math.round(point.y)));
  await browser('mouse','down','left');await browser('mouse','up','left');
  if(wait)await browser('wait','--fn',`(${root}).getElementById('abort').hidden`);
}
