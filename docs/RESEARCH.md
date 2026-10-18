# Literature and public systems review

Reviewed 16 October 2026. Primary sources are linked below. Public project claims are not measurements made by ApplyBurst. Legal and scraping-policy review is deliberately outside this baseline's scope, as requested.

## Discovery systems

| Work | What it establishes | Decision for this project |
| --- | --- | --- |
| [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html) | Public board reads; optional content and question fields; authenticated application submission | Full descriptions in background ingestion for detailed search; question schemas on selection; do not assume an applicant can use the POST API |
| [Lever Postings API](https://github.com/lever/postings-api) | Public per-company postings, application fields, employer API key and POST throttling | Structured ingestion; separate read and application capabilities |
| [Ashby public job API](https://developers.ashbyhq.com/docs/public-job-posting-api) | Structured postings with application URLs and listing visibility | Filter unlisted records; preserve the original application URL |
| [JobSpy](https://github.com/speedyapply/JobSpy) | Search across several job boards; fetching missing descriptions adds per-job requests | Optional coverage fallback; not the interactive latency dependency |
| [mherzog4/job-boards](https://github.com/mherzog4/job-boards) | Separate board-slug discovery/validation from posting ingestion; archive-index bootstrap | Adopt the separation; do not run registry expansion during user search |
| [ATS job board reference](https://github.com/GregoryBolshakov/ats-job-boards-reference) | Author's dated snapshots and normalization pitfalls across ATS systems | Test provider schemas and sparse fields; independently verify live behavior |
| [wickfeed/ats-job-aggregator](https://github.com/wickfeed/ats-job-aggregator) | Normalized multi-ATS ingestion and diff monitoring | Useful pattern for later provider expansion; Apify is not required by our architecture |

We actually tested JobSpy 1.3.0 and live feeds from Greenhouse, Lever and Ashby. We did not run the other aggregators or reproduce their reported coverage. JobSpy's repository currently resolves to `speedyapply/JobSpy`; old Bunsly links redirect there. The former AIHawk repository link also redirects to a different project, so it is not treated as a stable current baseline.

The tested source registry deliberately includes Trendyol, Insider One, Peak and Dream Games. Source provenance is recorded in [config/boards.json](../config/boards.json). These are employer-board samples, not a comprehensive Turkish market index. Some companies expose old and new ATS destinations simultaneously; registry validation and migration handling are necessary.

The core update adds [Personio's documented public XML integration](https://support.personio.de/hc/en-us/articles/207576365-Integrate-jobs-from-Personio-into-your-website-via-XML) as a browserless source. A live appliedAI feed returned full descriptions and creation dates in one request. This extends discovery, not application execution. Personio documents redirecting applicants to its hosted form; an employer API is not an applicant credential.

[SmartRecruiters' public Posting API](https://developers.smartrecruiters.com/docs/endpoints) distinguishes company searches from posting details. Our live sample needed eleven requests for ten complete jobs, much slower than the single-request Greenhouse/Lever/Ashby/Workable feeds. Keep this hydration off the interactive path and cache it. Harvested SmartRecruiters boards now use the correct company endpoint rather than the Ashby fallback.

Do not assume Recruitee's Careers Site API is anonymous: its [current official documentation](https://support.recruitee.com/en/articles/1066282-api-documentation) requires a careers API token. A public XML feed is a separate potential source; it has not been implemented or benchmarked here.

## Browser automation and literature

| Work | Finding or mechanism | Architectural implication |
| --- | --- | --- |
| [WebArena, Zhou et al., 2023/2024](https://arxiv.org/abs/2307.13854) | Reproducible web environments and functional end-state evaluation | Evaluate received applications and their contents, not agent descriptions of success. Its original agent scores are historical, not current product rankings |
| [Steward, 2024](https://arxiv.org/abs/2409.15441) | Natural-language browser automation with caching to reduce repeated work | Reuse learned actions; do not reason over the same stable form on each application |
| [Agent JIT Compilation, Winston et al., ICML 2026](https://arxiv.org/abs/2605.21470) | Compiles tasks into executable plans and schedules independent operations; authors report 10.4× planner speedup over Browser-Use across five applications | Separate interpretation from execution; use validated preconditions, postconditions and bounded concurrency. We did not reproduce their benchmark |
| [Stagehand](https://github.com/browserbase/stagehand) | Code plus AI operations, caching and reusable action primitives | Similar direction to our known-form replay. Review source/version before integrating; no dependency or measured Stagehand speed claim here |
| [Browser Use](https://github.com/browser-use/browser-use) | General browser-agent framework with local and cloud options | Candidate for later unknown-flow evaluation; not necessary for known form filling |
| [Skyvern](https://github.com/Skyvern-AI/skyvern) | Visual/LLM automation for varied websites and workflow execution | Reference for broad coverage, not the lightweight default. Not run in this baseline |

The baseline compares **our own deterministic HTTP and Playwright implementations**, not performance of Codex, Claude, Stagehand, Browser Use or Skyvern. Our local receiver omits employer authentication, CAPTCHA, multi-step conditional questions, geographic eligibility and network variability. This comparison isolates execution overhead; it cannot establish public-site application success.

## Jev and lightweight alternatives: later evaluation

Current measurements compare one-pass deterministic execution with the previous two-pass engine, with no model calls. This is not a classifier/LLM benchmark. See [CORE_ENGINE.md](CORE_ENGINE.md) for actual coverage and measurement scope.

[Jev's official documentation](https://docs.typesafe.ai/introduction) describes typed Choice, Score and Noul decisions over a state. That is the model the user meant. It is a potentially useful routing/ranking comparator, not a requirement for discovery. Its API probabilities do not establish accuracy or calibration on job eligibility and form mapping.

The user requested that discovery and application architecture come first, that the GPU remain available for training, and that the system run on laptops. No model benchmark is complete and no model remains a runtime dependency. We have **not verified** which of the alternatives below is faster, cheaper or better than Jev on this task.

| Candidate | Appropriate later experiment | Main question to verify |
| --- | --- | --- |
| Rules, aliases and SQLite BM25 | Role/skill filters, known form-field mapping | How much useful coverage is already achieved without inference? |
| TF-IDF + logistic regression / fastText | Fixed role, seniority and form-field classes | Accuracy, abstention and memory after employer-separated training/validation splits. [fastText source](https://github.com/facebookresearch/fastText) |
| Model2Vec + a small classifier | CPU semantic retrieval and fixed-label classification | Benefit over BM25 per MB and millisecond; Turkish/English generalization. [Model2Vec](https://github.com/MinishLab/model2vec), [potion-base-8M](https://huggingface.co/minishlab/potion-base-8M) |
| SetFit / FastFit | Few-shot role or question classification | Labeling needs, inference cost and unseen-company behavior. [SetFit](https://github.com/huggingface/setfit), [FastFit](https://github.com/IBM/fastfit) |
| GLiClass | Variable label sets supplied at inference | Shortlisting accuracy and confidence on unfamiliar fields. [Source](https://github.com/Knowledgator/GLiClass) |
| GLiNER2.5-Decide | Typed classification without generated text, CPU-capable | Task-specific quality and actual laptop latency. [Official model card](https://huggingface.co/fastino/GLiNER2.5-Decide) |
| Laya | Local typed-decision comparator, including multilingual checkpoints | Candidate-count effects and calibration on Turkish/English forms. [Official source](https://github.com/NandhaKishorM/laya) |
| Jev | Hosted typed-decision reference | End-to-end network latency, quality, calibrated abstention and real billed cost. [Official docs](https://docs.typesafe.ai/introduction) |

This is a shortlist, not a leaderboard. A small model with a Jev-shaped API is not automatically equivalent to Jev. A vendor CPU result on a large server is not laptop evidence. General classifier benchmark accuracy is not job-application accuracy.

Vision models such as [Qwen3-VL](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct) and [UI-TARS](https://huggingface.co/ByteDance-Seed/UI-TARS-1.5-7B) belong only in a later comparison for forms that cannot be understood from structured DOM data. They add model/runtime cost and are not needed in this baseline.

For later evaluation, build an employer-separated English/Turkish set of role labels, eligibility facts and form fields, including unknown and ambiguous cases. Compare accuracy/macro-F1, error at an abstention threshold, coverage, p50/p95 wall time including loading, peak RAM, install/model size, and billed cost where applicable. Pin every checkpoint and runtime. Test on the actual laptop with GPU disabled first; the RTX 3050 is an optional additional run. Do not let a classifier invent missing candidate facts.

## Existing project audit

Reviewed [isobed18/linkedin_job_scraper at 16d2e9](https://github.com/isobed18/linkedin_job_scraper/tree/16d2e910825ad540c15c383303428e61e3d38295). A reference checkout is at `D:\research_cache\linkedin_job_scraper`; the original project was not modified.

- `linkedin.py` uses one Selenium session and serial job-detail navigation. Each detail fetch explicitly sleeps 3–5 seconds, then sleeps another 2–3.5 seconds after returning to search. For 50 jobs this is **250–425 seconds in detail-related pauses alone**, derived from code, not measured execution time. Scrolling, page loads, waits, startup and analysis add more time.
- The pipeline generates per-job LLM analyses and cold-email drafts. The approval branch produces another draft in Telegram. This is not an implementation with independently verified employer application receipts.
- The code's SMTP function emails a discovered-job digest to a configured recipient; that does not establish 50 outbound employer applications.

The reusable concepts are the parsed candidate profile, explicit preferences and approval context. The new baseline does not carry over browser profiles, credentials, CSV exports, Telegram coupling or n8n orchestration.
