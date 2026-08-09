<p align="center">
  <a href="https://openworkprotocol.io"><img src=".github/assets/owp-icon-black.svg" width="80" alt="Open Work Protocol"></a>
</p>

# owp-desk — Ridgeline Freight's back office

This standalone OWP example models a high-volume back-office desk for a small
trucking company. Tenders, quotes, bookings,
invoices, claims and the churn between them — a couple of hundred inbound
documents a day, forty customers that outlive every load, four workflows run
over and over with the occasional judgment call.

The example exercises repeat transactions, recurring business entities, and a
bounded operator queue under high document volume.

[Project site](https://openworkprotocol.io) ·
[RC2 specification](https://github.com/OpenWorkProtocol/owp/blob/main/spec/owp-1.0-rc2.md) ·
[release evidence](EVIDENCE.md) · [contact](mailto:info@openworkprotocol.io)

```
src/entities.ts    the entity plane: customers, lanes, drivers, carriers as
                   knowledge pages, referenced from links — never protocol records
src/inbound.ts     EDI / portal / mail / telematics → observations → the watcher
src/vocabulary.ts  the published vocabulary and the declared tiebreak (§9)
src/watcher.ts     pinned generic watcher snapshot, repointed at freight
tools/entities.ts  maintain the entity pages; print the link entry for one
tools/loadboard.ts the load board's server (port 7121)
tools/seed.ts      pour a day of freight into a running surface
ui/index.html      THE LOAD BOARD — a dispatcher's grid
knowledge/         the entity plane itself: twelve entity pages of standing
                   facts, plus how the back office actually runs
test/              24 narratives: 19 against the unchanged reference surface,
                   5 that execute the load board's own script against it
```

This repository is a complete, standalone deployment. Pinned snapshots of the
reference surface and generic watcher power its local CLI, tests, demo, and
small durable installations; the load board itself still speaks only the
public HTTP binding and can point at any conforming surface. What it adds is
freight vocabulary, an entity plane, an inbound adapter, and an operator
experience with its own character.

## Protocol coverage

1. **The entity plane.** Customers, lanes, drivers and carriers are knowledge
   pages referenced from `links`. The surface never learns the word "customer",
   and the argument that settles it is §1.4: the working set must shrink as
   work completes, and an entity table only grows.
2. **Quote → booking → invoice.** A quote that wins becomes a *new* deliverable
   with `depends_on` pointing back — never a mutation. The chain is enforced by
   the assignment chooser, so a freight desk gets a workflow engine's guarantee
   out of a filter the protocol already had.
3. **Volume.** 218 inbound documents through the watcher, becoming 208
   deliverables — 120 contract tenders dispatched straight to the board, 88 into
   the operator's triage queue; bounded attention paging; six sessions draining
   the 120 loads with no duplicate claim; a review bot clearing 120 invoices
   under §18's delegation invariant; and the working set ending the day smaller
   than it started (208 → 88).
4. **The load board.** A dispatcher's grid — one line per load, nine columns,
   an inline dispatch slip that tears off underneath the row. It looks nothing
   like the console, the desk, the dossier or the terminal wall, because a
   dispatcher does not read cards. It is built for one person: a non-technical
   operator with the phone ringing, and every choice on it answers one of their
   four fears —

   | the fear | what the board does about it |
   |---|---|
   | a tender goes cold while nobody looks | `waiting` is weighted: the older a row is, the heavier it reads |
   | money committed without authority | the standing `authority` policy is rendered *on the decision*, beside the number |
   | a claim goes quiet | the slip shows the load's recent activity, and names who owns the wait |
   | losing track of which load is where | one chip per row says what that row is asking for, in freight English |

   And the protocol's words are not on it. Not `deliverable`, not `ref`, not
   `triage`, not `park`, not `continuation` — those live in the `wire` drawer at
   the bottom for the one operator in ten who wants them. Two densities,
   because a board on the wall and a board under your nose are different
   instruments.
5. **The inbound adapter.** EDI 204 tenders, 214 status messages, portal RFQs,
   claim documents, telematics pings and plain mail, all translated into
   observations for the same watcher that proposes forgejo upgrades in owp-ops.

The test suite validates opaque keyset cursors under concurrent queue changes,
item context on attention rows, ordered bounded worklogs, vocabulary-neutral
watcher behavior, and high-volume queue handling. Detailed release results are
recorded in [`EVIDENCE.md`](EVIDENCE.md).

## Running it

```sh
npm install
npm test                                   # 24 narratives, no build step
npm run demo                               # synthetic day + load board → http://localhost:7121
npm run surface                            # durable local surface → http://localhost:7117
npm run init                               # publish an empty RIDGE project
./owp help                                 # bundled agent/session CLI

# the board, against any surface that speaks the HTTP binding
OWP_URL=http://127.0.0.1:7117 npm run board          # → http://localhost:7121
OWP_URL=http://127.0.0.1:7117 npm run seed 60        # pour a day of freight

node tools/entities.ts list all
node tools/entities.ts show lane DEN-SLC
node tools/entities.ts link customer ACME
```

See [`docs/deploy.md`](docs/deploy.md) for durable deployment, feed
credentials, and Codex/Claude/Pi wiring.
