# Website and local application boundary

There are two deliverables, with the same small frontend and discovery cache format:

| Component | Website demo | Windows app |
| --- | --- | --- |
| Job search | Browserless HTTP + shared public-job cache | Same adapters + persistent local cache |
| Résumé and answers | Not accepted by the server | Stored on the person's computer |
| Job-site authentication | Not collected | Person signs into a separate local browser profile |
| Application execution | Disabled | Deterministic browser companion |
| Optional models | Only with explicit future data-processing choice | Optional CPU-local feature, no model needed for known forms |

A server-side browser/LLM cannot submit a person's résumé and authenticated application while receiving none of the application data or session capability. Avoiding storage is different from avoiding processing. The default therefore executes on the person's device. An extension could offer the same privacy boundary later; it is not required for the Windows app.

The exe starts a loopback-only Node/SQLite service and a bundled Python browser worker. The web UI is its interface. Sessions and application values travel between these local components, and from the local browser to the employer; they do not pass through tapsubmit.com. The discovery website uses a separate SQLite directory and an API allowlist that rejects all profile/browser/application operations.

## Automatic flow

1. Choose sites and searches, or use résumé-derived suggestions.
2. Reuse a recent exact-query cache, or scrape the chosen sites. Keep old results on a failed source. Default freshness filter is the past week; source freshness and active status are not guarantees of ongoing employer acceptance.
3. If the person opts into Auto apply, queue up to the visible limit of supported application destinations.
4. Read/fill known facts and exact saved answers. Unknown required questions, closed jobs, login walls and unsupported forms become incomplete outcomes; the queue continues.
5. Automatic permissions constrain allowed sites and daily attempts. Before the final click, durably record submission intent and acknowledge it to the worker. An absent acknowledgement prevents the click.
6. Recognize new confirmation evidence. Only then show a green confirmation card. An uncertain final result requires checking before any retry.

Automatic mode now inspects, fills, submits and verifies each job in one browser visit, with a live policy check and durable intent acknowledgement before the final click. Exact batch-review mode still prepares and reopens forms to verify the reviewed plan. See [the core engine](CORE_ENGINE.md) and its raw measurements for the current performance and coverage boundary.

## Verification boundary, 16 October 2026

- Packaged launcher started its own local server and auto-authenticated the UI.
- User's attached DOCX imported through the packaged worker; no employer received it.
- Live query `AI engineer`, Türkiye, past week, Indeed + Himalayas: one job returned in the displayed ~6.4-second run; no remote matches were added for those filters. Do not extrapolate this to universal 50-job coverage.
- Public HTTPS query `AI engineer`, United States, past week, Indeed: 25 jobs in the displayed2.6s; same query reused25 cached jobs in0.2s. These are individual runs, not latency percentiles.
- Through the packaged app UI, a synthetic automatic run against local Greenhouse-, Lever- and Ashby-shaped forms produced three confirmations; a fourth required an unanswered question and was skipped. Independent receiver read: exactly three accepted, zero rejected. These are test employers, not real employer applications.
- Existing verification: 45 JavaScript checks and 43 Python/browser checks passed. No new test suite was added for the UI/packaging work; live and packaged-flow verification was performed separately.
- Real employer submission count remains zero. Earlier real-site read-only inspections are documented in `handoff.md`.
- Complete installer is approximately113MB (272MB expanded), with1309 payload files. ZIP integrity and required runtime/UI paths are checked during the build; private data paths are excluded. Payload extraction, bundled Node, worker diagnosis and DOCX extraction were verified separately from the source tree. Reopening a second launcher instance is implemented but its final verification command was rejected by automatic approval review.
