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

## Review the mobile wireframes

The approved mobile walkthrough is included in this repository at:

```text
docs/wireframes/artifactory-everyday-feed/
```

From the Feed repository root, serve it in one terminal:

```sh
python3 -m http.server 4107 \
  --directory docs/wireframes/artifactory-everyday-feed
```

Open [http://127.0.0.1:4107/#flow](http://127.0.0.1:4107/#flow). If Portless is
already installed, the same viewer can use the stable URL from Sam's setup:

```sh
bunx portless alias artifactory-wireframes 4107
open 'https://artifactory-wireframes.localhost/#flow'
```

Use **Previous**, **Next**, or the flow steps to move through the mobile views.
The first six screens are the implemented everyday Feed journey; screens 7–14
capture Hunter's proposed switcher, discovery, group, routine, and physical
output concepts. The viewer and its SVG sources are tracked with this guide, so
a normal Feed clone is sufficient.

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

## Use Sam's migrated transcripts through a secure sharing link

Sam's handoff is a TinyCloud SDK `tc1:` sharing link, not a request that
Hunter must generate. The link embeds a new private session key and a signed,
expiring delegation for that key. Treat the whole handoff directory as a
password.

The generated handoff and transfer archive are kept outside Git at:

```text
.context/hunter-transcript-share/
├── README.md
├── bun.lock
├── package.json
├── read-transcripts.mjs
└── share.json
.context/hunter-transcript-share.zip
```

Sam transfers `hunter-transcript-share.zip` through the secure channel. Hunter
then extracts it and runs, from inside the transferred directory:

```sh
unzip hunter-transcript-share.zip
cd hunter-transcript-share
bun install
bun read-transcripts.mjs ./share.json ./transcripts
```

No Ethereum wallet, OpenKey sign-in, TinyCloud profile, or Sam-owned key is
required on Hunter's machine. The receiver uses the session key embedded in the
link to list and fetch the shared data.

The current handoff is scoped to:

- space `applications` owned by Sam's Feed test identity;
- KV prefix `xyz.tinycloud.artifacts/artifacts/listen-import`;
- actions `tinycloud.kv/get` and `tinycloud.kv/list`;
- the cryptographically signed expiry recorded in `share.json`.

The end-to-end check downloads 31 JSON artifacts. Each imported Listen artifact
contains the migrated transcript text in `body.text`. The share grants no
write, delete, SQL, secrets, wallet, or owner authority.

The SDK receiver currently uses the embedded share key directly.
`autoSubdelegate` is present in the API but full sub-delegation into another
session is not implemented yet. Do not claim that the link has been moved into
Hunter's own session. It remains a bearer credential until expiry or revocation.

The browser Feed does not yet ingest a `tc1:` share directly. Hunter can use
the downloaded JSON as local fixtures now; rendering Sam-owned data directly
requires the planned delegated-source/share-link integration.

Never commit `share.json`, paste its token into a shell command, or send it
through ordinary chat. Delete transferred and local copies when the test is
finished.

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
