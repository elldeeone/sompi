# Sompi 0.11.5 vault-migration proof

Date: 2026-07-20  
Network: Kaspa Testnet-10

## Release identity

- Git commit: `a5f94d323ad3f6de1c40bae7f75fc7523d4b2b64`
- Git tag: `v0.11.5`
- npm package: `@elldeeone/sompi@0.11.5`
- npm SHA-1: `b6884924305ca5e10ee801cda65c712ba2ee7cf7`
- Package entries: 218

The clean release verifier passed 518 tests (517 passed and one root-only
ownership test was skipped), protocol conformance, offline smoke, OpenAPI and
Arazzo checks, Hermes callback tests, deterministic local E2E, production
dependency audit, packed-artifact verification, and a clean consumer install.

## Timeout recovery

The earlier requests `vmg_Dt3-qz2BVYutGO7riDSHRQ` and
`vmg_gGQxbJS6s2WL739IHY4p3Q` both reached `expired`. Neither entered owner
execution or produced a transaction. The second request specifically proved
that 0.11.5 terminalizes an expired `awaiting_authority` record and releases
the single live migration slot before admitting a replacement.

## Funded migration

- Migration: `vmg_AEGRM3ZbaAsA-yVJaqIQmw`
- State: `applied`
- Previous protection: 5 tKAS per vault window
- New protection: 4 tKAS per vault window
- Stable receive address:
  `kaspatest:qqxy9pqyunyhclwh08dndjc2zz8sprfmr7xqqnlcey8ecq76ws737gfyldufl`
- Recovery transaction:
  `cf08ca5c9aed7a5f4fc89e1a0bfc0029335dd50284fde6bfba86173752bda4c7`
- Replacement transaction:
  `7c02e09cfa711f5f398524d3d25b5a2538cc44982cfe57db18b3168659df1310`
- Replacement outpoint: output 0 of the replacement transaction
- Receipt digest:
  `sha256:PcsPilSDm0Favd4a_RwrR02Q8SjEvWgcgh5yd4h0TLQ`

The configured independent TN10 accepted-chain witness reported both
transactions accepted. After restart, the wallet projected 4 tKAS vault
protection, 3.463994 tKAS remaining in the current window, no incoming or
pending funds, and the same stable receive address. Sompi API, Authority, and
Hermes gateway services were active.

## Fresh-agent onboarding

The public `v0.11.5` bootstrap example was fetched into an empty temporary
directory and previewed using only the public npm package:

```text
npm exec --yes --allow-scripts=better-sqlite3@12.11.1 \
  --package=@elldeeone/sompi@0.11.5 -- \
  sompi-operator bootstrap-preview host-bootstrap.json
```

The preview succeeded with request digest
`sha256:xfxRFPSiMBEy7up-bRn9LilOIl0lBcI8nHPweUazUi8`, selected Testnet-10,
pinned the demo Merchant and Telegram Authority profile, and returned the
digest-bound privileged bootstrap command. No host state or funds were changed
by the preview.
