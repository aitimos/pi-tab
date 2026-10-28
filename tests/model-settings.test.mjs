import test from 'node:test';
import assert from 'node:assert/strict';
import {changeModels,savedProviders} from '../src/model-settings.js';
const fixture=()=>{
 const provider={id:'p',api:'openai-completions',baseUrl:'https://old.test/v1',apiKey:'old',providerName:'Work'};
 const profiles=['a','b'].map(id=>({...provider,id,profileId:id,providerId:'p',model:id,headers:{'X-Old':'secret'},compat:{old:true}}));
 return {profiles,providers:[provider],preferences:{systemPrompt:'Keep'},config:profiles[0]};
};
test('provider edits update every linked model in place and discard obsolete connection options',()=>{
 const original=fixture();const {data}=changeModels(original,{action:'update-provider',id:'p',values:{baseUrl:'https://new.test/v1/',apiKey:'new',providerName:'New'}});
 assert.deepEqual(data.profiles.map(p=>p.id),['a','b']);assert.equal(data.providers.length,1);
 for(const p of [...data.profiles,data.config]){assert.equal(p.baseUrl,'https://new.test/v1');assert.equal(p.apiKey,'new');assert.equal(p.headers,undefined);assert.equal(p.compat,undefined);}
 assert.equal(original.profiles[0].apiKey,'old');assert.deepEqual(data.preferences,original.preferences);
});
test('initial setup profiles without provider records are grouped and editable',()=>{
 const original=fixture();original.providers=[];for(const p of original.profiles)delete p.providerId;
 const provider=savedProviders(original)[0];assert.equal(savedProviders(original).length,1);
 const {data}=changeModels(original,{action:'update-provider',id:provider.id,values:{apiKey:'fixed'}});
 assert.ok(data.profiles.every(p=>p.apiKey==='fixed'&&p.providerId===provider.id));
});
test('deleting a provider removes associated models, records import exclusions and preserves preferences',()=>{
 const {data}=changeModels(fixture(),{action:'delete-provider',id:'p'});
 assert.equal(data.config,null);assert.deepEqual(data.profiles,[]);assert.deepEqual(data.providers,[]);
 assert.deepEqual(data.removedProfiles,['a','b']);assert.deepEqual(data.removedProviders,['p']);assert.equal(data.preferences.systemPrompt,'Keep');
});
test('deleting one model keeps its provider and other models; updating retains the profile ID',()=>{
 let {data}=changeModels(fixture(),{action:'delete-model',id:'a'});
 assert.equal(data.providers.length,1);assert.deepEqual(data.profiles.map(p=>p.id),['b']);assert.equal(data.config,null);
 data=changeModels(data,{action:'update-model',id:'b',values:{...data.profiles[0],model:'renamed'}}).data;
 assert.equal(data.profiles[0].id,'b');assert.equal(data.profiles[0].model,'renamed');
});
test('all edits and deletes reject configurations in use without changing storage',()=>{
 for(const action of ['update-model','delete-model','update-provider','delete-provider']){
  const state=fixture(),before=JSON.stringify(state);
  assert.throws(()=>changeModels(state,{action,id:action.endsWith('provider')?'p':'a',values:{}},['a']),/正在运行/);
  assert.equal(JSON.stringify(state),before);
 }
});
test('native OAuth providers only allow display-name changes, not custom endpoints or keys',()=>{
 const state=fixture();state.providers[0].nativeProvider='kimi-coding';for(const p of state.profiles)p.nativeProvider='kimi-coding';
 const {data}=changeModels(state,{action:'update-provider',id:'p',values:{providerName:'Kimi',baseUrl:'https://bad.test',apiKey:'bad'}});
 assert.equal(data.providers[0].baseUrl,state.providers[0].baseUrl);assert.equal(data.profiles[0].apiKey,'old');
});
test('removing the only setup model retains its implicit provider for reuse',()=>{
 const state=fixture();state.providers=[];state.profiles=state.profiles.slice(0,1);delete state.profiles[0].providerId;
 const {data}=changeModels(state,{action:'delete-model',id:'a'});
 assert.equal(data.profiles.length,0);assert.equal(savedProviders(data).length,1);
});
test('changing an endpoint without an explicitly supplied key clears the old key',()=>{
 const {data}=changeModels(fixture(),{action:'update-provider',id:'p',values:{baseUrl:'https://different.test'}});
 assert.ok(data.profiles.every(p=>p.apiKey===''));
});
test('editing or deleting duplicated saved providers does not leave hidden duplicates behind',()=>{
 for(const action of ['update-provider','delete-provider']){
  const state=fixture();state.providers.push({...state.providers[0],id:'duplicate'});
  const {data}=changeModels(state,{action,id:'duplicate',values:{apiKey:'new'}});
  assert.equal(data.providers.length,action==='update-provider'?1:0);
  assert.ok(data.removedProviders.includes('p'));
  if(action==='update-provider')assert.ok(data.profiles.every(p=>p.apiKey==='new'));
 }
});
