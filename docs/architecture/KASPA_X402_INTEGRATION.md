# Kaspa-x402 alpha.8 integration contract

Status: normative clean-cutover map for Sompi

Target release: `@kaspa-x402/*@0.1.0-alpha.8`

Network: `kaspa:testnet-10` only

## 1. Purpose and ownership boundary

This document maps the complete landed Kaspa-x402 alpha.8 contract into Sompi.
It is not a second x402 specification and it does not authorize Sompi to
reimplement Kaspa transaction, covenant, voucher, server, or facilitator
mechanics. The immutable alpha.8 specifications, schemas, vectors, and public
package behavior remain authoritative for those mechanics.

Sompi owns the stable `Purchase` lifecycle, AP2 authorization, deterministic
policy, Treasury capacity and movement, durable effect fencing, Chain Evidence,
the effective Finality Floor, fulfilment, and receipts. The Kaspa-x402 adapter
translates canonical Purchase facts into the pinned public client API and
returns independently checked protocol evidence. Raw x402 and Kaspa artifacts
are immutable Evidence Attachments; they are not Sompi domain state.

The normal Sompi Purchase API is the canonical agent-facing boundary. Sompi's
MCP executable is only a thin compatibility transport over that same service.
Kaspa-x402's own HTTP, MCP, and facilitator profiles describe communication
with a paid resource server; they do not make Sompi's outer MCP process a
trusted approval or wallet surface.

## 2. Immutable release identity

Sompi consumes exact versions. It never consumes `latest`, the moving `alpha`
tag, sibling workspace paths, or mutable Git branches.

| Package | Version | npm integrity |
| --- | --- | --- |
| `@kaspa-x402/core` | `0.1.0-alpha.8` | `sha512-UBY4g9jBZrJyd44zbsla01L2wbN+UQeButAiuEeFUd4EdGwVyR2qxMf1B4hApXBSvrOeH9UZQzhWkBD+Z3WT4A==` |
| `@kaspa-x402/covenant` | `0.1.0-alpha.8` | `sha512-HWySEyuNpzFDH4vVZRsUCnMLWWt2ou3sp1XEU+gaycl3O/7fWJPzWo1MYosZzPkS2newL6lXQSr/OR/YQ4wSag==` |
| `@kaspa-x402/client` | `0.1.0-alpha.8` | `sha512-n36rG2nYDrN7Dgu5jlh16390k/Z5sOnsj40a347ir8C9U/X/tlgPY24KB0YmUqVmxEOBYRAw2pAEKI/qDqIEwA==` |
| `@kaspa-x402/server` | `0.1.0-alpha.8` | `sha512-X5ax8oWGfJlxQqh2RaEQYHw0wQKbRR/iFoeJ9/2w93oNsOC++svNEA/MHlR4SSAiukdXI6PizcsYq0KwPi6jsA==` |

All four published tarballs report Git source
`d3ef63ebfb72ef5139993e75804fcc846a1f9487`. The annotated
`v0.1.0-alpha.8` tag resolves to release-record commit
`8ad1979d0c1a610442dc206f0cefd3286f2ee7e0`; the tag object is
`06cc127bc669837e0969ed0eafc6942c2baeacae`. These identities have different
purposes and must not be conflated:

- package behavior is bound to the npm tarball integrity and independently
  reproduced byte-for-byte from the exact `gitHead` source revision;
- immutable specifications, schemas, vectors, and release evidence are bound
  to the release tag and its content lock;
- Rusty Kaspa consensus evidence is bound to
  `78257f273a26c4be085bab0f79437dee99ca8835`;
- the batch SilverScript fixture is bound to upstream SilverScript
  `956868ea63a2af4176889f1331449b5f4f9e1df8`.

The upstream alpha.8 release snapshot reports a locked source state and the
funded TN10 report proves standard-native, corrected additive, additive
conflict/retry, restart recovery, external-head reconciliation, batch deposit,
voucher-only charging, claim, old-voucher rejection, and strict-boundary
refund. That evidence characterizes the dependency; it does not substitute for
Sompi's own end-to-end evidence.

### 2.1 Public package seams

Sompi uses the packages at their published seams:

- `@kaspa-x402/core` owns strict wire types, schema validation, canonical
  encoders, request authorization, payment identifiers, voucher and channel
  digests, network identifiers, headers, and error vocabulary;
- `@kaspa-x402/covenant` owns the canonical escrow/KIP-10 helpers, transaction
  v0/v1 calculations, storage mass, and fixture reproducibility;
- `@kaspa-x402/client` owns offer selection, exact authorization through
  `FundingProvider`, channel signing and persistence interfaces, paid HTTP/MCP
  behavior, settlement application, and refund coordination;
- `@kaspa-x402/server` is used by the local Merchant and conformance harness for
  exact verification, durable replay/head/attempt state, channel commitments,
  claim/refund state, and protected-handler sequencing.

Sompi implements the public `FundingProvider`, `ChannelSigner`, `ChannelStore`,
`AddressCodec`, chain-source, and durable-store seams only where the published
API requires application-owned capabilities. These implementations translate
Sompi Treasury or Journal capabilities; they do not copy protocol parsing or
consensus rules into the Purchase model.

## 3. Supported protocol surface

Sompi supports only the following alpha.8 combinations:

| Scheme | Binding/profile | Sompi status |
| --- | --- | --- |
| `exact` | `kaspa-exact-v2` / `standard-native` | required first exact profile |
| `exact` | `kaspa-exact-v2` / `additive` | required optional exact profile |
| `batch-settlement` | `kaspa-escrow-v1` | separate gated lifecycle |

The common network is `kaspa:testnet-10`, the asset is `KAS`, and the x402
version is `2`. Unknown versions, bindings, profiles, schemes, encodings,
networks, or assets fail closed. `kaspa-exact-v1`, alpha.6 borrow reservations,
and every legacy payload or state reader are removed in this cutover rather
than retained as compatibility branches.

## 4. Canonical flow shared by both exact profiles

The Purchase module uses the public lower-level client operations rather than a
convenience call that hides durable boundaries:

1. acquire a bounded `SOMPI-CHECKOUT` and x402 `PAYMENT-REQUIRED` challenge;
2. normalize the effective request and reject redirects;
3. select one explicitly supported `exact` entry;
4. independently compare its canonical facts to Checkout Terms, Purchase
   Authorization, Treasury policy, and the Operator Manifest;
5. persist intent, requirements digest, normalized request hash, payment
   identifier, selected profile, effective Finality Floor, and reserved
   Treasury capacity;
6. stage an attempt-specific funding capability and ask the pinned
   Kaspa-x402 client to authorize one exact artifact;
7. persist the prepared payload and transaction identity before any paid retry;
8. commit a single-use paid-retry outbox effect;
9. send the identical `PAYMENT-SIGNATURE` to the identical effective URL;
10. persist `PAYMENT-RESPONSE`, protocol finality, and independent Chain
    Evidence;
11. apply settlement and compare the result to canonical Purchase facts;
12. release fulfilment only after the effective Sompi Finality Floor and then
    persist the receipt.

Automatic corrective re-signing is forbidden. A challenge change, retry that
would require a different transaction, or unknown outcome enters
reconciliation. A human-present caller must explicitly authorize any genuinely
new payment attempt.

The exact request authorization is mandatory. The payer funding key signs the
canonical transaction identity, selected profile, payment output, amount,
recipient script, requirements hash, normalized request hash, optional additive
challenge, funding input index, and expiry. The additive head is not payment
authority. The resource server or facilitator supplies its independently
computed `requestHash`; it may not trust the value embedded in the payload.

## 5. Standard-native exact

`standard-native` is the default exact profile. Its transaction is version 0
and contains:

- one or more authoritative standard payer P2PK inputs;
- exactly one Merchant output equal to the advertised amount;
- at most one payer change output;
- no covenant field, additive head, challenge, or additional Merchant output;
- native subnetwork, zero gas, empty payload, canonical mass, and a bounded fee.

The permanent economic invariants are:

```text
merchant gain = advertised Purchase amount
payer cost = advertised Purchase amount + explicit bounded network fee
```

Sompi's current covenant vault cannot directly provide an arbitrary standard
x402 input. Treasury therefore retains the journaled vault-to-attempt-P2PK
staging movement. That is a Sompi funding constraint, not part of the x402
profile. The adapter receives only the staged outpoint and an attempt-scoped
signing capability, never general vault authority.

## 6. Additive exact

`additive` is the Kaspa-x402 profile built with the KIP-10 introspection
primitive. It is not a claim that KIP-10 itself standardizes the entire x402
wire protocol.

The canonical version-1 transaction contains:

- input 0: the exact advertised current Merchant head;
- input 1 and later: standard payer P2PK funding inputs;
- output 0: the same-script successor at
  `old head amount + advertised Purchase amount`;
- at most one payer change output;
- no separate Merchant payment output.

The KIP-10 script enforces a minimum increase. The Kaspa-x402 verifier enforces
exact equality. A larger successor delta is an overpayment and fails. The
configured additive threshold is an application anti-churn minimum; it is not
an extra payment, a network fee, or a universal Kaspa dust floor.

An additive `402` reads a healthy head without reserving it. Many challenges
may name the same head. The first valid candidate atomically claims and advances
it; losing candidates receive fresh terms and never run protected work.
Independent head chains provide bounded concurrency. Public offer generation
may reconcile only a fixed number of selected heads, never scan work
proportional to total inventory.

Head recovery is evidence-driven:

- a locally known accepted transaction advances deterministically;
- a trusted indexer or configured chain source may prove the exact spender and
  same-index, same-script successor lineage;
- a same-address output alone is never sufficient;
- unknown lineage makes only that head unavailable for operator recovery;
- standard-native or another healthy head may remain available.

## 7. Exact verification and settlement ownership

Kaspa-x402 owns canonical transaction parsing, transaction-ID derivation,
authoritative input resolution, P2PK signature verification, KIP-10 script and
successor checks, contextual mass, compute budgets, fees, replay consumption,
head claiming, broadcast, and protocol finality observation. Sompi calls that
implementation and independently compares its result to the authorized domain
facts; it does not duplicate the transaction engine.

Before protected work, the selected server/facilitator path must have verified
the complete artifact, consumed replay evidence, and claimed the additive head
when applicable. Settlement stages remain durable across `pending`,
`broadcast`, `accepted`, and `applied`. Ambiguous outcomes remain consumed until
trusted reconciliation. Accepted handler output is durable before the final
commit; an uncertain handler is recovery-required and is never blindly rerun.

Kaspa-x402 protocol finality may be `accepted` or `confirmed`. Sompi persists
that label as evidence but releases privileged state only at the stronger of:

- the Merchant's advertised protocol requirement; and
- the Operator Manifest's effective Chain Evidence Finality Floor.

Recovery may never downgrade the originally required finality.

## 8. Batch settlement is a separate lifecycle

Batch is not a third exact profile and an escrow deposit never authorizes a
later Purchase. Every request needs its own Purchase Authorization and its own
durable capacity reservation before Sompi asks the channel signer to raise a
voucher ceiling.

`PaymentRequirements.amount` is the maximum charge for that request. The
actual accepted charge may be lower and is a separate canonical Settlement
fact. Sompi must not overwrite the authorization ceiling with the actual charge
or treat unused ceiling as paid value.

The immutable channel identity binds network, asset, escrow template, client
and server public keys, payee, refund address, absolute refund DAA, and salt.
The active voucher binds the complete current outpoint and serialized script.
Voucher amounts are cumulative and monotonic within one active-outpoint epoch.
Old vouchers remain valid against that exact outpoint, so a newly stored signed
ceiling may never decrease.

Batch processing rules are:

- initial deposit and top-up are accepted on-chain before protected work;
- a voucher-only request durably stores the verified commitment before its
  result is released;
- required voucher ceiling is at least the greater of the prior signed ceiling
  and `active charged amount + current request maximum`;
- actual charge is positive, no greater than the request maximum, and recorded
  separately from the signed ceiling;
- claim is full-epoch: claim amount equals active charged amount and is no
  greater than the signed voucher;
- continuation value equals active funding minus the authorized claim; the
  claim fee comes from the server payout or separate server funding, never from
  the continuation;
- a claim continuation starts a new voucher epoch and invalidates the old
  outpoint-bound voucher;
- unilateral refund is valid only when contextual DAA is strictly greater than
  the absolute `refundTimeoutDaa`;
- broadcast-only or mempool-only deposit, top-up, claim, and refund remain
  pending and do not mutate active channel state.

The batch covenant bounds client risk by the signed ceiling, not by the most
recent actual charge. A server claim above actual active charges but within a
signed ceiling is detectable protocol misconduct, not necessarily a covenant
failure. Sompi records receipts and stops further signing on inconsistency.

## 9. Transport rules

### Paid HTTP

The canonical headers are `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and
`PAYMENT-RESPONSE`. Both the initial request and paid retry reject redirects,
and the effective URL must equal the requested URL. A signed payment header is
never forwarded. The retry selects exactly one unchanged accepted entry and
uses the same payment identifier for idempotent recovery.

### Kaspa-x402 MCP transport

If a Merchant exposes a paid MCP tool, its canonical trusted server audience is
part of the v2 tool-call fingerprint. The audience comes from trusted
configuration, not tool arguments. Sompi's outer MCP compatibility process may
invoke the Purchase service, but it does not gain wallet or Authority
credentials and it does not interpret payment success itself.

### Facilitator

Direct mode remains valid and a third-party hosted facilitator is not required.
A configured facilitator advertises only healthy modes and profiles. Exact
`/verify` and `/settle` receive an independently computed request hash.
Server-owned settle, claim, or refund operations require authenticated resource
servers. Sompi persists the facilitator identity and advertised capability used
for every operation.

## 10. Normative traceability map

The test names below define required Sompi acceptance groups. Phase work may
split them into smaller files, but it may not remove the stated assertion.

| Normative rule | Protocol owner | Sompi seam and canonical fact | Durable evidence/state | Positive acceptance | Negative/adversarial acceptance | Alpha.6 deletion |
| --- | --- | --- | --- | --- | --- | --- |
| x402 v2, TN10, KAS, pinned binding only | Kaspa-x402 core | profile selector; network, asset, version, binding | requirements attachment + dependency manifest | `alpha8-profile-pins` | unknown/moving profile fails closed | alpha.6 profile constants and fallback |
| strict requirements, payload, response, and error schemas | Kaspa-x402 core | protocol adapter boundary | bounded raw attachment + parsed canonical projection | `alpha8-schema-conformance` | unknown fields, malformed integers, wrong discriminators | handwritten alpha.6 envelope readers |
| one selected offer is unchanged on retry | Kaspa-x402 HTTP | checkout comparison; selected canonical terms | requirements digest + request hash | `exact-offer-selection` | accepted-entry substitution | v1 offer decoder |
| no paid redirects | Kaspa-x402 HTTP | controlled egress; effective Merchant URL | request/outbox fingerprints | `paid-http-no-redirect` | initial and paid redirect disclosure | permissive redirect handling |
| payment identifier is request-bound | Kaspa-x402 core/server | Purchase idempotency | payment identifier binding | `paid-retry-idempotency` | cross-resource replay | legacy loose retry identity |
| payer authorizes exact request | Kaspa-x402 exact | funding capability; authorized request facts | authorization attachment + digest | `exact-request-authorization` | changed route, payee, profile, input, expiry, challenge | unsigned v1 payload assumptions |
| automatic corrective re-signing forbidden | Kaspa-x402 client | Purchase recovery | prepared artifact identity + attempt generation | `exact-one-artifact-recovery` | corrective triple-pay attempt | automatic replacement builder |
| standard Merchant gain is exact | Kaspa-x402 exact | Treasury/Settlement comparison | output evidence + amount | `standard-native-economics` | duplicate/over/under payment output | KIP-10-only builder |
| standard payer cost is amount plus bounded fee | Kaspa-x402 exact | Treasury Reservation | staging and exact fee evidence | `standard-native-fee-bound` | unexpected residual or fee ceiling breach | threshold top-up accounting |
| additive successor delta is exact entire payment | Kaspa-x402 exact | Settlement comparison | prior/successor amounts + lineage | `additive-exact-delta` | separate Merchant output or excessive delta | dual-benefit transaction shape |
| additive challenge is non-exclusive | Kaspa-x402 exact/server | Merchant adapter | challenge/head/version attachment | `additive-unanswered-flood` | 1,000 unanswered offers consume a head | consumable reservation inventory |
| additive head claim has one winner | Kaspa-x402 server | Purchase reconciliation | CAS claim and settlement stage | `additive-conflict-retry` | concurrent double fulfilment | reservation expiry retirement |
| unknown additive lineage fails closed | Kaspa-x402 server | Merchant/Chain Evidence | proven spender/successor chain | `additive-trusted-reconcile` | same-address top-up/grief adoption | address-only inventory recovery |
| exact success response matches accepted facts | Kaspa-x402 core/server | Settlement adapter | transaction, amount, network, payer, profile, finality | `exact-settlement-response` | empty txid, wrong amount/network/profile | permissive result hydrator |
| replay is consumed before protected work | Kaspa-x402 server | Purchase effect fence | replay record + prepared txid | `exact-replay-fence` | duplicate/cross-request execution | transaction-only lock |
| ambiguous exact remains pending | Kaspa-x402 server | Purchase recovery | settlement stage + observations | `exact-broadcast-recovery` | reuse after timeout/node absence | release-on-error behavior |
| handler result is durable and one-shot | Kaspa-x402 server + Sompi Purchase | fulfilment | result digest + commit state | `exact-handler-resume` | crash reruns irreversible handler | prose-only idempotency |
| finality cannot be downgraded | Kaspa-x402 + Sompi Chain Evidence | Finality Floor | protocol and effective levels | `exact-finality-recovery` | accepted evidence satisfies confirmed floor | alpha.6 conflated finality |
| deposit does not authorize Purchase | Sompi | AP2/Authority + batch coordinator | per-Purchase authorization | `batch-per-request-authorization` | funded-channel unauthorized call | exact-only empty channel adapters |
| voucher is full-outpoint and epoch bound | Kaspa-x402 batch | channel signer/store seam | voucher + active channel epoch | `batch-voucher-binding` | stale/cross-channel/cross-resource voucher | no batch state |
| voucher ceiling is monotonic | Kaspa-x402 batch | Treasury channel capacity | signed maximum + charged/claimed bases | `batch-monotonic-voucher` | rollback or ceiling below required amount | no batch state |
| actual charge is separate and bounded | Kaspa-x402 batch + Sompi Settlement | Purchase Settlement | max authorization + actual amount | `batch-variable-charge` | actual above authorized maximum | no batch state |
| deposit/top-up precedes content | Kaspa-x402 batch | Treasury Movement | funding tx + accepted evidence | `batch-deposit-topup` | mempool/broadcast-only release | no batch state |
| claim-fee reserve remains spendable | Kaspa-x402 batch + Sompi Treasury | channel capacity | reserve policy + active funding | `batch-claim-fee-reserve` | voucher exhausts claim/refund capacity | no batch state |
| full-epoch claim preserves continuation | Kaspa-x402 batch/covenant | Treasury Movement | claim, continuation, fee, new epoch | `batch-claim-continuation` | partial/overclaim or fee deducted from continuation | no batch state |
| refund uses strict absolute DAA | Kaspa-x402 batch/covenant | Treasury Movement + Chain Evidence | timeout + contextual DAA + refund tx | `batch-refund-boundary` | relative timeout or DAA equal boundary | no batch state |
| old voucher fails after continuation | Kaspa-x402 batch | ChannelStore | old/new epoch identifiers | `batch-epoch-rotation` | replay old voucher against successor | no batch state |
| corrective channel state is authenticated | Kaspa-x402 batch | client/channel adapter | verified latest voucher + active outpoint | `batch-corrective-state` | adopt forged server voucher state | no batch state |
| facilitator request hash is independent | Kaspa-x402 facilitator | payment-execution adapter | facilitator audience + request hash | `facilitator-request-binding` | infer hash from attacker payload | alpha.6 direct-only assumptions |
| facilitator advertises only healthy capabilities | Kaspa-x402 facilitator | configured execution adapter | supported-kind snapshot | `facilitator-capability-health` | execute unadvertised profile/mode | implicit mode support |
| public work is bounded | Kaspa-x402 server + Sompi API | transport and Merchant adapter | limit configuration + metrics | `bounded-payment-inputs` | head, UTXO, body, concurrency amplification | unbounded scans/parsing |
| secrets never enter agent transports | Sompi | API/MCP projection | redacted evidence references | `transport-secret-projection` | logs, errors, MCP/API response leak | raw artifact output |

## 11. Treasury and recovery contract

Treasury Reservation covers only:

```text
advertised amount or authorized batch capacity
+ explicitly bounded Kaspa transaction fees
+ explicitly bounded vault staging or recovery fees
```

There is no KIP-10 Merchant top-up beyond the advertised additive delta.
Attempt-specific staging remains journaled because of the Sompi vault covenant.
The adapter receives a single-purpose funding capability for the selected
profile or channel transition. It never receives the vault owner key, recovery
authority, unrestricted wallet access, or the ability to raise policy ceilings.

Before an irreversible effect, Sompi persists the canonical intent,
authorization, capacity reservation, exact artifact or batch movement plan,
idempotency scope, and recovery state. An uncertain observation never permits a
blind rebuild, re-sign, rebroadcast, repay, re-claim, or re-fulfil action.

## 12. Clean-cutover deletion inventory

The alpha.8 cutover is incomplete until active source, state, tests, and current
documentation contain none of the following:

- `0.1.0-alpha.6` package pins or integrity metadata;
- `kaspa-exact-v1` active requirements, schemas, payloads, or decoders;
- Merchant borrow reservations, exclusive leases, or expiry retirement;
- KIP-10 threshold as additional Merchant benefit;
- separate additive Merchant payment output or `paymentOutputIndex` assumptions
  inherited from alpha.6;
- alpha.6 demo inventory stores or compatibility readers;
- exact-only dummy `ChannelSigner` or `ChannelStore` adapters after batch lands;
- old Journal epoch readers or migrations;
- legacy commands, fixtures, vectors, examples, exports, and fallback branches;
- current documentation that presents alpha.6 behavior as supported.

Historical Git commits remain evidence. No historical compatibility code is
retained at runtime.

## 13. Evidence required before conformance claims

Sompi may claim alpha.8 testnet support only after all of the following pass
from the exact pinned dependency set:

- npm integrity, Git provenance, immutable schema, and vector checks;
- cross-package exact consensus and HTTP vectors for both profiles;
- standard-native and additive positive and mutation tests;
- additive unanswered-offer, conflict, lineage, and recovery tests;
- batch channel, voucher, deposit/top-up, claim, continuation, and refund tests;
- API and MCP parity over the same Purchase service;
- AP2 and deterministic Authority substitution/replay/expiry tests;
- crash injection before and after every external effect;
- full funded TN10 standard-native, additive, batch, and recovery proof;
- formal security diff scan, independent validation, remediation, and clean
  rescan;
- secret, dependency, package, and documentation gates.

Mainnet remains disabled. The upstream alpha.8 mainnet-shaped offline evidence
and read-only node checks are compatibility evidence only.
