# Current state

Last updated: **2026-07-20**

## Status

The published `0.11.0` runtime on Terah is the epoch-18 clean cutover for the
generic x402 Merchant path, Hermes onboarding, wallet visibility, direct
native-KAS Transfers, automatic funding intake, owner-managed limits, and the
one-wallet UX. The current source tree is the `0.11.1` patch candidate fixing
the approved-Transfer response contract found during the live release canary;
it is not yet published or deployed.

Sompi is an API-first local agent wallet and purchasing runtime:

- `sompi-api` is the canonical Purchase interface;
- `sompi-agent` is the agent-facing CLI;
- `sompi-mcp` is an optional stateless compatibility wrapper;
- `sompi-authority` is the isolated human-present Authority;
- `sompi-operator` provisions policy, vault, chain evidence, and credentials.

Journal epoch 18 is the only source-tree schema. It is a clean cutover with no
reader for earlier epochs.

## Owner-managed limits and vault protection

- Everyday per-payment and hourly limits change through one durable Policy
  Change and exact human-present approval. The new policy applies only to new
  work; existing work keeps its original snapshot.
- Every outgoing payment requires approval. The removed approval-threshold
  model has no runtime, manifest, Journal, API, CLI, or agent surface.
- Vault protection changes use a separate durable Vault Migration. Chat
  approval records the exact plan; execution still requires the offline owner
  key through `sompi-operator vault-migrate`.
- Migration fences new vault effects, preserves current rolling-window spend,
  records exact prepared transactions before submission, and reconciles
  ambiguous outcomes without replacement broadcasts.
- The public receive address is stable across internal vault replacement.
  Internal vault addresses and atomic/DAA evidence are technical-only.
- The API is canonical. `sompi-agent` and optional MCP tools remain thin
  clients of the same Policy Change, Vault Migration, Wallet, Transfer, and
  Purchase modules.

Acceptance evidence: 513 tests run, with 512 passing and one root-only
ownership test skipped. Offline smoke, Kaspa-x402 alpha.8 conformance,
OpenAPI/Arazzo validation, Hermes callback tests, deterministic local E2E,
package and clean-consumer verification, production dependency audit, retained
TN10 evidence, and the complete release verifier pass. Current upstream
SilverScript `26e3b9f94821b6fe47a2492755252ec4f995abb1` reproduces all 12 vault
fixtures exactly.

## Security remediation

- Runtime packages install scriptlessly. The only native build capability is a
  name-, version-, and lifecycle-command-bound rebuild of `better-sqlite3`,
  followed by an actual SQLite behaviour probe.
- Telegram approval and denial are separate opaque capabilities. Consuming one
  atomically invalidates both, and Policy Change prompts share the same
  Authority admission budget as Purchase and Transfer prompts.
- Policy protection has a monotonic activation generation. Policy and vault
  changes bind the exact generation and counterpart protection digest, so
  A-B-A replay and separately approved unsafe compositions fail closed.
- Vault Migration fences both direct Treasury operations and prepared Purchase
  effects, then rechecks the fence immediately before submission.
- Already admitted Treasury work remains recoverable against its immutable
  policy snapshot, while replacement-vault activation requires independently
  accepted recovery evidence.
- Policy Change request keys are bound to both requested limits. Owner Authority
  requests bind their durable creation and expiry times instead of assuming one
  fixed approval lifetime.
- A Vault Migration fence is removed only when the Journal proves owner
  execution never began and the vault still matches the approved old digest;
  expiry-boundary and restart recovery are both covered.

## Wallet and Transfer integration

- `wallet` reports one TN10 receive address, total/available/incoming/pending
  tKAS balances, automatic securing status, policy limits, chain status, and
  bounded activity without exposing keys.
- Future deposits to the receive address are detected and moved automatically
  through the durable vault-deposit Treasury operation. Only the initial
  vault activation remains an explicit operator ceremony.
- Public summaries, approvals, errors, and activity lead with tKAS. Exact sompi
  remains structured atomic evidence for consensus and accounting.
- `transfer` creates one durable, human-present, vault-backed native KAS send.
- The signed `sompi.transfer.1` decision binds the recipient, amount, source,
  fee and total ceilings, policy, manifest, expiry, finality, and Transfer ID.
- The Journal links approved Transfer evidence to the exact Treasury Movement.
  Owner approval cannot bypass the allowlist,
  per-transfer, rolling-hour, or fee ceilings.
- The per-transfer ceiling applies to the exact recipient amount. The fee has a
  separate ceiling and amount plus fee consume rolling capacity. A read-only
  Treasury preflight rejects impossible requests before Authority approval;
  durable intent repeats the same check against current capacity.
- API, CLI, MCP compatibility, OpenAPI, Arazzo, and the Hermes skill use the
  same Transfer and Wallet View interfaces.
- The complete local suite passes 513 tests (512 pass, one privileged-only
  ownership test skipped) plus the offline smoke.

Version `0.10.0` is published, tagged `v0.10.0`, and deployed on Terah from the
byte-verified public registry package. That historical release uses epoch 16 and replaced
the old wallet projection with one stable receive address, automatic inward
securing, unified activity, and KAS-first public amounts.

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

The `0.9.1` regression canary then sent exactly the configured per-transfer
maximum of `100,000,000` sompi to the approved recipient in transaction
`35be8e0493513ec977e8bfd54337f36e09584c57c49d0f0525431ebe028f0f65`.
The fee was `6,153,180` sompi, below its independent `25,000,000`-sompi
ceiling. Independent accepted-chain evidence shows the exact recipient output
and an `86,725,800`-sompi vault continuation. The earlier failed Transfer was
not retried and has no transaction.

## Terah

Terah remains the private operator-controlled Hermes deployment.

- Hermes is active.
- Sompi `0.8.2` was quiesced, backed up, and owner-recovered. The old runtime
  was removed to a plain-Hermes baseline, then `0.9.0` was installed through
  the public bootstrap workflow. The byte-verified `0.10.0` package now runs
  without replacing the epoch-16 state.
- The installed Sompi skill, callback plugin, isolated compatibility overlay,
  systemd units, and package match this repository.
- Authority, API, Hermes gateway, and all local sockets are healthy.
- Bootstrap request `sha256:RhCKbVuaN0l8AsQs-izM4rbj_wwstSYybmxBPWvz_RY`
  created fresh keys and Journal epoch 16. Activation transaction
  `a8b2082a59b147dc223a26c112468e63d5f793727665b26bc2ffdb4796ae78ae`
  deposited `277,229,550` sompi into the new SilverScript vault.
- Natural wallet questions return one receive address, total/available/incoming/
  pending tKAS balances, securing state, limits, chain status, and activity.
- Human-approved direct Transfers and the standard-native x402 regression are
  receipted. Automatic funding intake secured the existing receive-address
  deposit without an approval prompt in transaction
  `6076b807a4dd9edd7bc9e37a8a5d82c115cccf3ec0aea168c6b923b1c51c29d0`.
  The current vault outpoint is that transaction's output `0`, with
  `10000.9490244 tKAS` available and nothing incoming or pending.
- Authority, API, Hermes gateway, and all local sockets remain healthy.

The earlier Phase 11 and `0.8.2` evidence remains historical.

## Verification

For the published `0.10.0` release:

- 486 unit tests run: 485 pass and one root-only ownership test is skipped;
- the three Hermes plugin tests pass;
- local generic-Merchant E2E and crash recovery pass;
- x402 package/source/vector conformance passes;
- current and historical funded evidence locks pass;
- OpenAPI and Arazzo checks pass;
- production dependency audit reports zero vulnerabilities;
- the 208-file package policy, clean install, licence audit, and consumer smoke
  pass.

The complete release verifier passes, including its final clean-tree assertion.

The project owner previously closed further formal security-scan iteration.
The existing audit record remains under [`security/audits/`](security/audits/).

## Release

The current release is `@elldeeone/sompi@0.10.0`, tagged `v0.10.0`. The registry
tarball is byte-identical to the verified 208-file release artifact (SHA-256
`fc957b4c912fe178717c62c88ff06429368a758abd9fd47cba4f6b26096e8948`).
The published package is live on Terah and its wallet, automatic funding,
Transfer, x402 Purchase, recovery, and agent-skill paths are canary proven.

Mainnet, autonomous authorization, passkeys, UCP, and official AP2/x402
interoperability remain out of scope. See
[`docs/mainnet-readiness.md`](docs/mainnet-readiness.md).
