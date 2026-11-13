import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ComposerDrafts} from '../src/composer-drafts.js';

const file={name:'original.txt',size:3,part:{type:'text',text:'original file bytes'}};
const original={text:'  original\n',attachments:[file]};

test('a definite rejection restores exact text and attachments to an empty composer',()=>{
  const drafts=new ComposerDrafts(),token=drafts.begin('A',original);
  drafts.reject(token);
  assert.deepEqual(drafts.current('A'),original);
  assert.deepEqual(drafts.retained('A'),[]);
});

test('new editing and its attachments survive rejection and either draft can be retrieved',()=>{
  const drafts=new ComposerDrafts(),token=drafts.begin('A',original);
  const edited={text:'new draft',attachments:[{...file,name:'new.txt'}]};
  drafts.save('A',edited);drafts.reject(token);
  assert.deepEqual(drafts.current('A'),edited);
  assert.deepEqual(drafts.retained('A')[0].attachments,[file]);
  drafts.restore('A',drafts.retained('A')[0].id);
  assert.deepEqual(drafts.current('A'),original);
  assert.equal(drafts.retained('A')[0].text,'new draft');
  drafts.restore('A',drafts.retained('A')[0].id);
  assert.deepEqual(drafts.current('A'),edited);
  assert.equal(drafts.retained('A')[0].text,original.text);
});

test('a rejected submission belongs to its original ref even while another ref is edited',()=>{
  const drafts=new ComposerDrafts(),token=drafts.begin('A',original);
  drafts.save('A',{text:'another A draft'});drafts.save('B',{text:'B draft'});
  drafts.reject(token);
  assert.equal(drafts.current('A').text,'another A draft');
  assert.equal(drafts.current('B').text,'B draft');
  assert.equal(drafts.retained('A')[0].text,original.text);
  assert.deepEqual(drafts.retained('B'),[]);
});

test('repeated rejections are retained individually and completing a token is idempotent',()=>{
  const drafts=new ComposerDrafts(),first=drafts.begin('A',original),second=drafts.begin('A',{text:'second'});
  drafts.save('A',{text:'latest'});drafts.reject(first);drafts.reject(second);drafts.reject(first);drafts.finish(first);
  assert.deepEqual(drafts.retained('A').map(d=>d.text),[original.text,'second']);
  assert.equal(drafts.current('A').text,'latest');
  assert.equal(drafts.restore('B',drafts.retained('A')[0].id),false);
});

test('accepted or unknown submissions are released without creating resendable drafts',()=>{
  for(const outcome of ['accepted','unknown']){
    const drafts=new ComposerDrafts(),token=drafts.begin('A',original);
    drafts.save('A',{text:'new draft'});drafts.finish(token);drafts.reject(token);
    assert.equal(drafts.current('A').text,'new draft',outcome);
    assert.deepEqual(drafts.retained('A'),[],outcome);
  }
});

test('draft snapshots own their attachment lists independently of later editor mutations',()=>{
  const drafts=new ComposerDrafts(),input={...original,attachments:[file]},token=drafts.begin('A',input);
  input.attachments.length=0;drafts.reject(token);
  const read=drafts.current('A');read.attachments.length=0;
  assert.deepEqual(drafts.current('A'),original);
});

test('attachment-only editing is occupied and successful empty composers stay empty',()=>{
  const drafts=new ComposerDrafts(),token=drafts.begin('A',{text:'',attachments:[file]});
  drafts.save('A',{text:'',attachments:[{...file,name:'later.txt'}]});drafts.reject(token);
  assert.equal(drafts.current('A').attachments[0].name,'later.txt');
  assert.equal(drafts.retained('A')[0].attachments[0].name,'original.txt');
  const accepted=drafts.begin('B',original);drafts.finish(accepted);
  assert.deepEqual(drafts.current('B'),{text:'',attachments:[]});
  assert.deepEqual(drafts.retained('B'),[]);
});
