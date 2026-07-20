# Current state

Last updated: **2026-07-20**

## Status

The published `0.11.5` runtime on Terah is the epoch-18 clean cutover for the
generic x402 Merchant path, Hermes onboarding, wallet visibility, direct
native-KAS Transfers, automatic funding intake, owner-managed limits, and the
one-wallet UX. Its funded direct-Transfer and generic exact-purchase canaries
are accepted and receipted. Its funded Vault Migration canary lowered vault
protection from 5 tKAS to 4 tKAS while preserving the stable receive address.
Timed-out Authority requests and stale owner-approved plans terminalize without
owner-key or chain work. The short-lived operator validates the root-owned
manifest and owner key, verifies the API-owned runtime directory, then
permanently drops to the pinned API UID/GID before opening wallet, Journal, or
evidence state.

`0.11.7` is the current release candidate. It closes a live short-offer edge:
single-transaction approval now expires 30 seconds before Checkout expiry, so
Sompi cannot start Treasury staging without enough time for the first Merchant
submission. Temporarily uncorroborated recovery absence stays pending rather
than becoming a false conflict, and a confirmed recovery with no Merchant
payment ends as `expired` with capacity released. The triggering Purchase was
recovered on TN10 with no Merchant payment; evidence is recorded in
[`evidence/purchase-expiry-recovery-0.11.6/`](evidence/purchase-expiry-recovery-0.11.6/README.md).
An Authority prompt that reaches that earlier deadline now returns the expired
Purchase in the same API call instead of surfacing a generic internal error and
requiring a second status call.

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

Acceptance evidence: 522 tests run, with 521 passing and one root-only
ownership test skipped. Offline smoke, Kaspa-x402 alpha.8 conformance,
OpenAPI/Arazzo validation, Hermes callback tests, deterministic local E2E,
package and clean-consumer verification, production dependency audit, retained
TN10 evidence, and the complete release verifier pass. Current upstream
SilverScript `26e3b9f94821b6fe47a2492755252ec4f995abb1` reproduces all 12 vault
fixtures exactly.

Funded closure evidence is recorded in
[`evidence/vault-migration-0.11.5/`](evidence/vault-migration-0.11.5/README.md).
Migration `vmg_AEGRM3ZbaAsA-yVJaqIQmw` applied recovery transaction
`cf08ca5c9aed7a5f4fc89e1a0bfc0029335dd50284fde6bfba86173752bda4c7`
and replacement transaction
`7c02e09cfa711f5f398524d3d25b5a2538cc44982cfe57db18b3168659df1310`.
Both are accepted on TN10, and the stable receive address is unchanged.

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
- Before owner execution begins, expired plans become `expired` and plans whose
  approved vault snapshot no longer matches become `failed`. Both transitions
  are durable, release the live migration slot, and perform no external effect.
- An expired `awaiting_authority` plan is terminalized before a status read or
  replacement proposal, so a timed-out Telegram prompt cannot retain the live
  migration slot.
- Offline owner execution begins as the declared root operator but opens no
  runtime state as root. It validates the API runtime identity, drops all
  privileges to the pinned API UID/GID, and only then composes the runtime.

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
  was removed to a plain-Hermes baseline, then the current installation was
  built through the public bootstrap workflow. The byte-verified `0.11.5`
  package now runs without replacing epoch-18 state.
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
  Before the later migration, that transaction's output `0` held
  `10000.9490244 tKAS` with nothing incoming or pending.
- Authority, API, Hermes gateway, and all local sockets remain healthy.
- The funded 0.11.5 Vault Migration canary changed on-chain protection from
  5 tKAS to 4 tKAS, retained the public receive address, and activated
  replacement outpoint
  `7c02e09cfa711f5f398524d3d25b5a2538cc44982cfe57db18b3168659df1310:0`.
  The post-migration wallet reports `9999.2554038 tKAS` available, 4 tKAS
  vault protection, and nothing incoming or pending.

The earlier Phase 11 and `0.8.2` evidence remains historical.

## Verification

For the published `0.11.5` release:

- 518 unit tests run: 517 pass and one root-only ownership test is skipped;
- the three Hermes plugin tests pass;
- local generic-Merchant E2E and crash recovery pass;
- x402 package/source/vector conformance passes;
- current and historical funded evidence locks pass;
- OpenAPI and Arazzo checks pass;
- production dependency audit reports zero vulnerabilities;
- the 218-file package policy, clean install, licence audit, and consumer smoke
  pass.

The complete release verifier passes, including its final clean-tree assertion.

The project owner previously closed further formal security-scan iteration.
The existing audit record remains under [`security/audits/`](security/audits/).

## Release

The current release is `@elldeeone/sompi@0.11.5`, tagged `v0.11.5`. The registry
tarball matches the verified 218-file release artifact (npm SHA-1
`b6884924305ca5e10ee801cda65c712ba2ee7cf7`). The published package is live on
Terah. Wallet, automatic funding, Transfer, x402 Purchase, recovery,
agent-skill, Vault Migration, and fresh-agent preview paths are canary proven.

Mainnet, autonomous authorization, passkeys, UCP, and official AP2/x402
interoperability remain out of scope. See
[`docs/mainnet-readiness.md`](docs/mainnet-readiness.md).
