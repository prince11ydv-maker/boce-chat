import {createHash} from 'node:crypto';
import {isIP} from 'node:net';

// Provider hosts are exact, server-configured values; never accept an SMTP URL,
// arbitrary user-supplied host, raw IP address, or transport options from a request.
export const SMTP_HOSTS=Object.freeze([
  'smtp-relay.brevo.com','smtp.gmail.com','smtp.office365.com',
  'smtp.mail.yahoo.com','smtp.zoho.com','smtppro.zoho.com','smtp.zoho.eu',
  'smtp.sendgrid.net','smtp.mailgun.org','smtp.eu.mailgun.org',
  'smtp.mailersend.net','smtp.resend.com','mail.smtp2go.com','smtp.elasticemail.com'
]);
const hosts=new Set(SMTP_HOSTS);
const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const controls=/[\u0000-\u001f\u007f\u2028\u2029]/;

export class MailDeliveryError extends Error {
  constructor(code,message,{retryable=false,deliveryUncertain=false,providerCode,responseCode}={}){
    super(message);
    this.name='MailDeliveryError';this.code=code;this.retryable=retryable;this.deliveryUncertain=deliveryUncertain;
    if(providerCode)this.providerCode=providerCode;
    if(responseCode)this.responseCode=responseCode;
    // Deliberately no raw SMTP error/cause, provider response, URL, recipient, or
    // credentials: these exceptions are safe for an outbox worker's status log.
  }
}
const configError=()=>new MailDeliveryError('EMAIL_CONFIGURATION','Email delivery is not configured safely.');
const inputError=()=>new MailDeliveryError('EMAIL_INVALID_MESSAGE','The email message is invalid.');
function oneLine(value,max=200){if(typeof value!=='string'||!value.trim()||value.length>max||controls.test(value))throw inputError();return value.trim();}
function mailbox(value){const address=oneLine(value,254);const at=address.lastIndexOf('@');if(at<=0||at!==address.indexOf('@'))throw inputError();const local=address.slice(0,at),domain=address.slice(at+1);if(local.length>64||local.startsWith('.')||local.endsWith('.')||local.includes('..')||! /^[a-zA-Z0-9.!#$%&'*+\-/=?^_`{|}~]+$/.test(local)||!domain.includes('.')||domain.length>253||!domain.split('.').every(label=>/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)))throw inputError();return address;}
function publicOrigin(value){const origin=oneLine(value,300);let url;try{url=new URL(origin);}catch{throw inputError();}if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash||url.origin!==origin||isIP(url.hostname)||!url.hostname.includes('.')||/(?:^|\.)(localhost|local|internal|invalid)$/.test(url.hostname))throw inputError();return origin;}
function appUrl(value,origin){const raw=oneLine(value,4096);let url;try{url=new URL(raw);}catch{throw inputError();}if(url.protocol!=='https:'||url.username||url.password||url.origin!==origin)throw inputError();return url.href;}
function bodyText(value,max=20000){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw inputError();return value.trim();}
function greeting(value){if(value===undefined||value===null||value==='')return 'there';return oneLine(value,100);}
function expiration(value,fallback,max){const minutes=value??fallback;if(!Number.isInteger(minutes)||minutes<1||minutes>max)throw inputError();return minutes;}
function emailShell({appName,title,intro,body,actionLabel,actionUrl,footer,unsubscribeUrl}){
  const safe=value=>escapeHtml(value);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe(title)}</title></head><body style="margin:0;background:#f5f6fb;font-family:Arial,sans-serif;color:#25283e"><table role="presentation" style="width:100%;border-collapse:collapse"><tr><td style="padding:32px 16px"><table role="presentation" style="width:100%;max-width:560px;margin:auto;background:#fff;border:1px solid #e5e6ee;border-radius:16px;border-collapse:separate"><tr><td style="padding:30px"><p style="margin:0 0 24px;color:#5759bd;font-size:18px;font-weight:700">${safe(appName)}</p><h1 style="margin:0 0 18px;font-size:26px;line-height:1.3">${safe(title)}</h1><p style="font-size:15px;line-height:1.8">${safe(intro)}</p><div style="font-size:15px;line-height:1.8;white-space:pre-wrap">${safe(body)}</div>${actionUrl?`<p style="margin:26px 0"><a href="${safe(actionUrl)}" style="display:inline-block;background:#5659c8;border-radius:8px;padding:14px 20px;color:white;font-size:14px;font-weight:700;text-decoration:none">${safe(actionLabel)}</a></p><p style="font-size:12px;line-height:1.7;word-break:break-all;color:#6e7186">Or copy this link:<br><a href="${safe(actionUrl)}" style="color:#5659c8">${safe(actionUrl)}</a></p>`:''}<hr style="border:0;border-top:1px solid #e8e8ef;margin:26px 0"><p style="font-size:12px;line-height:1.8;color:#6e7186">${safe(footer)}</p>${unsubscribeUrl?`<p style="font-size:12px;line-height:1.8"><a href="${safe(unsubscribeUrl)}" style="color:#6e7186">Manage or stop these class notifications</a></p>`:''}</td></tr></table></td></tr></table></body></html>`;
}

export function renderPasswordResetEmail({origin,name,resetUrl,expiresMinutes=15,appName='Classnest'}={}){
  origin=publicOrigin(origin);appName=oneLine(appName,60);const url=appUrl(resetUrl,origin),minutes=expiration(expiresMinutes,15,60),who=greeting(name),subject=`Reset your ${appName} password`;
  const body=`We received a request to reset your ${appName} password. Use the button below to choose a new password.\n\nThis link expires in ${minutes} minutes and can only be used once.`;
  const footer='If you did not request this, you can ignore this email. Your password stays the same until you complete the reset.';
  return {subject,text:`Hi ${who},\n\n${body}\n\nReset password:\n${url}\n\n${footer}\n\n${appName}`,html:emailShell({appName,title:'A fresh password. A fresh start.',intro:`Hi ${who},`,body,actionLabel:'Reset password',actionUrl:url,footer})};
}

export function renderVerificationEmail({origin,name,verificationUrl,expiresMinutes=1440,appName='Classnest'}={}){
  origin=publicOrigin(origin);appName=oneLine(appName,60);const url=appUrl(verificationUrl,origin),minutes=expiration(expiresMinutes,1440,2880),who=greeting(name),subject=`Verify your ${appName} email`;
  const duration=minutes%60===0?`${minutes/60} ${minutes===60?'hour':'hours'}`:`${minutes} minutes`;
  const body=`Confirm that this email address belongs to you before using email recovery and class notifications.\n\nThis link expires in ${duration} and can only be used once. Verifying your email does not approve posting access; your class admin handles that separately.`;
  const footer='If you did not request this, you can ignore this email.';
  return {subject,text:`Hi ${who},\n\n${body}\n\nVerify email:\n${url}\n\n${footer}\n\n${appName}`,html:emailShell({appName,title:'Make your class connection official.',intro:`Hi ${who},`,body,actionLabel:'Verify email',actionUrl:url,footer})};
}

export function renderNotificationEmail({origin,name,subject,title,body,text,actionLabel,actionUrl,unsubscribeUrl,appName='Classnest'}={}){
  origin=publicOrigin(origin);appName=oneLine(appName,60);subject=oneLine(subject||title,150);title=oneLine(title||subject,150);const content=bodyText(body??text),who=greeting(name);
  const action=actionUrl?appUrl(actionUrl,origin):undefined,label=action?oneLine(actionLabel||'Open your class workspace',80):undefined,unsubscribe=unsubscribeUrl?appUrl(unsubscribeUrl,origin):undefined;
  if(actionLabel&&!action)throw inputError();
  const footer='This update was sent from your class workspace.';
  return {subject,text:`Hi ${who},\n\n${title}\n\n${content}${action?'\n\n'+label+':\n'+action:''}\n\n${footer}${unsubscribe?'\nManage or stop these class notifications:\n'+unsubscribe:''}\n\n${appName}`,html:emailShell({appName,title,intro:`Hi ${who},`,body:content,actionLabel:label,actionUrl:action,footer,unsubscribeUrl:unsubscribe})};
}

function readConfig(env){
  try{
    const host=oneLine(env.MAIL_HOST,253).toLowerCase(),port=Number(env.MAIL_PORT||'587');
    if(!hosts.has(host)||isIP(host)||!['465','587'].includes(String(port)))throw inputError();
    const user=oneLine(env.MAIL_USER,320),password=env.MAIL_PASSWORD;
    if(typeof password!=='string'||!password.length||password.length>4096||/[\u0000\r\n]/.test(password))throw inputError();
    const from=mailbox(env.MAIL_FROM),name=oneLine(env.MAIL_FROM_NAME||'Classnest',60),origin=publicOrigin(env.PUBLIC_ORIGIN);
    return {host,port,user,password,from,name,origin};
  }catch{throw configError();}
}

function deliveryFailure(error){
  const codes=new Set(['ECONNECTION','ETIMEDOUT','ETIMEOUT','EDNS','ESOCKET','EPIPE','ETLS','EAUTH','EENVELOPE','EMESSAGE','ESTREAM','ERECIPIENT','EHEADER','EFORMAT']);
  const providerCode=codes.has(error?.code)?error.code:undefined,responseCode=Number.isInteger(error?.responseCode)&&error.responseCode>=400&&error.responseCode<=599?error.responseCode:undefined;
  // An explicit SMTP 4xx is temporary even when Nodemailer classifies it as an
  // envelope/authentication error. An explicit 5xx is a permanent rejection.
  const permanent=responseCode?responseCode>=500:['EAUTH','EENVELOPE','EMESSAGE','EHEADER','EFORMAT'].includes(providerCode);
  return new MailDeliveryError('EMAIL_DELIVERY_FAILED','The email provider did not confirm acceptance.',{providerCode,responseCode,retryable:!permanent,deliveryUncertain:!responseCode&&!permanent&&!['EAUTH','ECONNECTION','EDNS','ETLS','EENVELOPE','EHEADER','EFORMAT'].includes(providerCode)});
}

export function createMailer({env=process.env,transportFactory}={}){
  const enabled=env.EMAIL_ENABLED==='true';
  if(!enabled)return Object.freeze({enabled:false,async sendEmail(){throw new MailDeliveryError('EMAIL_DISABLED','Email delivery is disabled.');}});
  const config=readConfig(env);
  let transportPromise;
  async function transport(){
    if(!transportPromise)transportPromise=(async()=>{
      const factory=transportFactory||((options)=>import('nodemailer').then(module=>module.default.createTransport(options)));
      const client=await factory({host:config.host,port:config.port,secure:config.port===465,requireTLS:true,ignoreTLS:false,opportunisticTLS:false,auth:{user:config.user,pass:config.password},tls:{rejectUnauthorized:true,minVersion:'TLSv1.2',servername:config.host},pool:false,connectionTimeout:15000,greetingTimeout:10000,socketTimeout:25000,dnsTimeout:5000,logger:false,debug:false,transactionLog:false,disableFileAccess:true,disableUrlAccess:true,maxRecipients:1});
      if(!client||typeof client.sendMail!=='function')throw configError();return client;
    })();
    try{return await transportPromise;}catch{transportPromise=undefined;throw configError();}
  }
  return Object.freeze({enabled:true,async sendEmail(message){
    if(!message||typeof message!=='object'||Array.isArray(message))throw inputError();
    const to=mailbox(message.to),id=oneLine(message.id??message.idempotencyKey,128);
    if(!/^[a-zA-Z0-9_-]{1,128}$/.test(id))throw inputError();
    const data={...message,origin:config.origin,appName:config.name};
    let content;
    if(message.template==='password-reset')content=renderPasswordResetEmail(data);
    else if(message.template==='email-verification')content=renderVerificationEmail(data);
    else if(message.template==='notification')content=renderNotificationEmail(data);
    else if(message.template==='class-notification'){
      if(!['note','notice','daily-routine','teacher-reminder','class-status'].includes(message.type))throw inputError();
      content=renderNotificationEmail({...data,subject:data.subject||('Classnest · '+oneLine(data.title,150)).slice(0,150),actionLabel:message.type==='teacher-reminder'?'Respond to your class reminder':message.type==='notice'?'Read this notice':'Open your class workspace'});
    }
    else throw inputError();
    const messageId=`<classnest.${createHash('sha256').update(config.origin+'\0'+id).digest('hex')}@${new URL(config.origin).hostname}>`;
    const client=await transport();
    let info;
    try{info=await client.sendMail({from:{name:config.name,address:config.from},to:{address:to},envelope:{from:config.from,to:[to]},subject:content.subject,text:content.text,html:content.html,messageId,disableFileAccess:true,disableUrlAccess:true,maxRecipients:1});}
    catch(error){throw deliveryFailure(error);}
    const accepted=Array.isArray(info?.accepted)&&info.accepted.some(value=>typeof value==='string'?value.toLowerCase()===to.toLowerCase():typeof value?.address==='string'&&value.address.toLowerCase()===to.toLowerCase());
    if(!accepted||(Array.isArray(info?.rejected)&&info.rejected.length)){
      const code=info?.rejectedErrors?.find(error=>Number.isInteger(error?.responseCode)&&error.responseCode>=400&&error.responseCode<=599)?.responseCode;
      throw new MailDeliveryError('EMAIL_RECIPIENT_REJECTED','The email provider did not accept the recipient.',{retryable:code>=400&&code<500,responseCode:code});
    }
    // SMTP acceptance is not inbox delivery. Reusing an outbox ID gives a stable
    // Message-ID but does not provide exactly-once sending across network retries.
    return {accepted:true,messageId,delivery:'smtp-accepted',semantics:'at-least-once'};
  }});
}

let defaultMailer;
export async function sendEmail(message){defaultMailer??=createMailer();return defaultMailer.sendEmail(message);}
