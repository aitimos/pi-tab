import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUserContent, userContentText, editUserContent } from '../src/message-content.js';

const image = {type:'image',mimeType:'image/png',data:'aGVsbG8='};
const content = [{type:'text',text:'看一下附件'}, {type:'text',text:'文件：notes.txt\n测试正文'},image];
test('native attachments retain their contents and reject images on text-only models', () => {
  assert.deepEqual(normalizeUserContent(content,{input:['text','image']}),content);
  assert.throws(() => normalizeUserContent(content,{input:['text']}),/不支持图片/);
  assert.equal(normalizeUserContent('普通消息',{input:['text']}),'普通消息');
  assert.throws(() => normalizeUserContent([{type:'file'}],{input:['text']}),/格式/);
  assert.throws(() => normalizeUserContent('',{input:['text']}),/内容/);
});
test('editing queued text preserves every file and image', () => {
  assert.equal(userContentText(content),'看一下附件');
  const edited = editUserContent(content,'改成新的要求');
  assert.equal(edited[0].text,'改成新的要求');
  assert.deepEqual(edited.slice(1),content.slice(1));
  assert.equal(content[0].text,'看一下附件');
  assert.deepEqual(editUserContent([image],'描述图片'),[{type:'text',text:'描述图片'},image]);
});
