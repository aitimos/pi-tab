export function createOAuthUI({root,i18n,auth,onSelect}) {
  i18n.addMessages({"登录提供商": "Sign-in provider", "退出登录": "Sign out", "登录": "Sign in", "已登录": "Signed in", "使用提供商账号授权": "Authorize with your provider account", "打开授权页面": "Open authorization page", "继续": "Continue", "请选择支持浏览器登录的提供商。": "Choose a provider that supports browser sign-in.", "登录已取消。": "Sign-in cancelled.", "登录已结束，请重新开始。": "Sign-in has ended. Please start again.", "登录步骤已更新，请重试。": "The sign-in step has changed. Please try again.", "未知登录操作。": "Unknown sign-in action.", "登录需要 HTTPS 网页。": "Sign-in requires an HTTPS page."});
  const byId=id=>root.getElementById(id),t=i18n.t;
  i18n.html(byId('oauth-form'),`
        <div class="form-body">
          <p id="oauth-status" role="status"></p>
          <div id="oauth-events"></div>
          <label id="oauth-prompt" hidden><span id="oauth-question"></span><input id="oauth-input" autocomplete="off" /><select id="oauth-choice" hidden></select></label>
          <p id="oauth-error" class="error" role="alert" hidden></p>
        </div>
        <div class="form-footer"><div class="form-buttons"><button id="oauth-cancel" class="subtle" type="button" hidden>取消</button><button id="oauth-logout" class="subtle" type="button" hidden>退出登录</button><button id="oauth-submit" class="primary" type="submit">登录</button></div></div>
      `);
  i18n.addMessages({'登录方式':'Sign-in method','网页登录，粘贴回调 URL':'Browser sign-in, paste callback URL','设备码登录':'Device code sign-in','回调 URL 或授权码':'Callback URL or authorization code','粘贴完整回调 URL 或授权码':'Paste the full callback URL or authorization code','授权后的 localhost 页面可能无法打开，复制地址栏中的完整 URL 并粘贴到这里。':'The localhost page may not load after authorization. Copy its full URL from the address bar and paste it here.'});
  i18n.addMessages({'等待授权':'Waiting for authorization','登录请求未完成。请检查网络；书签模式可能受跨域限制，可改用扩展。':'Sign-in request failed. Check your network; cross-origin restrictions may block bookmark mode. Try the extension.','授权信息与本次登录不匹配，请重新登录。':'This authorization does not match the current sign-in. Please start again.'});
  let oauthId,oauthPrompt,oauthTimer,account=null,attempt=0,selectedApi,selectedProvider;
  function oauthError(error){
    const message=error.message||String(error);
    const display=/failed to fetch|networkerror|load failed/i.test(message)?'登录请求未完成。请检查网络；书签模式可能受跨域限制，可改用扩展。':/state mismatch/i.test(message)?'授权信息与本次登录不匹配，请重新登录。':message;
    i18n.text(byId('oauth-error'),()=>t(display));byId('oauth-error').hidden=false;
  }
  async function cancelOAuth(){attempt++;clearTimeout(oauthTimer);const id=oauthId;oauthId=null;oauthPrompt=null;if(id)await auth('cancel',{id}).catch(oauthError);}
  function oauthAccount(){
    byId('oauth-logout').hidden=!account?.connected;
    i18n.text(byId('oauth-submit'),()=>account?.connected?t('选择模型'):t('登录'));
    i18n.text(byId('oauth-status'),()=>account?.connected?t('已登录'):t('使用提供商账号授权'));
  }
  async function openOAuth(api,providerId){
    selectedApi=api;selectedProvider=providerId;
    byId('content').hidden=true;byId('model-dialog').hidden=false;byId('manual-model-form').hidden=true;byId('provider-form').hidden=true;byId('oauth-form').hidden=false;
    i18n.text(byId('model-dialog-title'),()=>t('账户登录'));
    await cancelOAuth();account=null;delete byId('oauth-form').dataset.provider;byId('oauth-prompt').hidden=true;byId('oauth-cancel').hidden=true;byId('oauth-events').replaceChildren();
    byId('oauth-error').hidden=true;byId('oauth-submit').disabled=true;
    const version=attempt;
    try {
      const accounts=await auth('list',{api});
      if(version!==attempt)return;
      account=accounts.find(item=>item.id===providerId);
      if(!account)throw Error(t('请选择支持浏览器登录的提供商。'));
      i18n.text(byId('model-dialog-title'),account.name);oauthAccount();
      byId('oauth-form').dataset.provider=providerId;byId('oauth-submit').disabled=false;
    } catch(error) { if(version===attempt)oauthError(error); }
  }
  const useOAuth=()=>onSelect(account.id,account.name,selectedApi);
  async function pollOAuth(){
    const id=oauthId;if(!id)return;
    try{
      const result=await auth('status',{id});if(oauthId!==id)return;
      if(result.state==='error')throw new Error(result.error);
      if(result.state==='done'){await useOAuth();oauthId=null;return;}
      const area=byId('oauth-events');area.replaceChildren();
      for(const event of result.events){
        if(event.type==='auth_url'||event.type==='device_code'){
          const url=new URL(event.url||event.verificationUri);if(url.protocol!=='https:')continue;
          const link=document.createElement('a');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';link.className='text-button';i18n.text(link,()=>t('打开授权页面'));area.append(link);
          if(event.userCode){const code=document.createElement('pre');code.textContent=event.userCode;area.append(code);}
        }
      }
      if(result.prompt?.id!==oauthPrompt?.id || !result.prompt){
        oauthPrompt=result.prompt;byId('oauth-prompt').hidden=!oauthPrompt;byId('oauth-submit').disabled=!oauthPrompt;
        if(!oauthPrompt)i18n.text(byId('oauth-submit'),()=>t('等待授权'));
        if(oauthPrompt){
          const prompt=oauthPrompt;i18n.text(byId('oauth-question'),()=>prompt.type==='manual_code'?t('回调 URL 或授权码'):prompt.type==='select'&&selectedProvider==='openai-codex'?t('登录方式'):prompt.message);const select=oauthPrompt.type==='select';byId('oauth-choice').hidden=!select;byId('oauth-input').hidden=select;
          if(select)byId('oauth-choice').replaceChildren(...oauthPrompt.options.map(item=>i18n.option(()=>selectedProvider==='openai-codex'?t(item.id==='browser'?'网页登录，粘贴回调 URL':'设备码登录'):item.label,item.id)));
          else{byId('oauth-input').type=oauthPrompt.type==='secret'?'password':'text';byId('oauth-input').value='';byId('oauth-input').placeholder=oauthPrompt.type==='manual_code'?t('粘贴完整回调 URL 或授权码'):oauthPrompt.placeholder||'';byId('oauth-input').spellcheck=false; if(oauthPrompt.type==='manual_code'&&selectedProvider==='openai-codex')i18n.text(byId('oauth-status'),()=>t('授权后的 localhost 页面可能无法打开，复制地址栏中的完整 URL 并粘贴到这里。'));}
          i18n.text(byId('oauth-submit'),()=>t('继续'));
        }
      }
      oauthTimer=setTimeout(()=>void pollOAuth(),800);
    }catch(error){if(oauthId===id){await cancelOAuth();byId('oauth-submit').disabled=false;byId('oauth-cancel').hidden=true;byId('oauth-prompt').hidden=true;oauthAccount();oauthError(error);}}
  }
  byId('oauth-cancel').addEventListener('click',async()=>{await cancelOAuth();byId('oauth-submit').disabled=false;byId('oauth-prompt').hidden=true;byId('oauth-cancel').hidden=true;byId('oauth-events').replaceChildren();oauthAccount();});
  byId('oauth-logout').addEventListener('click',async()=>{try{await auth('logout',{providerId:account.id});await openOAuth(selectedApi,selectedProvider);}catch(error){oauthError(error);}});
  byId('oauth-form').addEventListener('submit',async event=>{
    event.preventDefault();if(byId('oauth-submit').disabled)return;byId('oauth-submit').disabled=true;byId('oauth-error').hidden=true;
    try{
      if(oauthId&&oauthPrompt){await auth('answer',{id:oauthId,promptId:oauthPrompt.id,value:oauthPrompt.type==='select'?byId('oauth-choice').value:byId('oauth-input').value});oauthPrompt=null;byId('oauth-input').value='';byId('oauth-prompt').hidden=true;byId('oauth-submit').disabled=true;return;}
      if(account?.connected){await useOAuth();return;}
      byId('oauth-submit').disabled=true;byId('oauth-logout').hidden=true;byId('oauth-cancel').hidden=false;
      const version=attempt;
      const {id}=await auth('start',{providerId:account.id,api:selectedApi});
      if(version!==attempt){await auth('cancel',{id});return;}
      oauthId=id;void pollOAuth();
    }catch(error){byId('oauth-submit').disabled=false;oauthError(error);}
  });
  return {open:openOAuth,cancel:cancelOAuth};
}
