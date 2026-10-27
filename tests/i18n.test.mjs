import test from 'node:test';
import assert from 'node:assert/strict';
import {createI18n,resolveLanguage} from '../src/i18n.js';
import english from '../src/locales/en.json' with {type:'json'};
import landing from '../src/locales/landing.en.json' with {type:'json'};

test('language matching respects browser order, Chinese variants and explicit override',()=>{
  for(const [languages,expected] of [[['zh-TW','en-US'],'zh-CN'],[['en-GB','zh-CN'],'en'],[['fr','zh-HK'],'zh-CN'],[['ja'],'en'],[[],'en']])assert.equal(resolveLanguage('auto',languages),expected);
  assert.equal(resolveLanguage('en',['zh-CN']),'en');
  assert.equal(resolveLanguage('zh-CN',['en-US']),'zh-CN');
});
test('auto follows language changes while manual choice persists',()=>{
  const saved=[];const locale=createI18n({languages:['zh-CN'],save:value=>saved.push(value)});
  locale.setLanguages(['en']);assert.equal(locale.language,'en');
  locale.setMode('zh-CN');locale.setLanguages(['en-US']);assert.equal(locale.language,'zh-CN');
  locale.setMode('auto');assert.equal(locale.language,'en');assert.deepEqual(saved,['zh-CN','auto']);
  locale.setMode('en',false);assert.equal(saved.length,2);
});
test('switching labels preserves template arguments and unknown data',()=>{
  const locale=createI18n({mode:'en'});
  const value=locale.t('删除会话：{0}','保存中文.txt');
  assert.ok(value.includes('保存中文.txt'));assert.ok(!value.includes('删除会话'));
  assert.equal(locale.t('test-model-测试'),'test-model-测试');
  locale.setMode('zh-CN');assert.equal(locale.t(value),'删除会话：保存中文.txt');
  locale.setMode('en');assert.equal(locale.t('对话 2'),locale.t('对话 {0}',2));
});
test('refresh updates owned live bindings and releases detached nodes',()=>{
  const locale=createI18n({mode:'zh-CN'});const node={isConnected:true,textContent:''};
  locale.text(node,()=>locale.t('保存'));assert.equal(node.textContent,'保存');
  locale.setMode('en');assert.equal(node.textContent,'Save');
  locale.text(node,'User text 保存');locale.setMode('zh-CN');assert.equal(node.textContent,'User text 保存');
  locale.text(node,()=>locale.t('保存'));node.isConnected=false;locale.setMode('en');assert.equal(node.textContent,'保存');
});
test('all catalog entries have English text and matching interpolation parameters',()=>{
  for(const [source,target] of Object.entries({...english,...landing})){
    assert.equal(typeof target,'string',source);assert.ok(target.trim(),source);
    assert.deepEqual([...source.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort(),[...target.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort(),source);
  }
});
