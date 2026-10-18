// Bounded probe: how close are job titles to the plan's roles vs the CV's own headline lines?
import {embed,dot} from '../web/lib/semantic.mjs';
const roles=['Backend Developer','Backend Engineer','Software Engineer','Python Developer','Data Engineer','Full Stack Developer','DevOps Engineer'];
const cvLines=['Backend Software Engineer','Python, FastAPI, PostgreSQL, Docker, REST APIs and distributed systems. Four years building backend services.'];
const jobs=['Python Developer','Data Engineer','API Engineer (Python)','Software Engineer, Backend','Backend Engineer (Python)','Account Executive','Registered Nurse','Graphic Designer','Softwareentwickler Backend (m/w/d)','Frontend Developer','Data Analyst','Machine Learning Engineer','Site Reliability Engineer','Java Developer','Sales Engineer','QA Engineer'];
const [rv,cv,jv]=await Promise.all([embed(roles,'query'),embed(cvLines,'query'),embed(jobs,'passage')]);
console.log('job'.padEnd(36),roles.map(r=>r.slice(0,9).padStart(10)).join(''),' cvHead');
jobs.forEach((j,i)=>console.log(j.padEnd(36),rv.map(r=>dot(r,jv[i]).toFixed(2).padStart(10)).join(''),dot(cv[0],jv[i]).toFixed(2).padStart(7)));
