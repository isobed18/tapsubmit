# TapSubmit

Find relevant jobs across many sites, then prepare and send applications from **your own computer**.

- **Website ([tapsubmit.com](https://tapsubmit.com))** — finds jobs only. Your CV is read in your browser; only detected roles, skills and the region you choose are sent to search. No account, no sign-in to job sites, no applications.
- **App (Windows)** — a small local server plus a browser on your machine. Your account, CV, job-site sign-ins, answers and application history are stored only in the app's `data/` folder on your computer. TapSubmit has no server copy of them.

Don't want to trust a download? Read this code, or build the app yourself (see [desktop/README.md](desktop/README.md)).

## Shared job pool (optional)

TapSubmit continuously collects public job postings from company career sites (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, BambooHR, Workday and more) into a shared pool. The website searches it, and anyone can download it from tapsubmit.com (`/download/jobs.jsonl.gz`, gzip JSON lines: title, company, location, work type, posting date and link — no descriptions, no personal data).

Two options exist, both **off by default**:

- **Share found jobs** — after a search, public job details (title, company, location, work type, link) are added to the shared pool. Never a CV, name, contact details, answers or sign-ins.
- **Use the downloaded pool** (app only) — downloads the pool and searches it locally next to the live sources.

## Privacy boundary

| Data | Website | App |
| --- | --- | --- |
| CV file / text | stays in the browser | stays on your computer |
| Name, email, phone | never sent | stays on your computer |
| Job-site sign-ins (cookies) | not used | separate local browser profile |
| Screening answers, notes | not used | stays on your computer |
| Search terms | detected roles/skills + region | sent only to the job sites you choose |
| Found jobs | cached up to 21 days; shared pool only with permission | shared pool only with permission |

The website uses no generative AI model and no GPU. A small multilingual encoder (MiniLM, CPU) reads job titles and form labels. The app can optionally use a local CPU model you install yourself for text drafts; nothing is sent to an AI service.

## Run from source

```sh
# Website (discovery only)
cd web && npm ci && cd ..
node scripts/build_public_pool_index.mjs   # optional: needs public-pool/jobs-0001.jsonl.gz (download it from tapsubmit.com)
node web/discovery-server.mjs              # http://127.0.0.1:8789

# Local app (Windows build steps in desktop/README.md)
APPLYBURST_MODE=local node web/server.mjs
```

Applications are only sent after you allow it for the sites and limits you choose; unknown questions are never guessed — the job waits for your answer.

## License

MIT — see [LICENSE](LICENSE).
