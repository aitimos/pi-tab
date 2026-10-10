import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';

const safeKeys = ['name','reasoning','thinkingLevelMap','input','contextWindow','maxTokens','compat','samplingParams','cost'];
export function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请先选择接口地址，或填写完整的 HTTP(S) 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('接口地址须为 HTTP(S) 地址，不能包含账号密码、查询参数或 #。');
  return url.href.replace(/\/+$/, '');
}
export function createModelConfig({ models:catalog = [], apis = [] } = {}) {
  function describe({ api, baseUrl, model, modelInfo = {}, reasoning, thinking = 'off' }) {
    const matches = catalog.filter(item => item.id === model || item.id === model?.split('/').at(-1));
    matches.sort((a,b) => Number(b.api === api) - Number(a.api === api) || Number(b.baseUrl === baseUrl) - Number(a.baseUrl === baseUrl));
    const ref = matches[0];
    const info = { id:model, name:model, api, baseUrl, reasoning:false, input:['text'], contextWindow:128000, maxTokens:16384, cost:{input:0,output:0,cacheRead:0,cacheWrite:0} };
    for (const source of [ref, modelInfo]) if (source) for (const key of safeKeys) {
      if (source[key] !== undefined && (key !== 'compat' || !source.api || source.api === api)) info[key] = source[key];
    }
    if (reasoning !== undefined) info.reasoning = reasoning;
    info.thinkingLevels = getSupportedThinkingLevels(info);
    info.thinking = clampThinkingLevel(info, thinking);
    return info;
  }
  function fallback(api, baseUrl) {
    const host = new URL(baseUrl).hostname;
    return catalog.filter(item => item.api === api && (() => { try { return new URL(item.baseUrl).hostname === host; } catch { return false; } })());
  }
  async function discover(config, { fetch:request = globalThis.fetch, signal } = {}) {
    const { api, apiKey = '' } = config;
    if (!apis.some(item => item.id === api)) throw new Error('未知接口类型。');
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const headers = { Accept:'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let endpoint = `${baseUrl}/models`, kind = 'openai';
    if (new URL(baseUrl).port === '11434') { endpoint = `${baseUrl.replace(/\/v1$/, '')}/api/tags`; kind = 'ollama'; }
    else if (api === 'anthropic-messages') {
      endpoint = `${baseUrl.replace(/\/v1$/, '')}/v1/models?limit=1000`; kind = 'anthropic';
      delete headers.Authorization; headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01'; headers['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if (api === 'google-generative-ai') {
      endpoint = `${/\/v1(beta)?$/.test(baseUrl) ? baseUrl : baseUrl + '/v1beta'}/models?pageSize=1000`; kind = 'google';
      delete headers.Authorization; headers['x-goog-api-key'] = apiKey;
    } else if (api === 'google-vertex') {
      endpoint = `${baseUrl.replace(/\/v1$/, '')}/v1/publishers/google/models`; kind = 'google';
      delete headers.Authorization; headers['x-goog-api-key'] = apiKey;
    } else if (api === 'azure-openai-responses') {
      endpoint += '?api-version=v1'; delete headers.Authorization; headers['api-key'] = apiKey;
    } else if (api === 'openai-codex-responses') {
      endpoint = `${baseUrl.replace(/\/responses$/, '').replace(/\/codex$/, '')}/codex/models?client_version=0.144.1`; kind = 'codex';
      try { const claims = JSON.parse(atob(apiKey.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); const id=claims['https://api.openai.com/auth']?.chatgpt_account_id; if (id) headers['ChatGPT-Account-Id']=id; } catch {}
    }
    const timeout = AbortSignal.timeout(15000);
    const combined = signal ? AbortSignal.any([signal,timeout]) : timeout;
    const found = new Map();
    try {
      if (api === 'bedrock-converse-stream') throw new Error('Bedrock 模型使用内置目录，请按账号权限选择。');
      for (let page=0; page<20; page++) {
        const response = await request(endpoint, { headers, signal:combined, redirect:'error' });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? '认证失败，请检查密钥或令牌。' : `模型列表请求失败（HTTP ${response.status}）。`);
        const payload = await response.json();
        const rows = payload.data ?? payload.models ?? payload.publisherModels;
        if (!Array.isArray(rows)) throw new Error('服务返回的模型列表格式无法识别。');
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue;
          if (kind==='google' && row.supportedGenerationMethods && !row.supportedGenerationMethods.includes('generateContent')) continue;
          const rawId = kind==='google' ? row.name?.split('/').at(-1) : row.id || row.slug || row.model || row.name;
          if (typeof rawId !== 'string' || !rawId.trim()) continue;
          const id=rawId.trim(), native={};
          const reasoning=row.capabilities?.thinking?.supported ?? row.reasoning ?? row.thinking;
          if (typeof reasoning==='boolean') native.reasoning=reasoning;
          if (row.display_name || row.displayName || row.name && kind!=='google') native.name=row.display_name || row.displayName || row.name;
          const context=row.max_input_tokens || row.inputTokenLimit || row.context_window || row.context_length;
          const output=row.max_tokens || row.outputTokenLimit || row.max_completion_tokens;
          if (Number.isFinite(context) && context>0) native.contextWindow=context;
          if (Number.isFinite(output) && output>0) native.maxTokens=output;
          found.set(id, { ...describe({api,baseUrl,model:id,modelInfo:native}), source:'service' });
        }
        const next = new URL(endpoint);
        if (kind==='anthropic' && payload.has_more && payload.last_id) next.searchParams.set('after_id',payload.last_id);
        else if (kind==='google' && payload.nextPageToken) next.searchParams.set('pageToken',payload.nextPageToken);
        else break;
        if (next.href===endpoint) break;
        endpoint=next.href;
        if (page===19) throw new Error('模型列表分页过多，请手动填写模型名称。');
      }
      if (!found.size) throw new Error('服务未返回可用模型，可以手动填写。');
      return { models:[...found.values()], source:'service', warning:'' };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const models = fallback(api,baseUrl).map(item => ({...describe({api,baseUrl,model:item.id,modelInfo:item}),source:'catalog'}));
      const warning=timeout.aborted ? '获取模型超时，可以重试或手动填写。' : error instanceof TypeError ? '无法获取模型列表，请检查地址、网络及服务的跨域设置。' : error.message;
      if (models.length) return {models,source:'catalog',warning};
      throw new Error(warning);
    }
  }
  return { describe, discover, apis };
}
