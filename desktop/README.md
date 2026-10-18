# ApplyBurst for Windows

Run `dist/ApplyBurst-Setup.exe`, choose an installation folder, and choose **Install & open**. The installer includes Python, Node and the application worker; no terminal commands or administrator setup are required. It starts a loopback server and opens the app in your browser. Keep the small launcher running during applications.

The preview installer is unsigned. Default installation is `D:\Apps\ApplyBurst` when D: exists, otherwise the user's local Programs folder. Existing installations are not overwritten. Data stays in `data/` beside the installed app; use the launcher's data-folder button to find it. Never upload that directory.

Chrome or Edge is reused with a separate ApplyBurst profile. If neither is installed, first launch downloads Playwright Chromium. Sign in to each job website in the window opened by the app, then close that window. The app reuses that local session; it does not use your normal browser profile or send cookies to the demo server.

Upload a CV, pick what ApplyBurst may do, and press **Start**. Typing a role is optional: the CV decides the search directions unless you replace them.

| Profile | What happens | Final submit |
| --- | --- | --- |
| Find only (default) | Search with the CV and show matching jobs | Never |
| Prepare, then ask me | Fill every known field, stop before the final button | Only the exact batch you review and send |
| Controlled auto | Send on the form families you allow, using only your CV, your details and saved answers | Automatic within the per-run and daily limits |
| Full auto | As controlled, and also values the website prefilled (for example from your LinkedIn profile) | Automatic within the limits |

Automatic profiles ask for one explicit permission that shows their scope; Start never widens it, and it can be withdrawn in Settings. Pause lets open forms finish and starts nothing new; Stop closes the browser. Jobs, form filling, sending and employer confirmation appear live in one card per job. Unknown questions are never guessed: the job waits in **Needs you**, the others continue, and one answer retries every job that waited only for it. A card counts as applied only after new employer confirmation evidence; an uncertain submission is never resent automatically.

First launch downloads the small multilingual CV/form reader (Xenova/paraphrase-multilingual-MiniLM-L12-v2, int8 ONNX, about 135 MB, pinned revision, every file size- and SHA-256-checked) into `data/models` with a progress bar; later launches run offline. It runs on the CPU only. Without it (no internet on first launch), typed-role searches still work and the next launch finishes setup.

Current application families: LinkedIn Easy Apply, Greenhouse, Lever, Ashby and Workable. These have fixture verification and earlier read-only live inspections; real submission coverage is not yet established. Indeed discovery often links to one of these employer forms; Indeed's own application flow is not yet automated. CAPTCHA, logins and unsupported sites remain explicit incomplete outcomes.

No generative LLM or GPU is used. Known fields are deterministic; the small encoder only reads meaning (CV roles, job-title relevance, form labels, buttons and confirmation messages in any language).

## Build

On Windows with Node 24, Python 3.12, the repository environment and PyInstaller 6.22.3:

```powershell
uv pip install --python .venv\Scripts\python.exe pyinstaller==6.22.3
.\desktop\build.ps1 -Installer
```

Outputs: portable `dist/ApplyBurst/ApplyBurst.exe`, `dist/ApplyBurst-payload.zip`, and single installer `dist/ApplyBurst-Setup.exe`. Only explicit web/config/script resources enter the package, plus the Windows x64 encoder runtime pruned from `web/node_modules` (transformers.js Node build, ONNX Runtime win32/x64, sharp). Run `npm install` in `web/` before building. Runtime data, credentials, personal résumés, model weights and browser profiles are excluded. JobSpy/pandas/numpy/torch stacks are excluded; ordinary discovery uses Node HTTP adapters.

The public website uses `APPLYBURST_MODE=discovery` and a different data directory. It refuses profile, résumé, browser and application APIs. `APPLYBURST_MODE=local` is used only by the local app. A one-use loopback ticket starts the desktop session without exposing a password or asking a nontechnical user to set up an admin account.
