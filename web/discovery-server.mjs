// Public Railway entry point. No Auth, Applications, browser controller, or upload routes.
import {createServer} from 'node:http';
import {readFileSync,existsSync,mkdirSync,statSync,createReadStream} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {Store} from './lib/store.mjs';
import {IndexedSearch} from './lib/indexed-search.mjs';
import {Planner} from './lib/planner.mjs';
import {publicDiscovery} from './lib/public-discovery.mjs';
import {decorate} from './lib/jobs.mjs';
import {semanticStats,encoder} from './lib/semantic.mjs';
import {PublicPool} from './lib/public-pool.mjs';
import {createHash} from 'node:crypto';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
export async function createDiscoveryServer({root=ROOT,directory=process.env.APPLYBURST_DATA||join(ROOT,'.data/railway-preview'),publicOrigin=process.env.APPLYBURST_PUBLIC_ORIGIN||'https://tapsubmit.com',seed=true}={}){
 mkdirSync(directory,{recursive:true});
 const store=new Store(join(directory,'discovery.sqlite'));
 const search=new IndexedSearch(store);
 if(seed&&!store.setting('public_seed_v1')){
  const snapshot=JSON.parse(readFileSync(join(root,'demo/public/jobs.json'),'utf8'));
  const groups=new Map();
  for(const raw of snapshot.jobs){
   const id=raw.provider+':'+raw.board,job=decorate({...raw,source_id:id,source_kind:'ats'});
   if(!groups.has(id))groups.set(id,[]);groups.get(id).push(job);
  }
  for(const[id,jobs]of groups)store.replaceSource({id,provider:jobs[0].provider,board:jobs[0].board,kind:'ats'},jobs,{complete:false,report:{outcome:'bundled_public_snapshot'}});
  store.setting('public_seed_v1',true);
 }
 await search.load();
 // Shared harvested pool (read-only, built into the image). Company-site searches query it next to the
 // bundled snapshot; its jobs are read on demand and never copied to the volume.
 const pool=new PublicPool(join(root,'public-pool/pool.sqlite'),join(root,'public-pool/manifest.json'));
 const ownGet=store.getJob.bind(store);store.getJob=id=>ownGet(id)||pool.get(id);
 const combined=new Proxy(search,{get(target,key){
  if(key==='query')return async(query,filters,limit)=>{const [a,b]=await Promise.all([target.query(query,filters,limit),pool.query(query,filters,limit)]);const seen=new Set(a.results.map(r=>r.id));return{...a,results:[...a.results,...b.results.filter(r=>!seen.has(r.id))].slice(0,limit),total:a.total+b.total};};
  const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 const planner=new Planner({store,dataDirectory:directory});
 if(process.env.APPLYBURST_PRELOAD_MODEL==='1')await encoder(directory);
 const origins=[publicOrigin,...(process.env.RAILWAY_PUBLIC_DOMAIN?['https://'+process.env.RAILWAY_PUBLIC_DOMAIN]:[]),...(process.env.APPLYBURST_EXTRA_ORIGINS||'').split(',').filter(Boolean)];
 const handler=publicDiscovery({root,store,search:combined,planner,base:'/applyburst',publicOrigin,publicOrigins:origins,maxRunning:2,maxTasks:60,pool});
 // The browser extension is paused; only the page assets are served.
 const assets={
  '/assets/discovery.js':['web/public/discovery.js','text/javascript; charset=utf-8'],
  '/assets/discovery.css':['web/public/discovery.css','text/css; charset=utf-8'],
  '/assets/city-picker.mjs':['web/public/city-picker.mjs','text/javascript; charset=utf-8'],
  '/assets/tom-select.js':['web/public/vendor/tom-select/tom-select.min.js','text/javascript; charset=utf-8'],
  '/assets/tom-select.css':['web/public/vendor/tom-select/tom-select.min.css','text/css; charset=utf-8'],
 };
 const cache=new Map();
 // Cloudflare keeps /assets for hours whatever we send: every asset URL carries a content version, so a
 // deploy is never served a cached script that no longer matches its page.
 const BUILD=createHash('sha256').update(['web/public/discovery.html','web/public/discovery.js','web/public/discovery.css','web/public/city-picker.mjs','web/public/resume-reader.mjs','web/shared/features.mjs','web/shared/professional.mjs','web/public/client-engine.mjs'].map(p=>existsSync(join(root,p))?readFileSync(join(root,p),'utf8'):'').join('|')).digest('hex').slice(0,12);
 const versioned=text=>String(text).replace(/(from\s*'|import\(')\.\/([\w.-]+\.m?js)'/g,(_,head,name)=>head+'./'+name+'?v='+BUILD+"'").replace(/(\/assets\/[\w.-]+\.(?:js|mjs|css))"/g,(_,url)=>url+'?v='+BUILD+'"');
 const csp="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://remoteok.com https://jobicy.com https://remotive.com https://www.arbeitnow.com; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
 const server=createServer(async(req,res)=>{
  const host=req.headers.host||'localhost';
  function send(status,value,type='application/json',headers={}){
   if(res.writableEnded)return;
   let bytes=Buffer.isBuffer(value)?value:Buffer.from(type==='application/json'?JSON.stringify(value):String(value));
   if(bytes.length>1024&&/\bgzip\b/.test(req.headers['accept-encoding']||'')){bytes=gzipSync(bytes);headers={...headers,'Content-Encoding':'gzip',Vary:'Accept-Encoding'};}
   res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':csp,...headers,'Content-Length':bytes.length});res.end(bytes);
  }
  const json=async(request,maximum=12000)=>{
   if(Number(request.headers['content-length']||0)>maximum)throw Object.assign(new Error('Request too large.'),{status:413});
   const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>maximum)throw Object.assign(new Error('Request too large.'),{status:413});chunks.push(chunk);}
   try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw Object.assign(new Error('Invalid JSON.'),{status:400});}
  };
  try{
   const url=new URL(req.url,'http://'+host);
   let path=url.pathname;if(path==='/applyburst'){send(302,'','text/plain',{Location:'/'});return;}
   if(path.startsWith('/applyburst/'))path=path.slice('/applyburst'.length);
   if(req.method==='GET'&&path==='/healthz'){
    send(200,{status:'ok',mode:'discovery_only',registration:false,applications:false,gpu:false,generative_llm:false,semantic_cpu:semanticStats().loaded,rss_mb:Math.round(process.memoryUsage().rss/1048576)});return;
   }
   if(req.method==='GET'&&(path==='/'||path==='/index.html')){send(200,versioned(readFileSync(join(root,'web/public/discovery.html'),'utf8')),'text/html; charset=utf-8');return;}
   if(req.method==='GET'&&path==='/robots.txt'){send(200,'User-agent: *\nDisallow: /api/\nDisallow: /applyburst/api/\n','text/plain');return;}
   // Download the shared pool (public posting metadata only, gzip JSON lines). Streamed, never buffered.
   if(req.method==='GET'&&path==='/download/jobs.jsonl.gz'){
    const file=join(root,'public-pool/jobs-0001.jsonl.gz');if(!existsSync(file)){send(404,{error:'Download is not available yet.'});return;}
    res.writeHead(200,{'Content-Type':'application/gzip','Content-Length':statSync(file).size,'Content-Disposition':'attachment; filename="tapsubmit-jobs.jsonl.gz"','Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff'});createReadStream(file).pipe(res);return;
   }
   if(req.method==='GET'&&path==='/download/jobs-manifest.json'){const file=join(root,'public-pool/manifest.json');if(existsSync(file)){send(200,readFileSync(file),'application/json',{'Cache-Control':'public, max-age=3600'});return;}}
   if(req.method==='GET'&&assets[path]){
    const[file,type]=assets[path],full=join(root,file);if(!existsSync(full)){send(404,{error:'Download is not available yet.'});return;}
    if(!cache.has(file))cache.set(file,/.m?js$/.test(file)&&!file.includes('/vendor/')?Buffer.from(versioned(readFileSync(full,'utf8'))):readFileSync(full));
    // Page code must never be older than the page: a cached script against a new HTML broke the site
    // after a deploy ("Cannot read properties of null (reading 'checked')"). Vendor files may cache.
    send(200,cache.get(file),type,{'Cache-Control':file.includes('/vendor/')?'public, max-age=86400':'no-cache'});return;
   }
   if(await handler({req,path,url,send,json,host}))return;
   req.resume();send(404,{error:'This preview supports job discovery only.'});
  }catch(error){req.resume();send(error.status||400,{error:error.status?error.message:'Search could not finish. Please try again.'});}
 });
 server.requestTimeout=20000;server.headersTimeout=15000;
 return{server,store,close:async()=>{await new Promise(resolve=>server.close(resolve));store.db.close();}};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const app=await createDiscoveryServer(),port=Number(process.env.PORT||process.env.APPLYBURST_PORT||8789);
 app.server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({service:'tapsubmit-discovery',port,mode:'discovery_only',rss_mb:Math.round(process.memoryUsage().rss/1048576)})));
 let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.close();process.exit(0);};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
