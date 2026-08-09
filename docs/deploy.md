# Operating the Ridgeline load board

This checkout contains a pinned reference surface, CLI, inbound adapter,
entity-plane tools, load board, synthetic feed, and canonical freight-session
skill. The OWP database holds active transactions; `knowledge/` holds durable
customer, lane, driver, and carrier truth.

## Validate the artifact

```sh
npm install
npm test
npm run demo
```

Open `http://127.0.0.1:7121`. The demo is an in-memory synthetic day. The
persistent path below exercises the same inbound adapter over HTTP.

## Run one persistent freight loop

Use three shells. Loopback open mode is sufficient for the local proof.

```sh
# shell 1 — durable active working set
OWP_DB="$PWD/owp.db" npm run surface
```

```sh
# shell 2 — operator initializes; an inbound client pours a bounded fixture
export OWP_URL=http://127.0.0.1:7117
npm run init
npm run seed -- 12
npm run board
```

Open `http://127.0.0.1:7121`. `npm run init` publishes an empty `RIDGE` project;
it does not invent freight. `npm run seed -- 12` is explicitly test data. A
real feed calls the exported `runInbound` adapter with stable source identities
and its own cursor.

## Attach Codex or Pi

```sh
export OWP_URL=http://127.0.0.1:7117
codex --cd "$PWD" \
  'Operate as an OWP Ridgeline freight session. Follow AGENTS.md and skills/owp-desk/SKILL.md. Call surface.describe, register if needed, claim the next eligible transaction, read applicable authority policy and entity pages, then report the ref and permitted next action.'
```

Pi can use the same canonical skill without installation:

```sh
export OWP_URL=http://127.0.0.1:7117
pi --skill ./skills/owp-desk \
  'Claim the next RIDGE transaction and operate it under the repository skill.'
```

Use `pi install -l .` for persistent project-local loading. Codex uses
`AGENTS.md`; the plugin manifest is distribution metadata. The agent host does
not speak to the load board and does not need MCP—it calls the OWP surface with
`./owp` and edits entity pages with repository tools.

Verify the loop:

```sh
./owp whoami
./owp call surface.describe
./owp next --json
node tools/entities.ts link customer ACME
```

The board must show the claim and subsequent progress on the row's dispatch
slip. Transactions that commit money, capacity, or liability follow the
published authority policy and reach the operator as evidence-bearing
questions. The producing agent cannot accept its own completion.

One checkout carries one ignored `.owp/session`. Concurrent freight agents
need separate worktrees/checkouts or explicit, separately registered
`OWP_SESSION` values.

## Authenticated deployment and feeds

```sh
OWP_DB=/var/lib/owp/owp.db OWP_HOST=0.0.0.0 \
OWP_OPERATOR_TOKEN="$OWP_OPERATOR_TOKEN" \
OWP_AGENT_TOKEN="$OWP_AGENT_TOKEN" \
npm run surface

OWP_URL=https://owp.example OWP_TOKEN="$OWP_OPERATOR_TOKEN" npm run init
OWP_URL=https://owp.example OWP_TOKEN="$OWP_OPERATOR_TOKEN" npm run board
```

Agent sessions and ordinary inbound adapters use agent-class credentials;
operator clients use the operator credential. Trigger owners and delegated
rate/review clients receive only the grants they need. Do not use the synthetic
seed against a production working set.

The board binds `127.0.0.1:7121`. Put TLS and user authentication in front of
it; reaching an unauthenticated operator proxy conveys operator authority. Back
up the SQLite database/WAL/SHM together and version `knowledge/` separately.

## Stop, clean up, and troubleshoot

Stop board and surface shells with `Ctrl-C`. For the disposable proof only:

```sh
rm -f -- "$PWD/owp.db" "$PWD/owp.db-wal" "$PWD/owp.db-shm" "$PWD/.owp/session"
```

Success means `24/24` tests, the board at 7121 shows seeded rows, a claimed row
changes visibly, and stopping the surface makes the board report an outage—not
an empty desk. Set `OWP_TIMEOUT_MS` to bound upstream waits (default 10000).
Change `OWP_PORT`/`BOARD_PORT` if 7117/7121 is busy. A 502
`SURFACE_UNREACHABLE` means the surface URL/process is wrong; 401 means the
token is wrong; 403 means its authority is insufficient. `npm run init` and
`npm run seed -- 12` are repeat-safe, but never seed a production working set.
