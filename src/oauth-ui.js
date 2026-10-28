export function createOAuthUI({root,i18n,auth,onSelect}) {
  i18n.addMessages({"登录提供商": "Sign-in provider", "退出登录": "Sign out", "登录": "Sign in", "已登录": "Signed in", "使用提供商账号授权": "Authorize with your provider account", "打开授权页面": "Open authorization page", "继续": "Continue", "请选择支持浏览器登录的提供商。": "Choose a provider that supports browser sign-in.", "登录已取消。": "Sign-in cancelled.", "登录已结束，请重新开始。": "Sign-in has ended. Please start again.", "登录步骤已更新，请重试。": "The sign-in step has changed. Please try again.", "未知登录操作。": "Unknown sign-in action.", "登录需要 HTTPS 网页。": "Sign-in requires an HTTPS page."});
  const byId=id=>root.getElementById(id),t=i18n.t;
  i18n.html(byId('oauth-form'),`
        <div class="form-body">
          <label><span>提供商</span><select id="oauth-provider" aria-label="登录提供商"></select></label>
          <p id="oauth-status" role="status"></p>
          <div id="oauth-events"></div>
          <label id="oauth-prompt" hidden><span id="oauth-question"></span><input id="oauth-input" autocomplete="off" /><select id="oauth-choice" hidden></select></label>
          <p id="oauth-error" class="error" role="alert" hidden></p>
        </div>
        <div class="form-footer"><div class="form-buttons"><button id="oauth-cancel" class="subtle" type="button" hidden>取消</button><button id="oauth-logout" class="subtle" type="button" hidden>退出登录</button><button id="oauth-submit" class="primary" type="submit">登录</button></div></div>
      `);
  let oauthId,oauthPrompt,oauthTimer,oauthAccounts=[],attempt=0;
  function oauthError(error){i18n.text(byId('oauth-error'),()=>t(error.message||String(error)));byId('oauth-error').hidden=false;}
  async function cancelOAuth(){attempt++;clearTimeout(oauthTimer);const id=oauthId;oauthId=null;oauthPrompt=null;if(id)await auth('cancel',{id}).catch(oauthError);}
  function oauthAccount(){
    const account=oauthAccounts.find(item=>item.id===byId('oauth-provider').value);
    byId('oauth-logout').hidden=!account?.connected;
    i18n.text(byId('oauth-submit'),()=>account?.connected?t('选择模型'):t('登录'));
    i18n.text(byId('oauth-status'),()=>account?.connected?t('已登录'):t('使用提供商账号授权'));
  }
  async function openOAuth(){
    byId('content').hidden=true;byId('model-dialog').hidden=false;byId('manual-model-form').hidden=true;byId('provider-form').hidden=true;byId('oauth-form').hidden=false;
    i18n.text(byId('model-dialog-title'),()=>t('账户登录'));
    await cancelOAuth();byId('oauth-provider').disabled=false;byId('oauth-prompt').hidden=true;byId('oauth-cancel').hidden=true;byId('oauth-events').replaceChildren();
    byId('oauth-error').hidden=true;byId('oauth-submit').disabled=true;
    const version=attempt;
    try{oauthAccounts=await auth('list');if(version!==attempt)return;byId('oauth-provider').replaceChildren(...oauthAccounts.map(item=>new Option(item.name,item.id)));oauthAccount();}
    catch(error){oauthError(error);}
    finally{byId('oauth-submit').disabled=false;}
  }
  const useOAuth=()=>onSelect(byId('oauth-provider').value,oauthAccounts.find(item=>item.id===byId('oauth-provider').value).name);
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
        if(oauthPrompt){
          i18n.text(byId('oauth-question'),oauthPrompt.message);const select=oauthPrompt.type==='select';byId('oauth-choice').hidden=!select;byId('oauth-input').hidden=select;
          if(select)byId('oauth-choice').replaceChildren(...oauthPrompt.options.map(item=>new Option(item.label,item.id)));
          else{byId('oauth-input').type=oauthPrompt.type==='secret'?'password':'text';byId('oauth-input').value='';byId('oauth-input').placeholder=oauthPrompt.placeholder||'';}
          i18n.text(byId('oauth-submit'),()=>t('继续'));
        }
      }
      oauthTimer=setTimeout(()=>void pollOAuth(),800);
    }catch(error){if(oauthId===id){await cancelOAuth();byId('oauth-provider').disabled=false;byId('oauth-submit').disabled=false;byId('oauth-cancel').hidden=true;oauthAccount();oauthError(error);}}
  }
  byId('oauth-provider').addEventListener('change',oauthAccount);
  byId('oauth-cancel').addEventListener('click',async()=>{await cancelOAuth();byId('oauth-provider').disabled=false;byId('oauth-submit').disabled=false;byId('oauth-prompt').hidden=true;byId('oauth-cancel').hidden=true;byId('oauth-events').replaceChildren();oauthAccount();});
  byId('oauth-logout').addEventListener('click',async()=>{try{await auth('logout',{providerId:byId('oauth-provider').value});await openOAuth();}catch(error){oauthError(error);}});
  byId('oauth-form').addEventListener('submit',async event=>{
    event.preventDefault();if(byId('oauth-submit').disabled)return;byId('oauth-submit').disabled=true;byId('oauth-error').hidden=true;
    try{
      if(oauthId&&oauthPrompt){await auth('answer',{id:oauthId,promptId:oauthPrompt.id,value:oauthPrompt.type==='select'?byId('oauth-choice').value:byId('oauth-input').value});oauthPrompt=null;byId('oauth-input').value='';byId('oauth-prompt').hidden=true;byId('oauth-submit').disabled=true;return;}
      if(oauthAccounts.find(item=>item.id===byId('oauth-provider').value)?.connected){await useOAuth();return;}
      byId('oauth-submit').disabled=true;byId('oauth-provider').disabled=true;byId('oauth-logout').hidden=true;byId('oauth-cancel').hidden=false;
      const version=attempt;
      const {id}=await auth('start',{providerId:byId('oauth-provider').value});
      if(version!==attempt){await auth('cancel',{id});return;}
      oauthId=id;void pollOAuth();
    }catch(error){byId('oauth-provider').disabled=false;byId('oauth-submit').disabled=false;oauthError(error);}
  });
  return {open:openOAuth,cancel:cancelOAuth};
}
