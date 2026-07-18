# Threat model

## Protected assets

- wallet, vault, staging, Authority, bot, API, and recovery credentials;
- KAS and policy capacity;
- exact user decision and displayed facts;
- Purchase/Movement/Channel/Journal integrity;
- prepared transactions, vouchers, and idempotency identities;
- settlement, chain, fulfilment, and receipt evidence;
- paid resource content;
- service availability.

## Trust boundaries

Untrusted:

- agent output and MCP requests;
- Merchant HTTP responses and redirects;
- x402 headers/artifacts until verified;
- Telegram callback data before exact validation;
- raw node, witness, and indexer responses;
- caller-provided paths, IDs, URLs, bodies, and recovery requests.

Trusted only within their narrow role:

- Operator Manifest and provisioned credentials;
- separate Trusted Authority;
- Treasury and secure local state;
- Journal transactions and effect fences;
- Chain Evidence after configured corroboration;
- exact pinned protocol implementations and algorithms.

## Required security properties

1. An agent cannot authorize or loosen policy.
2. User approval covers every payment-relevant fact.
3. A Merchant receives exactly the approved amount or batch charge.
4. No irreversible effect occurs before durable intent and recovery state.
5. Ambiguous effects cannot be repeated with new authority.
6. A settled payment can recover fulfilment without paying again.
7. Protocol, request, Merchant, payee, profile, channel, and finality cannot be
   substituted across a Purchase.
8. Secrets never enter agent-visible output, reports, package artifacts, or the
   Journal.
9. Untrusted work is bounded before expensive parsing, chain reads, or signing.

## Main attack classes

| Attack | Control |
|---|---|
| Agent fabricates approval | Authority is a separate process with an unavailable signing key |
| Chat text treated as approval | Only exact Authority terminal input or bound Telegram callback is accepted |
| Merchant/resource substitution | Canonical request, origin, resource and requirements digests are signed and rechecked |
| Paid redirect leaks payment | Redirects are rejected before signing and during paid transport |
| Multiple spendable corrective retries | One immutable artifact per authorization; changed offer requires a new decision |
| Cross-resource replay | Payer and Authority signatures bind the exact request and audience |
| Fake UTXO or transaction | Trusted input lookup, canonical txid, signature, mass, fee and output verification |
| Extra Merchant benefit | Exact economic equality; additive delta is the sole Merchant payment |
| Unpaid additive-head exhaustion | Offers are read-only; claims occur only for valid signed candidates |
| Additive lineage grief | Follow only proven spend/successor lineage; otherwise disable one head |
| Batch overcharge | Signed ceiling, actual-charge check, monotonic voucher, route/channel binding |
| Continuation value theft | Exact active funding minus accepted claim accounting |
| Early refund | Absolute DAA timeout and strict `current DAA > timeout` check |
| Crash after broadcast | Prepared bytes and effect fence are durable; recovery observes first |
| Handler rerun after payment | Fulfilment result and recovery state are durable and idempotent |
| Finality downgrade | Required floor is persisted and cannot be weakened during recovery |
| Chain-source spoofing | Operator node plus independent witness under one Chain Evidence module |
| API/MCP exhaustion | Bounded bodies, evidence, connections, concurrency, deadlines, and result size |
| REST/index amplification | Entry/byte/input caps, duplicate rejection, memoized reads, bounded scans |
| Callback replay | Exact bot/user/chat/prompt/decision binding and one-time durable state |
| Secret path/package leak | Owner-only no-follow reads, exact package allowlist, tarball inspection |

## Authorization join

The following values must match across intent, verified terms, Authority
evidence, prepared payment, settlement, fulfilment, and receipt:

- Purchase ID and request key;
- Merchant identity/origin;
- URL, method, body digest, and resource identity;
- x402 requirements/request hashes;
- network, scheme, profile or channel epoch;
- payee and amount/ceiling/actual charge;
- fee and total cost ceilings;
- finality floor and expiry;
- payment identifier and transaction/commitment identity.

No component may infer missing equality from another component's successful
return.

## Effect boundaries

| Effect | Durable state required first | Recovery rule |
|---|---|---|
| Vault/staging submission | intent, policy reservation, prepared bytes/key reference, expected outputs, fence | observe exact outputs/spenders before retry |
| Exact payment | verified offer, authorization, total-cost reservation, immutable payment artifact, fence | Merchant evidence then chain evidence; same artifact only |
| Batch voucher | channel epoch, ceiling, actual-charge rule, cumulative state, Movement | never sign a sibling cumulative value |
| Claim/refund | prepared transaction, expected continuation/output, absolute DAA rule, fence | observe claim/refund race before action |
| Paid Merchant request | exact request, payment signature, payment identifier, settlement expectation | reuse only the same durable request |
| Fulfilment | settled payment and bounded expected resource facts | recover content; never repay |

## Availability and limits

Admission limits exist before authentication, parsing, evidence storage,
Authority prompts, Purchase execution, REST/UTXO reads, and operator recovery.
Operator recovery has separate credentials, sockets, pools, and budgets so an
agent cannot starve it.

Timeout does not imply no side effect. Any timeout after possible invocation is
ambiguous until authoritative observation proves otherwise.

## Residual risks

- AP2-derived authorization is not third-party AP2 interoperability.
- Kaspa-x402 and SilverScript remain pre-1.0/experimental dependencies.
- External node/witness availability can pause recovery.
- Telegram account/device security remains part of the user's trust boundary.
- The current deployment is testnet-only and operator-controlled.
- Mainnet, autonomous authorization, passkeys, UCP, and hosted multi-user
  custody need new threat models and acceptance gates.

## Verification

The repository includes substitution, replay, redirect, malformed artifact,
fee/mass, head contention, batch race, crash/restart, admission, callback, path,
package, and clean-install tests. Funded TN10 evidence is under
[`../../evidence/`](../../evidence/).
