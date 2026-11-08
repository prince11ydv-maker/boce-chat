import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyNoticeFile} from '../notice-file-validation.js';

// These fixtures exercise header/type/dimension validation only. They are not
// complete encoded photographs/PDFs and do not establish decoder correctness.
function png(width=640,height=480){const bytes=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);return bytes;}
function jpg(width=640,height=480){const bytes=Buffer.alloc(34);Buffer.from([255,216,255,224]).copy(bytes);bytes.writeUInt16BE(16,4);bytes[20]=255;bytes[21]=192;bytes.writeUInt16BE(17,22);bytes[24]=8;bytes.writeUInt16BE(height,25);bytes.writeUInt16BE(width,27);bytes[32]=255;bytes[33]=217;return bytes;}
function gif(width=640,height=480){const bytes=Buffer.alloc(10);bytes.write('GIF89a');bytes.writeUInt16LE(width,6);bytes.writeUInt16LE(height,8);return bytes;}
function webp(width=640,height=480){const bytes=Buffer.alloc(30);bytes.write('RIFF');bytes.writeUInt32LE(22,4);bytes.write('WEBP',8);bytes.write('VP8X',12);bytes.writeUInt32LE(10,16);bytes.writeUIntLE(width-1,24,3);bytes.writeUIntLE(height-1,27,3);return bytes;}
function bmp(width=640,height=480){const bytes=Buffer.alloc(26);bytes.write('BM');bytes.writeUInt32LE(width,18);bytes.writeInt32LE(height,22);return bytes;}
function tiff(width=640,height=480){const bytes=Buffer.alloc(38);bytes.write('II');bytes.writeUInt16LE(42,2);bytes.writeUInt32LE(8,4);bytes.writeUInt16LE(2,8);for(const [offset,tag,value] of [[10,256,width],[22,257,height]]){bytes.writeUInt16LE(tag,offset);bytes.writeUInt16LE(4,offset+2);bytes.writeUInt32LE(1,offset+4);bytes.writeUInt32LE(value,offset+8);}return bytes;}
function box(type,payload=Buffer.alloc(0)){const bytes=Buffer.alloc(payload.length+8);bytes.writeUInt32BE(bytes.length);bytes.write(type,4,4,'ascii');payload.copy(bytes,8);return bytes;}
function ispe(width,height){const bytes=Buffer.alloc(12);bytes.writeUInt32BE(width,4);bytes.writeUInt32BE(height,8);return box('ispe',bytes);}
function clap(cropRight){const bytes=Buffer.alloc(32);bytes.writeUInt32BE(1000000,0);bytes.writeUInt32BE(cropRight,4);bytes.writeUInt32BE(10000,8);bytes.writeUInt32BE(1,12);bytes.writeUInt32BE(1,20);bytes.writeUInt32BE(1,28);return box('clap',bytes);}
const ftyp=(brand='avif')=>box('ftyp',Buffer.concat([Buffer.from(brand),Buffer.alloc(4),Buffer.from(brand)]));
const meta=properties=>box('meta',Buffer.concat([Buffer.alloc(4),box('iprp',box('ipco',properties))]));
const heif=(brand='avif',width=640,height=480,extra=Buffer.alloc(0))=>Buffer.concat([ftyp(brand),meta(Buffer.concat([ispe(width,height),extra]))]);
const verified=(extension,buffer)=>verifyNoticeFile({filename:'fixture.'+extension,buffer});
const rejects=(extension,buffer,pattern)=>assert.throws(()=>verified(extension,buffer),error=>error.status===400&&(!pattern||pattern.test(error.message)));

test('notice file metadata recognizes PDF and every supported raster filename extension',()=>{
  assert.deepEqual(verified('pdf',Buffer.from('%PDF-1.7\nHeader fixture only\n%%EOF')),{mime:'application/pdf'});
  const fixtures=[['png',png(),'image/png'],['jpg',jpg(),'image/jpeg'],['jpeg',jpg(),'image/jpeg'],['gif',gif(),'image/gif'],['webp',webp(),'image/webp'],['bmp',bmp(),'image/bmp'],['tif',tiff(),'image/tiff'],['tiff',tiff(),'image/tiff'],['avif',heif('avif'),'image/avif'],['heic',heif('heic'),'image/heic'],['heif',heif('mif1'),'image/heif']];
  for(const [extension,bytes,mime] of fixtures)assert.deepEqual(verified(extension,bytes),{mime,width:640,height:480});
});

test('spoofed formats, unsupported active markup, missing PDF EOF, oversized files and truncated headers fail',()=>{
  rejects('jpg',png(),/contents do not match/);rejects('pdf',png(),/contents do not match/);rejects('png',Buffer.from('<svg onload="alert(1)"></svg>'),/supported/);rejects('pdf',Buffer.from('<html><script>alert(1)</script></html>'),/supported/);
  rejects('svg',png(),/Use a PDF/);rejects('pdf',Buffer.from('%PDF-1.7\nNo end marker'),/supported/);rejects('png',png().subarray(0,20),/incomplete|invalid/);rejects('jpg',Buffer.from([255,216,255]),/between/);
  rejects('png',Buffer.alloc(20*1024*1024+1),/20 MiB/);rejects('png',new Uint8Array(png()),/20 MiB/);
});

test('pixel and edge limits apply to supported raster headers and permit their exact boundaries',()=>{
  assert.equal(verified('png',png(10000,10000)).width,10000);assert.equal(verified('png',png(30000,1)).width,30000);
  for(const bytes of [png(10001,10000),png(30001,1),png(1,30001),png(0,1)])rejects('png',bytes,/100 megapixels/);
  rejects('jpg',jpg(30001,1),/100 megapixels/);rejects('gif',gif(30001,1),/100 megapixels/);rejects('bmp',bmp(30001,1),/100 megapixels/);rejects('tiff',tiff(30001,1),/100 megapixels/);rejects('webp',webp(30001,1),/100 megapixels/);
});

test('raw AVIF/HEIF dimensions cannot be hidden by crop metadata, and preview sizing uses the largest raw image',()=>{
  rejects('avif',heif('avif',1000000,10000,clap(999999)),/100 megapixels/);
  rejects('heic',heif('heic',1000000,10000,clap(999999)),/100 megapixels/);
  const safeRaw=verified('avif',heif('avif',10000,2000,clap(9999)));assert.deepEqual(safeRaw,{mime:'image/avif',width:10000,height:2000});
  const larger=Buffer.concat([ftyp(),meta(Buffer.concat([ispe(640,480),ispe(5000,4000)]))]);assert.equal(verified('avif',larger).width,5000);assert.equal(verified('avif',larger).height,4000);
});

test('ISO image container traversal rejects malformed, excessive and deeply nested boxes without scanning compressed data as boxes',()=>{
  const truncated=heif().subarray(0,-1);rejects('avif',truncated,/container|incomplete/);
  const incompleteDimensions=Buffer.concat([ftyp(),meta(box('ispe',Buffer.alloc(8)))]);rejects('avif',incompleteDimensions,/dimensions/);
  const tooManyImages=Buffer.concat([ftyp(),meta(Buffer.concat(Array.from({length:65},()=>ispe(1,1))))]);rejects('avif',tooManyImages,/dimensions/);
  const tooManyBoxes=Buffer.concat([heif(),...Array.from({length:4097},()=>box('free'))]);rejects('avif',tooManyBoxes,/excessive/);
  let nested=ispe(1,1);for(let i=0;i<7;i++)nested=box('meta',Buffer.concat([Buffer.alloc(4),nested]));rejects('avif',Buffer.concat([ftyp(),nested]),/nested too deeply/);
  const wide=Buffer.alloc(16);wide.writeUInt32BE(1);wide.write('free',4);wide.writeBigUInt64BE(2n**63n,8);rejects('avif',Buffer.concat([heif(),wide]),/too large/);
  const opaquePayload=Buffer.concat([heif(),box('mdat',Buffer.from('ispe'.repeat(100)))]);assert.deepEqual(verified('avif',opaquePayload),{mime:'image/avif',width:640,height:480});
});
