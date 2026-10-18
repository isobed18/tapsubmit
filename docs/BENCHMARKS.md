# Measurements — 16 October 2026

All application writes used synthetic data and project-owned loopback/hosted sandbox receivers. Employer sites were accessed with GET requests only. No employer application or recruiter email was sent. No model benchmark is complete. There is no GPU dependency.

## V2: detailed search and the website

The V2 bundle contains **1,892 postings / 1,850 unique opportunities** from nine boards. Greenhouse internal requisition IDs collapse 42 repeated postings; different matching locations are retained before collapse. Full descriptions exist for 1,891 postings, technology mentions for 907, workplace evidence for 1,209, and recognizable title seniority for 634. Unknowns remain unknown.

The exporter refresh took 27.17s with one failed source; it retained previous Palantir postings. Its first-50 milestone values are zero because this was an already-populated catalog, **not an empty-index bootstrap result**. The website live-refresh probe took 20.83s; Palantir timed out at 18s and its 309 previous records were retained with their old observation ages. The JavaScript/Python enrichers currently differ by one technology-tagged record. These reports demonstrate partial-result preservation, not all-source success: [discovery-v2.json](../reports/discovery-v2.json), [live-refresh-v2.json](../reports/live-refresh-v2.json).

### Shared CPU search engine

Node v24.13.0 on the same desktop; ten detailed queries, 30 samples each, prebuilt index already loaded. JSON parse: 32.88ms; packed-index parse: 12.26ms; engine initialization: 11.66ms. **Query p95 spans 0.09–3.45ms**, depending on the expression. These query times exclude network transfer, parsing, UI rendering, and startup. They are not laptop results.

The catalog is 14,524,420 decoded bytes / 2,577,203 bytes gzip. The packed inverted index is 6,265,598 decoded / 1,552,371 bytes gzip. Compression is a local gzip calculation, not measured deployment wire bytes. Additional Node heap for loading the packed index was 17,488,352 bytes; whole process heap was 79,042,128 bytes. Browser peak memory and laptop behavior remain unmeasured.

An index-build probe measured 1,000ms to build from descriptions versus 3.62ms to initialize the packed representation, checking result parity on six queries. The separate query benchmark's initialization was 11.66ms; variation is preserved rather than presenting the fastest sample as a guarantee. A changed live catalog falls back to a local build; the browser UI reports which path it actually used.

Example results: `description:postgresql` found 80 unique opportunities. `description:postgresql NOT level:senior` returned 62 in browser QA, including database requirements absent from titles. The default `skill:python AND (backend OR "distributed systems") NOT level:senior` returned 108 on this snapshot. These are lexical matches, not 108 eligible jobs for the synthetic or actual user.

Raw evidence: [search-v2-final.json](../reports/search-v2-final.json), [index-v2.json](../reports/index-v2.json). [search-v2.json](../reports/search-v2.json) preserves the earlier full-build experiment.

### Preparation and sandbox execution

A real read-only Stripe Greenhouse question inspection found **23 required groups, five recognized identity/upload mappings, and 18 unresolved required groups**. Alternate resume file/text inputs count as one question group. This establishes required-field discovery, not submission readiness. [Raw inspection](../reports/form-inspection-v2.json).

The browser selected 50 actual matching opportunities and made 50 multipart requests with a 26,624-byte synthetic resume and six fixed answers. At concurrency five, the local V2 run finished in **0.9443s**, including **0.9150s submission/receipt checking + 0.0293s independent receiver reread**. All 50 had matching IDs, hashes and confirmed sandbox states; all 50 were persisted; zero outcomes were unknown. This local receiver has no injected ATS delay. [Downloaded browser evidence](../reports/sandbox-browser-v2-local.json).

Six API checks separately verified valid uploads, stable idempotent replay, corrupt-byte rejection, missing-answer rejection, unregistered-board rejection, and exactly one independently stored receipt after replay. [Raw API checks](../reports/sandbox-api-v2.json).

Browser QA also checked description-only retrieval, invalid-query clearing, real form inspection, synthetic email download, and the 390px responsive layout. The desktop browser's local-index rebuild showed 717ms in one observation; this is a single startup observation, not a percentile or a laptop measurement.

The deployed owner-private site's HTTPS API was then tested with supported Sites service access from a Node desktop client. **50/50 sandbox receipts were confirmed and persisted in 5.8570s**, comprising 5.5735s submission and 0.2835s final receiver verification. Five requests ran concurrently; each uploaded 26,624 synthetic bytes. Replay, corrupt bytes, missing answers, and unknown board rejection also passed. The initial catalog download plus local full-text index build took 6.4675s; its first detailed query took 13.12ms and found 108 unique matches. These are single hosted API observations, not browser measurements or percentiles.

The subsequent hosted refresh completed in 11.641s including response transfer, with all nine sources succeeding. Earlier partial-source runs remain above. Hosted Greenhouse inspection again reported 23 required groups and 18 unresolved; real submission remained unverified. [Hosted raw evidence](../reports/hosted-demo-v2.json). The interactive UI was verified locally; the deployed browser requires the owner's ChatGPT sign-in. No access policy was relaxed for testing.

### Correctness and limits

20 Python tests and 24 dependency-free JavaScript tests passed. They include full Lever sections, HTML cleanup, cache representation invalidation, phrase and Boolean semantics, punctuation skills, Go-versus-verb aliasing, Turkish location normalization, missing facts, explicit filters, evidence, canonical collapse, alternative form controls, and abstention on consent/custom questions. The site TypeScript check and production build passed.

These tests establish implementation behavior, not a manually judged real-world retrieval benchmark. They do not compare Jev or other models, prove market-wide recall, test the actual laptop, or validate any real employer application adapter. The website visibly reports real employer adapters as zero.

## Earlier title-search and executor baseline

## Environment and method

Windows 11; AMD Ryzen 5 7600X, six cores/twelve threads; Python 3.12.10. Package versions and timestamps are embedded in every report; dependency resolution is committed in `uv.lock`. This is desktop evidence. The user's RTX 3050 laptop has not been tested, and concurrent machine activity was not controlled as in a laboratory.

Application batches contain 50 jobs. Unless stated otherwise, each scenario has three repeats. Tables show medians and observed ranges; three repeats do not establish a reliable production p95. HTTP and SMTP receiver delay is an explicit injected 100ms (one HTTP scenario uses 500ms). It is not a measurement of real ATS latency.

## Live discovery and cache

| Measurement | Result | Scope |
| --- | --- | --- |
| First 50 indexed jobs | 771.9ms | Empty local index, nine-board refresh |
| First 50 `engineer` title matches | 772.7ms | Empty index; no user-specific eligibility filtering |
| Entire nine-board refresh | 5.894s; 1,890 jobs | All nine sources succeeded in this run |
| Next refresh | 4.992s | Revision-aware refresh; cached results remained available throughout |
| SQLite cached query, p50 / p95 | 3.278ms / 5.519ms | 200 full-text `engineer` queries, 1,890-job index, 50 results each |
| Actual HTTP title search, p50 / p95 | 12.002ms / 32.566ms | 200 loopback requests, separate 1,695-job catalog, 50 results each |
| First HTTP search request | 132.140ms | Includes first connection/request; server already running |
| JobSpy LinkedIn search | 20/50 jobs, 14.329s library time | One query for software engineer/Turkey; 429 warning; 20.173s including process/import overhead |

Raw evidence: [discovery-final.json](../reports/discovery-final.json), [search-http.json](../reports/search-http.json), [jobspy.json](../reports/jobspy.json). Discovery bootstrap uses an empty index; this does not mean OS DNS caches, network paths, or providers' CDNs were cold.

The 1,890 jobs comprise Stripe 726, Cloudflare 436, Palantir 309, Ashby 62, Ramp 163, Trendyol 42, Insider One 114, Peak 18 and Dream Games 20. There were 54 postings whose location text mentioned Turkey/Turkiye/Istanbul/Ankara; this heuristic is not geographic eligibility and omits other Turkish cities. It does not establish 50 software jobs suitable for a particular candidate in Turkey.

An earlier nine-board run took 31.248s because of slow responses. The individual request deadline was subsequently added; an intermediate run indexed 1,581 jobs with source failures. Both are preserved in [discovery.json](../reports/discovery.json) and [discovery-deadline.json](../reports/discovery-deadline.json). A final successful refresh does not erase this failure evidence. Return cached/available results early and expose partial source coverage.

In the payload probe, Stripe metadata was 453,473 decoded bytes versus 5,651,563 with descriptions: **12.46×** the decoded size. Both responses were gzip encoded; those numbers are not measured wire bytes. A prior conditional-refresh test returned HTTP 304 with empty bodies from all nine boards.

## Application execution against a local receiver

| Path | Workers | Receiver delay | Median for 50 | Observed range |
| --- | ---: | ---: | ---: | ---: |
| Multipart HTTP | 1 | 100ms | 5.992s | 5.885–6.202s |
| Multipart HTTP | 5 | 100ms | 1.872s | 1.837–1.900s |
| Multipart HTTP | 10 | 100ms | 1.343s | 1.340–1.448s |
| Multipart HTTP | 20 | 100ms | 1.122s | 1.091–1.169s |
| Multipart HTTP | 10 | 500ms | 3.392s | 3.357–3.404s |
| Browser, after startup | 1 | 100ms | 16.208s | 15.949–16.334s |
| Browser, after startup | 2 | 100ms | 8.092s | 8.015–8.968s |
| Browser, after startup | 5 | 100ms | 4.029s | 3.773–4.043s |
| SMTP acceptance | 10 | 100ms | 1.078s | 1.021–1.102s |

Browser medians **including** browser/context/page startup: 17.058s at one worker, 8.934s at two, and 5.027s at five. Startup for each repeat is recorded separately. The two-worker setting is the default resource budget for future laptop use, not a measured laptop result.

The receiver checks all six required candidate fields, validates exact uploaded resume bytes, and returns a job-specific receipt with a SHA-256 and byte count. The browser path navigates, fills controls, selects an option, uploads a file, clicks submit, and parses/validates the confirmation. HTTP includes client setup, all multipart requests and receipt checking. Browser timing after startup includes all form navigations. Mail timing includes fresh SMTP sessions and attachment transmission; fixture listener startup is excluded.

All **28 final scenarios returned 50 verified fixture receipts or 50 SMTP acceptances**. Receiver counts independently agree with send-side confirmations in the repeated HTTP, browser and SMTP cases. The singly sampled paced case validates the same receipt format. SMTP acceptance is never called employer delivery or an ATS confirmation.

A separate **2-request/second** fixture run needed **24.846s** for 50 receipts. This is not a throttling test against Lever. It illustrates the mathematical throughput limit and why a universal “50 public-site applications in a few seconds” claim is unsupported.

Raw evidence: [baseline-final.json](../reports/baseline-final.json). [baseline.json](../reports/baseline.json) preserves the initial run, including larger outliers; the final table does not silently average that different execution snapshot into the repeated final run.

## Correctness checks

16 local checks passed. They cover source normalization; unlisted/prospect filtering; cache freshness and closures; rollback on an invalid snapshot; conditional reads and failure preservation; fast-result availability during a slow source; API input constraints and minimal result payloads; missing required candidate facts; concurrent/persistent duplicate claims; explicit rate-rejection retries; missing receipts; timeout after receiver-side acceptance; interrupted-run recovery; and loopback-only submission targets.

These tests do not establish real ATS coverage. Authentication, conditional forms, CAPTCHA, CSRF/session constraints, file-format validation by an employer, remote network variability and actual receipt recognition remain to be tested in real adapters. No direct comparison with Codex, Claude or vendor browser-agent latency was performed.

## Reproduction

Use the commands in [README](../README.md#reproduce-measurements). `applyburst.discovery_bench` also measures HTTP search in new runs; the saved `discovery-final.json` predates that additional measurement, so its HTTP comparison is in the separate `search-http.json`. Public feeds will change, and exact counts/timings are not expected to reproduce bit-for-bit.

The current evidence supports fast indexed discovery and low-overhead known-workflow execution. Real application coverage and laptop performance remain acceptance gates, documented in the [roadmap](ROADMAP.md).
