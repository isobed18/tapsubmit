// Bounded HTTP deployment smoke check. No employer submissions, credentials or private CVs.
import {writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
const origin=(process.argv[2]||'http://127.0.0.1:53358').replace(/\/$/,''),output=process.argv[3];
const checks=[];
for(const[path,expected,method]of [
 ['/',200,'GET'],['/applyburst/',200,'GET'],['/healthz',200,'GET'],['/api/public/config',200,'GET'],['/api/public/vocabulary',200,'GET'],['/api/public/pool/stats',200,'GET'],['/assets/discovery.js',200,'GET'],['/assets/discovery.css',200,'GET'],['/assets/city-picker.mjs',200,'GET'],['/assets/tom-select.js',200,'GET'],['/assets/tom-select.css',200,'GET'],['/assets/match-ui.mjs',200,'GET'],['/assets/client-match.mjs',200,'GET'],['/assets/resume-reader.mjs',200,'GET'],['/assets/pdf.min.mjs',200,'GET'],['/assets/pdf.worker.min.mjs',200,'GET'],['/download/extension',404,'GET'],
 ['/api/register',404,'POST'],['/api/login',404,'POST'],['/api/profile',404,'POST'],['/api/browser',404,'POST'],['/api/extension/sync',404,'GET'],['/api/extension/event',404,'POST'],['/api/applications/prepare-one',404,'POST'],['/api/applications/submit-one',404,'POST'],['/applyburst/api/register',404,'POST'],['/applyburst/api/extension/sync',404,'GET'],
]){
 const tick=performance.now(),r=await fetch(origin+path,{method,redirect:'follow',headers:method==='POST'?{'Content-Type':'application/json',Origin:origin}:undefined,body:method==='POST'?'{}':undefined,signal:AbortSignal.timeout(30000)});
 const bytes=new Uint8Array(await r.arrayBuffer());
 checks.push({path,method,status:r.status,expected,pass:r.status===expected,bytes:bytes.length,elapsed_ms:Math.round(performance.now()-tick),sets_cookie:r.headers.has('set-cookie')});
}
const health=await(await fetch(origin+'/healthz')).json();
const result={date:new Date().toISOString(),origin,health,checks,passed:checks.filter(c=>c.pass&&!c.sets_cookie).length,total:checks.length};
if(output){mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify(result,null,2));if(result.passed!==result.total)process.exitCode=1;
