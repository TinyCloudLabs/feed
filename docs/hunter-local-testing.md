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

The approved mobile walkthrough is available in the shared `tinycloud-dev`
workspace at:

```text
.context/design/artifactory-everyday-feed/
```

From the workspace root, serve it in one terminal:

```sh
python3 -m http.server 4107 \
  --directory .context/design/artifactory-everyday-feed
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
output concepts. The `.context` design bundle is not part of the Feed clone, so
Hunter needs the shared workspace or a copy of that directory.

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

## Use Sam's real Listen transcripts without sharing Sam's key

Use a request/grant/import capability chain. Hunter creates the receiving key;
Sam grants only read access to that key; Hunter may derive a narrower child
grant for another Hunter-owned session. Never send `key.json`, an Ethereum
private key, or a TinyCloud profile directory.

Use `@tinycloud/cli` `0.7.7-beta.4` or newer for this flow. The commands below
use `bunx` so the Feed repository's older development CLI cannot be selected by
accident.

### A. Hunter creates the read session and request

From the Feed repository root:

```sh
mkdir -p hunter-handoff.local

bunx @tinycloud/cli@beta profile create hunter-feed-source \
  --host https://node.tinycloud.xyz \
  --posture delegate-session \
  --operator human

bunx @tinycloud/cli@beta --profile hunter-feed-source auth request \
  --permission docs/hunter-transcript-permissions.json \
  --expiry 7d \
  --emit hunter-handoff.local/transcripts.request.json
```

Hunter sends only `transcripts.request.json` to Sam. The request contains a
public session DID and requested capabilities; it does not contain Hunter's
private session key.

### B. Sam reviews and grants the request

Before approving, Sam should inspect the request and confirm it contains only:

- SQL `read` on `xyz.tinycloud.listen/conversations`;
- KV `get` and `list` on `xyz.tinycloud.listen/transcript/`;
- the intended Hunter session DID and expiry.

Using Sam's existing owner profile:

```sh
bunx @tinycloud/cli@beta \
  --profile feed-migration-owner \
  --json auth grant hunter-handoff.local/transcripts.request.json \
  > hunter-handoff.local/transcripts.grant.json
```

Sam sends only `transcripts.grant.json` back to Hunter. The resulting parent
delegation is read-only, expires after at most seven days, and can be revoked by
CID. Its actual expiry cannot exceed Sam's active owner session.

### C. Hunter imports and verifies the grant

```sh
bunx @tinycloud/cli@beta \
  --profile hunter-feed-source \
  auth import hunter-handoff.local/transcripts.grant.json

bunx @tinycloud/cli@beta --profile hunter-feed-source auth caps

bunx @tinycloud/cli@beta --profile hunter-feed-source kv list \
  --space applications \
  --prefix 'xyz.tinycloud.listen/transcript/'

bunx @tinycloud/cli@beta --profile hunter-feed-source sql export \
  --space applications \
  --db 'xyz.tinycloud.listen/conversations' \
  --output hunter-handoff.local/conversations.db
```

Fetch a specific transcript without broadening access:

```sh
bunx @tinycloud/cli@beta --profile hunter-feed-source kv get \
  'xyz.tinycloud.listen/transcript/TRANSCRIPT_ID' \
  --space applications \
  --output hunter-handoff.local/transcript.json
```

### D. Hunter derives a child grant for his own worker session

The worker creates its own request. Hunter's read session grants the same or a
narrower request from the imported parent capability—Sam does not sign again.

```sh
bunx @tinycloud/cli@beta profile create hunter-feed-worker \
  --host https://node.tinycloud.xyz \
  --posture delegate-session \
  --operator agent

bunx @tinycloud/cli@beta --profile hunter-feed-worker auth request \
  --permission docs/hunter-transcript-permissions.json \
  --expiry 1d \
  --emit hunter-handoff.local/worker.request.json

bunx @tinycloud/cli@beta \
  --profile hunter-feed-source \
  --json auth grant hunter-handoff.local/worker.request.json \
  > hunter-handoff.local/worker.grant.json

bunx @tinycloud/cli@beta --profile hunter-feed-worker \
  auth import hunter-handoff.local/worker.grant.json

bunx @tinycloud/cli@beta --profile hunter-feed-worker auth caps
```

The child grant cannot add permissions or outlive the parent. Revoking or
expiring the parent invalidates authority for its descendants.

### Current Feed integration boundary

The CLI sessions above can read/export the delegated source data and prove
sub-delegation. The current browser Feed binds API actor headers to the wallet
that signed into Feed. It does not yet import a separate source-owner grant or
select that owner as its data actor. Therefore Hunter has two working options:

1. use the delegated CLI session to inspect/export Sam's transcripts, then copy
   approved fixtures into Hunter's own TinyCloud space and run Feed normally;
2. add the planned delegated-source-actor integration before pointing the live
   Feed UI directly at Sam's space.

Trying to send Sam-owned delegation data through an unmodified Hunter-signed
Feed UI will correctly fail actor binding rather than silently crossing the
identity boundary.

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
