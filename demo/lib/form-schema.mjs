const identity={first_name:'first_name',last_name:'last_name',name:'name',full_name:'name',email:'email',phone:'phone',resume:'resume',resume_text:'resume',website:'website',linkedin_profile:'linkedin'};
export function greenhouseSchema(jobId,payload){
 const questions=[...(payload.questions||[]),...(payload.location_questions||[]),...(Array.isArray(payload.compliance)?payload.compliance:[])];
 const groups=questions.map((q,i)=>{
  const alternatives=(q.fields||[]).map(f=>({name:f.name,type:f.type,options:(f.values||[]).map(v=>({value:String(v.value??v.id),label:v.label}))}));
  const mapping=alternatives.map(f=>identity[f.name]).find(Boolean)||null;
  return {id:String(i),label:q.label||'Additional question',required:!!q.required,alternatives,mapping,
    preparation:mapping?'known_field':'needs_answer',note:mapping?'Recognized field; supply an approved candidate value.':'No answer is invented.'};
 });
 const demographics=payload.demographic_questions?.questions||[];
 for(const q of demographics)groups.push({id:'demographic-'+q.id,label:q.question||q.label||'Demographic question',required:!!q.required,alternatives:[],mapping:null,preparation:'needs_answer',note:'Candidate choice required when mandatory.'});
 for(const rule of payload.data_compliance||[]){if(rule.requires_consent)groups.push({id:'consent-'+groups.length,label:'Data processing / retention consent',required:true,alternatives:[],mapping:null,preparation:'needs_answer',note:'Consent must be supplied explicitly.'});}
 const required=groups.filter(g=>g.required),unresolved=required.filter(g=>!g.mapping);
 return {job_id:jobId,provider:'greenhouse',title:payload.title,inspection:'public_question_schema',inspected_at:Date.now()/1000,
   groups,required_groups:required.length,recognized_required_groups:required.length-unresolved.length,unresolved_required_groups:unresolved.length,
   status:unresolved.length?'needs_candidate_answers':'known_fields_detected',automatic_submission_verified:false,
   note:'Read-only inspection. Recognizing fields does not prove that a real application can be submitted.'};
}
