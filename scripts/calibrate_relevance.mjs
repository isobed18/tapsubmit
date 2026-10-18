// Where does title similarity separate relevant from irrelevant pool titles? Bounded look, not a suite.
import {DatabaseSync} from 'node:sqlite';
import {VectorCache,dot} from '../web/lib/semantic.mjs';
const db=new DatabaseSync('.data/model-eval/planner.sqlite'),cache=new VectorCache(db,'.data/model-eval');
const titles=[...new Set(db.prepare("SELECT json_extract(payload,'$.title') t FROM jobs WHERE active=1").all().map(r=>r.t).filter(Boolean))];
const vectors=await cache.vectors(titles,'passage');
for(const role of ['Machine Learning Engineer','Registered Nurse','Accountant','Sales Representative','Frontend Developer']){
 const [r]=await cache.vectors([role],'query');const ranked=titles.map((t,i)=>[t,dot(r,vectors[i])]).sort((a,b)=>b[1]-a[1]);
 const band=x=>ranked.filter(([,s])=>s>=x).length;
 console.log(`\n== ${role}: >=0.7 ${band(0.7)} | >=0.6 ${band(0.6)} | >=0.5 ${band(0.5)} | >=0.4 ${band(0.4)} of ${titles.length}`);
 for(const cut of [0.62,0.55,0.48,0.42])console.log('  around',cut,':',ranked.filter(([,s])=>s<cut+0.03&&s>=cut).slice(0,4).map(([t,s])=>t.slice(0,48)+' '+s.toFixed(2)).join(' | '));
}
