# Security policy

The supported protocol target is the current release candidate named in
`README.md`. Superseded drafts and development snapshots receive no security
updates.

Do not place credentials, personal data, exploit details, or live deployment
addresses in a public issue. Use GitHub private vulnerability reporting when it
is enabled for the affected OpenWorkProtocol repository. If that channel is not
available, open a minimal issue asking a maintainer for a private reporting
channel and disclose no vulnerability details there.

Include the affected repository and revision, threat model, reproduction,
impact, and the smallest safe test case. Maintainers will acknowledge receipt,
coordinate a fix and disclosure window, and state which releases are affected.
No response-time SLA is promised by this volunteer release candidate.

The reference surface is not a security boundary by itself. Open mode is for
loopback use. Routable deployments require authentication, TLS, protected
operator clients, scoped credentials, request limits, and secret handling as
specified by Annex A and the repository deployment guide.
