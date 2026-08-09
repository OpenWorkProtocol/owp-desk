# Release evidence

Validated from an isolated release-shaped checkout on 2026-08-08 with Node
24.19.0. No sibling OWP repositories or `.owp-deps` directory were present.

```text
npm ci             pass; 0 vulnerabilities
npm test           24/24 pass
./owp help          pass
npm run init        pass twice against a scratch durable surface
npm run demo       freight load board returns 200
npm run surface    console and surface.describe return 200
```

The evidence covers transaction chains, entity pages, bounded attention while
rows are cleared, six concurrent sessions draining work exactly once, scoped
invoice review, graduated money/commitment authority, external claim waits, a
218-document inbound day, and the real dense load-board UI. The day ends with a
smaller working set than it started with.

The embedded 1.0-rc2 reference runtime is identified by
`vendor/owp-reference/MANIFEST.sha256`; source and watcher provenance are
recorded in `vendor/owp-reference/SNAPSHOT.md`.
