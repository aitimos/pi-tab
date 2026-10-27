import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

test('extension shares one site engine across paths and tabs, routes tasks and page tools', async () => {
  const session=new Map();
  const tabs=new Map([
    [10,{id:10,url:'https://www.example.com/a?from=1',title:'One'}],
    [11,{id:11,url:'https://www.example.com/b?from=2',title:'Two'}],
    [12,{id:12,url:'https://other.example/',title:'Other'}],
  ]);
  const engineCalls=[];
  const pageCalls=[];
  const badges=[];
  const titles=[];
  const injected=[];
  let missingReceiver=false;
  let startupError;
  let onMessage,onClick,engineOpened=false;
  const chrome={
    action:{onClicked:{addListener:listener=>{onClick=listener;}},setBadgeText:async value=>badges.push(value),setTitle:async value=>titles.push(value)},
    scripting:{executeScript:async request=>{injected.push(request);missingReceiver=false;}},
    tabs:{
      onRemoved:{addListener(){}},onUpdated:{addListener(){}},
      query:async()=>[...tabs.values()],get:async id=>tabs.get(id),
      create:async({url})=>{const tab={id:13,url,title:'New'};tabs.set(tab.id,tab);return tab;},
      sendMessage:async(id,message)=>{
        pageCalls.push({id,message});
        if(missingReceiver)throw new Error('Could not establish connection. Receiving end does not exist.');
        if(startupError&&message.type==='activate')return {ok:false,error:startupError};
        if(message.type==='execute-tool')return {ok:true,value:{output:[{type:'text',text:'page result'}]}};
        return {ok:true,value:{active:true}};
      },
    },
    offscreen:{hasDocument:async()=>engineOpened,createDocument:async()=>{engineOpened=true;}},
    runtime:{
      onMessage:{addListener:listener=>{onMessage=listener;}},
      sendMessage:async message=>{
        engineCalls.push(message);
        if(message.method==='listChats')return {ok:true,value:[{id:1,title:'Shared'}]};
        if(message.method==='readAgent')return {ok:true,value:[{kind:'pi.assistant',text:'完成'}]};
        if(message.method==='receiveFromTab')return {ok:true,value:{queued:true}};
        return {ok:true,value:{activeId:1}};
      },
    },
    storage:{session:{
      get:async key=>({[key]:session.get(key)}),
      set:async values=>{for(const [key,value]of Object.entries(values))session.set(key,value);},
      remove:async key=>session.delete(key),
    }},
  };
  vm.runInNewContext(await readFile('src/extension-worker.js','utf8'),{chrome,URL,Promise,setTimeout,console:{error(){}}});
  const send=(message,from=10)=>new Promise(resolve=>onMessage(message,{tab:tabs.get(from)},resolve));

  assert.equal((await send({type:'identity'})).value.active,false);
  await onClick(tabs.get(10));
  assert.equal(pageCalls.at(-1).message.openWindow,true);
  await onClick(tabs.get(11));
  await onClick(tabs.get(12));
  const first=(await send({type:'identity'})).value;
  const second=(await send({type:'identity'},11)).value;
  assert.equal(first.site,'www.example.com');
  assert.equal(second.site,first.site);
  assert.notEqual(second.tabId,first.tabId);
  await send({type:'engine-call',method:'initialize'});
  await send({type:'engine-call',method:'initialize'},11);
  assert.equal(engineCalls.at(-1).site,engineCalls.at(-2).site);
  assert.equal(engineCalls.at(-1).tabId,11);
  assert.equal((await send({type:'tabs-list'})).value.tabs.length,3);
  assert.equal((await send({type:'tabs-open',url:'https://new.example/'})).value.tabId,13);
  assert.equal((await send({type:'tabs-open',url:'javascript:alert(1)'})).ok,false);
  assert.equal((await send({type:'tabs-send',tabId:11,chatId:1,text:'检查页面',fromChatId:5})).value.queued,true);
  assert.equal(engineCalls.at(-1).method,'receiveFromTab');
  assert.equal(engineCalls.at(-1).site,'www.example.com');
  assert.equal((await send({type:'tabs-read',tabId:11,chatId:1,limit:3})).value[0].text,'完成');
  assert.equal((await send({type:'page-tool',site:'www.example.com',tabId:11,name:'page_snapshot',args:{}})).value.output[0].text,'page result');
  assert.equal(pageCalls.at(-1).id,11);
  missingReceiver=true;
  await onClick(tabs.get(10));
  assert.equal(injected.length,1);
  assert.equal(injected[0].target.tabId,10);
  assert.equal(injected[0].files[0],'content.js');
  assert.equal(badges.at(-1).text,'');
  startupError='模型目录加载失败';
  await onClick(tabs.get(10));
  assert.equal(badges.at(-1).text,'!');
  assert.match(titles.at(-1).title,/模型目录加载失败/);
  startupError=null;
  await onClick(tabs.get(10));
  assert.equal(badges.at(-1).text,'');
  await onClick({id:99,url:'chrome://extensions/'});
  assert.match(titles.at(-1).title,/只能在普通网页使用/);
  assert.equal(session.has('active:99'),false);
});
