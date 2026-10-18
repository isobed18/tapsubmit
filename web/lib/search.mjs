import {Worker} from 'node:worker_threads';
export class SearchService{
 constructor(){this.worker=null;this.pending=new Map();this.sequence=0;this.indexMs=null;this.generation=0;}
 async load(catalog){
  const next=new Worker(new URL('../search-worker.mjs',import.meta.url));
  await new Promise((resolve,reject)=>{next.once('error',reject);next.on('message',message=>{if(message.type==='ready'){this.indexMs=message.index_ms;resolve();}else if(message.type==='error'&&!message.id){reject(new Error(message.error));}else if(message.type==='result'||message.type==='error'){const pending=this.pending.get(message.id);if(pending){clearTimeout(pending.timer);this.pending.delete(message.id);message.type==='result'?pending.resolve(message.result):pending.reject(new Error(message.error));}}});next.postMessage({type:'load',catalog});});
  const previous=this.worker;this.worker=next;this.generation++;if(previous){const until=Date.now()+10000;while([...this.pending.values()].some(p=>p.worker===previous)&&Date.now()<until)await new Promise(r=>setTimeout(r,10));await previous.terminate();}
 }
 query(query,filters={}){if(!this.worker)throw new Error('Search is still starting.');const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Search timed out.'));},10000);this.pending.set(id,{resolve,reject,timer,worker:this.worker});this.worker.postMessage({type:'search',id,query,filters});});}
 async close(){for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('Search stopped.'));}this.pending.clear();await this.worker?.terminate();}
}
