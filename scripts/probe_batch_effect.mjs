// Bounded check: does the int8 (dynamically quantized) encoder give a text the same vector regardless of
// which other texts share its batch? Compares single-text vs batched embeddings.
import {pipeline,env} from '../web/node_modules/@huggingface/transformers/dist/transformers.node.mjs';
env.cacheDir=process.env.APPLYBURST_MODEL_CACHE||'D:/cache/models';env.allowRemoteModels=false;
const ex=await pipeline('feature-extraction','Xenova/paraphrase-multilingual-MiniLM-L12-v2',{dtype:'q8',device:'cpu'});
const one=async t=>{const o=await ex([t],{pooling:'mean',normalize:true});return o.data.slice(0,o.dims[1]);};
const many=async ts=>{const o=await ex(ts,{pooling:'mean',normalize:true});const d=o.dims[1];return ts.map((_,i)=>o.data.slice(i*d,(i+1)*d));};
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const pairs=[['Registered Nurse','Hemşire'],['Frontend Developer','Backend Developer'],['AI Engineer','Machine Learning Engineer']];
const long='Python, FastAPI, PostgreSQL, Docker, REST APIs and distributed systems. Four years building backend services with CI/CD pipelines, observability and on-call duties in a fintech company.';
for(const [a,b]of pairs){
 const [va,vb]=[await one(a),await one(b)],[ba,bb]=await many([a,b]),[la,lb]=await many([a,b,long]);
 console.log(`${a} ~ ${b}: single ${dot(va,vb).toFixed(3)} · same batch ${dot(ba,bb).toFixed(3)} · batch with a long text ${dot(la,lb).toFixed(3)} · self drift ${(1-dot(va,la)).toFixed(4)}`);
}
