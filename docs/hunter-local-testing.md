# Hunter's local Feed testing guide

This guide gets the Feed UI and Feed Host running locally, then verifies the
manifest-backed Ethereum delegation flow introduced in Feed PR #25.

## What you are testing

One OpenKey sign-in grants the browser session the Feed, Artifactory, and
Listen capabilities declared by the combined manifest. The browser then uses
its session key to create one multi-resource delegation for Feed Host and
submits it once. Feed Host authority setup must not produce a separate Ethereum
signature request for each SQL or KV resource.

## Prerequisites

- Bun 1.3 or newer
- A Chromium-based browser for manual testing
- An Ethereum wallet available through OpenKey for the manual flow
- Playwright Chromium for the automated flow

Do not use or commit a production private key. The automated test creates an
ephemeral Ethereum key in memory.

## 1. Install

```sh
git clone https://github.com/TinyCloudLabs/feed.git
cd feed
bun install --frozen-lockfile
bunx playwright install chromium
```

If the repository is already cloned, pull `main` and run the two install
commands from the repository root.

## 2. Render the app locally

Start Feed Host in one terminal:

```sh
FEED_HOST_SEED=1 bun run host
```

Expected output includes a local URL on port `8787`. Leave this process
running.

Start the Feed UI in a second terminal:

```sh
bun run dev:local
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The UI should show the
Feed sign-in screen and connect to `http://127.0.0.1:8787`.

Optional checks before signing in:

```sh
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/delegation-policy | jq
```

The policy should have a `delegateDID`, eight resources, and no `#` fragment in
the delegate DID.

## 3. Test the manual Ethereum flow

1. Select **Sign in with OpenKey**.
2. Choose an external Ethereum wallet.
3. Complete OpenKey and TinyCloud setup.
4. Wait for **Setting up your Feed** and then the seeded **A useful first
   look** item.
5. Reload the page. Feed should restore without opening the wallet.

A brand-new wallet can require multiple signatures while OpenKey creates and
provisions its TinyCloud account. That is part of sign-in. What must not appear
after sign-in is a Feed Host signature message whose URI is the policy's
`delegateDID`, such as a separate request for
`xyz.tinycloud.feed/settings`. Feed Host receives one bundled delegation
without another wallet approval.

The rendered flow is correct when:

- no bundle or resource approval UI appears in Feed;
- the Feed Host receives one delegation submission;
- the first Feed item renders and its controls work;
- reload restores or repairs access without an Ethereum signature;
- **Access & automation** opens and can attach a test credential reference.

## 4. Run the focused end-to-end proof

Stop the manual servers or use alternate ports. This command starts isolated
Feed Host and Vite processes, injects an ephemeral Ethereum wallet, completes
OpenKey sign-in, and checks the bundled delegation behavior:

```sh
FEED_SMOKE_HOST_PORT=8890 \
FEED_SMOKE_WEB_PORT=4290 \
bunx playwright test e2e/specs/openkey-wallet-feed-flow.pw.ts \
  --grep "one sign-in sets up Feed"
```

Expected result:

```text
1 passed
```

The test specifically asserts that Feed Host receives one submission and that
no signed Ethereum message names Feed Host as its URI.

Run every browser scenario, including reload recovery and failure handling:

```sh
FEED_SMOKE_HOST_PORT=8890 \
FEED_SMOKE_WEB_PORT=4290 \
bun run test:smoke
```

## 5. Run the code checks

```sh
bun run typecheck
bun run test
bun run build
```

The current baseline is 40 unit/integration tests plus three Playwright browser
scenarios.

## Troubleshooting

### `Failed to fetch`

Confirm Feed Host is reachable at `http://127.0.0.1:8787/health` and that the
UI was started with `bun run dev:local`. A Vite process started without the
local host override points at the hosted Feed API instead.

### Port already in use

Stop the existing process or choose isolated Playwright ports with
`FEED_SMOKE_HOST_PORT` and `FEED_SMOKE_WEB_PORT` as shown above.

### A stale session will not recover

Use **Sign out**, clear the site data for `127.0.0.1:5173`, and sign in once
more. Current manifest-backed sessions normally repair a stale local Feed Host
delegation cache without a wallet prompt.

### Feed setup fails after a DID error

Confirm both TinyCloud dependencies are `2.6.4-beta.1` or newer:

```sh
bun pm ls | grep '@tinycloud/.*sdk'
```

Also confirm `/delegation-policy` returns a fragmentless principal DID.

