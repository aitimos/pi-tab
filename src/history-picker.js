import {refKey} from './conversation-ref.js';
import {createI18n} from './i18n.js';
const saved=await chrome.storage.local.get('pi-tab-language');
const locale=createI18n({mode:saved['pi-tab-language']||'auto',languages:await chrome.i18n.getAcceptLanguages()}),t=(...args)=>locale.t(...args);
const grant=location.hash.slice(1),byId=id=>document.getElementById(id);
const request=async(type,extra={})=>{
  const response=await chrome.runtime.sendMessage({type,grant,...extra});
  if(!response?.ok)throw Error(response?.error||'PICKER_EXPIRED');
  return response.value;
};
byId('rebuild').textContent=t('重建目录');
byId('heading').textContent=t('历史对话');byId('close').textContent=t('关闭');byId('refresh').textContent=t('刷新目录');
byId('help').textContent=t('选择后仅查看历史。点击“在当前页继续”才会切换执行页面。');
byId('search').placeholder=t('搜索标题或来源站点');byId('search').setAttribute('aria-label',t('搜索标题或来源站点'));byId('more').textContent=t('加载更多');
let cursor=null,rows=[];
function render(){
  const search=byId('search').value.toLowerCase();
  byId('rows').replaceChildren();
  for(const row of rows.filter(item=>(item.title+' '+item.ref.ownerSite).toLowerCase().includes(search))){
    const li=document.createElement('li'),button=document.createElement('button'),small=document.createElement('small');
    button.type='button';button.dataset.ref=encodeURIComponent(refKey(row.ref));button.textContent=row.title;small.textContent=row.ref.ownerSite+' · '+t('对话 {0}',row.ref.conversationId);button.append(small);
    button.onclick=event=>{if(event.isTrusted)void choose(row.ref);};li.append(button);byId('rows').append(li);
  }
}
async function choose(ref){try{await request('picker-select',{ref});}catch(error){byId('error').textContent=t(error.message);}}
async function load(refresh=false,reset=false){
  try{
    byId('error').textContent='';const page=await request('picker-list',{cursor:refresh?null:cursor,refresh,reset});
    rows=refresh?page.rows:[...rows,...page.rows];cursor=page.nextCursor;byId('more').hidden=!cursor;render();
    if(page.sourceErrors.length)byId('error').textContent=t('部分站点的历史暂不可用，可稍后刷新目录。');
  }catch(error){byId('error').textContent=t(error.message);byId('rebuild').hidden=false;}
}
byId('search').oninput=render;byId('more').onclick=event=>{if(event.isTrusted)void load();};
byId('rebuild').onclick=event=>{if(event.isTrusted)void load(true,true);};
byId('refresh').onclick=event=>{if(event.isTrusted)void load(true);};
byId('close').onclick=event=>{if(event.isTrusted)void request('picker-close');};
document.addEventListener('keydown',event=>{if(event.isTrusted&&event.key==='Escape')void request('picker-close');});
await load();byId('search').focus();
