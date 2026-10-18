// Client-side CV processing, occupation planning, matching, caching, continuation,
// direct browser job fetching (for CORS-enabled public APIs), and local device companion bridge.
import {resumeText} from './resume-reader.mjs';
import {profileFeatures,suggestedSearches,ROLES,jobFeatures,fold} from '../shared/features.mjs';
import {matchProfessionalTitles,roleKey} from '../shared/professional.mjs';

const VOCAB_KEY='ab_vocab_cache_v2';
const FEED_CACHE_KEY='ab_client_feeds_v1';
const CURSOR_KEY='ab_client_cursors_v1';
const RATE_KEY='ab_client_rates_v1';
const GUEST_CV_KEY='ab_guest_cv_v1';
const FEED_TTL_MS=10*60*1000;

let memoryVocab=null;
let pendingFile=null;

function readStore(key,fallback={}){
 try{return typeof localStorage!=='undefined'?JSON.parse(localStorage.getItem(key)||JSON.stringify(fallback)):fallback;}catch{return fallback;}
}
function writeStore(key,value){
 try{if(typeof localStorage!=='undefined')localStorage.setItem(key,JSON.stringify(value));}catch{}
}

export async function loadVocabulary(base='/applyburst/api/'){
 if(memoryVocab)return memoryVocab;
 const cached=readStore(VOCAB_KEY,null);
 if(cached&&Array.isArray(cached.entries)&&cached.entries.length>1000&&Date.now()-(cached.at||0)<24*3600*1000){
  memoryVocab=cached;
  return memoryVocab;
 }
 const res=await fetch(base+'public/vocabulary',{credentials:'same-origin'});
 if(!res.ok)return{titles:[],entries:[]};
 const data=await res.json();
 memoryVocab={titles:data.titles||[],entries:data.entries||[],at:Date.now()};
 writeStore(VOCAB_KEY,memoryVocab);
 return memoryVocab;
}

export function extractContactFacts(text=''){
 const lines=String(text||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
 const email=text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0]||'';
 const phone=text.match(/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-]?)\d{3}[\s.-]?\d{2,4}(?:[\s.-]?\d{2,4})?/)?.[0]?.trim()||'';
 const linkedin=text.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s)<>"']+/i)?.[0]||'';
 const github=text.match(/https?:\/\/(?:www\.)?github\.com\/[^\s)<>"']+/i)?.[0]||'';
 const nameLine=lines.find(l=>l.length>=3&&l.length<=60&&!/[@:/]|curriculum|resume|özgeçmiş/i.test(l))||'';
 return{name:nameLine,email,phone,linkedin,github};
}
export const extractLocalFacts=extractContactFacts;

export function planClientQueries({text='',query='',titles=[],features=null}={}){
 const feat=features||profileFeatures(text);
 const normTitles=titles.map(t=>typeof t==='string'?t:t?.title||t?.label).filter(Boolean);
 const roleLabels=(feat.roles||[]).map(id=>ROLES.find(r=>r.id===id)?.label).filter(Boolean);
 const explicit=String(query||'').trim();
 const queries=[...new Set([...(explicit?[explicit]:[]),...normTitles,...roleLabels,...suggestedSearches(feat)])].filter(Boolean).slice(0,4);
 return{queries,roles:[...new Set([...normTitles,...roleLabels])].slice(0,5),features:feat};
}

export function clientFilterJob(job,spec={}){
 const titleKey=roleKey(job?.title||'');
 const targetTitles=(spec.titles||[]).map(t=>roleKey(typeof t==='string'?t:t?.title||t?.label)).filter(Boolean);
 const targetRoles=new Set(spec.roles||[]);
 const jf=jobFeatures({title:job?.title||'',description:job?.description||'',skills:job?.skills||[]});
 const titleMatch=targetTitles.find(t=>t&&(titleKey.includes(t)||t.includes(titleKey)));
 const roleMatch=jf.roles.find(r=>targetRoles.has(r));
 const rivalRoles=jf.roles.filter(r=>!targetRoles.has(r));
 if(!titleMatch&&!roleMatch)return{accepted:false,reason:'unrelated_role'};
 if(!titleMatch&&rivalRoles.length&&!roleMatch)return{accepted:false,reason:'rival_profession'};
 const skillSet=new Set((spec.skills||[]).map(s=>fold(s)));
 const overlap=(jf.skills||[]).filter(s=>skillSet.has(fold(s)));
 const closestRole=titleMatch||(roleMatch?ROLES.find(r=>r.id===roleMatch)?.label||roleMatch:null);
 const review=!titleMatch&&overlap.length===0&&targetTitles.length>0;
 return{accepted:true,closest_role:closestRole,overlap,review,reason:review?'broad_role_match':null};
}

export async function processCVInBrowser(file,base='/applyburst/api/'){
 const t0=performance.now();
 pendingFile=file;
 const [text,vocab]=await Promise.all([resumeText(file),loadVocabulary(base)]);
 const features=profileFeatures(text);
 const titles=matchProfessionalTitles(text,vocab.entries||[]);
 const planned=planClientQueries({text,titles,features});
 const facts=extractContactFacts(text);
 const elapsed_ms=Math.round((performance.now()-t0)*10)/10;
 const summary={
  filename:file.name,
  name:facts.name||file.name.replace(/\.[^.]+$/,''),
  facts,
  features,
  titles,
  roles:planned.roles,
  queries:planned.queries,
  elapsed_ms,
  updated_at:Date.now()
 };
 writeStore(GUEST_CV_KEY,summary);
 return{summary,file};
}

export function getSavedGuestCV(){
 return readStore(GUEST_CV_KEY,null);
}

export function getPendingCVFile(){
 return pendingFile;
}

export function clearPendingCVFile(){
 pendingFile=null;
}

function classifyRoute(url=''){
 const lower=String(url||'').toLowerCase();
 if(lower.includes('greenhouse.io')||lower.includes('grnh.se'))return{label:'Greenhouse',family:'greenhouse',automatable:true};
 if(lower.includes('lever.co'))return{label:'Lever',family:'lever',automatable:true};
 if(lower.includes('ashbyhq.com'))return{label:'Ashby',family:'ashby',automatable:true};
 if(lower.includes('workable.com'))return{label:'Workable',family:'workable',automatable:true};
 if(lower.includes('linkedin.com'))return{label:'LinkedIn',family:'linkedin',automatable:true};
 return{label:'Employer site',family:null,automatable:false};
}

function stripHtml(html=''){
 return String(html||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
}

const CLIENT_SOURCES={
 remoteok:{
  label:'Remote OK',
  async fetchPage(query){
   const res=await fetch('https://remoteok.com/api',{signal:AbortSignal.timeout(8000)});
   if(!res.ok)throw Object.assign(new Error('HTTP '+res.status),{status:res.status});
   const raw=await res.json();
   const rows=Array.isArray(raw)?raw.filter(r=>r&&r.id&&r.position):[];
   return rows.map(r=>({
    id:'remoteok:'+r.id,
    title:String(r.position||'').trim(),
    company:String(r.company||'').trim(),
    location:String(r.location||'Remote').trim(),
    workplace:'remote',
    description:stripHtml(r.description||'').slice(0,4000),
    url:String(r.apply_url||r.url||'').trim(),
    posted_at:r.date||null,
    source:'remoteok',
    skills:Array.isArray(r.tags)?r.tags.slice(0,8):[]
   }));
  }
 },
 jobicy:{
  label:'Jobicy',
  async fetchPage(query){
   const tag=encodeURIComponent(String(query||'').split(/\s+/)[0]||'');
   const url='https://jobicy.com/api/v2/remote-jobs?count=50'+(tag?'&tag='+tag:'');
   const res=await fetch(url,{signal:AbortSignal.timeout(8000)});
   if(!res.ok)throw Object.assign(new Error('HTTP '+res.status),{status:res.status});
   const data=await res.json();
   const rows=Array.isArray(data?.jobs)?data.jobs:[];
   return rows.map(r=>({
    id:'jobicy:'+r.id,
    title:String(r.jobTitle||'').trim(),
    company:String(r.companyName||'').trim(),
    location:String(r.jobGeo||'Remote').trim(),
    workplace:'remote',
    description:stripHtml(r.jobDescription||r.jobExcerpt||'').slice(0,4000),
    url:String(r.url||'').trim(),
    posted_at:r.pubDate||null,
    source:'jobicy',
    skills:Array.isArray(r.jobIndustry)?r.jobIndustry.slice(0,5):[]
   }));
  }
 },
 remotive:{
  label:'Remotive',
  async fetchPage(query){
   const q=encodeURIComponent(String(query||'').trim());
   const url='https://remotive.com/api/remote-jobs?limit=50'+(q?'&search='+q:'');
   const res=await fetch(url,{signal:AbortSignal.timeout(8000)});
   if(!res.ok)throw Object.assign(new Error('HTTP '+res.status),{status:res.status});
   const data=await res.json();
   const rows=Array.isArray(data?.jobs)?data.jobs:[];
   return rows.map(r=>({
    id:'remotive:'+r.id,
    title:String(r.title||'').trim(),
    company:String(r.company_name||'').trim(),
    location:String(r.candidate_required_location||'Remote').trim(),
    workplace:'remote',
    description:stripHtml(r.description||'').slice(0,4000),
    url:String(r.url||'').trim(),
    posted_at:r.publication_date||null,
    source:'remotive',
    skills:Array.isArray(r.tags)?r.tags.slice(0,8):[]
   }));
  }
 },
 arbeitnow:{
  label:'Arbeitnow',
  async fetchPage(query,page=1){
   const res=await fetch(`https://www.arbeitnow.com/api/job-board-api?page=${page}`,{signal:AbortSignal.timeout(8000)});
   if(!res.ok)throw Object.assign(new Error('HTTP '+res.status),{status:res.status});
   const data=await res.json();
   const rows=Array.isArray(data?.data)?data.data:[];
   return rows.map(r=>({
    id:'arbeitnow:'+r.slug,
    title:String(r.title||'').trim(),
    company:String(r.company_name||'').trim(),
    location:String(r.location||'').trim(),
    workplace:r.remote?'remote':'onsite',
    description:stripHtml(r.description||'').slice(0,4000),
    url:String(r.url||'').trim(),
    posted_at:r.created_at?new Date(r.created_at*1000).toISOString():null,
    source:'arbeitnow',
    skills:Array.isArray(r.tags)?r.tags.slice(0,8):[]
   }));
  }
 }
};

export async function runClientSideFeeds({queries=[],titles=[],features={},country='worldwide',sites=[],limit=100,expand=false,onSource,onJobBatch}={}){
 const chosen=sites.filter(s=>CLIENT_SOURCES[s]);
 if(!chosen.length)return{jobs:[],sources:[]};
 const primaryQuery=String(queries[0]||titles[0]||'').trim();
 const feedCache=readStore(FEED_CACHE_KEY,{});
 const cursors=readStore(CURSOR_KEY,{});
 const rates=readStore(RATE_KEY,{});
 const now=Date.now();
 const filterSpec={
  titles:titles.length?titles:queries,
  roles:features.roles||[],
  skills:features.skills||[],
  country:country||'worldwide',
  remote:!!features.remote,
  level:features.level||null
 };
 const matched=[];
 const sourceRows=[];

 await Promise.all(chosen.map(async site=>{
  const rate=rates[site]||{};
  if(rate.cooldown_until&&now<rate.cooldown_until){
   const row={site:CLIENT_SOURCES[site].label,state:'cooling_down',count:0};
   sourceRows.push(row);onSource?.(row);return;
  }
  const cursorKey=`${site}:${primaryQuery.toLowerCase()}`;
  const prevCursor=cursors[cursorKey]||{page:1,offset:0};
  const page=expand?Math.min(3,(prevCursor.page||1)+1):1;
  const cacheKey=`${cursorKey}:p${page}`;
  let rawJobs=null;
  if(!expand&&feedCache[cacheKey]&&now-feedCache[cacheKey].at<FEED_TTL_MS){
   rawJobs=feedCache[cacheKey].jobs;
  }else{
   try{
    rawJobs=await CLIENT_SOURCES[site].fetchPage(primaryQuery,page);
    feedCache[cacheKey]={at:now,jobs:rawJobs.slice(0,120)};
    cursors[cursorKey]={page,offset:rawJobs.length,at:now};
    rates[site]={last_ok_at:now,cooldown_until:0};
   }catch(err){
    if(err?.status===429)rates[site]={...rate,cooldown_until:now+60000};
    rawJobs=feedCache[cacheKey]?.jobs||[];
   }
  }
  const siteBatch=[];
  for(const job of rawJobs||[]){
   const check=clientFilterJob(job,filterSpec);
   if(!check.accepted)continue;
   const route=classifyRoute(job.url);
   const card={
    id:job.id,
    title:job.title,
    company:job.company,
    location:job.location,
    workplace:job.workplace,
    source:CLIENT_SOURCES[site].label,
    target:route.label,
    family:route.family,
    automatable:route.automatable,
    url:job.url,
    stage:check.review?'related':route.automatable?'matched':'manual',
    role:check.closest_role||primaryQuery||null,
    why:check.review?check.reason||null:null
   };
   matched.push(card);
   siteBatch.push(card);
  }
  const row={site:CLIENT_SOURCES[site].label,state:'done',count:siteBatch.length};
  sourceRows.push(row);
  if(siteBatch.length)onJobBatch?.(siteBatch,row);
  onSource?.(row);
 }));

 writeStore(FEED_CACHE_KEY,feedCache);
 writeStore(CURSOR_KEY,cursors);
 writeStore(RATE_KEY,rates);
 return{jobs:matched.slice(0,limit),sources:sourceRows};
}

// Probe local companion on 127.0.0.1:53357 when user opens the public website on their PC.
export async function probeLocalCompanion(){
 if(typeof location==='undefined')return{localOrigin:null,connected:false,sameOrigin:false};
 if(location.hostname==='127.0.0.1'||location.hostname==='localhost')return{localOrigin:location.origin,connected:true,sameOrigin:true};
 try{
  const res=await fetch('http://127.0.0.1:53357/applyburst/api/device/ping',{
   method:'GET',
   credentials:'include',
   headers:{'X-ApplyBurst-Bridge':'1'},
   signal:AbortSignal.timeout(1200)
  });
  if(!res.ok)return{localOrigin:null,connected:false,sameOrigin:false};
  const data=await res.json();
  return{localOrigin:'http://127.0.0.1:53357',connected:!!data.available,sameOrigin:false,data};
 }catch{
  return{localOrigin:null,connected:false,sameOrigin:false};
 }
}

// Chrome & Edge Browser Extension Bridge (no EXE or local server required)
const extPending=new Map();
const extListeners=new Set();
let extListenerAttached=false;

function ensureExtListener(){
 if(extListenerAttached||typeof window==='undefined')return;
 extListenerAttached=true;
 window.addEventListener('message',event=>{
  if(event.source!==window||event.origin!==window.location.origin)return;
  const nonce=document.documentElement.getAttribute('data-tapsubmit-nonce');
  const data=event.data;
  if(!data||!nonce||data.nonce!==nonce)return;
  if(data.channel==='TAPSUBMIT_EXT_TO_PAGE'&&data.requestId&&extPending.has(data.requestId)){
   const resolve=extPending.get(data.requestId);
   extPending.delete(data.requestId);
   resolve(data.response);
  }else if(data.channel==='TAPSUBMIT_EXT_STREAM'&&data.message){
   for(const fn of extListeners)try{fn(data.message);}catch{}
  }
 });
}

export function isExtensionInstalled(){
 return typeof document!=='undefined'&&Boolean(document.documentElement.getAttribute('data-tapsubmit-extension'));
}

export function sendExtensionCommand(payload,timeoutMs=8000){
 if(!isExtensionInstalled())return Promise.resolve({ok:false,installed:false});
 ensureExtListener();
 const nonce=document.documentElement.getAttribute('data-tapsubmit-nonce');
 const requestId=crypto.randomUUID();
 return new Promise(resolve=>{
  const timer=setTimeout(()=>{extPending.delete(requestId);resolve({ok:false,timeout:true});},timeoutMs);
  extPending.set(requestId,res=>{clearTimeout(timer);resolve(res);});
  window.postMessage({channel:'TAPSUBMIT_PAGE_TO_EXT',nonce,requestId,payload},window.location.origin);
 });
}

export async function initExtensionBridge({apiBase='/applyburst/api/',csrf=null}={}){
 if(!isExtensionInstalled())return{installed:false,connected:false};
 const res=await sendExtensionCommand({type:'WEBSITE_BRIDGE_INIT',apiBase:new URL(apiBase,window.location.origin).href,csrf},2500);
 return{installed:true,connected:!!res?.ok,version:res?.extensionVersion||null,synced:!!res?.synced};
}

export function subscribeExtensionEvents(fn){
 ensureExtListener();
 extListeners.add(fn);
 return()=>extListeners.delete(fn);
}

