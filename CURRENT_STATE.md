# Current state

Last updated: **2026-07-19**

## Status

The generic x402 Merchant cutover and near-automatic Hermes onboarding are
complete on `main`.

Sompi is an API-first local purchasing runtime:

- `sompi-api` is the canonical Purchase interface;
- `sompi-agent` is the agent-facing CLI;
- `sompi-mcp` is an optional stateless compatibility wrapper;
- `sompi-authority` is the isolated human-present Authority;
- `sompi-operator` provisions policy, vault, chain evidence, and credentials.

Journal epoch 15 is the only active schema.

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

## Terah

Terah remains the private operator-controlled Hermes deployment.

- Hermes is active.
- Sompi was removed to a plain-Hermes baseline, then installed from the packed
  `0.8.2` release candidate through the public bootstrap workflow.
- The installed Sompi skill, callback plugin, isolated compatibility overlay,
  systemd units, and package match this repository.
- Authority, API, Hermes gateway, and all local sockets are healthy.
- Bootstrap created a normal TN10 funding wallet without exposing its key. The
  trusted activation command deposited `73,569,300` sompi into the new
  SilverScript vault in transaction
  `e8dc10f8aeaa267a75f2a106bf2ce3a64db6a21441a5f5faf74376402a170f69`.
- Human approval in Telegram completed Purchase
  `pur_bR9Get_H0IHPmLoEfGItpQ` against `demo.kaspa-x402.org`.
- Vault staging transaction
  `ff0f448336879f2ce2dfb03e689ab125577c661508abff8f9c3c71a7e815e788`
  advanced the covenant exactly once. Standard-native payment transaction
  `522e8ded26d9378406d85b610660be189f82c74f3152fe2a2f98f591f372e17a`
  paid `20,000,000` sompi and the Purchase is `receipted`.
- The live continuation UTXO matches the journaled vault outpoint. Recovery
  reconciled the accepted staging effect before settlement and did not submit
  a duplicate transaction.

The earlier Phase 11 evidence remains historical. The evidence above is a new
clean-install, human-present onboarding canary.

## Verification

At this release state:

- 461 unit tests run: 460 pass and one root-only ownership test is skipped;
- the three Hermes plugin tests pass;
- local generic-Merchant E2E and crash recovery pass;
- x402 package/source/vector conformance passes;
- current and historical funded evidence locks pass;
- OpenAPI and Arazzo checks pass;
- production dependency audit reports zero vulnerabilities;
- the 199-file package policy, clean install, licence audit, and consumer smoke
  pass.

The complete release verifier passes, including its final clean-tree assertion.

The project owner previously closed further formal security-scan iteration.
The existing audit record remains under [`security/audits/`](security/audits/).

## Release

The release version is `@elldeeone/sompi@0.8.2`, tagged `v0.8.2`. Main and the
npm package are the release surfaces; Terah runs the same verified package
build.

Mainnet, autonomous authorization, passkeys, UCP, and official AP2/x402
interoperability remain out of scope. See
[`docs/mainnet-readiness.md`](docs/mainnet-readiness.md).
