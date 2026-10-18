# Next acceptance gates

## Completed in the research demo

Nine-board full-description ingestion; source failures and retained cache; conservative normalization with unknowns; detailed Boolean/field search; source evidence and duplicate requisition collapse; CPU Web Worker and revision-checked prebuilt index; read-only Greenhouse question inspection; synthetic template drafts; selected batches; durable, idempotent sandbox receipts; local HTTP/browser/SMTP baseline measurements; responsive website; source and reproducible reports.

These demonstrate a working system architecture. They do not establish market-wide discovery, candidate fit, or real employer submission coverage.

## 1. Coverage, search quality, and the actual laptop

Expand the registry and monitor ATS migrations. Build a manually judged English/Turkish query set with descriptions, required qualifications, negation, location, and eligibility. Evaluate precision/recall and stale/closed results across employers, alongside latency. Synthetic correctness tests are not a relevance benchmark.

Measure startup transfer, time to 50 unique relevant results, p50/p95 query latency, and peak browser memory on the user's laptop with GPU disabled. Current measurements use a Ryzen 5 7600X desktop. Candidate target: warm query p95 below 250ms on the laptop; this is not yet a proven guarantee.

At larger index sizes, move queries to a shared CPU retrieval service and send only matching snippets/details. The current approximately 4.13MB gzip catalog-plus-index is practical for a nine-board demo, not the distribution strategy for millions of postings. Add cross-source canonical identities before mixing LinkedIn and employer records; current collapse handles repeated Greenhouse internal requisitions only.

## 2. One real form family, measured end to end

The real public Greenhouse schema inspection is implemented. Build the corresponding local session executor with approved candidate facts, conditional questions, schema fingerprints, file upload, and an employer-specific confirmation condition. Public listing GET APIs do not grant applicant submission POST credentials.

Validate at least five employers and missing/conditional-field paths with reviewed test data before claiming that ATS family is supported. Track discovered → eligible → prepared → attempted → confirmed separately. Timeouts after possible side effects stay unknown until reconciled; never blindly retry.

Then expand to a second form family and explicit mail applications. Keep browser concurrency at two until laptop measurements justify more. Known templates and facts handle basic mail writing; SMTP acceptance remains distinct from delivery and ATS confirmation. No real employer or email submissions occurred in the current work.

## 3. Add classifiers only for measured gaps

Compare rules/BM25, TF-IDF/fastText, Model2Vec, SetFit/FastFit, GLiClass, GLiNER2.5-Decide, Laya, and Jev on employer-separated labels and unfamiliar form fields. Measure quality, abstention, load time, RAM, CPU p50/p95, and actual hosted cost. Do not download/run models on the reserved GPU. No classifier should invent a candidate's visa, salary, consent, or eligibility facts.

## 4. Broader release

The owner-private website is the current try-it demo; its sandbox really receives uploads and persists receipts. Broader sharing needs the intended audience, user/session isolation, request quotas, retention, and a reviewed real-adapter set. Licensing and scraping-policy review remain deliberately deferred at the user's request. Public “50 real applications in seconds” copy waits for evidence from that supported set.
