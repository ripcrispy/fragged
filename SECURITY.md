# Security policy

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Report vulnerabilities privately through GitHub's **"Report a vulnerability"** button on this repository's
**Security** tab (private vulnerability reporting). Include:

- what the issue is and its impact,
- steps or a proof of concept to reproduce it,
- the version or commit affected, and any configuration it depends on.

We aim to acknowledge reports within **5 working days** and to agree a disclosure date with you. Fixes are released
as soon as practical, and reporters are credited in the changelog unless they'd rather not be.

## Supported versions

Until 1.0, only the latest release (and `main`) receives security fixes.

## Scope

In scope: the core application, the module runtime and SDK, and the modules bundled in `modules/`.

Out of scope: third-party modules (report to their authors), vulnerabilities that need administrator access or a
malicious installed module (administrators and modules are trusted by design), and findings from automated scanners
without a demonstrated impact.

## Hardening notes for operators

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). In short: always set `APP_SECRET`, run behind HTTPS with
`TRUST_PROXY=1` only when a proxy really sits in front, keep `AUTH_DEV_PROVIDER` off in production (startup refuses
it), install only modules you trust, and keep backups.
