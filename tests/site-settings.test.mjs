import test from 'node:test';
import assert from 'node:assert/strict';
import {SiteSettings} from '../src/site-settings.js';
const storage = () => {
  const items = new Map();
  return {getItem:key=>items.get(key)??null,setItem:(key,value)=>items.set(key,value)};
};
test('independent tabs share settings without losing another tab’s changes', () => {
  const origin=storage(), a=new SiteSettings(origin,'site'), b=new SiteSettings(origin,'site');
  a.initialize();
  a.update(data=>{data.preferences.systemPrompt='Site prompt';});
  b.update(data=>{data.profiles.push({id:'model-1',apiKey:'test-only'});});
  a.update(data=>{data.providers.push({id:'provider-1'});});
  assert.equal(b.read().preferences.systemPrompt,'Site prompt');
  assert.equal(a.read().profiles[0].apiKey,'test-only');
  assert.equal(b.read().providers.length,1);
  assert.equal(new SiteSettings(storage(),'site').read().profiles.length,0);
});
test('existing settings are imported once and stale session data cannot overwrite them', () => {
  const origin=storage(), a=new SiteSettings(origin,'site');
  a.initialize({preferences:{systemPrompt:'Previous prompt'},profiles:[{id:'old'}]});
  a.update(data=>{data.preferences.systemPrompt='New prompt';});
  const reopened=new SiteSettings(origin,'site');
  reopened.initialize({preferences:{systemPrompt:'Stale prompt'},profiles:[]});
  assert.equal(reopened.read().preferences.systemPrompt,'New prompt');
  assert.equal(reopened.read().profiles.length,1);
  assert.equal(new SiteSettings(origin,'other-extension-site').read().profiles.length,0);
});
