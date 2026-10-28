import test from 'node:test';
import assert from 'node:assert/strict';
import {builtinProviders} from '@earendil-works/pi-ai/providers/all';
import {authenticationForApi,browserOAuthProviders} from '../src/browser-auth.js';
const providers=builtinProviders();
test('API authentication choices follow Pi provider capabilities and browser-supported flows',()=>{
 for(const api of new Set(providers.flatMap(p=>p.getModels().map(m=>m.api)))){
  const methods=authenticationForApi(providers,api);
  const native=providers.filter(p=>p.getModels().some(m=>m.api===api));
  assert.equal(methods.some(m=>m.id==='api_key'),native.some(p=>!!p.auth?.apiKey));
  assert.deepEqual(methods.filter(m=>!['api_key','none'].includes(m.id)).map(m=>m.id),native.filter(p=>p.auth?.oauth && browserOAuthProviders.includes(p.id)).map(p=>p.id));
 }
 assert.deepEqual(authenticationForApi(providers,'openai-codex-responses').map(m=>m.id),['openai-codex']);
 assert.ok(!authenticationForApi(providers,'google-generative-ai').some(m=>m.id==='anthropic'));
 assert.ok(authenticationForApi(providers,'openai-completions').some(m=>m.id==='kimi-coding'));
 assert.ok(authenticationForApi(providers,'anthropic-messages').some(m=>m.id==='github-copilot'));
});
