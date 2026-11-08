import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMailer,MailDeliveryError,renderPasswordResetEmail,renderVerificationEmail,renderNotificationEmail} from '../mailer.js';

const settings={EMAIL_ENABLED:'true',MAIL_HOST:'smtp-relay.brevo.com',MAIL_PORT:'587',MAIL_USER:'verified-smtp-login',MAIL_PASSWORD:'test-only-private-smtp-password',MAIL_FROM:'classowner@example.com',MAIL_FROM_NAME:'Classnest',PUBLIC_ORIGIN:'https://classnest.example.com'};
const reset={id:'outbox-reset-1',to:'student@example.com',template:'password-reset',name:'Student',resetUrl:'https://classnest.example.com/#reset-password/private-reset-token',expiresMinutes:15};
const fixture=(extra={})=>{const calls=[],options=[];return {calls,options,mailer:createMailer({env:{...settings,...extra},transportFactory:config=>{options.push(config);return {async sendMail(message){calls.push(message);return {accepted:[message.to.address],rejected:[],messageId:message.messageId};}};}})};};

test('email is disabled by default and never fakes a successful delivery',async()=>{
  let created=false;const mailer=createMailer({env:{},transportFactory:()=>{created=true;throw new Error('Must not connect');}});
  assert.equal(mailer.enabled,false);await assert.rejects(mailer.sendEmail(reset),error=>error instanceof MailDeliveryError&&error.code==='EMAIL_DISABLED');assert.equal(created,false);
});

test('SMTP requires a provider hostname, verified-sender address, exact HTTPS origin, and strict TLS',async()=>{
  for(const changes of [{MAIL_HOST:'smtp://user:pass@smtp-relay.brevo.com'},{MAIL_HOST:'127.0.0.1'},{MAIL_HOST:'localhost'},{MAIL_HOST:'smtp.attacker.example'},{MAIL_HOST:'smtp-relay.brevo.com\r\nX-Extra: 1'},{MAIL_PORT:'25'},{MAIL_PORT:'2525'},{MAIL_FROM:'owner@example.com\r\nBcc: stolen@example.com'},{MAIL_FROM:'Name <owner@example.com>'},{PUBLIC_ORIGIN:'http://classnest.example.com'},{PUBLIC_ORIGIN:'https://localhost'},{PUBLIC_ORIGIN:'https://classnest.example.com/path'},{PUBLIC_ORIGIN:'https://classnest.example.com?token=private'},{PUBLIC_ORIGIN:'https://user:pass@classnest.example.com'}]){
    assert.throws(()=>createMailer({env:{...settings,...changes}}),error=>error.code==='EMAIL_CONFIGURATION');
  }
  for(const port of ['465','587']){const f=fixture({MAIL_PORT:port});await f.mailer.sendEmail(reset);const options=f.options[0];assert.equal(options.host,'smtp-relay.brevo.com');assert.equal(options.port,Number(port));assert.equal(options.secure,port==='465');assert.equal(options.requireTLS,true);assert.equal(options.ignoreTLS,false);assert.equal(options.opportunisticTLS,false);assert.equal(options.tls.rejectUnauthorized,true);assert.equal(options.tls.minVersion,'TLSv1.2');assert.equal(options.tls.servername,options.host);assert.equal(options.logger,false);assert.equal(options.debug,false);assert.equal(options.transactionLog,false);assert.equal(options.disableFileAccess,true);assert.equal(options.disableUrlAccess,true);assert.equal(options.maxRecipients,1);assert.equal('url' in options,false);}
});

test('reset and verification emails escape profile data and keep links on the configured origin',async()=>{
  const f=fixture();await f.mailer.sendEmail({...reset,name:'<img src=x onerror="attack()">',from:'attacker@example.com',bcc:'hidden@example.com',html:'<script>attack()</script>',attachments:[{path:'/private/secret'}],headers:{Bcc:'hidden@example.com'}});
  const message=f.calls[0];assert.match(message.html,/&lt;img src=x onerror=&quot;attack\(\)&quot;&gt;/);assert.ok(!message.html.includes('<img'));assert.ok(!message.html.includes('<script>'));assert.equal('attachments' in message,false);assert.equal('bcc' in message,false);assert.equal('headers' in message,false);assert.deepEqual(message.envelope,{from:'classowner@example.com',to:['student@example.com']});assert.match(message.text,/expires in 15 minutes/);assert.match(message.text,/private-reset-token/);
  const verified=renderVerificationEmail({origin:settings.PUBLIC_ORIGIN,name:'Student & friend',verificationUrl:settings.PUBLIC_ORIGIN+'/#verify-email/private-token',expiresMinutes:1440});assert.match(verified.html,/Student &amp; friend/);assert.match(verified.text,/24 hours/);assert.match(verified.text,/does not approve posting access/);
  for(const url of ['https://attacker.example/#reset-password/private-token','http://classnest.example.com/#reset-password/private-token','https://classnest.example.com.attacker.example/#reset-password/private-token','https://user:pass@classnest.example.com/#reset-password/private-token','https://classnest.example.com/\r\nprivate-token'])await assert.rejects(f.mailer.sendEmail({...reset,resetUrl:url}),error=>error.code==='EMAIL_INVALID_MESSAGE');
  const badRecipients=['student@example.com,other@example.com','student@example.com\r\nBcc: hidden@example.com',['student@example.com'],'Name <student@example.com>'];for(const to of badRecipients)await assert.rejects(f.mailer.sendEmail({...reset,to}),error=>error.code==='EMAIL_INVALID_MESSAGE');
});

test('notification templates render text safely and reject header injection and external action links',()=>{
  const data={origin:settings.PUBLIC_ORIGIN,name:'A < B',subject:'New note shared',title:'Calculus <notes>',body:'Review <script>attack()</script> & share your ideas.\nNext line.',actionLabel:'Open <note>',actionUrl:settings.PUBLIC_ORIGIN+'/#subject/a',unsubscribeUrl:settings.PUBLIC_ORIGIN+'/#email-preferences/private-token'};
  const result=renderNotificationEmail(data);assert.ok(!result.html.includes('<script>'));assert.match(result.html,/Calculus &lt;notes&gt;/);assert.match(result.html,/Review &lt;script&gt;attack\(\)&lt;\/script&gt; &amp; share/);assert.match(result.html,/Open &lt;note&gt;/);assert.match(result.text,/Next line/);assert.match(result.text,/Manage or stop/);
  for(const changes of [{subject:'Subject\r\nBcc: stolen@example.com'},{actionUrl:'https://attacker.example'},{unsubscribeUrl:'https://attacker.example'},{actionLabel:'Click',actionUrl:undefined}])assert.throws(()=>renderNotificationEmail({...data,...changes}),error=>error.code==='EMAIL_INVALID_MESSAGE');
  assert.throws(()=>renderPasswordResetEmail({origin:settings.PUBLIC_ORIGIN,resetUrl:reset.resetUrl,expiresMinutes:0}),error=>error.code==='EMAIL_INVALID_MESSAGE');
});

test('SMTP acceptance is checked, stable Message-ID supports retries without claiming exactly-once delivery',async()=>{
  const f=fixture();const first=await f.mailer.sendEmail(reset),second=await f.mailer.sendEmail(reset),third=await f.mailer.sendEmail({...reset,id:'outbox-reset-2'});assert.equal(first.accepted,true);assert.equal(first.delivery,'smtp-accepted');assert.equal(first.semantics,'at-least-once');assert.equal(first.messageId,second.messageId);assert.notEqual(first.messageId,third.messageId);assert.equal(f.calls.length,3);assert.ok(!first.messageId.includes('private-reset-token'));assert.match(first.messageId,/@classnest\.example\.com>$/);
  const reject=createMailer({env:settings,transportFactory:()=>({async sendMail(){return {accepted:[],rejected:['student@example.com'],response:'PRIVATE SMTP RESPONSE'};}})});await assert.rejects(reject.sendEmail(reset),error=>error.code==='EMAIL_RECIPIENT_REJECTED'&&!String(error.stack).includes('PRIVATE SMTP RESPONSE'));
  const temporary=createMailer({env:settings,transportFactory:()=>({async sendMail(){return {accepted:[],rejected:['student@example.com'],rejectedErrors:[{responseCode:450,response:'PRIVATE SMTP RESPONSE'}]};}})});await assert.rejects(temporary.sendEmail(reset),error=>error.code==='EMAIL_RECIPIENT_REJECTED'&&error.retryable===true&&error.deliveryUncertain===false);
});

test('SMTP failures are redacted and expose only bounded retry status, never credentials or reset URLs',async()=>{
  for(const [code,responseCode,retryable] of [['EAUTH',535,false],['ESOCKET',undefined,true],['ECONNECTION',421,true],['EENVELOPE',550,false],['EENVELOPE',450,true],['EAUTH',454,true]]){
    const raw=Object.assign(new Error('PRIVATE_RESET_TOKEN '+settings.MAIL_PASSWORD+' '+reset.resetUrl),{code,responseCode,response:'PRIVATE SMTP BODY',command:'DATA',config:settings});
    const mailer=createMailer({env:settings,transportFactory:()=>({async sendMail(){throw raw;}})});
    await assert.rejects(mailer.sendEmail(reset),error=>{assert.equal(error.code,'EMAIL_DELIVERY_FAILED');assert.equal(error.retryable,retryable);assert.equal(error.providerCode,code);const serialized=JSON.stringify(error)+' '+error.stack;assert.ok(!serialized.includes('PRIVATE_RESET_TOKEN'));assert.ok(!serialized.includes(settings.MAIL_PASSWORD));assert.ok(!serialized.includes(reset.resetUrl));assert.ok(!serialized.includes('PRIVATE SMTP BODY'));assert.equal('cause' in error,false);return true;});
  }
});
