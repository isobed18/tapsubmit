# Deployed tapsubmit.com design (reference copy)

Fetched read-only from https://tapsubmit.com on 18 October 2026 (`/`, `/assets/discovery.css`, `/assets/discovery.js`).
This is the design the user approved. After that deployment, `web/public/discovery.*` on disk was rewritten into a
different (blue/slate, then dark) theme, and those files are untracked, so this copy is the only on-disk record of
what is live. The local app (`web/public/minimal.css`) follows these tokens:

| Token | Value |
| --- | --- |
| Paper background | `#faf9f6` |
| Ink | `#242922` |
| Muted | `#777d72` |
| Line | `#e5e6df` |
| Green (accent, primary buttons) | `#426c45` (hover `#335936`) |
| Soft green (chips, selected) | `#ecf1e7` / panel `#f3f5ee` / dashed `#c8d0c0` |
| Type | Inter / system sans; headline accents in Georgia italic, green |

Do not redeploy `web/public/discovery.*` without comparing it to this copy first.
