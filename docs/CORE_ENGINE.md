# Core engine: speed, relevance, verified completion

Current priority: finding relevant active postings and applying quickly on ordinary laptops.
Packaging, screens and deployment are secondary. No n8n, subagents, required model or GPU inference.

## Execution path

1. Compile the user's detailed search, or derive searches from résumé skills. Preserve the
   original Boolean/field/phrase expression for local filtering; send provider-compatible
   keywords to external search endpoints.
2. Query recent saved memberships first. Exact successful searches live for 30 minutes;
   successful empty queries live for five minutes. Remote OK's feed is shared across different
   queries for 15 minutes, including concurrent requests. Company boards have source TTLs.
   Failed/throttled reads retain previous evidence; successful refreshes replace query
   membership. Observation time and posting date remain different facts.
3. Fetch public search/ATS data over HTTP. Do not launch a browser to discover jobs. Ingest
   full descriptions where provided; LinkedIn guest cards can lack them. Harvest employer
   board identities from destinations, resolve bounded short links, and index those boards
   independently of the interactive search.
4. Rank the returned shortlist locally. The persistent corpus uses BM25; the shortlist uses
   the same Boolean field/phrase grammar, term evidence, explicit requirements, location,
   seniority and freshness rules without building a second inverted index. Scores are an
   ordering mechanism, not eligibility probabilities. Unclear topic/location matches need
   review; explicit mismatches cannot enter the automatic queue. Engineering searches
   reject clearly different roles even when company boilerplate mentions engineers or AI.
5. Deduplicate by provider identity and employer destination. Preserve job-identifying query
   parameters. A Greenhouse embedded token and its direct job URL share one destination;
   separate embedded jobs remain separate. Do not deduplicate by fuzzy title/company.
6. Open one local browser, reuse its authenticated context, and cap **total** active pages
   across LinkedIn and other employers. Default concurrency is two. LinkedIn remains a
   sequential lane with configurable pacing; this does not establish a ban-safe rate.
7. Automatic mode inspects, fills, submits and verifies a job in **one pass**. It does not
   prepare an entire batch and reopen every form. Known employer handoffs from LinkedIn
   continue to the destination adapter, which checks its own site permission. Unknown
   required questions stop that job before filling/uploading whenever visible initially;
   later conditional questions can still require a skip. Exact batch review remains a
   separate two-pass option.
8. Before every final click, the backend rechecks live permission, pause, daily cap,
   destination family, disclosure sources and duplicate/uncertain attempts. It records
   submission intent durably **before** acknowledging the click. Confirmation requires new
   website evidence. No receipt/confirmation means unknown, never automatic retry.

## Coverage, without counting a registry as implementation

| Family/source | Discovery | Current application capability |
| --- | --- | --- |
| Greenhouse | Public company feed, full descriptions; short-link and board harvesting | Deterministic DOM adapter, embedded forms, synthetic submission/receiver verification, real read-only inspection |
| Lever | Public company feed, full descriptions | Deterministic DOM adapter; synthetic submission/receiver verification, real read-only inspection |
| Ashby | Public company feed, full descriptions | Deterministic DOM adapter; synthetic submission/receiver verification, real read-only inspection |
| Workable | Public company widget feed; company harvesting | DOM adapter, real read-only inspection; no verified real submission |
| LinkedIn | Guest cards; optional local authenticated discovery | Local signed-in Easy Apply adapter, English/Turkish, synthetic multi-step verification; employer handoff; subject to login/limits |
| Indeed | HTTP targeted search, descriptions and some employer destinations | Supported employer adapters after direct routing; Indeed Apply itself remains unsupported |
| SmartRecruiters | Public company search plus detail requests; board harvesting | Human-verification block observed; no automatic application adapter |
| Personio | Public XML feed, full descriptions, board harvesting | Discovery only; no automatic application adapter |
| Himalayas / Remote OK | HTTP search/feed, posting dates and advertised restrictions | Follow actual supported employer destinations; aggregator pages themselves are not verified application forms |
| Glassdoor, other configured targets | Optional/partial discovery or routing metadata | No claim of general automatic coverage |

Five executable application families do not mean twenty verified job portals. An ATS adapter
can serve many employers using that family, but custom questions, authentication, validation,
CAPTCHA and site changes still limit completion. **No real employer application has been sent
during development.**

## Measurements

Raw, source-fingerprinted results are in [core-engine.json](../reports/core-engine.json),
[core-discovery.json](../reports/core-discovery.json) and
[core-policy.json](../reports/core-policy.json). The first is a controlled loopback execution
comparison, the second is live read-only discovery, and the third checks the production HTTP
API/worker against an independent synthetic receiver. They are different workloads.

16 October 2026 desktop runs:

| Workload | Measured result | Scope |
| --- | --- | --- |
| 50-job automatic queue: 48 answerable + 2 unknown | 41.16s median; 48 confirmed, 2 skipped | Two loopback runs, four fixture families, fresh uploads independently hashed |
| Previous prepare/reopen/submit path | 77.40s median | Same fixture workload and two-page limit; single pass is 1.88× faster |
| Automatic browser memory | 583–585MB peak summed process-tree RSS | Two automatic runs; shared pages are counted, not private physical memory |
| US live discovery, three related searches | 70 matches in 2.85s; first batch 0.10s | Six sampled employer boards were indexed first; Indeed/Himalayas/Remote OK searched live |
| Türkiye live discovery, same searches | 9 matches in 1.97s; first batch 0.42s | Some matches require topic/location/seniority review; zero automatically selectable supported routes in this sample |
| Repeated exact-query cache | 1.27ms / 1.41ms p50, Türkiye / US | Five local samples each; excludes HTTP/UI |
| Discovery peak RSS | 527MB | Node benchmark including six-source ingestion, SQLite and search worker; not just a query |

The US sample has six automatically selectable supported destinations. That is routing and
selection evidence, **not** six completed applications. Work authorization remains unknown.

The [résumé-only flow](../reports/core-resume-search.json) subsequently generated `agentic AI`,
`AI engineer` and `machine learning intern` from the local early-career profile. It reused all
six employer-source caches, returned11 Türkiye matches in2.871s, and repeated in1.33ms p50.
No automatically selectable supported destination was present in that sample. A public
aggregator listing for its first internship returned HTTP403 during a separate read-only
destination probe; no workaround or application was attempted.

[Fresh live form inspection](../reports/core-live-forms.json) found the form and final button
on all four sampled Greenhouse/Lever/Ashby/Workable pages in1.9–2.8s each. Inspection typed
nothing, uploaded nothing and emitted zero submission intents; it does not verify a real
employer submission.

Reproduce from the repository root (PowerShell):

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH='D:\cache\ms-playwright'
uv run --extra bench python -m applyburst.core_bench --jobs 50 --repeats 2 --output reports/core-engine.json
node scripts/measure_discovery.mjs --output reports/core-discovery.json
# Optional: --profile <private extracted-resume.txt>; résumé content is not put in the report.
```

The application comparison uses 48 answerable jobs across four fixture families and two
unknown-question jobs. Receiver counts, unique identities and all fresh-upload hashes must
agree with executor outcomes. LinkedIn fixture pacing is zero; browser startup and answer
calibration are reported/excluded separately. Default production pacing and real site network
latency add time. This is not a measured rate for real employer applications.

Memory figures are measured on this desktop, not the user's RTX 3050 laptop. Browser memory
is summed process-tree RSS and includes shared pages. No model calls or GPU inference occur.
Live discovery counts can shrink after correcting irrelevant roles/country restrictions;
raw count is not the product metric. The retrieval rules still need human relevance labels
before any accuracy claim.

## Decisions and remaining work

- Keep structured HTTP ingestion + shared cache + CPU retrieval. A vector database is an
  optional derived index: existing stable IDs, content hashes, chunks and the index-event
  outbox support it. Store candidate information separately from a future shared job cache.
- Keep DOM adapters as the fast application route. Applicant access to a public posting API
  does not confer employer credentials for application submission. Use the applicant's local
  session; do not replay undocumented submission endpoints as if confirmation were assured.
- Keep Jev, small classifiers and general LLM/computer-use agents optional. Current known
  flows need none. Evaluate a model only on observed unfamiliar-field/ranking errors with
  employer-separated labels, abstention, CPU latency and RAM measurements. No model
  comparison has been completed.
- Next coverage work should follow observed destinations, not an arbitrary portal count:
  improve actual employer-link resolution, then validate the highest-volume unsupported
  family. An unsupported flow stays incomplete until independently verified.
- Keep the browser's shared HTTP cache. Playwright documents that request routing disables
  HTTP caching, so blanket asset interception needs a measured benefit before adoption.
  [Playwright routing reference](https://playwright.dev/python/docs/api/class-page#page-route).
- A real completion-rate benchmark needs a user-approved real batch/site permission and
  actual employer confirmations. Work authorization, salary, consent and custom answers
  must come from the user; a model cannot establish those facts.
