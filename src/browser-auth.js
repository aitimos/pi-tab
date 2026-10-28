// Pi's other OAuth flows require a Node callback server. These providers expose
// Pi-native device-code or copy-code flows that can run in a browser.
export const browserOAuthProviders = ['anthropic','openai-codex','github-copilot','kimi-coding','meta','xai'];
export function authenticationForApi(providers, api) {
  const matching=providers.filter(p=>p.getModels().some(model=>model.api===api));
  return [
    ...(matching.some(p=>p.auth?.apiKey)?[{id:'api_key',name:'密钥（API Key）'},{id:'none',name:'无需认证'}]:[]),
    ...matching.filter(p=>p.auth?.oauth && browserOAuthProviders.includes(p.id)).map(p=>({id:p.id,name:p.auth.oauth.name})),
  ];
}
