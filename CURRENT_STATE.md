# Current state

Last updated: **2026-07-21**

## Status

The source tree is now the `0.12.0` Kaspa-x402 `0.1.0-alpha.9` clean-cutover
candidate defined by ADR-0023. All four protocol packages, their exact source
and release provenance, and the unmodified HTTP, consensus, exact-interoperable,
and batch-interoperable vectors are pinned. The settlement verifier applies
alpha.9's canonical authorization timeout and additive-challenge bounds before
normal work; an expired already-durable attempt remains observation-only during
recovery. Canonical batch requirements and commitment IDs are independently
reproduced from the upstream vector.

Journal epoch 19 is the only active source-tree epoch. It deliberately retains
epoch 18's physical schema while changing the semantic protocol/recovery
boundary. Epochs 1-18 are rejected without mutation, migration, compatibility
reader, or fallback. Active alpha.8 packages, fixtures, code paths, commands,
and current documentation have been removed; historical ADR and funded
evidence records remain labelled as history.

Local acceptance currently passes 551 tests (550 pass and one expected
root-only ownership skip), offline smoke, exact package/source reproduction,
and all five alpha.9 protocol-conformance checks. Release publication, fresh
funded TN10 evidence, and the fresh Terah epoch-19 runtime are not yet claimed
in this intermediate state.

The current `0.11.11` release completes the user-interaction follow-up to
`0.11.10`. `sompi-agent transfer` now continues the same durable Transfer
through routine settlement and receipt recovery, using the same 75-second
bounded, identity-checked, progress-sensitive model as Purchase. The original
request key, Transfer ID, authorization, and transaction remain fixed; no
replacement send is created.

Telegram approval cards are now concise by default. Purchase, Transfer,
spending-limit, and vault-protection prompts lead with only the action,
human-scale amount, Merchant or exact recipient, maximum exposure, network,
and consequence needed to decide. Every signed fact is retained in Telegram's
native collapsed advanced details. Normal approvals use one message; oversized
valid fact sets use request-bound detail pages followed by the only card with
Approve and Deny. Public lifecycle
summaries and the Hermes skill also lead with plain outcomes and keep fees,
IDs, profiles, finality, digests, and raw states available on request.

This release is verified by 548 tests (547 pass and one expected
root-only skip), offline smoke, and all three Hermes callback-plugin tests.

The published `0.11.10` release removes the slow agent-managed
purchase/recover/sleep loop. `sompi-agent purchase` waits for approval and then
continues only the same durable Purchase through bounded recovery until it is
terminal or reaches a 75-second continuation deadline. It verifies the
Purchase ID and request key on every response, retries immediately on durable
progress, backs off only on unchanged state, and returns the last honest view
if recovery remains unresolved. `sompi-agent recover` includes its first API
request inside that same deadline and call limit; a hung first request ends in
a bounded deadline error because no honest view exists yet. The canonical API,
Journal, authority, payment bytes, settlement rules, and explicit MCP recovery
operations are unchanged.

This release is verified by 538 tests (537 pass and one expected root-only
skip), protocol conformance, deterministic E2E, generated contract checks,
Hermes plugin tests, package inspection, and a clean consumer install. It is
tagged `v0.11.10`, published, and deployed on Terah from the byte-verified npm
artifact.

The published `0.11.10` runtime on Terah is the epoch-18 clean cutover for the
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

`0.11.9` closes a live short-offer edge:
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
If an exact payment wins after a staging-recovery race was already planned, the
recovery Effect is now closed against that winner before projection. A
receipted Purchase therefore reports completion rather than stale recovery
guidance. The final follow-up performs the required two-read losing-candidate
absence corroboration inside one recovery request instead of relying on an
agent to issue two commands within the short proof window.
The funded follow-up paid the demo Merchant exactly once, returned the report,
and now projects every staging-race Effect as observed with no pending user
action. Evidence is recorded in
[`evidence/purchase-staging-race-0.11.9/`](evidence/purchase-staging-race-0.11.9/README.md).

Sompi is an API-first local agent wallet and purchasing runtime:

- `sompi-api` is the canonical Purchase interface;
- `sompi-agent` is the agent-facing CLI;
- `sompi-mcp` is an optional stateless compatibility wrapper;
- `sompi-authority` is the isolated human-present Authority;
- `sompi-operator` provisions policy, vault, chain evidence, and credentials.

Journal epoch 19 is the only source-tree schema. It is a clean cutover with no
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

Acceptance evidence: 525 tests run, with 524 passing and one root-only
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
  built through the public bootstrap workflow. The byte-verified `0.11.11`
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
- The `0.11.10` in-place update preserved the receive address, epoch-18 runtime
  state, and wallet balances. Authority, API, and the restarted Hermes gateway
  are active; the gateway has zero post-start restarts.
- The `0.11.11` in-place update preserved the same epoch-18 Journal, receive
  address, wallet, keys, and policy state. The authenticated Wallet View passed
  through the live API socket after activation. Authority, API, and Hermes are
  active with zero post-start restarts; the installed skill and callback plugin
  match the verified registry package.
- The funded 0.11.5 Vault Migration canary changed on-chain protection from
  5 tKAS to 4 tKAS, retained the public receive address, and activated
  replacement outpoint
  `7c02e09cfa711f5f398524d3d25b5a2538cc44982cfe57db18b3168659df1310:0`.
  The post-migration wallet reports `9999.2554038 tKAS` available, 4 tKAS
  vault protection, and nothing incoming or pending.
- The `0.11.9` staging-race canary paid `0.2 tKAS` once in transaction
  `1ca0d3425228172da951c032aedaab40ee708927a1842a5f05a95fa82d9950ea`,
  returned the report, and left every Purchase Effect observed. Its planned
  losing recovery transaction was never broadcast. The current wallet has
  `9998.4288957 tKAS` available, `0 tKAS` pending, and no required user action.

The earlier Phase 11 and `0.8.2` evidence remains historical.

## Verification

For `0.11.11`:

- 548 unit tests run: 547 pass and one root-only ownership test is skipped;
- the three Hermes plugin tests pass;
- local generic-Merchant E2E and crash recovery pass;
- x402 package/source/vector conformance passes;
- current and historical funded evidence locks pass;
- OpenAPI and Arazzo checks pass;
- production dependency audit reports zero vulnerabilities;
- the 221-file package policy, clean install, licence audit, and consumer smoke
  pass.

The complete release verifier passes, including its final clean-tree assertion.

The project owner previously closed further formal security-scan iteration.
The existing audit record remains under [`security/audits/`](security/audits/).

## Release

The current published release is `@elldeeone/sompi@0.11.11`, tagged
`v0.11.11`. The registry tarball matches the verified release artifact (npm
SHA-1 `9aec09ea24ef907e60a7845ba49f4a910b56a9a8`) and is live on Terah. Wallet,
automatic funding, Transfer, x402 Purchase, staging-race recovery, agent-skill,
Vault Migration, and fresh-agent preview paths are canary proven.

Mainnet, autonomous authorization, passkeys, UCP, and official AP2/x402
interoperability remain out of scope. See
[`docs/mainnet-readiness.md`](docs/mainnet-readiness.md).
