// Bounded debug: English translation candidates for a local top role (meaning sim, CV score, title-line evidence).
import {Planner} from '../web/lib/planner.mjs';
import {Store} from '../web/lib/store.mjs';
import {embed,dot} from '../web/lib/semantic.mjs';
const store=new Store('.data/model-eval/planner.sqlite'),planner=new Planner({store,dataDirectory:'.data/model-eval'});
const CASES=[['nurse probe','Ayşe Örnek\nYoğun Bakım Hemşiresi\nHasta takibi, ilaç uygulamaları, yoğun bakım protokolleri, 6 yıl deneyim. Ankara Şehir Hastanesi.','Hemşire',['Registered Nurse','Physician','Caregiver']],
 ['civil grad','Demo Mezun\nİnşaat Mühendisi (Yeni Mezun)\nSaha stajı: betonarme yapı denetimi, AutoCAD, metraj ve hakediş hazırlama','İnşaat Mühendisi',['Construction Worker','Civil Engineer','Industrial Engineer']]];
for(const [name,cv,local,english]of CASES){
 const plan=await planner.plan(cv,{country:'turkey'}),scores=new Map(plan.candidates.map(([t,s])=>[t,s]));
 const lines=cv.split('\n').slice(0,2),[lv,tv,...ev]=await embed([lines[1],local,...english]);
 console.log(name,'· plan',plan.queries.join(' | '),'· roles',plan.roles.map(r=>r.title).join(', '));
 english.forEach((e,i)=>console.log('   ',e.padEnd(20),'sim to',local,dot(tv,ev[i]).toFixed(3),'· headline',dot(lv,ev[i]).toFixed(3),'· score',scores.get(e)??'(not top-12)'));
}
