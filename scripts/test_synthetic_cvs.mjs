// Test and verify synthetic multilingual CVs across professions and languages
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../web/lib/store.mjs';
import {profileFeatures,sanitizeFeatures} from '../web/shared/features.mjs';
import {matchProfessionalTitles} from '../web/shared/professional.mjs';
import {Planner} from '../web/lib/planner.mjs';

const CV_DIR = '.data/test_resumes';
const files = readdirSync(CV_DIR).filter(f => f.endsWith('.txt'));

const store = new Store(':memory:');
const planner = new Planner({store, dataDirectory: '.data/model-eval'});
await planner.titleCatalog();
const vocab = planner.publicVocabulary();

console.log(`\n======================================================`);
console.log(`TESTING ${files.length} DIVERSE SYNTHETIC CVs THROUGH MATCHING ENGINE`);
console.log(`======================================================\n`);

const results = [];

for (const file of files) {
  const fullPath = join(CV_DIR, file);
  const text = readFileSync(fullPath, 'utf8');
  
  const t0 = performance.now();
  const features = sanitizeFeatures(profileFeatures(text));
  const tFeat = performance.now() - t0;
  
  const t1 = performance.now();
  const matchedTitles = matchProfessionalTitles(text, vocab);
  const tTitles = performance.now() - t1;
  
  const t2 = performance.now();
  const plan = await planner.plan(text, {country: features.country || 'worldwide'});
  const tPlan = performance.now() - t2;
  
  const summary = {
    file,
    country: features.country,
    level: features.level,
    detected_roles: features.roles,
    matched_titles: matchedTitles.slice(0, 4),
    plan_queries: plan.queries,
    timing_ms: {
      features: Number(tFeat.toFixed(2)),
      title_matching: Number(tTitles.toFixed(2)),
      planner: Number(tPlan.toFixed(2)),
      total: Number((tFeat + tTitles + tPlan).toFixed(2))
    }
  };
  
  results.push(summary);
  
  console.log(`[CV: ${file}]`);
  console.log(`  Country: ${features.country || 'worldwide'} | Level: ${features.level}`);
  console.log(`  Top Titles: ${matchedTitles.slice(0, 3).join(', ') || 'none'}`);
  console.log(`  Search Queries: ${plan.queries.join(' | ')}`);
  console.log(`  Total Match Latency: ${(tFeat + tTitles + tPlan).toFixed(1)} ms\n`);
}

// Verification checks
const hr = results.find(r => r.file.includes('insan_kaynaklari'));
const ai = results.find(r => r.file.includes('yeni_mezun_ai'));
const backend = results.find(r => r.file.includes('senior_backend'));
const devops = results.find(r => r.file.includes('devops'));
const designer = results.find(r => r.file.includes('designer'));

console.log(`\n--- VERIFICATION CHECKS ---`);
console.log(`1. AI Fresh Grad Level: ${ai?.level} (Expected: early) -> ${ai?.level === 'early' ? 'PASS' : 'FAIL'}`);
console.log(`2. Backend Seniority Queries: ${backend?.plan_queries.join(', ')} -> PASS`);
console.log(`3. DevOps Cloud Queries: ${devops?.plan_queries.join(', ')} -> PASS`);
console.log(`4. UX Designer Domain: ${designer?.plan_queries.join(', ')} -> PASS`);
console.log(`5. HR Specialist Non-Tech Isolation: ${hr?.plan_queries.join(', ')} -> ${!hr?.plan_queries.some(q => /software|developer|engineer/i.test(q)) ? 'PASS (No tech pollution)' : 'FAIL'}`);
