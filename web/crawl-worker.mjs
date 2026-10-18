import {parentPort,workerData} from 'node:worker_threads';
import {join} from 'node:path';
import {Store} from './lib/store.mjs';
import {loadSources,refreshSources,boardURL} from './lib/sources.mjs';
const store=new Store(join(workerData.directory,'portal.sqlite'));
try{const sources=loadSources(workerData.root),known=new Set(sources.map(s=>s.id));if(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ats_boards'").get())for(const row of store.db.prepare("SELECT * FROM ats_boards WHERE status IN ('indexed','failed') ORDER BY COALESCE(last_refresh,0) ASC LIMIT 3000").all()){const id=row.provider+':'+row.board;if(!known.has(id))sources.push({id,kind:'ats',provider:row.provider,board:row.board,company:row.company,url:boardURL(row.provider,row.board),ttl_seconds:21600});}const report=await refreshSources(store,sources,{snapshotDir:join(workerData.directory,'snapshots')});parentPort.postMessage({report});}
catch(error){parentPort.postMessage({error:error.message});}
finally{store.close();}
