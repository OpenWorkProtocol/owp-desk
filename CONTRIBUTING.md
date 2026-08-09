# Contributing

From a clean checkout run `npm ci`, `npm test`, the exact operator acceptance
steps in `docs/deploy.md`, and `git diff --check`. Changes to the freight
vocabulary stay in `types/registry.md` and the link envelopes; protocol changes
belong in the specification repository. Preserve standalone operation—no
sibling repository, local path, unpublished package, or developer database may
be required. Do not commit credentials, `.owp/session`, databases, or feeds.

Contributions are accepted under MIT. Follow `SECURITY.md` for vulnerabilities.
