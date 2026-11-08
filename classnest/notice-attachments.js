export const maxNoticeAttachmentBytes=20*1024*1024;
export const noticeAttachmentColumns=Object.freeze(['notice_id','filename','original_name','mime','size']);
export const noticeAttachmentTypes=Object.freeze({
  pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',
  gif:'image/gif',bmp:'image/bmp',avif:'image/avif',heic:'image/heic',heif:'image/heif',tif:'image/tiff',tiff:'image/tiff'
});
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const idValue=value=>{if(typeof value!=='string'||!value.trim()||value.length>100||/[\x00-\x1f\x7f]/.test(value))fail('A valid notice is required.');return value;};
const filenamePattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.([a-z]+)$/;

/** Validate canonical database/backup metadata. This does not inspect file bytes;
 * the upload handler must validate and seal the actual file before attaching. */
export function validateNoticeAttachmentMetadata(record){
  if(!record||typeof record!=='object'||Array.isArray(record)||Object.keys(record).length!==noticeAttachmentColumns.length||Object.keys(record).some(key=>!noticeAttachmentColumns.includes(key)))fail('Invalid notice attachment metadata.');
  const notice_id=idValue(record.notice_id),match=typeof record.filename==='string'&&record.filename.match(filenamePattern);
  if(!match||!Object.hasOwn(noticeAttachmentTypes,match[1]))fail('Invalid notice attachment reference.');
  const {filename,original_name,mime,size}=record;
  if(typeof original_name!=='string'||!original_name.trim()||original_name.length>200||/[\\/\x00-\x1f\x7f]/.test(original_name)||original_name==='.'||original_name==='..')fail('Use a safe original attachment name of at most 200 characters.');
  const originalExtension=original_name.slice(original_name.lastIndexOf('.')+1).toLowerCase();
  if(!Object.hasOwn(noticeAttachmentTypes,originalExtension)||noticeAttachmentTypes[originalExtension]!==noticeAttachmentTypes[match[1]]||mime!==noticeAttachmentTypes[match[1]])fail('The attachment name and content type must match a supported PDF or photo.');
  if(!Number.isSafeInteger(size)||size<1||size>maxNoticeAttachmentBytes)fail('Notice attachments must be between 1 byte and 20 MiB.');
  return {notice_id,filename,original_name,mime,size};
}

/** Public fields intentionally omit storage paths and server filenames. */
export function publicNoticeAttachment(record){
  const attachment=validateNoticeAttachmentMetadata(record);
  return {originalName:attachment.original_name,mime:attachment.mime,size:attachment.size,kind:attachment.mime==='application/pdf'?'pdf':'image'};
}

/** Authorization and the file lifecycle remain with the notice HTTP handlers.
 * Call attach/removeRecord inside their existing administrator transaction. */
export function createNoticeAttachments({db}={}){
  if(!db||!['all','get','run','transaction'].every(name=>typeof db[name]==='function'))throw new TypeError('Notice attachments require a database.');
  async function get(noticeId){
    const row=await db.get('SELECT notice_id,filename,original_name,mime,size FROM notice_attachments WHERE notice_id=?',idValue(noticeId));
    return row?validateNoticeAttachmentMetadata(row):null;
  }
  async function list(semester){
    if(!Number.isSafeInteger(semester)||semester<1)fail('Choose a valid semester.');
    return (await db.all('SELECT a.notice_id,a.filename,a.original_name,a.mime,a.size FROM notice_attachments a JOIN notices n ON n.id=a.notice_id WHERE n.semester=? ORDER BY n.created DESC,a.notice_id',semester)).map(validateNoticeAttachmentMetadata);
  }
  async function attach(noticeId,record){return db.transaction(async()=>{
    noticeId=idValue(noticeId);
    if(!record||typeof record!=='object'||Array.isArray(record)||Object.hasOwn(record,'notice_id')&&record.notice_id!==noticeId)fail('The attachment must belong to this notice.');
    const checked=validateNoticeAttachmentMetadata({...record,notice_id:noticeId});
    if(!await db.get('SELECT id FROM notices WHERE id=?',noticeId))fail('Notice not found.',404);
    if(await db.get('SELECT notice_id FROM notice_attachments WHERE notice_id=?',noticeId))fail('This notice already has an attachment.',409);
    if(await db.get('SELECT notice_id FROM notice_attachments WHERE filename=?',checked.filename))fail('This uploaded file is already attached to another notice.',409);
    await db.run('INSERT INTO notice_attachments(notice_id,filename,original_name,mime,size) VALUES(?,?,?,?,?)',...noticeAttachmentColumns.map(key=>checked[key]));
    return checked;
  });}
  async function removeRecord(noticeId){return db.transaction(async()=>{
    const row=await get(noticeId);if(row)await db.run('DELETE FROM notice_attachments WHERE notice_id=?',noticeId);return row;
  });}
  return Object.freeze({get,list,attach,removeRecord});
}
