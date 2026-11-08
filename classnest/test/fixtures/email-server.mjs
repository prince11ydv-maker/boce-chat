import nodemailer from 'nodemailer';

// Install the fake transport before server/mailer imports. This fixture never
// creates an SMTP socket: messages stay inside the fork's test-only IPC pipe.
nodemailer.createTransport=()=>({
  async sendMail(message){
    if(process.connected)await new Promise((resolve,reject)=>process.send({type:'mail',message},error=>error?reject(error):resolve()));
    return {accepted:message.envelope.to};
  }
});

await import('../../server.js');
