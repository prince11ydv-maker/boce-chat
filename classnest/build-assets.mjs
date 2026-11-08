import {copyFile,cp,mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

// Generated assets stay out of the source archive; npm ci recreates this exact
// version locally and during deployment. No CDN or third-party viewer is used.
const root=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(import.meta.url);
const source=path.dirname(require.resolve('pdfjs-dist/package.json'));
const metadata=JSON.parse(await readFile(path.join(source,'package.json'),'utf8'));
if(metadata.version!=='6.5.438')throw new Error('Install the locked PDF.js version before building preview assets.');
const target=path.join(root,'public','vendor','pdfjs');
await mkdir(path.join(target,'wasm'),{recursive:true});
for(const file of ['pdf.min.mjs','pdf.worker.min.mjs'])await copyFile(path.join(source,'build',file),path.join(target,file));
for(const directory of ['cmaps','standard_fonts'])await cp(path.join(source,directory),path.join(target,directory),{recursive:true,force:true});
await copyFile(path.join(source,'LICENSE'),path.join(target,'LICENSE'));
// PDF image codecs use their JavaScript fallbacks; do not ship the PDF scripting
// sandbox, QuickJS, or WebAssembly binaries to the preview client.
for(const file of ['openjpeg_nowasm_fallback.js','jbig2_nowasm_fallback.js','LICENSE_OPENJPEG','LICENSE_PDFJS_OPENJPEG','LICENSE_JBIG2','LICENSE_PDFJS_JBIG2'])await copyFile(path.join(source,'wasm',file),path.join(target,'wasm',file));
console.log('Prepared local PDF.js '+metadata.version+' preview assets.');
