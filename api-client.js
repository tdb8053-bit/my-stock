(() => {
  'use strict';
  const config=window.ASSET_MANAGER_CONFIG||{};
  const allowed=new Set(['getPortfolioData','getWatchlistData','getSubmissionStatus','submitTransaction']);
  const AUTH_ENDPOINT='https://script.googleapis.com/v1/scripts/';
  let accessToken='';
  let expiresAt=0;
  let authVersion=0;
  let tokenClient=null;
  const AUTH_REQUIRED='登入失效或權限需確認，請重新登入。';

  function configured(){
    return Boolean(config.oauthClientId&&!config.oauthClientId.startsWith('YOUR_')&&config.apiDeploymentId&&!config.apiDeploymentId.startsWith('YOUR_')&&config.scopes);
  }
  function status(text){const el=document.getElementById('sync');if(el)el.textContent=text;}
  function authButton(){return document.getElementById('authButton');}
  function setSignedIn(value){const button=authButton();if(button)button.textContent=value?'登出':'登入';}

  function initializePwaAuth(){
    const button=authButton();
    if(!button)return;
    button.addEventListener('click',()=>{
      if(accessToken&&Date.now()<expiresAt-360000){
        if(sessionStorage.getItem('pendingTransactionRequestId')){
          alert('有一筆交易仍待核對，請先確認交易記錄後再登出。');
          return;
        }
        accessToken='';expiresAt=0;authVersion++;setSignedIn(false);status('已登出');window.clearPrivateData&&window.clearPrivateData();window.location.reload();return;
      }
      accessToken='';expiresAt=0;authVersion++;setSignedIn(false);
      if(window.clearPrivateData)window.clearPrivateData();
      if(!configured()){
        alert('尚未完成 GitHub API 設定。請依 README 填入 OAuth Client ID 與 API 部署 ID。');
        return;
      }
      if(!window.google||!google.accounts||!google.accounts.oauth2){
        status('登入元件載入中');
        alert('Google 登入元件尚未載入，請確認網路後重新整理。');
        return;
      }
      if(!tokenClient){
        tokenClient=google.accounts.oauth2.initTokenClient({
          client_id:config.oauthClientId,
          scope:config.scopes,
          callback:response=>{
            if(response.error||!response.access_token){status('登入未完成');alert('Google 登入未完成：'+(response.error_description||response.error||'請重試。'));return;}
            accessToken=response.access_token;
            expiresAt=Date.now()+Number(response.expires_in||3600)*1000;
            authVersion++;
            setSignedIn(true);status('已登入 · 同步中');
            if(typeof window.refreshAll==='function')window.refreshAll();
          }
        });
      }
      tokenClient.requestAccessToken({prompt:''});
    });
  }

  async function runAppsScript(operation,parameters){
    if(!allowed.has(operation))throw new Error('不允許的資料操作。');
    const remaining=expiresAt-Date.now();
    if(!accessToken||remaining<=360000){
      accessToken='';expiresAt=0;authVersion++;setSignedIn(false);status(AUTH_REQUIRED);
      if(window.clearPrivateData)window.clearPrivateData();
      throw new Error(AUTH_REQUIRED);
    }
    const requestToken=accessToken,requestAuthVersion=authVersion;
    const response=await fetch(AUTH_ENDPOINT+encodeURIComponent(config.apiDeploymentId)+':run',{
      method:'POST',
      headers:{'Authorization':'Bearer '+requestToken,'Content-Type':'application/json'},
      body:JSON.stringify({function:'dispatchPwaRequest',parameters:[operation,parameters]})
    });
    const payload=await response.json().catch(()=>({}));
    if(authVersion!==requestAuthVersion){const error=new Error('登入狀態已更新，重新同步資料。');error.staleAuthResponse=true;throw error;}
    if(!response.ok){
      const error=new Error(payload.error&&payload.error.message||'Apps Script API 呼叫失敗（HTTP '+response.status+'）。');
      if(response.status===401||response.status===403){
        if(authVersion===requestAuthVersion){accessToken='';expiresAt=0;authVersion++;setSignedIn(false);if(window.clearPrivateData)window.clearPrivateData();status(AUTH_REQUIRED);}
        else error.staleAuthResponse=true;
      }
      throw error;
    }
    if(payload.error){
      const detail=payload.error.details&&payload.error.details[0];
      throw new Error(detail&&detail.errorMessage||payload.error.message||'Apps Script 執行失敗。');
    }
    if(!payload.done)throw new Error('Apps Script 尚未完成執行，請稍後重試。');
    const result=payload.response&&payload.response.result;
    if(result===undefined)throw new Error('Apps Script 沒有回傳資料。');
    return result;
  }

  window.apiCall=(name,...args)=>runAppsScript(name,args);
  window.initializePwaAuth=initializePwaAuth;
  window.isPwaAuthenticated=()=>{
    if(!accessToken)return false;
    if(Date.now()>=expiresAt-360000){
      accessToken='';expiresAt=0;authVersion++;setSignedIn(false);status(AUTH_REQUIRED);
      if(window.clearPrivateData)window.clearPrivateData();
      return false;
    }
    return true;
  };
})();
