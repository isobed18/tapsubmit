import test from 'node:test';import assert from 'node:assert/strict';
import {SITES,siteForURL,applicationPlan} from '../lib/application-plan.mjs';
test('website registry routes exact domains without claiming submission coverage',()=>{
 assert.equal(SITES.length,24);assert.ok(SITES.every(site=>!site.submission_verified));
 assert.equal(siteForURL('https://www.linkedin.com/jobs/view/1').id,'linkedin');
 for(const url of ['https://linkedin.com.attacker.test/job','http://linkedin.com/job','not a URL'])assert.equal(siteForURL(url),null);
});
test('application planning maps known identity but leaves custom screening unanswered',()=>{
 const plan=applicationPlan({id:'one',apply_url:'https://boards.greenhouse.io/example/jobs/1'},{name:'Demo Middle Candidate',email:'demo@example.test'}, {groups:[{id:'first',mapping:'first_name',required:true},{id:'last',mapping:'last_name',required:true},{id:'visa',label:'Visa sponsorship?',required:true}]});
 assert.equal(plan.recognized_fields,2);assert.equal(plan.missing_questions[0].label,'Visa sponsorship?');assert.equal(plan.status,'needs_answers');assert.equal(plan.automatic_submission_verified,false);
});
