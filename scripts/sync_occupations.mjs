// Build-time public taxonomy import. Runtime uses the compact local file, never the ESCO API.
// No candidate data is sent. Keep the dataset version and response hashes reproducible.
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
const version='v1.2.1',folder='.data/research/esco-'+version;
mkdirSync(folder,{recursive:true});
async function page(offset){
 const file=folder+'/page-'+offset+'.json';
 if(existsSync(file))return JSON.parse(readFileSync(file,'utf8'));
 const url=new URL('https://ec.europa.eu/esco/api/resource/occupation');
 for(const [key,value] of Object.entries({isInScheme:'http://data.europa.eu/esco/concept-scheme/occupations',language:'en',selectedVersion:version,limit:100,offset}))url.searchParams.set(key,value);
 const response=await fetch(url,{signal:AbortSignal.timeout(30000),headers:{Accept:'application/json'}});
 if(!response.ok)throw new Error('ESCO HTTP '+response.status);
 const text=await response.text();if(Buffer.byteLength(text)>20000000)throw new Error('Taxonomy page exceeds budget.');
 const result=JSON.parse(text);if(!result._embedded||!result.total)throw new Error('Unexpected ESCO response.');
 writeFileSync(file,text);return result;
}
const first=await page(0),pages=[first],total=first.total;
// API offset is a PAGE NUMBER, not a record offset. Bounded three-request parallelism.
for(let at=1;at<Math.ceil(total/100);at+=3){
 const batch=await Promise.all(Array.from({length:Math.min(3,Math.ceil(total/100)-at)},(_,i)=>page(at+i)));
 pages.push(...batch);console.log('Read occupations:',Math.min(pages.length*100,total)+'/'+total);
}
const occupations=new Map(),seen=new Set();
for(const data of pages)for(const [uri,item] of Object.entries(data._embedded)){
 seen.add(uri);
 if(!uri.includes('/occupation/')||!item.preferredLabel?.en)continue;
 const labels={};for(const [language,preferred] of Object.entries(item.preferredLabel)){
  labels[language]=[...new Set([preferred,...(item.alternativeLabel?.[language]||[])].filter(t=>typeof t==='string'&&t.length<180))];
 }
 occupations.set(uri,{id:uri.split('/').at(-1),title:item.preferredLabel.en,labels});
}
// Bulk API also returns ISCO hierarchy/group nodes. Validate pagination before omitting those
// broad groups: matching a whole group is not evidence of the same specific occupation.
if(seen.size!==total||!occupations.size)throw new Error('Incomplete taxonomy: '+seen.size+'/'+total);
const out={source:'https://esco.ec.europa.eu/en/use-esco',version,imported_at:new Date().toISOString(),languages:[...new Set([...occupations.values()].flatMap(o=>Object.keys(o.labels)))].sort(),occupations:[...occupations.values()].sort((a,b)=>a.id.localeCompare(b.id))};
const encoded=JSON.stringify(out),compressed=gzipSync(encoded+'\n',{level:9});writeFileSync('config/occupations.esco.json.gz',compressed);
const provenance={version,count:occupations.size,source_concepts:total,hierarchy_groups_omitted:seen.size-occupations.size,bytes:Buffer.byteLength(encoded)+1,compressed_bytes:compressed.length,sha256:createHash('sha256').update(encoded+'\n').digest('hex'),compressed_sha256:createHash('sha256').update(compressed).digest('hex'),pages:pages.length,api:'https://ec.europa.eu/esco/api/resource/occupation',raw_cache:folder};
writeFileSync('reports/model-layer/occupation-source.json',JSON.stringify(provenance,null,2)+'\n');console.log(JSON.stringify(provenance));
