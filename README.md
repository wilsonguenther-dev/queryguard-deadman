# queryguard-deadman

This repo is an outside alarm clock for QueryGuard Uptime, the site-health checker inside Drivia Consulting. QueryGuard's own checks run as a scheduled job inside our database, and a scheduled job that dies cannot report its own death, so something outside our systems has to notice the silence. Every 15 minutes this repo's GitHub Actions run opens the watched pages directly; if one does not answer correctly the run fails, and GitHub's failed-run email to the repo owner is the alert.

## What runs

- `.github/workflows/deadman.yml`: a check at :07, :22, :37 and :52 past every hour (and on demand from the Actions tab). It runs `node scripts/uptime/deadman.mjs`, one Node 24 file with no dependencies, against the addresses in `docs/uptime/deadman-targets.json`. Any failed check fails the run.
- `.github/workflows/keepalive.yml`: once a month (04:41 UTC on the 1st) it calls GitHub's "Enable a workflow" API for both workflows and checks they report `active`, because GitHub switches off scheduled workflows in a public repo after 60 days without activity. It uses only the built-in `GITHUB_TOKEN` (`actions: write`), makes no commit and never edits the workflow files. `KEEPALIVE` holds the one stamp the first version committed and is no longer written.

## Schedule rules (read before changing anything here)

GitHub's own words, from https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule: "This event will only trigger a workflow run if the workflow file exists on the default branch. Scheduled workflows will only run on the default branch. In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days." and "The schedule event can be delayed during periods of high loads of GitHub Actions workflow runs. High load times include the start of every hour. If the load is sufficiently high enough, some queued jobs may be dropped." From https://docs.github.com/en/actions/concepts/security/github_token: "events triggered by the GITHUB_TOKEN will not create a new workflow run" (except `workflow_dispatch` and `repository_dispatch`). A GitHub staff answer (https://github.com/orgs/community/discussions/185355) adds: "Any commit pushed to the default branch will resync the impacted scheduled workflows."

What happened here on 2026-09-30: the repo was created at 01:47Z, and 28 seconds later the first keepalive run pushed a `GITHUB_TOKEN` commit, which became the head of `main`. The workflow stayed `active`, Actions stayed enabled and the cron was valid, yet in 5 hours not one `schedule` run appeared while manual runs worked and the owner's drivia-consulting repo ran its own schedule at 05:45Z. A push to `main` by the repo owner is the documented resync, and was made at 07:11Z. The bot commit is a suspect, not a proven cause: the same account's drivia-consulting `licensing-probe` (cron `23 */6 * * *`, due 00:23/06:23/12:23/18:23 UTC) ran 3 times a day instead of 4 over 26 to 30 September, each 0.8 to 5.5 hours late, which is GitHub's documented delay-and-drop behaviour at a scale that makes this repo's cron a best-effort clock, not a 15-minute guarantee. Any reciprocal check on this dead-man must allow for hours of lag before it calls the schedule dead. So the rules are: no bot or `GITHUB_TOKEN` commit ever lands on `main`; after any change here the owner pushes it (not a bot); and when the dead-man goes quiet, first check `gh run list -R wilsonguenther-dev/queryguard-deadman --event schedule`, then `gh api repos/wilsonguenther-dev/queryguard-deadman/actions/workflows --jq '.workflows[]|{path,state}'`, then push a one-line owner commit to `main`.

## What it can see

Public web addresses only (today the 2BG site's `/api/health` and home page). There are no secrets, no API keys, no tokens, no client data and no database access anywhere in this repo. Run logs are public, so the script prints only PASS/FAIL, the address, the status code and a short reason code, never a page's contents. There is no `push` or `pull_request` trigger, so code from a fork never runs here.

## How to pause it

Actions tab, pick **deadman**, then **Disable workflow** (or `gh workflow disable deadman.yml -R wilsonguenther-dev/queryguard-deadman`); **Enable workflow** turns it back on. While it is paused, Drivia Consulting's own reciprocal check emails ops within an hour; that is expected.

## Where changes happen

Changes land first in Drivia Consulting's private repo (see `docs/uptime/DEADMAN.md` there), which owns `scripts/uptime/deadman.mjs` and `docs/uptime/deadman-targets.json`; the same bytes are then copied here in the same session, and a sha256 comparison catches any drift.

## Licence

None, on purpose: all rights reserved, Drivia Consulting code. The repo exists to run an alarm, not to be reused.
