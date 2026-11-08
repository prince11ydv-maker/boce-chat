import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const between=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);};
const stateFlow=source.slice(0,source.indexOf('\nfunction heading('));
const helpers=between('function modal(','async function mutation(');
const recovery=between('function forgotPassword(','async function emailOptions(');
const support=between('function adminSupportPanel(','async function loadMembers(');
const actions=between('function actionButton(','function empty(');
const passwordFields=between('function passwordChangeFields(','function bindRequiredPasswordForm(');
const now=Date.now(),owner={id:'owner',role:'admin',name:'Owner',email:'owner@example.test',semester:3};
const request={id:'request-one',email:'student@example.test',message:'Please help me regain access.',status:'pending',userId:'student',userName:'Student',userRole:'member',semester:3,created:now,expires:now+86400000};

function browser(user=null){
  const elements=new Map(),calls=[],messages=[],secrets=[],location={search:'',hash:'#admin',pathname:'/'};
  const get=selector=>{if(!elements.has(selector))elements.set(selector,{innerHTML:'',textContent:'',open:false,value:'',classList:{remove(){},add(){}},showModal(){this.open=true;},close(){this.open=false;},querySelectorAll(){return secrets;},reset(){this.resets=(this.resets||0)+1;}});return elements.get(selector);};
  let response={message:'Your request has been received.'},error=null,refreshes=0;
  const fixtureState={user,requiresLogin:!user,settings:{semester:3},semesters:[{id:3,name:'Semester 3'}]};
  const context=vm.createContext({URLSearchParams,Intl,Date,location,localStorage:{getItem:()=>null},document:{querySelector:get},window:{},setTimeout(){},clearTimeout(){},FormData:class extends Map{constructor(element){super(element.fd);}},fixtureState,
    async mockApi(path,method='GET',body){calls.push({path,method,body});if(error)throw error;return response;},async mockRefresh(){refreshes++;},mockToast:message=>messages.push(message)});
  vm.runInContext(stateFlow+'\n'+helpers+'\n'+passwordFields+'\n'+actions+'\n'+recovery+'\n'+support+`
    state=fixtureState;api=mockApi;refresh=mockRefresh;toast=mockToast;
    function stopNotePreview(){} function route(){return {page:'admin'};}
    globalThis.ui={requestAdminHelp,forgotPassword,loadSupportRequests,verifySupportRequest,resolveSupportRequest,rejectSupportRequest,savePersonalPassword,supportRequestCards,
      setUser(user){state.user=user;state.requiresLogin=!user;},setRequests(value){supportRequests=value;}};
  `,context);
  return {ui:context.ui,get,calls,messages,secrets,get refreshes(){return refreshes;},setResponse(value){response=value;},setError(value){error=value;},async submit(values){const element=get('#active-form');element.fd=Object.entries(values);secrets.splice(0,secrets.length,...Object.entries(values).filter(([key])=>/password|current|confirmation/i.test(key)).map(([name,value])=>({name,value})));await element.onsubmit({preventDefault(){},target:element,submitter:{disabled:false}});}};
}

test('manual recovery submits only email and message, gives generic acknowledgement and opens WhatsApp only by a plain link',async()=>{
  const app=browser();app.ui.requestAdminHelp();const html=app.get('#modal-body').innerHTML;
  assert.match(html,/name="email"/);assert.match(html,/name="message"/);assert.match(html,/maxlength="500"/);
  assert.match(html,/https:\/\/wa\.me\/9779763214754/);assert.doesNotMatch(html,/\?text=|type="password"/);
  await app.submit({email:'student@example.test',message:'Cannot receive reset email.'});
  assert.equal(app.calls.length,1);assert.equal(app.calls[0].path,'/support/password-requests');assert.equal(app.calls[0].method,'POST');
  assert.deepEqual(Object.keys(app.calls[0].body).sort(),['email','message']);
  assert.match(app.get('#modal-body').innerHTML,/Your request has been received/);assert.match(app.get('#modal-body').innerHTML,/does not|send a message yourself/);
  assert.equal(app.get('#active-form').resets,1);
});

test('existing email reset stays available alongside manual help',async()=>{
  const app=browser();app.ui.forgotPassword();assert.match(app.get('#modal-body').innerHTML,/30 minutes/);
  assert.match(app.get('#modal-body').innerHTML,/data-action="support-request"/);
  await app.submit({email:'student@example.test'});assert.equal(app.calls[0].path,'/forgot-password');
  assert.match(app.get('#modal-body').innerHTML,/spam folder/);assert.match(app.get('#modal-body').innerHTML,/Request admin help/);
});

test('the admin queue escapes user content, requires identity verification and supports another admin without self reset',()=>{
  const app=browser(owner);const html=app.ui.supportRequestCards([{...request,message:'<img src=x onerror=alert(1)>',userName:'<script>bad</script>'}]);
  assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|<script/);assert.match(html,/Verify identity/);assert.doesNotMatch(html,/Set temporary password/);
  const other={...request,userId:'other-admin',userRole:'admin',status:'verified',verifiedBy:owner.id,verifiedAt:now};
  assert.match(app.ui.supportRequestCards([other]),/Set temporary password/);
  assert.doesNotMatch(app.ui.supportRequestCards([{...other,verifiedBy:'someone-else'}]),/Set temporary password/);
  assert.doesNotMatch(app.ui.supportRequestCards([{...other,verifiedAt:now-31*60000}]),/Set temporary password/);
  const self=app.ui.supportRequestCards([{...request,userId:owner.id}]);assert.match(self,/Change my password/);assert.doesNotMatch(self,/Verify identity|Set temporary password/);
});

test('queue loads are private and a session change discards late admin results',async()=>{
  const app=browser();await app.ui.loadSupportRequests();assert.deepEqual(app.calls,[]);
  app.ui.setUser(owner);app.setResponse({requests:[request]});const loading=app.ui.loadSupportRequests();app.ui.setUser(null);await loading;
  assert.doesNotMatch(app.get('#support-requests').innerHTML,/student@example/);
  app.ui.setUser(owner);await app.ui.loadSupportRequests();assert.match(app.get('#support-requests').innerHTML,/student@example/);
  assert.equal(app.get('#support-request-count').textContent,'1 open');
});

test('identity and temporary-password steps each reauthenticate and clear all password fields after success or failure',async()=>{
  const app=browser(owner);app.ui.setRequests([request]);app.ui.verifySupportRequest(request.id);
  assert.match(app.get('#modal-body').innerHTML,/minlength="20"/);assert.match(app.get('#modal-body').innerHTML,/Your administrator password/);
  app.setResponse({requests:[]});await app.submit({verificationNote:'Confirmed the classmate in person.',currentPassword:'Current-owner-password'});
  assert.equal(app.calls[0].path,'/admin/password-requests/request-one/verify');assert.equal(app.calls[0].body.currentPassword,'Current-owner-password');
  assert.ok(app.secrets.every(field=>field.value===''));
  app.ui.setRequests([{...request,status:'verified',verifiedBy:owner.id,verifiedAt:now}]);app.ui.resolveSupportRequest(request.id);
  assert.match(app.get('#modal-body').innerHTML,/24 hours/);assert.match(app.get('#modal-body').innerHTML,/not display it again/);
  app.setError(Error('Current administrator password is incorrect.'));
  await app.submit({temporaryPassword:'Temporary-password-one',confirmTemporaryPassword:'Temporary-password-one',currentPassword:'Wrong-owner-password'});
  const resolve=app.calls.find(call=>call.path.endsWith('/resolve'));assert.ok(resolve);assert.equal(resolve.body.confirmTemporaryPassword,'Temporary-password-one');
  assert.ok(app.secrets.every(field=>field.value===''));assert.match(app.get('#form-error').textContent,/incorrect/);
});

test('personal-password recovery requires matching distinct passwords and sends no confirmation field to the existing endpoint',async()=>{
  const app=browser({...owner,passwordChangeRequired:true});let cleared=0;const element={querySelectorAll:()=>[{set value(value){assert.equal(value,'');cleared++;}}]};
  await assert.rejects(app.ui.savePersonalPassword(new Map([['current','temporary-secret'],['password','new-personal-password'],['confirmation','different']]),element),/do not match/);
  assert.deepEqual(app.calls,[]);assert.equal(cleared,1);
  await assert.rejects(app.ui.savePersonalPassword(new Map([['current','temporary-secret'],['password','temporary-secret'],['confirmation','temporary-secret']]),element),/different from/);
  await app.ui.savePersonalPassword(new Map([['current','temporary-secret'],['password','new-personal-password'],['confirmation','new-personal-password']]),element);
  assert.equal(app.calls[0].path,'/password');assert.deepEqual(Object.keys(app.calls[0].body).sort(),['current','password']);assert.equal(app.refreshes,1);assert.equal(cleared,3);
});
