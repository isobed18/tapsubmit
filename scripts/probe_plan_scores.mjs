// Bounded: top CV-scored seed roles (all languages) per synthetic profile, to tune planner margins.
import {Planner} from '../web/lib/planner.mjs';
import {Store} from '../web/lib/store.mjs';
const store=new Store('.data/model-eval/planner.sqlite'),planner=new Planner({store,dataDirectory:'.data/model-eval'});
const CVS={de_mech:['Demo Person\nMaschinenbauingenieur\nKonstruktion mit SolidWorks, FEM-Berechnungen, Fertigungsplanung, 6 Jahre Automobilzulieferer, Stuttgart','germany'],
 tr_civil_grad:['Demo Mezun\nİnşaat Mühendisi (Yeni Mezun)\nSaha stajı: betonarme yapı denetimi, AutoCAD, metraj ve hakediş hazırlama','turkey'],
 en_teacher:['Demo Teacher\nPrimary School Teacher\nLesson planning, classroom management, differentiated instruction, 8 years in public schools','usa'],
 en_ml_student:['Demo Student\nComputer Engineering Student (graduating 2027)\nPyTorch, LangGraph agents, computer vision projects, looking for AI/ML internships','usa']};
for(const [name,[cv,country]]of Object.entries(CVS)){const plan=await planner.plan(cv,{country});console.log(name.padEnd(14),plan.queries.join(' | '),'· roles',plan.roles.map(r=>r.title).join(', '),'\n   ',plan.candidates.slice(0,9).map(([t,s,l])=>`${t}[${l}] ${s}`).join(' | '));}
