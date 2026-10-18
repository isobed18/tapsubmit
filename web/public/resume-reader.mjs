// This module never makes a network request with the file or extracted text.
export async function resumeText(file){
 if(file.size>12*1024*1024)throw new Error('Use a CV smaller than 12 MB.');
 if(/\.txt$/i.test(file.name))return(await file.text()).slice(0,100000);
 const bytes=new Uint8Array(await file.arrayBuffer());
 if(/\.docx$/i.test(file.name))return docxText(bytes);
 if(/\.pdf$/i.test(file.name)){
  const pdfjs=await import('./pdf.min.mjs');pdfjs.GlobalWorkerOptions.workerSrc=new URL('./pdf.worker.min.mjs',import.meta.url).href;
  const loading=pdfjs.getDocument({data:bytes,isEvalSupported:false,useSystemFonts:true});let pdf;
  try{pdf=await loading.promise;if(pdf.numPages>30)throw new Error('Use a CV with no more than 30 pages.');let text='';for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n),content=await page.getTextContent();text+=content.items.map(x=>x.str||'').join(' ')+'\n';if(text.length>100000)throw new Error('The CV contains too much text. Use a shorter CV.');}if(text.trim().length<40)throw new Error('This PDF has too little selectable text and may need OCR. Use a text PDF, DOCX or TXT CV.');return text;}
  catch(error){if(error.name==='PasswordException')throw new Error('This PDF is password-protected. Upload an unlocked copy.');if(error.name==='InvalidPDFException')throw new Error('This PDF could not be read. Export it again as a text PDF, or use DOCX or TXT.');throw error;}
  finally{await loading.destroy();}
 }
 throw new Error('Choose a PDF, DOCX or TXT CV.');
}
async function docxText(bytes){
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),decoder=new TextDecoder();let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(view.getUint32(i,true)===0x06054b50){end=i;break;}
 if(end<0)throw new Error('Invalid DOCX file.');
 const count=view.getUint16(end+10,true);let offset=view.getUint32(end+16,true);
 for(let i=0;i<count;i++){
  if(offset+46>bytes.length||view.getUint32(offset,true)!==0x02014b50)break;
  const method=view.getUint16(offset+10,true),size=view.getUint32(offset+20,true),expanded=view.getUint32(offset+24,true),nameLen=view.getUint16(offset+28,true),extra=view.getUint16(offset+30,true),comment=view.getUint16(offset+32,true),local=view.getUint32(offset+42,true),name=decoder.decode(bytes.slice(offset+46,offset+46+nameLen));
  if(name==='word/document.xml'){
   if(size>12e6||expanded>20e6||local+30>bytes.length||view.getUint32(local,true)!==0x04034b50)throw new Error('Unsupported DOCX size.');
   const start=local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true);if(start+size>bytes.length)throw new Error('Truncated DOCX.');
   let raw=bytes.slice(start,start+size);if(method===8){const reader=new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(),chunks=[];let total=0;try{while(true){const{done,value}=await reader.read();if(done)break;total+=value.length;if(total>20e6){await reader.cancel();throw new Error('DOCX expansion exceeds 20 MB.');}chunks.push(value);}}finally{reader.releaseLock();}raw=new Uint8Array(total);let at=0;for(const chunk of chunks){raw.set(chunk,at);at+=chunk.length;}}else if(method!==0)throw new Error('Unsupported DOCX compression.');
   if(raw.length!==expanded||raw.length>20e6)throw new Error('Invalid DOCX expansion.');const xml=decoder.decode(raw);if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('Unsupported DOCX XML.');
   const doc=new DOMParser().parseFromString(xml,'application/xml');if(doc.querySelector('parsererror'))throw new Error('Invalid DOCX document.');
   return [...doc.getElementsByTagNameNS('*','p')].map(p=>[...p.getElementsByTagNameNS('*','t')].map(t=>t.textContent).join('')).join('\n').slice(0,100000);
  }
  offset+=46+nameLen+extra+comment;
 }
 throw new Error('No text document found in this DOCX.');
}
