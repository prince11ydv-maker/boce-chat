import {imageSize} from 'image-size';
import {noticeAttachmentTypes,maxNoticeAttachmentBytes} from './notice-attachments.js';
const invalid=message=>Object.assign(new Error(message),{status:400});
const same=(bytes,signature)=>signature.every((byte,index)=>bytes[index]===byte);
const types={png:['png'],jpg:['jpg','jpeg'],gif:['gif'],webp:['webp'],bmp:['bmp'],tiff:['tif','tiff'],heif:['heic','heif'],avif:['avif']};
const validDimensions=image=>Number.isSafeInteger(image.width)&&Number.isSafeInteger(image.height)&&image.width>0&&image.height>0&&image.width<=30000&&image.height<=30000&&image.width*image.height<=100000000;
function rawContainerSizes(bytes){
  const frames=[{start:0,end:bytes.length,depth:0}],images=[];let boxes=0;
  while(frames.length){const frame=frames.pop();let offset=frame.start;while(offset<frame.end){
    if(++boxes>4096||frame.end-offset<8)throw invalid('The photo has invalid or excessive container metadata.');
    let size=bytes.readUInt32BE(offset),header=8;const type=bytes.toString('ascii',offset+4,offset+8);
    if(size===1){if(frame.end-offset<16)throw invalid('The photo container is incomplete.');const wide=bytes.readBigUInt64BE(offset+8);if(wide>BigInt(Number.MAX_SAFE_INTEGER))throw invalid('The photo container is too large.');size=Number(wide);header=16;}
    if(size===0)size=frame.end-offset;
    if(size<header||offset+size>frame.end)throw invalid('The photo container is incomplete.');
    if(type==='ispe'){
      if(size<header+12||images.length>=64)throw invalid('The photo has invalid or excessive image dimensions.');
      const image={width:bytes.readUInt32BE(offset+header+4),height:bytes.readUInt32BE(offset+header+8)};
      if(!validDimensions(image))throw invalid('Use a photo of at most 100 megapixels and 30,000 pixels per side.');images.push(image);
    }
    if(['meta','iprp','ipco'].includes(type)){
      if(frame.depth>=6)throw invalid('The photo container is nested too deeply.');
      const start=offset+header+(type==='meta'?4:0);if(start>offset+size)throw invalid('The photo container is incomplete.');frames.push({start,end:offset+size,depth:frame.depth+1});
    }
    offset+=size;
  }}
  return images;
}
/** Header/type and dimension validation, not an antivirus or full image decoder. */
export function verifyNoticeFile({filename,buffer}){
  if(!Buffer.isBuffer(buffer)||buffer.length<4||buffer.length>maxNoticeAttachmentBytes)throw invalid('Use a PDF or photo between 1 byte and 20 MiB.');
  const extension=String(filename).split('.').pop().toLowerCase();
  if(!Object.hasOwn(noticeAttachmentTypes,extension))throw invalid('Use a PDF, JPG, PNG, WebP, GIF, BMP, AVIF, HEIC, HEIF or TIFF file.');
  let detected,rawImages=[];
  if(/^%PDF-\d\.\d/.test(buffer.toString('ascii',0,8))&&buffer.subarray(-4096).includes(Buffer.from('%%EOF')))detected='pdf';
  else if(same(buffer,[137,80,78,71,13,10,26,10]))detected='png';
  else if(same(buffer,[255,216,255]))detected='jpg';
  else if(['GIF87a','GIF89a'].includes(buffer.toString('ascii',0,6)))detected='gif';
  else if(buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')detected='webp';
  else if(buffer.toString('ascii',0,2)==='BM')detected='bmp';
  else if(same(buffer,[73,73,42,0])||same(buffer,[77,77,0,42]))detected='tiff';
  else if(buffer.length>=24&&buffer.toString('ascii',4,8)==='ftyp'){
    const size=buffer.readUInt32BE(0),brands=[];
    if(size<16||size>1024||size>buffer.length)throw invalid('The photo has an invalid image container.');
    for(let offset=8;offset+4<=size;offset+=4)if(offset!==12)brands.push(buffer.toString('ascii',offset,offset+4));
    detected=brands.some(brand=>['avif','avis'].includes(brand))?'avif':brands.some(brand=>['heic','heix','hevc','hevx','mif1','msf1'].includes(brand))?'heif':null;
    // Validate uncropped sizes as well: crop metadata must not conceal a huge
    // image allocation in a native browser decoder.
    rawImages=rawContainerSizes(buffer);
  }
  if(detected==='pdf'){
    if(extension!=='pdf')throw invalid('The file contents do not match its extension.');
    return {mime:'application/pdf'};
  }
  if(!detected||!types[detected]?.includes(extension))throw invalid('The file contents do not match a supported photo or PDF.');
  let dimensions;try{dimensions=imageSize(Uint8Array.from(buffer));}catch{throw invalid('The photo header is incomplete or invalid. Export the original photo again.');}
  const images=[...(dimensions.images?.length?dimensions.images:[dimensions]),...rawImages];
  if(images.length>128||images.some(image=>!validDimensions(image)))throw invalid('Use a photo of at most 100 megapixels and 30,000 pixels per side.');
  const largest=images.reduce((max,image)=>image.width*image.height>max.width*max.height?image:max,images[0]);
  return {mime:noticeAttachmentTypes[extension],width:largest.width,height:largest.height};
}
