import {parentPort} from 'node:worker_threads';
import {SearchEngine} from '../demo/public/search-engine.mjs';
let engine;
parentPort.on('message',message=>{try{
 if(message.type==='load'){const start=performance.now();engine=new SearchEngine(message.catalog);parentPort.postMessage({type:'ready',index_ms:performance.now()-start});}
 else if(message.type==='search'){const result=engine.search(message.query,message.filters,100);result.results=result.results.map(({description,...job})=>job);parentPort.postMessage({type:'result',id:message.id,result});}
}catch(error){parentPort.postMessage({type:'error',id:message.id,error:error.message});}});
