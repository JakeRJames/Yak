# YAK

Your Accounts Keeper. Single-file personal finance app. Data stays in your browser.

## Live sharing (Ethereal)

`worker/` holds the small Cloudflare Worker that passes the encrypted household bills between phones. It deploys itself from GitHub Actions (`.github/workflows/sync.yml`): `dev` goes to a test Worker (`yak-sync-dev`, which also serves the dev build of YAK for trying on a phone), `main` goes to the live one (`yak-sync`). The result of each deploy is written to the `deploy-status` branch. It needs two repository secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
