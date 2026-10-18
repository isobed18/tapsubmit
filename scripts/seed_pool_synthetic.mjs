// Seed the shared job pool with diverse synthetic multilingual CV searches
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../web/lib/store.mjs';
import {Planner} from '../web/lib/planner.mjs';
import {profileFeatures, sanitizeFeatures} from '../web/shared/features.mjs';
import {SCRAPERS} from '../web/lib/scrapers.mjs';
import {Boards} from '../web/lib/boards.mjs';

const DB_PATH = process.env.APPLYBURST_DB || '.data/desktop-live/store.db';
const CV_DIR = '.data/test_resumes';

console.log(`\n======================================================`);
console.log(`COMMUNITY JOB POOL SEEDER (SYNTHETIC PROFILES)`);
console.log(`Database: ${DB_PATH}`);
console.log(`======================================================\n`);

const store = new Store(DB_PATH);
const planner = new Planner({store, dataDirectory: '.data/model-eval'});
await planner.titleCatalog();
const boards = new Boards({store, search: null});

const files = readdirSync(CV_DIR).filter(f => f.endsWith('.txt'));
console.log(`Found ${files.length} synthetic CV profiles to harvest jobs for.`);

let totalDiscovered = 0;
let totalIndexed = 0;
const sourcesToQuery = ['remoteok', 'jobicy', 'remotive', 'arbeitnow', 'himalayas'];

for (const file of files) {
  const fullPath = join(CV_DIR, file);
  const text = readFileSync(fullPath, 'utf8');
  const features = sanitizeFeatures(profileFeatures(text));
  const plan = await planner.plan(text, {country: features.country || 'worldwide'});

  console.log(`\n--- [CV: ${file}] ---`);
  console.log(`Target Roles: ${features.roles.join(', ') || 'General'}`);
  console.log(`Queries: ${plan.queries.slice(0, 3).join(' | ')}`);

  const primaryQuery = plan.queries[0] || 'Software Engineer';
  const harvestedJobs = [];

  for (const site of sourcesToQuery) {
    if (!SCRAPERS[site]) continue;
    try {
      const report = {warnings: [], throttled: false};
      const jobs = await SCRAPERS[site]({
        query: primaryQuery,
        country: features.country || 'worldwide',
        limit: 25,
        remote: true,
        hours_old: 720
      }, report);

      if (Array.isArray(jobs) && jobs.length > 0) {
        console.log(`  ✓ ${site}: found ${jobs.length} postings`);
        for (const j of jobs) {
          harvestedJobs.push({
            id: j.id || (site + ':' + (j.external_id || Math.random().toString(36).slice(2))),
            canonical_id: j.canonical_id || j.id,
            title: j.title,
            company: j.company || 'Unknown',
            location: j.location || 'Remote',
            workplace: j.workplace || 'remote',
            apply_url: j.destination_url || j.apply_url || j.url,
            destination_url: j.destination_url || j.apply_url || j.url,
            provider: site,
            seniority: features.level || '',
            seen_at: Date.now() / 1000
          });
        }
      } else {
        console.log(`  - ${site}: 0 results`);
      }
    } catch (err) {
      console.log(`  ✕ ${site}: error (${err.message})`);
    }
  }

  totalDiscovered += harvestedJobs.length;
  if (harvestedJobs.length > 0) {
    const added = store.ingestCommunityJobs(harvestedJobs);
    totalIndexed += added;
    const discoveredBoards = boards.note(harvestedJobs);
    console.log(`  -> Ingested ${added} new opportunities into SQLite FTS5 index (discovered ${discoveredBoards} ATS boards)`);
  }
}

const stats = store.stats();
const poolStats = store.pool.stats();

console.log(`\n======================================================`);
console.log(`HARVESTING SUMMARY`);
console.log(`======================================================`);
console.log(`Total Jobs Discovered: ${totalDiscovered}`);
console.log(`New Jobs Ingested:     ${totalIndexed}`);
console.log(`Total Active Postings: ${stats.postings}`);
console.log(`Unique Opportunities:  ${stats.opportunities}`);
console.log(`Saved Pool Target URLs:${poolStats.saved_destinations}`);
console.log(`======================================================\n`);

store.close();
