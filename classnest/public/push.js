/* Phone alerts are opt-in. Reading settings never requests permission or subscribes. */
(() => {
  'use strict';
  let h,config=null,devices=[],subscription=null,busy=false,status='',generation=0,loading=null;
  const ua=navigator.userAgent||'',nativeApp=/\bClassnestAndroid\//.test(ua);
  const ios=/iPad|iPhone|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  const approved=()=>['admin','teacher','member'].includes(h?.state()?.user?.role)&&!h.state()?.requiresApproval;
  const supported=()=>window.isSecureContext&&'Notification' in window&&'PushManager' in window&&'serviceWorker' in navigator;
  const standalone=()=>navigator.standalone===true||window.matchMedia?.('(display-mode: standalone)').matches===true;
  const webDevices=()=>devices.filter(device=>device.kind==='web');
  const enabled=()=>!!subscription&&webDevices().length>0&&Notification.permission==='granted';
  function reset(){generation++;config=null;devices=[];subscription=null;busy=false;status='';}
  async function load(){
    if(!approved()){reset();return;}
    if(nativeApp)return;
    if(loading)await loading;
    const at=generation,userId=h.state().user.id;
    loading=(async()=>{
      let next,registration,nextSubscription=null;
      try{next=await h.api('/push/devices');if(supported()){registration=await navigator.serviceWorker.getRegistration('/');nextSubscription=await registration?.pushManager?.getSubscription();}}
      catch(error){if(at===generation&&userId===h.state()?.user?.id){config=null;devices=[];subscription=null;status='Phone alert settings could not load. Try again.';}return;}
      if(at!==generation||userId!==h.state()?.user?.id)return;
      config=next;devices=Array.isArray(next.devices)?next.devices:[];subscription=nextSubscription;
    })();
    try{await loading;}finally{loading=null;}
  }
  function panel(){
    if(!approved())return '';
    const e=h.esc;
    if(nativeApp)return '<section class="panel push-preferences"><div><span class="eyebrow">PHONE NOTIFICATIONS</span><h2>Updates from your Android app.</h2><p class="visually-muted">Open the app menu and choose Enable phone alerts. Allow notifications when Android asks. You can change the permission later in your phone’s app settings.</p><p class="visually-muted">Lock-screen alerts say only that a new class update is ready. Open Classnest to view it after signing in.</p></div></section>';
    const installed=standalone(),available=supported()&&(!ios||installed),active=available&&enabled();
    const description=ios&&!installed?'On iPhone or iPad, open Classnest in Safari, choose Share → Add to Home Screen, then open the installed app and sign in to enable alerts.':!supported()?'This browser does not support phone alerts. Try an installed Classnest app or a recent browser that supports notifications.':config&&!config.webPushEnabled?'Phone alerts are being set up. Your in-app notifications still work.':active?'Enabled for this browser and current sign-in. New class updates can appear while the app is closed.':Notification.permission==='denied'?'Notifications are blocked in your browser settings. Allow them there, then return to Classnest.':'Enable alerts on this device for new class updates, including when Classnest is closed.';
    return `<section class="panel push-preferences"><div><span class="eyebrow">PHONE NOTIFICATIONS</span><h2>Your class, even when you’re away.</h2><p class="visually-muted">${e(description)}</p><p class="visually-muted">Lock-screen alerts contain no note, notice, teacher-response, or student details. Opening an alert requires the correct signed-in account. Enable alerts again after signing out and signing back in.</p>${status?`<p class="push-status" role="status">${e(status)}</p>`:''}</div><div class="push-actions">${available?`<button type="button" class="button button-dark" data-push="enable" ${busy||!config?.webPushEnabled||Notification.permission==='denied'?'disabled':''}>${busy?'Updating…':active?'Refresh this device':'Enable phone alerts'}</button>`:''}${available&&(subscription||webDevices().length)?`<button type="button" class="button" data-push="disable" ${busy?'disabled':''}>Disable on this browser</button>`:''}<button type="button" class="button button-small" data-push="reload" ${busy?'disabled':''}>Check settings</button></div></section>`;
  }
  function publicKey(value){
    if(typeof value!=='string'||!/^[A-Za-z0-9_-]{80,100}$/.test(value))throw new Error('Phone alerts are not configured yet.');
    const raw=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4));
    const bytes=Uint8Array.from(raw,char=>char.charCodeAt(0));if(bytes.length!==65||bytes[0]!==4)throw new Error('Phone alerts are not configured yet.');return bytes;
  }
  async function enable(){
    if(!approved()||nativeApp||!supported()||ios&&!standalone())return;
    if(!config?.webPushEnabled){await load();status='Check the phone alert settings, then choose Enable phone alerts.';h.render();return;}
    const userId=h.state().user.id,at=generation,key=publicKey(config.vapidPublicKey);
    // Start this permission request directly in the user's button gesture.
    busy=true;h.render();let permission;
    try{permission=Notification.permission==='granted'?'granted':await Notification.requestPermission();}catch(error){busy=false;throw error;}
    if(permission!=='granted'){busy=false;status='Phone alerts are off. Your in-app notifications are unchanged.';h.render();return;}
    if(at!==generation||userId!==h.state()?.user?.id)return;
    busy=true;status='';h.render();let created=false,current;
    try{
      const registration=await navigator.serviceWorker.register('/service-worker.js',{scope:'/',updateViaCache:'none'});
      const ready=await navigator.serviceWorker.ready;
      if(at!==generation||userId!==h.state()?.user?.id)throw new Error('Sign in again before enabling phone alerts.');
      current=await ready.pushManager.getSubscription();
      if(!current){current=await ready.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});created=true;}
      if(at!==generation||userId!==h.state()?.user?.id)throw new Error('Your sign-in changed. Enable alerts again for your current account.');
      await h.api('/push/devices','POST',{kind:'web',subscription:current.toJSON(),label:ios?'iPhone or iPad':/Android/.test(ua)?'Android browser':'This browser'});
      if(at!==generation||userId!==h.state()?.user?.id)return;
      subscription=current;status=registration.waiting?'Phone alerts are enabled. Close and reopen Classnest to finish applying its latest app update.':'Phone alerts are enabled for this browser and sign-in.';
      await load();
    }catch(error){if(created)await current?.unsubscribe().catch(()=>{});if(at===generation&&userId===h.state()?.user?.id)status=error.status===409?'Disable alerts on this browser, then enable them again for your current account.':error.message||'Phone alerts could not be enabled.';}
    finally{if(at===generation){busy=false;h.render();}}
  }
  async function disable(){
    if(!approved()||nativeApp)return;const at=generation;busy=true;status='';h.render();let failed=false;
    try{
      for(const device of webDevices())try{await h.api('/push/devices/'+encodeURIComponent(device.id),'DELETE');}catch{failed=true;}
      const registration=await navigator.serviceWorker.getRegistration('/'),current=await registration?.pushManager?.getSubscription();await current?.unsubscribe();
      if(at!==generation)return;subscription=null;await load();status=failed?'Browser alerts are off. Sign in again to finish updating your device settings.':'Phone alerts are off on this browser.';
    }catch{if(at===generation)status='Phone alerts could not be disabled. Check your connection and try again.';}
    finally{if(at===generation){busy=false;h.render();}}
  }
  function init(helpers){
    h=helpers;document.addEventListener('click',event=>{const control=event.target.closest('[data-push]');if(!control||busy)return;event.preventDefault();const action=control.dataset.push;
      return Promise.resolve(action==='enable'?enable():action==='disable'?disable():load().then(()=>h.render())).catch(error=>{status=error.message||'Phone alert settings could not be updated.';h.render();});
    });
  }
  window.ClassnestPushUI=Object.freeze({init,load,reset,panel});
})();
