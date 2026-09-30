# queryguard-deadman

This repo is an outside alarm clock for QueryGuard Uptime, the site-health checker inside Drivia Consulting. QueryGuard's own checks run as a scheduled job inside our database, and a scheduled job that dies cannot report its own death, so something outside our systems has to notice the silence. Every 15 minutes this repo's GitHub Actions run opens the watched pages directly; if one does not answer correctly the run fails, and GitHub's failed-run email to the repo owner is the alert.

## What runs

- `.github/workflows/deadman.yml`: a check at :07, :22, :37 and :52 past every hour (and on demand from the Actions tab). It runs `node scripts/uptime/deadman.mjs`, one Node 24 file with no dependencies, against the addresses in `docs/uptime/deadman-targets.json`. Any failed check fails the run.
- `.github/workflows/keepalive.yml`: once a month (04:41 UTC on the 1st) it writes the current UTC time into `KEEPALIVE` and commits it, because GitHub switches off scheduled workflows in a public repo after 60 days without activity. It uses only the built-in `GITHUB_TOKEN` and never edits the workflow files.

## What it can see

Public web addresses only (today the 2BG site's `/api/health` and home page). There are no secrets, no API keys, no tokens, no client data and no database access anywhere in this repo. Run logs are public, so the script prints only PASS/FAIL, the address, the status code and a short reason code, never a page's contents. There is no `push` or `pull_request` trigger, so code from a fork never runs here.

## How to pause it

Actions tab, pick **deadman**, then **Disable workflow** (or `gh workflow disable deadman.yml -R wilsonguenther-dev/queryguard-deadman`); **Enable workflow** turns it back on. While it is paused, Drivia Consulting's own reciprocal check emails ops within an hour; that is expected.

## Where changes happen

Changes land first in Drivia Consulting's private repo (see `docs/uptime/DEADMAN.md` there), which owns `scripts/uptime/deadman.mjs` and `docs/uptime/deadman-targets.json`; the same bytes are then copied here in the same session, and a sha256 comparison catches any drift.

## Licence

None, on purpose: all rights reserved, Drivia Consulting code. The repo exists to run an alarm, not to be reused.
