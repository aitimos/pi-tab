import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateConversationTitle} from '../src/conversation-title.js';

const user = text => ({kind:'pi.user',model:[{role:'user',content:[{type:'text',text}]}]});
const answer = content => ({kind:'pi.assistant',model:[{role:'assistant',stopReason:'stop',content}]});
test('title generation uses the first exchange without tools, thoughts or image bytes',async()=>{
  const entries=[
    {kind:'pi.user',model:[{role:'user',content:[{type:'text',text:'分析页面卡顿'},{type:'image',data:'PRIVATE_IMAGE_BYTES'}]}]},
    {kind:'tool',model:[{role:'toolResult',content:[{type:'text',text:'PRIVATE_TOOL_DATA'}]}]},
    answer([{type:'thinking',thinking:'PRIVATE_THOUGHT'},{type:'text',text:'图片资源加载过慢'}]),
    user('SECOND_TURN'),answer([{type:'text',text:'SECOND_REPLY'}]),
  ];
  const model={id:'configured-model'};
  const title=await generateConversationTitle({completeSimple:async(received,context,options)=>{
    assert.equal(received,model);
    assert.match(context.messages[0].content,/分析页面卡顿/);
    assert.match(context.messages[0].content,/图片资源加载过慢/);
    assert.doesNotMatch(JSON.stringify(context),/PRIVATE_|SECOND_TURN/);
    assert.equal(context.tools,undefined);
    assert.equal(options.maxTokens,1024);
    assert.ok(options.signal instanceof AbortSignal);
    return {stopReason:'stop',content:[{type:'thinking',thinking:'IGNORE'},{type:'text',text:'标题：“页面卡顿排查”。\n额外解释'}]};
  }},model,entries);
  assert.equal(title,'页面卡顿排查');
});
test('title generation waits for a final answer and bounds conversation input and output',async()=>{
  const models={completeSimple:async(_model,context)=>{
    assert.ok(context.messages[0].content.length<8300);
    return {stopReason:'stop',content:[{type:'text',text:'🌟'.repeat(40)}]};
  }};
  assert.equal(await generateConversationTitle(models,{},[user('hello')]),null);
  assert.equal(await generateConversationTitle(models,{},[user('hello'),{kind:'pi.assistant',model:[{role:'assistant',stopReason:'aborted',content:[{type:'text',text:'unfinished'}]}]}]),null);
  assert.equal([...await generateConversationTitle(models,{},[user('a'.repeat(12000)),answer([{type:'text',text:'b'.repeat(12000)}])])].length,30);
});
test('failed or empty title responses are rejected rather than saved as titles',async()=>{
  const entries=[user('hello'),answer([{type:'text',text:'你好'}])];
  for(const response of [{stopReason:'error',errorMessage:'unauthorized',content:[]},{stopReason:'stop',content:[{type:'thinking',thinking:'not final text'}]}]){
    await assert.rejects(generateConversationTitle({completeSimple:async()=>response},{},entries));
  }
});

test('an interrupted opening exchange does not prevent naming the next completed exchange',async()=>{
  const entries=[user('Abandoned task'),{kind:'pi.assistant',model:[{role:'assistant',stopReason:'aborted',content:[]}]},user('整理页面表格'),answer([{type:'text',text:'已整理为 CSV'}])];
  const title=await generateConversationTitle({completeSimple:async(_model,context)=>{
    assert.doesNotMatch(context.messages[0].content,/Abandoned/);
    assert.match(context.messages[0].content,/整理页面表格/);
    return {stopReason:'stop',content:[{type:'text',text:'页面表格整理'}]};
  }},{},entries);
  assert.equal(title,'页面表格整理');
});

test('stopping a conversation cancels its title request and interrupted runs do not start one',async()=>{
  const controller=new AbortController();
  const entries=[user('hello'),answer([{type:'text',text:'Hello'}])];
  const pending=generateConversationTitle({completeSimple:async(_model,_context,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason)))},{},entries,controller.signal);
  controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(await generateConversationTitle({completeSimple:()=>{throw Error('must not run');}},{},[...entries,user('second'),{kind:'pi.assistant',model:[{role:'assistant',stopReason:'aborted',content:[]}]}]),null);
});
