import {DatabaseSync} from 'node:sqlite';
import {Intents} from '../web/lib/intents.mjs';
const db=new DatabaseSync('.data/model-eval/planner.sqlite'),i=new Intents({store:{db},dataDirectory:'.data/model-eval'});
const labels=['Vorname*','Nachname*','Vorname','Nachname','E-Mail-Adresse*','Lebenslauf*','LinkedIn-Profil','Warum möchten Sie bei uns arbeiten?*'];
console.log(JSON.stringify((await i.classify('fields',labels)).map((r,k)=>labels[k]+' -> '+(r?r.label+' '+r.score+' m'+r.margin:'null'))));
