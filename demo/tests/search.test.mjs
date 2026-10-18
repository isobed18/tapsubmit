import test from 'node:test';import assert from 'node:assert/strict';
import {SearchEngine,parseQuery,emailDraft} from '../public/search-engine.mjs';
const base={provider:'fixture',board:'one',company:'Example',location:'Istanbul, Türkiye',locations:['Istanbul, Türkiye'],workplace:'remote',seniority:'unknown',employment_type:'full-time',seen_at:Date.now()/1000,skills:[],description:'',apply_url:'https://example.test'};
const corpus={jobs:[
  {...base,id:'a',title:'Backend Engineer',description:'We require Python and PostgreSQL. Experience with distributed systems.',skills:['Python','PostgreSQL']},
  {...base,id:'b',title:'Senior Backend Engineer',description:'Python services with Kubernetes.',skills:['Python','Kubernetes'],seniority:'senior'},
  {...base,id:'c',title:'Frontend Developer',description:'JavaScript and React. We do not use Java.',skills:['JavaScript','React'],workplace:'hybrid'},
  {...base,id:'d',title:'C++ Intern',description:'Build a C++ runtime. No Python requirement.',skills:['C++'],seniority:'intern',employment_type:'intern',location:'Berlin',locations:['Berlin']},
  {...base,id:'e',title:'Platform Engineer',description:'Golang and Kafka in our infrastructure.',skills:['Go','Kafka'],location:'London',locations:['London'],salary:{min:120000,max:160000,currency:'USD',period:'year'}}]};
const engine=new SearchEngine(corpus);const ids=(q,f)=>engine.search(q,f).results.map(j=>j.id).sort();
test('descriptions contain requirements absent from titles',()=>assert.deepEqual(ids('postgresql'),['a']));
test('Boolean precedence and phrase scope',()=>assert.deepEqual(ids('(skill:python OR skill:go) AND title:engineer NOT title:senior'),['a','e']));
test('quoted description phrases',()=>assert.deepEqual(ids('description:"distributed systems"'),['a']));
test('skill evidence is distinct from mere description mention',()=>{assert.deepEqual(ids('skill:java'),[]);assert.deepEqual(ids('skill:javascript'),['c']);});
test('punctuation skills remain searchable',()=>assert.deepEqual(ids('skill:"C++"'),['d']));
test('Turkish accents and aliases normalize',()=>assert.deepEqual(ids('location:turkey'),['a','b','c']));
test('unknown levels do not become junior',()=>assert.deepEqual(ids('',{levels:['junior']}),[]));
test('all required skills and explicit workplace filter',()=>assert.deepEqual(ids('engineer',{skills:['Python','Kubernetes'],workplace:'remote'}),['b']));
test('salary requires a known annual USD minimum',()=>assert.deepEqual(ids('',{min_salary:100000}),['e']));
test('stale observations are excluded only by explicit freshness filter',()=>{const e=new SearchEngine({jobs:[{...base,id:'old',title:'Engineer',seen_at:1}]});assert.equal(e.search('',{max_age_hours:24}).total,0);});
test('invalid expressions produce an error, never silent broadening',()=>{for(const q of ['python OR','(python','unknown:python','"python','()'])assert.throws(()=>parseQuery(q));});
test('negative-only query and AND precedence',()=>{assert.deepEqual(ids('NOT title:senior'),['a','c','d','e']);assert.deepEqual(ids('title:frontend OR skill:python AND level:senior'),['b','c']);});
test('matching evidence quotes the source field',()=>{const r=engine.search('postgresql').results[0];assert.equal(r.id,'a');assert.ok(r.evidence.some(e=>e.field==='skill'&&e.text.includes('PostgreSQL')));});
test('duplicate canonical identities are rejected',()=>assert.throws(()=>new SearchEngine({jobs:[corpus.jobs[0],corpus.jobs[0]]})));
test('mail drafts do not invent recipients or send messages',()=>{const draft=emailDraft(corpus.jobs[0]);assert.equal(draft.to,'');assert.ok(draft.note.includes('no email is sent'));});
test('Golang never aliases an ordinary verb in descriptions',()=>{const e=new SearchEngine({jobs:[{...base,id:'verb',title:'Engineer',description:'Go to our website for information.'},{...base,id:'language',title:'Engineer',description:'Backend services in Golang.',skills:['Go']}]});assert.deepEqual(e.search('golang').results.map(j=>j.id),['language']);assert.deepEqual(e.search('go').results.map(j=>j.id),['language']);});
test('known Turkish cities map to a country for location retrieval',()=>{const e=new SearchEngine({jobs:[{...base,id:'istanbul',title:'Engineer',location:'Istanbul',locations:['Istanbul']}]});assert.equal(e.search('location:turkey').total,1);});
test('multiple postings of one requisition count as one opportunity',()=>{const e=new SearchEngine({jobs:[{...base,id:'p1',canonical_id:'req1',title:'Python Engineer'},{...base,id:'p2',canonical_id:'req1',title:'Python Engineer'},{...base,id:'p3',canonical_id:'req2',title:'Python Engineer'}]});const r=e.search('python');assert.equal(r.total,2);assert.equal(r.matching_postings,3);assert.equal(r.duplicate_postings_removed,1);});
