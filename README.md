# YAK

Your Accounts Keeper. Single-file personal finance app. Data stays in your browser.

## Live sharing (Ethereal)

`worker/` holds the small Cloudflare Worker that passes the encrypted household bills between phones. It deploys itself from GitHub Actions (`.github/workflows/sync.yml`): `dev` goes to a test Worker (`yak-sync-dev`, which also serves the dev build of YAK for trying on a phone), `main` goes to the live one (`yak-sync`). The result of each deploy is written to the `deploy-status` branch. It needs two repository secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Bill reminders (Ethereal 1.1)

The same Worker sends Web Push reminders at 7pm UK time (cron at 18:00 and 19:00 UTC; only the run at 7pm UK time sends). Phones send only their push address and a list of dates with a kind (`due`, `pay`, `dd`); the nudge carries just the kind, and `sw.js` writes the message on the phone from the figures it already holds. When a manager updates live-shared house bills, housemates with reminders on get a `chg` nudge. The VAPID key pair is created by the Worker the first time it is needed and kept in its KV namespace.
