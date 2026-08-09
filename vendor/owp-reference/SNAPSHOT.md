# Embedded OWP reference runtime

This directory is the audited 1.0-rc2 source snapshot of the Open Work Protocol
reference surface, HTTP binding, operator console, and CLI prepared on
2026-08-08. It was derived from the `OpenWorkProtocol/owp-code` development tree
based on commit `c9ab43f0d2ae8620967d6b18b698360e98d378a4`; the RC2 audit changes were not
yet a public commit when the standalone tree was assembled. `MANIFEST.sha256`
is the authoritative identity of every bundled runtime file.

It is included so this repository is independently cloneable and can run its
tests, disposable demo, durable local surface, and agent CLI without cloning
another OWP repository. Production deployments may replace it with any
conforming surface and continue to use this repository's domain clients over
the HTTP binding.

The snapshot matches that manifest. Update it as one reviewed unit and run
this repository's complete test suite. The bundled code and this repository are
both MIT licensed.

`src/watcher.ts` is likewise an unmodified snapshot of the generic watcher from
`OpenWorkProtocol/owp-ops` commit
`439949d71ab0adfa3bce23dac35e55d4ce31e2e6`; its SHA-256 is
`363631a62158fab98250c20f2f286e50e2d83aeedcd39e47e6d08e9fd6092ad9`.
