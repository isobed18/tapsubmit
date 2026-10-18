export const ANSWERS={full_name:'Demo Candidate',email:'candidate@example.test',phone:'+10000000000',portfolio:'https://example.test/portfolio',city:'Istanbul',authorization:'Yes'};
export const RESUME='ApplyBurst synthetic resume\nNo real candidate data.\n'.repeat(512);
export const BOARDS=[['greenhouse','stripe','Stripe'],['greenhouse','cloudflare','Cloudflare'],['lever','palantir','Palantir'],['ashby','ashby','Ashby'],['ashby','ramp','Ramp'],['lever','trendyol','Trendyol'],['lever','insiderone','Insider One'],['lever','peakgames','Peak'],['lever','dreamgames','Dream Games']];
export async function sha256(value){const bytes=typeof value==='string'?new TextEncoder().encode(value):value;const hash=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,'0')).join('');}
export function validateIdentity(jobId,runId){
 if(typeof jobId!=='string'||jobId.length>200||!BOARDS.some(([p,b])=>jobId.startsWith(`${p}:${b}:`))||!/^[-a-zA-Z0-9:]+$/.test(jobId))throw new Error('Unsupported job identity.');
 if(typeof runId!=='string'||!/^[-a-zA-Z0-9]{8,80}$/.test(runId))throw new Error('Invalid sandbox run identity.');
}
