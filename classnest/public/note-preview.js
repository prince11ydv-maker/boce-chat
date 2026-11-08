/* Attachment bytes are fetched only from this app and rendered without HTML,
   document scripts, external viewers, PDF plugins, or iframes. */
(() => {
  'use strict';
  const maxFileBytes=20*1024*1024,maxTextBytes=1024*1024,maxCanvasPixels=6_000_000,maxImagePixels=16_000_000;
  const imageMimes=['image/png','image/jpeg','image/webp','image/gif','image/bmp','image/avif'];
  const mounts=new WeakMap();
  const previewError=message=>Object.assign(new Error(message),{name:'PreviewError'});
  let libraryPromise;
  function element(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
  async function pdfLibrary(){
    if(!libraryPromise)libraryPromise=import('/vendor/pdfjs/pdf.min.mjs').then(library=>{library.GlobalWorkerOptions.workerSrc='/vendor/pdfjs/pdf.worker.min.mjs';return library;}).catch(error=>{libraryPromise=null;throw error;});
    return libraryPromise;
  }
  function kindOf(note){
    const mime=String(note.mime||'').split(';')[0].toLowerCase(),extension=String(note.originalName||'').split('.').pop().toLowerCase();
    if(mime==='application/pdf'||!mime&&extension==='pdf')return 'pdf';
    if(imageMimes.includes(mime)||!mime&&['png','jpg','jpeg','webp','gif','bmp','avif'].includes(extension))return 'image';
    if(['text/plain','text/markdown'].includes(mime)||!mime&&['txt','md'].includes(extension))return 'text';
    return null;
  }
  function imageSize(bytes,mime){
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if(mime==='image/png'&&bytes.length>=24)return [view.getUint32(16),view.getUint32(20)];
    if(mime==='image/jpeg'&&bytes[0]===255&&bytes[1]===216){
      let at=2;
      while(at+3<bytes.length){
        if(bytes[at++]!==255)break;
        while(bytes[at]===255)at++;
        const marker=bytes[at++];
        if(marker===217||marker===218)break;
        if(marker===216||marker===1||marker>=208&&marker<=215)continue;
        if(at+2>bytes.length)break;
        const length=view.getUint16(at);
        if(length<2||at+length>bytes.length)break;
        if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=8)return [view.getUint16(at+5),view.getUint16(at+3)];
        at+=length;
      }
    }
    if(mime==='image/webp'&&bytes.length>=25){
      const chunk=String.fromCharCode(...bytes.subarray(12,16));
      if(chunk==='VP8X'&&bytes.length>=30)return [1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16),1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16)];
      if(chunk==='VP8L'&&bytes[20]===47)return [1+bytes[21]+((bytes[22]&63)<<8),1+(bytes[22]>>6)+(bytes[23]<<2)+((bytes[24]&15)<<10)];
      if(chunk==='VP8 '&&bytes.length>=30&&bytes[23]===157&&bytes[24]===1&&bytes[25]===42)return [view.getUint16(26,true)&16383,view.getUint16(28,true)&16383];
    }
    if(mime==='image/gif'&&bytes.length>=10&&String.fromCharCode(...bytes.subarray(0,6)).match(/^GIF8[79]a$/))return [view.getUint16(6,true),view.getUint16(8,true)];
    if(mime==='image/bmp'&&bytes.length>=26&&bytes[0]===66&&bytes[1]===77){
      const dib=view.getUint32(14,true);
      if(dib===12)return [view.getUint16(18,true),view.getUint16(20,true)];
      if(dib>=40&&bytes.length>=54)return [view.getInt32(18,true),Math.abs(view.getInt32(22,true))];
    }
    if(mime==='image/avif'){
      // Read bounded ISO-BMFF image properties before asking the browser to
      // decode. Unknown layouts retain the download fallback.
      const stack=[{start:0,end:bytes.length}],sizes=[];let boxes=0;
      while(stack.length){
        const range=stack.pop();let at=range.start;
        while(at+8<=range.end){
          if(++boxes>20000)throw previewError('This image has too many properties for a preview. Download the original instead.');
          let length=view.getUint32(at),header=8;const type=String.fromCharCode(...bytes.subarray(at+4,at+8));
          if(length===1){if(at+16>range.end)break;const high=view.getUint32(at+8),low=view.getUint32(at+12);length=high*4294967296+low;header=16;}
          if(length===0)length=range.end-at;
          if(!Number.isSafeInteger(length)||length<header||at+length>range.end)break;
          const start=at+header,end=at+length;
          if(type==='ispe'&&end-start>=12)sizes.push([view.getUint32(start+4),view.getUint32(start+8)]);
          if(['meta','iprp','ipco'].includes(type)){const childStart=start+(type==='meta'?4:0);if(childStart<end)stack.push({start:childStart,end});}
          at=end;
        }
      }
      if(sizes.length)return [Math.max(...sizes.map(size=>size[0])),Math.max(...sizes.map(size=>size[1]))];
    }
    throw previewError('This image cannot be previewed. Download the original instead.');
  }
  async function readBytes(response,{text=false}={}){
    const declared=Number(response.headers.get('content-length'));
    if(Number.isFinite(declared)&&declared>maxFileBytes){await response.body?.cancel().catch(()=>{});throw previewError('Files larger than 20 MB cannot be previewed.');}
    if(!response.body)throw previewError('The attachment could not be loaded.');
    const reader=response.body.getReader(),chunks=[];let length=0,truncated=false;
    try{
      while(true){
        const {value,done}=await reader.read();if(done)break;
        if(length+value.byteLength>maxFileBytes)throw previewError('Files larger than 20 MB cannot be previewed.');
        if(text&&length+value.byteLength>maxTextBytes){chunks.push(value.subarray(0,maxTextBytes-length));length=maxTextBytes;truncated=true;await reader.cancel();break;}
        chunks.push(value);length+=value.byteLength;
      }
    }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return {bytes,truncated};
  }
  function within(promise,milliseconds,onTimeout){
    let timer;
    return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{try{onTimeout();}catch{}reject(previewError('The preview took too long. Download the original instead.'));},milliseconds);})]).finally(()=>clearTimeout(timer));
  }
  function mount(container,note){
    if(!container||typeof container.replaceChildren!=='function')return ()=>{};
    mounts.get(container)?.();
    container.classList.add('note-preview');container.replaceChildren();
    const status=element('p','note-preview-status','Loading your attachment…');status.setAttribute('role','status');container.append(status);
    const abort=new AbortController();let active=true,objectUrl,loadingTask,pdf,renderTask,resizeObserver,resizeTimer,fetchTimer,requestTimedOut=false,generation=0,lastPage;
    const alive=()=>active&&container.isConnected;
    function cleanup(){
      if(!active)return;active=false;generation++;clearTimeout(fetchTimer);clearTimeout(resizeTimer);abort.abort();
      resizeObserver?.disconnect();renderTask?.cancel();
      try{const done=loadingTask?.destroy();done?.catch(()=>{});}catch{}
      if(objectUrl)URL.revokeObjectURL(objectUrl);
      mounts.delete(container);
    }
    mounts.set(container,cleanup);
    function errorMessage(message){if(!alive())return;status.className='note-preview-status note-preview-error';status.textContent=message;}
    function haltPdf(){renderTask?.cancel();try{loadingTask?.destroy()?.catch(()=>{});}catch{}}
    async function showPdf(bytes){
      const library=await pdfLibrary();if(!alive())return;
      loadingTask=library.getDocument({data:bytes,cMapUrl:'/vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/pdfjs/standard_fonts/',wasmUrl:'/vendor/pdfjs/wasm/',useWasm:false,isEvalSupported:false,disableFontFace:true,useSystemFonts:false,enableXfa:false,disableWorkerRendering:true,maxImageSize:maxImagePixels,canvasMaxAreaInBytes:24_000_000,stopAtErrors:true,verbosity:0});
      pdf=await within(loadingTask.promise,30_000,haltPdf);if(!alive())return;
      const toolbar=element('div','note-preview-toolbar'),previous=element('button','button button-small','← Previous'),next=element('button','button button-small','Next →'),pageLabel=element('span','note-preview-page'),zoomLabel=element('label','note-preview-zoom','Zoom '),zoomControl=element('select'),textButton=element('button','button button-small','Read page text');
      for(const button of [previous,next,textButton])button.type='button';
      previous.setAttribute('aria-label','Previous PDF page');next.setAttribute('aria-label','Next PDF page');pageLabel.setAttribute('aria-live','polite');zoomControl.setAttribute('aria-label','PDF zoom');textButton.setAttribute('aria-pressed','false');
      for(const [value,label] of [['1','Fit width'],['1.25','125%'],['1.5','150%'],['2','200%']]){const option=element('option','',label);option.value=value;zoomControl.append(option);}
      zoomLabel.append(zoomControl);toolbar.append(previous,pageLabel,next,zoomLabel,textButton);
      const viewport=element('div','note-preview-viewport'),canvas=element('canvas','note-preview-canvas'),pageText=element('pre','note-preview-text');canvas.setAttribute('role','img');viewport.append(canvas);pageText.hidden=true;container.append(toolbar,viewport,pageText);
      let pageNumber=1,zoom=1,busy=false,textMode=false;
      function controls(){previous.disabled=busy||pageNumber<=1;next.disabled=busy||pageNumber>=pdf.numPages;zoomControl.disabled=busy||textMode;textButton.disabled=busy;pageLabel.textContent=`Page ${pageNumber} of ${pdf.numPages}`;}
      async function render(){
        const turn=++generation,prior=renderTask;renderTask=null;prior?.cancel();if(prior)await prior.promise.catch(()=>{});
        if(!alive()||turn!==generation)return;
        busy=true;controls();status.textContent='Loading page '+pageNumber+'…';
        try{
          lastPage?.cleanup();lastPage=await pdf.getPage(pageNumber);if(!alive()||turn!==generation)return;
          if(textMode){
            const content=await within(lastPage.getTextContent(),20_000,haltPdf);if(!alive()||turn!==generation)return;
            let text='';for(const item of content.items){if(typeof item.str!=='string')continue;text+=item.str+(item.hasEOL?'\n':' ');if(text.length>=100_000){text=text.slice(0,100_000)+'\n\n[Page text shortened for preview.]';break;}}
            pageText.textContent=text.trim()||'No readable text was found on this page. Switch back to the PDF view to see scanned pages.';
          }else{
            const natural=lastPage.getViewport({scale:1}),width=Math.max(220,Math.min(viewport.clientWidth||container.clientWidth||780,1600)-24),desired=width/natural.width*zoom;
            const scale=Math.min(desired,Math.sqrt(maxCanvasPixels/(natural.width*natural.height)),8192/Math.max(natural.width,natural.height));
            if(!Number.isFinite(scale)||scale<=0)throw previewError('This PDF page cannot be previewed. Download the original instead.');
            const size=lastPage.getViewport({scale});canvas.width=Math.max(1,Math.floor(size.width));canvas.height=Math.max(1,Math.floor(size.height));canvas.setAttribute('aria-label',`Page ${pageNumber} of ${pdf.numPages}: ${String(note.title||'Shared note')}`);
            renderTask=lastPage.render({canvas,canvasContext:canvas.getContext('2d',{alpha:false}),viewport:size});await within(renderTask.promise,20_000,haltPdf);
          }
          if(!alive()||turn!==generation)return;status.textContent='';status.className='note-preview-status';
        }catch(error){if(alive()&&turn===generation&&error.name!=='RenderingCancelledException'){errorMessage(error.name==='PasswordException'?'This PDF is password-protected. Download it to open with its password.':'This PDF could not be rendered. Download the original instead.');}}
        finally{if(alive()&&turn===generation){busy=false;controls();}}
      }
      previous.addEventListener('click',()=>{if(!busy&&pageNumber>1){pageNumber--;render();}});next.addEventListener('click',()=>{if(!busy&&pageNumber<pdf.numPages){pageNumber++;render();}});
      zoomControl.addEventListener('change',()=>{zoom=Number(zoomControl.value)||1;render();});
      textButton.addEventListener('click',()=>{textMode=!textMode;viewport.hidden=textMode;pageText.hidden=!textMode;textButton.textContent=textMode?'View PDF page':'Read page text';textButton.setAttribute('aria-pressed',String(textMode));render();});
      if(typeof ResizeObserver==='function'){let measured=container.clientWidth;resizeObserver=new ResizeObserver(()=>{const width=container.clientWidth;if(Math.abs(width-measured)<3)return;measured=width;clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(alive()&&!textMode)render();},180);});resizeObserver.observe(container);}
      await render();
    }
    (async()=>{
      const kind=kindOf(note||{});
      if(!kind){status.textContent='Download the original to open this file in its own app. PDF and common photo formats can be viewed here; HEIC/HEIF and TIFF files retain the original download.';return;}
      if(typeof note.id!=='string'||!note.id.length||note.id.length>100)throw previewError('This note is unavailable.');
      const defaultEndpoint='/api/notes/'+encodeURIComponent(note.id)+'/preview',noticeEndpoint='/api/notices/'+encodeURIComponent(note.id)+'/preview';
      const endpoint=note.previewUrl===undefined?defaultEndpoint:note.previewUrl;
      if(endpoint!==defaultEndpoint&&endpoint!==noticeEndpoint)throw previewError('This attachment preview is unavailable.');
      fetchTimer=setTimeout(()=>{requestTimedOut=true;abort.abort();},60_000);
      const response=await fetch(endpoint,{credentials:'same-origin',redirect:'error',cache:'no-store',headers:{'X-Classnest-Request':'1'},signal:abort.signal});
      if(!response.ok){await response.body?.cancel().catch(()=>{});throw previewError(response.status===415?'This file type cannot be previewed. Download it to open in its original app.':response.status===404?'This attachment is no longer available.':'The attachment could not be loaded. Please try again or download it.');}
      const mime=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
      if(kind==='pdf'&&mime!=='application/pdf'||kind==='image'&&!imageMimes.includes(mime)||kind==='text'&&!['text/plain','text/markdown'].includes(mime)){await response.body?.cancel().catch(()=>{});throw previewError('This file cannot be previewed safely. Download the original instead.');}
      const {bytes,truncated}=await readBytes(response,{text:kind==='text'});clearTimeout(fetchTimer);if(!alive())return;
      if(kind==='pdf')await showPdf(bytes);
      else if(kind==='image'){
        const [width,height]=imageSize(bytes,mime);if(width<=0||height<=0||width>12000||height>12000||width*height>maxImagePixels)throw previewError('This image is too large for an inline preview. Download the original to view it.');
        const image=element('img','note-preview-image');image.alt=String(note.title||note.originalName||'Shared note');image.decoding='async';objectUrl=URL.createObjectURL(new Blob([bytes],{type:mime}));image.src=objectUrl;image.addEventListener('load',()=>{if(alive())status.textContent='';},{once:true});image.addEventListener('error',()=>errorMessage('This image could not be displayed. Download the original instead.'),{once:true});container.append(image);
      }else{
        const pre=element('pre','note-preview-text');pre.textContent=new TextDecoder('utf-8',{fatal:false}).decode(bytes,{stream:truncated});container.append(pre);status.textContent=truncated?'Showing the first 1 MB. Download the original for the full note.':'';
      }
    })().catch(error=>{clearTimeout(fetchTimer);if(!alive()||error.name==='AbortError'&&!requestTimedOut)return;errorMessage(requestTimedOut?'The preview took too long to load. Please try again or download the original.':error.name==='PasswordException'?'This PDF is password-protected. Download it to open with its password.':error.name==='PreviewError'?error.message:'Preview is unavailable in this browser. Download the original instead.');});
    return cleanup;
  }
  window.ClassnestPreview=Object.freeze({mount});
})();
