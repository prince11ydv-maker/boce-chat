import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/push.js',import.meta.url),'utf8');
const workerSource=await readFile(new URL('../public/service-worker.js',import.meta.url),'utf8');
const vapidPublicKey=Buffer.concat([Buffer.from([4]),Buffer.alloc(64,1)]).toString('base64url');
const user={id:'student-one',role:'member',semester:3};
function client({enabled=true,ua='Mozilla/5.0',installed=true,permission='default',devices=[],existing=false,permissionPromise}={}){
  const handlers=new Map(),calls=[],counts={permission:0,register:0,subscribe:0,unsubscribe:0,render:0};
  let account=user,sub=existing?subscription():null,currentDevices=[...devices];
  function subscription(){return {toJSON:()=>({endpoint:'https://push.example.test/device',keys:{p256dh:'test-public-key',auth:'test-auth'}}),async unsubscribe(){counts.unsubscribe++;sub=null;return true;}};}
  const registration={pushManager:{async getSubscription(){return sub;},async subscribe(options){counts.subscribe++;assert.equal(options.userVisibleOnly,true);assert.equal(options.applicationServerKey.length,65);return sub=subscription();}}};
  const Notification={permission,async requestPermission(){counts.permission++;const result=permissionPromise?await permissionPromise:'granted';this.permission=result;return result;}};
  const window={Notification,PushManager:class{},isSecureContext:true,matchMedia:()=>({matches:installed})};
  const navigator={userAgent:ua,platform:'',maxTouchPoints:0,serviceWorker:{getRegistration:async()=>registration,register:async(path,options)=>{counts.register++;assert.equal(path,'/service-worker.js');assert.equal(options.scope,'/');return registration;},ready:Promise.resolve(registration)}};
  const context=vm.createContext({window,navigator,Notification,Uint8Array,atob,location:{hash:'#notifications'},document:{addEventListener:(name,handler)=>handlers.set(name,handler)}});
  vm.runInContext(source,context);const ui=window.ClassnestPushUI;
  ui.init({state:()=>({user:account,requiresLogin:!account}),esc:value=>String(value),render(){counts.render++;},toast(){},async api(path,method='GET',body){
    calls.push({path,method,body});
    if(path==='/push/devices'&&method==='GET')return {enabled,webPushEnabled:enabled,vapidPublicKey,devices:currentDevices};
    if(path==='/push/devices'&&method==='POST'){currentDevices=[{id:'web-one',kind:'web',label:'This browser'}];return currentDevices[0];}
    if(method==='DELETE'){currentDevices=currentDevices.filter(device=>path!=='/push/devices/'+device.id);return {ok:true};}
    throw Error('Unexpected API operation');
  }});
  return {ui,calls,counts,window,setUser(value){account=value;},click(action){return handlers.get('click')({preventDefault(){},target:{closest:()=>({dataset:{push:action}})}});}};
}

test('settings loads never request permission or subscribe; manual enable binds the device after consent',async()=>{
  const app=client();await app.ui.load();assert.match(app.ui.panel(),/Enable phone alerts/);
  assert.equal(app.counts.permission,0);assert.equal(app.counts.register,0);assert.equal(app.counts.subscribe,0);
  await app.click('enable');assert.equal(app.counts.permission,1);assert.equal(app.counts.register,1);assert.equal(app.counts.subscribe,1);
  const save=app.calls.find(call=>call.method==='POST');assert.equal(save.path,'/push/devices');assert.equal(save.body.kind,'web');
  assert.equal(save.body.subscription.endpoint,'https://push.example.test/device');assert.match(app.ui.panel(),/Enabled for this browser/);
  await app.ui.load();assert.equal(app.counts.subscribe,1,'Reloading settings must not create another subscription');
  app.setUser(null);app.ui.reset();await app.ui.load();assert.equal(app.ui.panel(),'');
  app.setUser(user);await app.ui.load();assert.equal(app.counts.subscribe,1,'Signing back in must not automatically subscribe');
});

test('unconfigured service, native Android and noninstalled iPhone never prompt for browser notifications',async()=>{
  for(const options of [{enabled:false},{ua:'ClassnestAndroid/1.1.0'},{ua:'Mozilla iPhone',installed:false}]){
    const app=client(options);await app.ui.load();await app.click('enable');
    assert.equal(app.counts.permission,0);assert.equal(app.counts.subscribe,0);assert.equal(app.counts.register,0);
    assert.equal(app.calls.some(call=>call.method==='POST'),false);
    if(options.ua?.startsWith('ClassnestAndroid'))assert.match(app.ui.panel(),/app menu/);
    if(options.ua?.includes('iPhone'))assert.match(app.ui.panel(),/Add to Home Screen/);
  }
});

test('pending and blocked accounts neither load device settings nor request browser notification permission',async()=>{
  for(const role of ['pending','blocked']){
    const app=client();app.setUser({...user,role});await app.ui.load();await app.click('enable');await app.click('disable');
    assert.deepEqual(app.calls,[]);assert.equal(app.ui.panel(),'');assert.equal(app.counts.permission,0);assert.equal(app.counts.subscribe,0);
  }
});

test('an account transition during the permission prompt cannot attach a subscription to the next account',async()=>{
  let resolvePermission;const permissionPromise=new Promise(resolve=>resolvePermission=resolve),app=client({permissionPromise});await app.ui.load();
  const enabling=app.click('enable');assert.equal(app.counts.permission,1);
  app.setUser({...user,id:'different-user'});app.ui.reset();resolvePermission('granted');await enabling;
  assert.equal(app.counts.subscribe,0);assert.equal(app.calls.some(call=>call.method==='POST'),false);
});

test('manual disable removes current-login web devices and unsubscribes this browser without touching native devices',async()=>{
  const app=client({permission:'granted',existing:true,devices:[{id:'web-one',kind:'web'},{id:'android-one',kind:'android'}]});await app.ui.load();
  await app.click('disable');assert.equal(app.counts.unsubscribe,1);
  assert.deepEqual(app.calls.filter(call=>call.method==='DELETE').map(call=>call.path),['/push/devices/web-one']);
  assert.match(app.ui.panel(),/Phone alerts are off on this browser/);
});

function worker(windows=[]){
  const handlers=new Map(),shown=[],opened=[],self={location:{origin:'https://pusoe.vercel.app'},registration:{async showNotification(title,options){shown.push({title,options});}},clients:{async matchAll(){return windows;},async openWindow(url){opened.push(url);}},addEventListener:(name,handler)=>handlers.set(name,handler)};
  vm.runInNewContext(workerSource,{self,URL,caches:{},Request,Response,fetch(){throw Error('Push must not fetch private class data.');}});
  async function event(name,value){let job;handlers.get(name)({...value,waitUntil(promise){job=promise;}});await job;}
  return {shown,opened,push:payload=>event('push',{data:{json:()=>payload}}),click:data=>event('notificationclick',{notification:{data,close(){}}})};
}
const notificationId='a'.repeat(64);
test('lockscreen messages ignore payload content and accept only an opaque valid notification ID',async()=>{
  const app=worker();await app.push({notificationId,title:'Private lesson',body:'Private teacher explanation',url:'https://attacker.example/'});
  assert.equal(app.shown.length,1);assert.equal(app.shown[0].title,'Classnest');assert.equal(app.shown[0].options.body,'New class update. Sign in to view it.');
  assert.deepEqual(Object.keys(app.shown[0].options.data),['notificationId']);assert.equal(app.shown[0].options.data.notificationId,notificationId);
  assert.doesNotMatch(JSON.stringify(app.shown),/Private lesson|Private teacher|attacker/);
  for(const id of ['https://attacker.example/','b'.repeat(100),null,undefined])await app.push({notificationId:id});
  assert.equal(app.shown.length,1);
});

test('notification clicks use only a canonical same-origin authenticated lookup route',async()=>{
  const navigated=[];let focused=0,foreignFocus=0;
  const app=worker([{url:'https://attacker.example/',async focus(){foreignFocus++;}},{url:'https://pusoe.vercel.app/#home',async navigate(url){navigated.push(url);},async focus(){focused++;}}]);
  await app.click({notificationId,url:'https://attacker.example/?password=example'});
  assert.deepEqual(navigated,['https://pusoe.vercel.app/#notifications/'+notificationId]);assert.equal(focused,1);assert.equal(foreignFocus,0);assert.deepEqual(app.opened,[]);
  const closed=worker();await closed.click({notificationId:'javascript:alert(1)',url:'https://attacker.example/'});
  assert.deepEqual(closed.opened,['https://pusoe.vercel.app/#notifications']);
});
