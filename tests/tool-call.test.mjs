import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Type} from 'typebox';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {callTool} from '../src/tool-call.js';

test('direct tool calls retain streamed tail, structured result and diagnostics',async()=>{
  const result=await callTool({name:'bash',parameters:Type.Object({}),outputLimits:{maxBytes:8,maxLines:2,retain:'tail'},execute:async(args,api)=>{
    api.output('one\ntwo\nthree\n');
    api.diagnostic({severity:'info',message:'Full output: /tmp/out'});
    return {structuredOutput:{output:api.retainedOutput().text,truncated:api.retainedOutput().truncated,exitCode:7},isError:true};
  }},{},{},BACKGROUND_CONTEXT);
  assert.equal(result.isError,true);
  assert.equal(result.structuredOutput.truncated,true);
  assert.equal(result.output[0].text,'three\n');
  assert.ok(result.diagnostics.some(item=>item.message.includes('/tmp/out')));
});

test('direct tool failure keeps output already produced',async()=>{
  const result=await callTool({name:'bash',parameters:Type.Object({}),execute:async(args,api)=>{api.output('before timeout');throw Error('timed out');}},{},{},BACKGROUND_CONTEXT);
  assert.equal(result.isError,true);
  assert.equal(result.output[0].text,'before timeout');
  assert.equal(result.diagnostics[0].message,'timed out');
});

test('direct tools preserve image blocks and edit details without stringifying them',async()=>{
  const image={type:'image',mimeType:'image/png',data:'aGVsbG8='};
  const details={diff:'-before\n+after',patch:'patch'};
  const result=await callTool({name:'read',parameters:Type.Object({}),execute:async()=>({output:[image],details})},{},{},BACKGROUND_CONTEXT);
  assert.deepEqual(result.output,[image]);assert.deepEqual(result.details,details);
});
