"""Reproducible application-engine comparison; synthetic loopback employers only.

Measures the production executor, not a parallel simplified implementation. Fixture pacing
is zero to isolate engine overhead; this does not predict arbitrary real-site throughput.
"""
import argparse
import asyncio
import hashlib
import json
import os
import platform
import statistics
import time
from collections import Counter
from datetime import datetime,timezone
from pathlib import Path

from .companion import AutoAck,run_jobs
from .fixture import RESUME
from .form_fixtures import make_app
from .harness import serve

PERMISSION={'mode':'auto_all','paused':False,'sites':dict.fromkeys(['linkedin','greenhouse','lever','ashby','workable'],True)}
FAMILIES=[('greenhouse','gh/ok/jobs'),('lever','lever/ok'),('ashby','ashby/ok'),('linkedin','li/no_resume/jobs/view')]

class Sampler:
    def __init__(self):
        self.peak_rss=0;self.peak_processes=0;self.running=True;self.available=False
        try:
            import psutil
            self.process=psutil.Process();self.available=True
        except ImportError:pass
    async def sample(self):
        while self.running and self.available:
            try:
                processes=[self.process,*self.process.children(recursive=True)];rss=0;count=0
                for process in processes:
                    try:rss+=process.memory_info().rss;count+=1
                    except Exception:pass
                self.peak_rss=max(self.peak_rss,rss);self.peak_processes=max(self.peak_processes,count)
            except Exception:pass
            await asyncio.sleep(.25)
    def report(self):return{'peak_process_tree_rss_mb':round(self.peak_rss/1024**2,1) if self.available else None,'peak_processes':self.peak_processes if self.available else None,'memory_scope':'Sum of RSS for benchmark Python + its browser descendants; includes shared pages and is not private physical memory.'}

async def execute(context,jobs,mode,profile,answers):
    ack=AutoAck();request={'task':mode,'jobs':jobs,'profile':profile,'answers':answers,'permission':PERMISSION,
        'headless':True,'concurrency':2,'linkedin_pace_seconds':0,'confirm_timeout':4,'human_timeout':1}
    start=time.perf_counter();results,kept=await run_jobs(context,request,ack.emit,ack)
    for page,_,_ in kept:await page.close()
    return results,ack,time.perf_counter()-start

async def calibrate(context,base,profile):
    jobs=[{'id':'cal-'+family,'family':family,'url':base+'/'+path+'/cal-'+family+('/application' if family=='ashby' else '')}for family,path in FAMILIES]
    answers={}
    for _ in range(3):
        results,_,_=await execute(context,jobs,'prepare',profile,answers)
        missing=[m for row in results for m in row.get('missing',[])];added=0
        for question in missing:
            label=question['label'].lower();value=None
            if 'sponsorship' in label:value='No'
            elif 'authorized to work' in label:value='Yes'
            elif 'years of work experience' in label:value='2'
            elif 'proficiency in english' in label:value='Professional'
            if value is not None and question['fingerprint'] not in answers:answers[question['fingerprint']]=value;added+=1
        if not added:break
    return answers

def workload(base,count,prefix):
    jobs=[]
    for index in range(count):
        family,path=FAMILIES[index%len(FAMILIES)];ident=prefix+'-'+str(index)
        jobs.append({'id':ident,'family':family,'url':base+'/'+path+'/'+ident+('/application' if family=='ashby' else '')})
    # Two required questions we intentionally do not answer. They must not stop the queue.
    for index in range(2):jobs.append({'id':prefix+'-unknown-'+str(index),'family':'greenhouse','url':base+'/gh/unknown_required/jobs/'+prefix+'-unknown-'+str(index)})
    return jobs

async def main(args):
    from playwright.async_api import async_playwright
    directory=Path(args.output).resolve().parent;directory.mkdir(parents=True,exist_ok=True)
    resume=directory/'synthetic-engine-resume.txt';resume.write_bytes(RESUME)
    profile={'name':'Demo Middle Candidate','email':'candidate@example.test','phone':'+90 555 000 00 00','location':'Ankara, Turkiye','linkedin':'https://www.linkedin.com/in/demo-candidate','github':'https://github.com/demo-candidate','resume_path':str(resume)}
    fixture=make_app();sampler=Sampler();sampling=asyncio.create_task(sampler.sample());records=[];startup=time.perf_counter()
    sources={name:hashlib.sha256(Path(__file__).with_name(name+'.py').read_bytes()).hexdigest() for name in ('companion','adapters','formfill','formscan','form_fixtures','core_bench')}
    async with serve(fixture) as base,async_playwright() as pw:
        browser=await pw.chromium.launch(headless=True,args=['--disable-gpu']);startup_ms=(time.perf_counter()-startup)*1000
        context=await browser.new_context(locale='en-US');answers=await calibrate(context,base,profile);await context.close()
        for repeat in range(args.repeats):
            # Alternate order to avoid always giving one mode the warmed machine.
            modes=['two_pass','single_pass'] if repeat%2==0 else ['single_pass','two_pass']
            for mode in modes:
                sampler.peak_rss=0;sampler.peak_processes=0
                context=await browser.new_context(locale='en-US');jobs=workload(base,args.jobs-2,f'{mode}-{repeat}');fixture.state.submissions.clear();fixture.state.rejections.clear();start=time.perf_counter()
                if mode=='two_pass':
                    prepared,first,_=await execute(context,jobs,'prepare',profile,answers)
                    ready=[{**job,'expected_plan':next(row['plan_hash'] for row in prepared if row['job_id']==job['id'])} for job in jobs if any(row['job_id']==job['id'] and row['state']=='ready_to_submit' for row in prepared)]
                    submitted,ack,_=await execute(context,ready,'submit',profile,answers);results=[row for row in prepared if row['state']!='ready_to_submit']+submitted
                else:results,ack,_=await execute(context,jobs,'auto',profile,answers)
                elapsed=time.perf_counter()-start;accepted=fixture.state.submissions;states=dict(Counter(row['state'] for row in results));expected=args.jobs-2
                verified=states.get('confirmed')==len(accepted)==len(ack.record)==expected and states.get('needs_answers')==2 and len({row['job_id'] for row in accepted})==expected
                file_verified=all(row.get('files') and all(value['sha256']==hashlib.sha256(RESUME).hexdigest() for value in row['files'].values()) for row in accepted)
                stages={stage:round(statistics.median(row['timings_ms'][stage] for row in results if stage in row.get('timings_ms',{})),1) for stage in {key for row in results for key in row.get('timings_ms',{})}}
                record={'mode':mode,'repeat':repeat,'jobs':len(jobs),'seconds':round(elapsed,3),'confirmed_per_minute':round(expected/elapsed*60,2),'states':states,'receiver_count':len(accepted),'recorded_intents':len(ack.record),'receiver_verified':verified,'file_hashes_verified':file_verified,'median_job_stage_ms':stages,**sampler.report()}
                records.append(record);print(json.dumps(record),flush=True);await context.close()
                if not verified or not file_verified:
                    Path(args.output).write_text(json.dumps({'runs':records,'results':results,'receiver':accepted},indent=2),encoding='utf-8')
                    raise AssertionError('Production executor/receiver mismatch; inspect report raw results.')
        await browser.close()
    sampler.running=False;await sampling
    medians={mode:round(statistics.median(row['seconds'] for row in records if row['mode']==mode),3)for mode in ('two_pass','single_pass')}
    report={'utc':datetime.now(timezone.utc).isoformat(),'scope':'Production engine, four local fixture families, synthetic answers/files. No real employer submissions. Browser startup and answer calibration excluded from run time. LinkedIn fixture pacing is zero.','source_sha256':sources,'browser_startup_ms':round(startup_ms,1),'concurrency':2,'gpu_inference':False,'model_calls':0,'platform':platform.system()+' '+platform.release(),'runs':records,'median_seconds':medians,'speedup':round(medians['two_pass']/medians['single_pass'],3)}
    Path(args.output).write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps({key:report[key] for key in ['median_seconds','speedup']}),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--jobs',type=int,default=50);parser.add_argument('--repeats',type=int,default=2);parser.add_argument('--output',default='reports/core-engine.json');args=parser.parse_args()
    if not 6<=args.jobs<=50 or not 1<=args.repeats<=5:parser.error('Choose 6–50 jobs and 1–5 repeats.')
    asyncio.run(main(args))
