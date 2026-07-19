# Current state

Last updated: **2026-07-19**

## Status

The generic x402 Merchant cutover, near-automatic Hermes onboarding, wallet
visibility, and direct native-KAS Transfers are complete on `main`.

Sompi is an API-first local agent wallet and purchasing runtime:

- `sompi-api` is the canonical Purchase interface;
- `sompi-agent` is the agent-facing CLI;
- `sompi-mcp` is an optional stateless compatibility wrapper;
- `sompi-authority` is the isolated human-present Authority;
- `sompi-operator` provisions policy, vault, chain evidence, and credentials.

Journal epoch 16 is the only active schema. It is a clean cutover with no
epoch-15 reader.

## Wallet and Transfer integration

- `wallet` reports the TN10 funding and vault identities, observed vault
  balance, pending reservations, conservative available balance, policy limits,
  chain status, and bounded Sompi activity without exposing keys.
- `transfer` creates one durable, human-present, vault-backed native KAS send.
- The signed `sompi.transfer.1` decision binds the recipient, amount, source,
  fee and total ceilings, policy, manifest, expiry, finality, and Transfer ID.
- The Journal links approved Transfer evidence to the exact Treasury Movement.
  Approval may satisfy the approval threshold but cannot bypass the allowlist,
  per-transfer, rolling-hour, or fee ceilings.
- The per-transfer ceiling applies to the exact recipient amount. The fee has a
  separate ceiling and amount plus fee consume rolling capacity. A read-only
  Treasury preflight rejects impossible requests before Authority approval;
  durable intent repeats the same check against current capacity.
- API, CLI, MCP compatibility, OpenAPI, Arazzo, and the Hermes skill use the
  same Transfer and Wallet View interfaces.
- The complete local suite passes 476 tests (475 pass, one privileged-only
  ownership test skipped) plus the offline smoke.

The published and deployed `0.9.0` exposed a boundary error when a transfer
equal to the per-transfer limit was combined with its separate fee ceiling.
The source now corrects that behavior and the approval ordering. A patch
release and Terah deployment are still required before retrying a live transfer.

Version `0.9.0` is published, tagged `v0.9.0`, and deployed on Terah from the
byte-verified public registry package.

## Protocols

Payment is pinned to Kaspa-x402 `0.1.0-alpha.8` on TN10.

- `standard-native`: version 0, exact Merchant output.
- `additive`: version 1, reusable KIP-10-based head; successor delta is the
  entire Merchant payment.
- `batch-settlement`: capital-backed channel with separate approval for every
  charge increment.

The Merchant only needs to implement the supported x402 contract. Sompi sends
no proprietary Merchant authorization headers or receipt protocol.

Authorization is internal AP2-derived evidence signed by the Trusted Authority.
The exact AP2 v0.2 source/schema revision remains pinned as a provenance watch,
but Sompi makes no AP2 interoperability claim.

## Completed cutover

- Generic `PAYMENT-REQUIRED` evidence derives canonical Checkout Terms.
- Authorization binds the Merchant, request, payee, requirements, profile or
  channel, amount or ceiling, fees, finality, expiry, and Purchase.
- Merchant communication uses only the supported x402 contract; AP2-derived
  evidence remains internal to Sompi.
- Fulfilment is verified from the authorized request, paid response, settlement,
  and resource digest.
- Each completed Purchase records one canonical receipt.
- Standard-native, additive, and batch use the same authorization contract.
- API, CLI, skill, MCP, Telegram, policy denial, replay, restart, and ambiguous
  recovery paths are covered by tests.

## Fresh TN10 evidence

[`evidence/generic-x402-cutover/`](evidence/generic-x402-cutover/README.md)
records current-branch funded proofs:

- standard-native over the canonical HTTP API:
  `5699adb798f2535605d84391e611dd88dee9e49089b4b79f57744cfea19dfd13`;
- additive over MCP compatibility ingress:
  `efd2ab90eda9ff75ca0fd76487a95654e2dce2decceb544238f04df546c366f2`;
- batch claim:
  `18cd57a98a4bcf4ee21bf1d040cfdecf632f2d95127df97c63f4eadbe4fefc49`;
- strict-boundary batch refund:
  `107b8792cc302148476bba0fec3d1ed70fcea619694557a04a9370c0dfb5d1af`.

Both exact proofs show Merchant gain equal to the advertised 20,000,000 sompi.
The additive transaction has one output and mass 874 versus standard-native
mass 4,546 for these specific shapes. This is evidence for these transactions,
not a universal fee claim.

The public `demo.kaspa-x402.org` gateway was checked read-only and advertised
x402 v2 standard-native exact and batch settlement on a healthy TN10 chain.

A fresh human-approved Terah canary paid the public demo Merchant with
standard-native transaction
`e90e3dc0579340dcdbe9c79aec356852dda2f375ff8d358b1cda543027cffd25`.
The first paid HTTP result was ambiguous. Sompi proved the same transaction won
the staging race, replayed the same signed payment after Checkout expiry, and
recorded fulfilment and a receipt without another payment.

[`evidence/wallet-transfer/`](evidence/wallet-transfer/README.md) records the
fresh `0.9.0` wallet cutover:

- the prior vault was owner-recovered and epoch-15 state was archived rather
  than reused;
- a clean epoch-16 runtime activated a `277,229,550`-sompi vault;
- direct Transfer `trf_ZyrErQxp0ppYJVB383yy3Q` paid exactly `20,000,000`
  sompi in transaction
  `2367381deb425d4ec5c0b2599ea8bae952ea5a3ca2584d3fef275780680dae22`;
- Hermes converted a natural-language send into Transfer
  `trf_L4ExGmvaEcPhzfgajOnRLQ`, paid exactly `20,000,000` sompi in transaction
  `5b6bf2c4652646998c5f8d6224f3e04bb40f8e46f977070122f8c9c7dff3332b`,
  and recorded its receipt; and
- x402 regression Purchase `pur_OzXALTLYImDL-KH5wtsetw` paid the demo Merchant
  once in transaction
  `633fbf7e7540d6de9bf422c0abf43a9f476d13d622b656f7c482070bfd60e4eb`
  and returned the report.

## Terah

Terah remains the private operator-controlled Hermes deployment.

- Hermes is active.
- Sompi `0.8.2` was quiesced, backed up, and owner-recovered. The old runtime
  was removed to a plain-Hermes baseline, then `0.9.0` was installed through
  the public bootstrap workflow and replaced in place by the byte-verified npm
  package without reusing old state.
- The installed Sompi skill, callback plugin, isolated compatibility overlay,
  systemd units, and package match this repository.
- Authority, API, Hermes gateway, and all local sockets are healthy.
- Bootstrap request `sha256:RhCKbVuaN0l8AsQs-izM4rbj_wwstSYybmxBPWvz_RY`
  created fresh keys and Journal epoch 16. Activation transaction
  `a8b2082a59b147dc223a26c112468e63d5f793727665b26bc2ffdb4796ae78ae`
  deposited `277,229,550` sompi into the new SilverScript vault.
- Natural wallet questions return the observed balance, current address,
  limits, and chain status through the Sompi API.
- Human-approved direct Transfers and the standard-native x402 regression are
  receipted. The current vault outpoint is
  `5b6bf2c4652646998c5f8d6224f3e04bb40f8e46f977070122f8c9c7dff3332b:1`
  with `192,878,980` sompi and no reservation.
- Authority, API, Hermes gateway, and all local sockets remain healthy.

The earlier Phase 11 and `0.8.2` evidence remains historical.

## Verification

For the published `0.9.0` release:

- 473 unit tests run: 472 pass and one root-only ownership test is skipped;
- the three Hermes plugin tests pass;
- local generic-Merchant E2E and crash recovery pass;
- x402 package/source/vector conformance passes;
- current and historical funded evidence locks pass;
- OpenAPI and Arazzo checks pass;
- production dependency audit reports zero vulnerabilities;
- the 205-file package policy, clean install, licence audit, and consumer smoke
  pass.

The complete release verifier passes, including its final clean-tree assertion.

The project owner previously closed further formal security-scan iteration.
The existing audit record remains under [`security/audits/`](security/audits/).

## Release

The current release is `@elldeeone/sompi@0.9.0`, tagged `v0.9.0`. The registry
tarball is byte-identical to the locked 205-file release artifact (SHA-256
`0c8f7e1a670963460ba601517e6627c14bd50c94998253a96e62c50820630181`).
The published package is live on Terah and its wallet, Transfer, x402 Purchase,
recovery, and agent-skill paths are canary proven.

Mainnet, autonomous authorization, passkeys, UCP, and official AP2/x402
interoperability remain out of scope. See
[`docs/mainnet-readiness.md`](docs/mainnet-readiness.md).
