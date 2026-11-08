export const routineKinds = new Set(['class','exam']);
export const routineLimits = Object.freeze({columns:12,rows:40,cell:160,label:80,bytes:100*1024});
const invalid=message=>Object.assign(new Error(message),{status:400});
const defaultTitle=kind=>kind==='exam'?'Exam routine':'Weekly class routine';
export function validateRoutineContent(value,{allowEmpty=false}={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['title','columns','rows'].includes(key)))throw invalid('Send a routine title, columns, and rows.');
  if(typeof value.title!=='string'||!value.title.trim()||value.title.trim().length>routineLimits.label)throw invalid('Routine title is required (maximum 80 characters).');
  if(!Array.isArray(value.columns)||value.columns.length>routineLimits.columns||!allowEmpty&&!value.columns.length)throw invalid('Use between 1 and 12 routine columns.');
  const columns=value.columns.map(label=>{if(typeof label!=='string'||!label.trim()||label.trim().length>routineLimits.label)throw invalid('Every column needs a label of at most 80 characters.');return label.trim();});
  if(!Array.isArray(value.rows)||value.rows.length>routineLimits.rows||!columns.length&&value.rows.length)throw invalid('Use at most 40 routine rows.');
  const rows=value.rows.map(row=>{if(!Array.isArray(row)||row.length!==columns.length)throw invalid('Every routine row must match the number of columns.');return row.map(cell=>{if(typeof cell!=='string'||cell.length>routineLimits.cell)throw invalid('Routine cells must contain at most 160 characters.');return cell.trim();});});
  const content={title:value.title.trim(),columns,rows};
  if(Buffer.byteLength(JSON.stringify(content),'utf8')>routineLimits.bytes)throw invalid('This routine is too large. Shorten its cell text.');
  return content;
}
export function emptyRoutineContent(kind){return {title:defaultTitle(kind),columns:[],rows:[]};}
export function validateRoutineRecord(row){
  if(!row||!Number.isSafeInteger(row.semester)||row.semester<1||!routineKinds.has(row.kind)||!Number.isInteger(row.revision)||row.revision<1||row.revision>2147483647||typeof row.content!=='string'||typeof row.updated!=='string'||!Number.isFinite(Date.parse(row.updated)))throw invalid('Invalid stored routine.');
  let parsed;try{parsed=JSON.parse(row.content);}catch{throw invalid('Invalid stored routine.');}
  const content=validateRoutineContent(parsed,{allowEmpty:true});
  return {...row,content:JSON.stringify(content)};
}
export function publicRoutine(row){const checked=validateRoutineRecord(row);return {kind:checked.kind,...JSON.parse(checked.content),revision:checked.revision,updated:checked.updated};}
