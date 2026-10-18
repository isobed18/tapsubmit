// Build the read-only public pool index from the exported public metadata (run at Docker build time).
import {buildPoolIndex} from '../web/lib/public-pool.mjs';
const started=Date.now(),result=await buildPoolIndex('public-pool/jobs-0001.jsonl.gz','public-pool/pool.sqlite');
console.log(JSON.stringify({...result,seconds:(Date.now()-started)/1000}));
