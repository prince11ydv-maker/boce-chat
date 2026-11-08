import {readFile} from 'node:fs/promises';
export const maxAttachmentBytes=20*1024*1024;
const filenamePattern=/^[a-f0-9-]{36}\.(pdf|txt|md|docx|pptx|xlsx|png|jpg|jpeg|webp|gif|bmp|avif|heic|heif|tif|tiff)$/;
export function safeFilename(value){if(typeof value!=='string'||!filenamePattern.test(value))throw Object.assign(new Error('Invalid attachment reference.'),{status:400});return value;}
const storageError=()=>Object.assign(new Error('Attachment storage is temporarily unavailable. Please try again.'),{status:503});
export async function openStorage({url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY,bucket='classnest-attachments',client:providedClient}={}){
  let origin;try{origin=new URL(url);}catch{throw new Error('SUPABASE_URL is required for cloud storage.');}
  if(origin.protocol!=='https:'||!/^[-a-z0-9]+\.supabase\.co$/.test(origin.hostname)||origin.username||origin.password||origin.pathname!=='/')throw new Error('Use the HTTPS Supabase project URL.');
  if(!key||key.length<32)throw new Error('A server-only Supabase storage key is required.');
  const client=providedClient||(await import('@supabase/supabase-js')).createClient(origin.origin,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const store=client.storage.from(bucket);
  const checked=await client.storage.getBucket(bucket);
  if(checked.error||checked.data.public||Number(checked.data.file_size_limit)!==maxAttachmentBytes)throw new Error('Create a private classnest-attachments bucket with a 20 MB file limit first.');
  const object=(prefix,name)=>prefix+'/'+safeFilename(name);
  async function signed(path,download){const {data,error}=await store.createSignedUrl(path,60,download?{download}:{});if(error)throw storageError();return data.signedUrl;}
  async function read(name){
    const response=await fetch(await signed(object('notes',name)),{redirect:'error',signal:AbortSignal.timeout(60000)});
    if(!response.ok||!response.body)throw storageError();
    const chunks=[];let length=0;
    for await(const chunk of response.body){length+=chunk.length;if(length>maxAttachmentBytes)throw Object.assign(new Error('Files must be 20 MB or smaller.'),{status:413});chunks.push(chunk);}
    return Buffer.concat(chunks,length);
  }
  return {
    async createSignedUpload(name){const {data,error}=await store.createSignedUploadUrl(object('staged',name),{upsert:false});if(error)throw storageError();return {url:data.signedUrl,method:'PUT',expiresAt:Date.now()+2*3600000};},
    async sealUpload(name){const {error}=await store.move(object('staged',name),object('notes',name));if(error)throw Object.assign(new Error('Upload missing or already submitted. Select the file again.'),{status:409});return read(name);},
    async delete(name){if(!name)return;const {error}=await store.remove([object('notes',name)]);if(error)throw storageError();},
    async deleteStaged(name){const {error}=await store.remove([object('staged',name)]);if(error)throw storageError();},
    signedDownload:(name,originalName)=>signed(object('notes',name),originalName),
    read,
    async saveFromLocal(source,name){const data=await readFile(source);if(data.length>maxAttachmentBytes)throw new Error('Attachment too large.');const {error}=await store.upload(object('notes',name),data,{contentType:'application/octet-stream',upsert:false,cacheControl:'0'});if(error)throw storageError();}
  };
}
