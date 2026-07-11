# Sompi Purchase threat model

Status: current implementation threat model

Applies to: human-present AP2 v0.2 + Kaspa-x402 exact on testnet

## Security objective

An untrusted Agent may request a Purchase but cannot change its Merchant,
resource, request, amount, asset, network, payee, expiry, authority decision,
payment, Settlement, Fulfilment, or Receipt without deterministic detection.
No crash, timeout, replay, or malicious response may cause unauthorized or
unaccounted treasury movement.

## Protected assets

- wallet and consensus-vault signing keys;
- Trusted Authority signing key and approval decision;
- policy limits, reservations, and spend history;
- canonical Purchase facts and state transitions;
- AP2 mandates, Merchant checkout JWTs, and receipts;
- x402 requirements, payloads, identifiers, and settlement responses;
- prepared Kaspa transactions, transaction IDs, outpoints, and finality;
- Fulfilment bodies and digests;
- operator configuration, trust roots, and recovery state.

## Trust zones

### Agent zone

Includes the LLM, prompts, MCP caller, Merchant-provided prose, and tool
arguments. Fully untrusted. It may initiate and observe only.

### Sompi MCP zone

Validates tool inputs, applies egress policy, calls the Purchase module, and
projects status. It is deterministic code but remains exposed to agent and
Merchant input. It has treasury execution capability but no authority signing
credential.

### Trusted Authority zone

A separate deterministic process with its own credential and authenticated
local IPC. It independently validates and displays canonical approval facts.
It does not fetch Merchant content or accept free-form Agent instructions.

### Merchant zone

Externally controlled. Checkout terms, x402 responses, redirects, fulfilment,
and receipts remain untrusted until their signature, profile, identity, digest,
and semantic bindings verify.

### Kaspa/x402 zone

Kaspa-x402 code is trusted only within its pinned version and tested
invariants. RPC nodes, network timing, and HTTP transport are untrusted. Chain
observations require the configured finality and identity checks.

### Journal zone

SQLite is the local source of workflow truth. File-system compromise is outside
the first release's confidentiality guarantee, but corruption, partial writes,
duplicate processes, and process crashes are in scope. Private keys are not
stored in journal plaintext.

## Entry points

- MCP tool arguments and repeated calls;
- Merchant URLs, DNS, redirects, headers, bodies, and signatures;
- authority IPC requests/responses;
- policy and environment configuration;
- local database and restart/recovery paths;
- Kaspa RPC responses and websocket lifecycle;
- x402 `PaymentRequired`, `PaymentPayload`, and `SettlementResponse` objects;
- AP2 compact tokens, disclosures, JWT headers, JWKs, and receipts.

## Threats and mandatory controls

| Threat | Control | Verification |
|---|---|---|
| Prompt-injected Agent self-approves | Separate non-agentic authority; no authority key in MCP | Attempt approval with MCP-only process |
| Approval display differs from signed facts | Authority signs the canonical encoded approval request it displays | Mutate each field after display |
| Merchant/resource substitution | Request fingerprint and checkout hash bound through Purchase, AP2, payment, and receipt evidence | Cross-pair valid artifacts from two Purchases |
| Amount/asset/network/payee substitution | Exact atomic fields compared at every adapter return | Negative test each field |
| Malicious or stale Checkout | Merchant trust root, JWS verification, issuer/audience/time checks, latest-checkout hash | Bad key, expiry, replay, deterministic-signature cases |
| Mandate forgery or downgrade | Pin AP2 vct/profile/algorithm; verify SD-JWT/JWS before extraction | Unknown vct/alg, malformed disclosure, wrong signer |
| Payment payload replay | Unique payment identifier plus Kaspa-x402 replay/idempotency checks | Same ID/same payload and same ID/different payload |
| Crash after signing/submission | Persist planned effect and prepared bytes/reference first; reconcile before retry | Kill process at every effect edge |
| Policy overspend across processes | Transactional reservation with uniqueness and expiry; one writer/lease | Concurrent reservation tests |
| Vault continuation loss | Persist intent; reconcile covenant/outpoint from chain observation | Crash immediately after submit |
| Settlement spoofing | Kaspa-x402 validation plus canonical amount/network/transaction/finality match | Tampered response and wrong txid/outpoint |
| Paid but unfulfilled | Separate settled and fulfilled states; recovery queries Merchant and records dispute evidence | Merchant drops response after settlement |
| Fulfilled but receipt missing | Persist fulfilment digest and recover receipt without repeating payment | Drop receipt response |
| SSRF/private-network access | Resolve/validate every hop; deny loopback/private/link-local/metadata/unsafe schemes; cap redirects | Direct, DNS, and redirect bypass tests |
| DNS rebinding | Pin validated resolved addresses per connection where transport allows; revalidate each redirect | Change answer between validation/connect |
| Oversized/slow response | Header/body/time/redirect limits and streaming abort | Slowloris and oversized body tests |
| Secret disclosure | Redaction and explicit MCP/log projections; no raw key/error serialization | Snapshot logs and MCP errors |
| Evidence deletion/tampering | Digest, media type, profile, issuer, and verification record in journal | Modify evidence bytes after storage |
| Database corruption | Integrity check, backups/runbook, fail closed, no automatic destructive reset | Corrupt pages/schema version |
| Multiple Sompi processes | Database lock/lease and idempotent transitions | Concurrent worker test |
| Clock manipulation | bounded skew and chain/receipt time checks; short expiries | future iat, expired exp, skew edges |

## Canonical binding chain

The following equality checks are mandatory; a signature alone is insufficient:

```text
Purchase Intent request fingerprint
  == Merchant Checkout request fingerprint
  == authority display/signature request fingerprint
  == x402 resource/request binding
  == Fulfilment request fingerprint

Checkout JWT digest
  == Checkout Mandate checkout_hash
  == Payment Mandate transaction_id

Purchase amount/asset/network/payee
  == Checkout facts
  == authority-approved facts
  == Payment Mandate facts
  == selected x402 requirements
  == Settlement facts
  == Receipt facts

PurchaseId + attempt number
  -> unique payment identifier
  -> journal attempt
  -> Settlement
  -> Payment Receipt
```

## External-effect recovery matrix

| Planned effect | Durable before action | Observation used for recovery | Safe next action |
|---|---|---|---|
| Request Merchant terms | intent + request fingerprint + request ID | signed checkout JWT/digest or absence | repeat idempotent read only |
| Request authority approval | exact approval payload + nonce + expiry | signed decision bound to nonce/Purchase | retry with same request or expire |
| Reserve policy | Purchase/amount/payee/expiry | active unique reservation | reuse or release; never duplicate |
| Prepare payment | selected requirements + payment ID + prepared bytes/reference | journal preparation record | submit same prepared payment only |
| Submit exact Kaspa payment | prepared payment + submission intent | txid/outpoint/UTXO/finality and x402 idempotency state | observe/reconcile; do not rebuild blindly |
| Ask Merchant to fulfil | settled attempt + request fingerprint | idempotent Merchant result/resource digest | retry same payment ID/request only |
| Obtain receipts | mandate/settlement/fulfilment digests | signed receipt reference | refetch receipt; never repay |

## Cryptographic policy

- Allow only algorithms explicitly listed in the supported-profile declaration.
- AP2 v0.2 direct mandates use the exact `mandate.checkout.1` and
  `mandate.payment.1` vct values.
- Merchant Checkout JWT signatures must be non-deterministic as required by the
  pinned AP2 profile unless sufficient independent entropy is included.
- Hashes use SHA-256 where the pinned AP2/x402 profile permits/defaults it.
- Compact serialized artifacts are retained byte-for-byte for dispute hashes.
- Key identifiers resolve only through configured trust roots; token-supplied
  arbitrary remote key URLs are not fetched.
- Authority, Merchant, and receipt signing roles use distinct keys and issuer
  identities in the demo proof.

## Native KAS/AP2 limitation

AP2 v0.2's `Amount` semantics require ISO-4217 currency and minor units. Native
KAS/sompi is not currently standardized by that field. The first testnet build
must therefore isolate an explicitly named experimental KAS Payment Instrument
profile inside the AP2 adapter, preserve exact sompi in canonical Purchase
state, and avoid claiming strict native-KAS AP2 interoperability. The profile
must not enter x402/Kaspa-x402 wire objects. ADR-0010 records the exact mapping.

## Out of scope for the first release

- protecting a host already controlled by an administrator/root attacker;
- autonomous/open mandate constraint evaluation;
- passkey RP/origin/recovery security;
- batch channel authorization and claims;
- third-party production Merchant trust onboarding;
- mainnet economic or operational safety claims.

## Security acceptance

The end-to-end release is not complete until every threat marked with a
verification above has an automated negative or fault-injection test, or an
explicit documented manual proof where automation is impossible. A successful
happy path alone is not security evidence.
