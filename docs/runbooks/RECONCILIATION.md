# Interrupted-operation reconciliation

Status: initial testnet-10 operator runbook

Sompi persists an effect before every irreversible external action. A timeout,
lost response, crash, or process kill therefore means “observe first”, never
“try the payment again”. The durable operation key or Purchase ID is the only
safe retry identity.

## Immediate response

1. Stop repeated Agent calls. Preserve the original `requestKey`, `purchaseId`,
   or direct Treasury `operationKey`.
2. Restart the same Sompi version with the same data directory, policy, wallet,
   vault, authority identity, trust store, and network.
3. Run the read-only status tool first:
   - `purchase_status` for a Purchase;
   - `treasury_operation_status` for `send_payment`, `vault_send`, or
     `vault_deposit`.
4. If the projection says recovery is required, call exactly one matching
   recovery tool with the same identifier:
   - `purchase_recover`; or
   - `treasury_operation_recover`.
5. Read status again. Retain the returned transaction ID, state, evidence
   digests, and operator action without copying raw signed artifacts into chat.

Do not create a new request key, operation key, Purchase, vault deposit, or
manual transaction to bypass an ambiguous state.

## What recovery is allowed to do

Recovery may:

- reacquire the same deterministic authority request;
- query Merchant AP2 authorization status;
- observe the exact saved wallet/vault inputs and immutable transaction ID;
- observe the exact Treasury staging outpoint, exact Kaspa payment, or safe
  abandoned-staging recovery race;
- replay the same idempotent Merchant fulfilment/receipt lookup after verified
  Settlement;
- resubmit only the exact saved prepared bytes after a proof-backed observation
  establishes non-submission and the original authority is still valid.

Recovery may not rebuild a different payment, change payee/amount/network,
silently increase a fee ceiling, ask the Agent to approve, or infer absence
from a transient RPC/HTTP error.

## State interpretation

| Projection | Meaning | Operator action |
|---|---|---|
| `created`, `terms_bound`, `awaiting_authority`, `authorised` | No payment Settlement is recorded | Follow the displayed action; approve only in the authority terminal |
| `execution_prepared` | Immutable execution exists, but no verified submission/Settlement is recorded | Use recovery if requested; never build a replacement transaction |
| `submitted` | Submission may have succeeded | Reconcile until exact chain/Merchant evidence resolves it |
| `settled` | Verified spend is final; fulfilment remains | Recover fulfilment/receipts only; never repay |
| `fulfilled` | Resource digest is durable; receipts remain | Recover receipts only |
| `receipted` | Complete | No recovery action |
| `expired` | No new authority, staging, signing, or exact payment may begin | Start a new Purchase only after any staged funds are safely resolved |
| `failed_recoverable` or `recoveryRequired: true` | A durable effect needs observation | Run the matching recovery tool once, then inspect status |
| `failed_terminal`, `conflict`, or unresolved ambiguity | Automatic progress is unsafe | Stop and inspect evidence; do not submit manually |

`not_found` is safe to retry only when the adapter returns the explicit
proof-backed retryable form for the exact immutable transaction/input set. A
404, missing explorer page, dropped websocket, or one RPC node saying “not
found” is not sufficient by itself.

## Direct Treasury Movements

All direct sends share the Purchase Journal's rolling policy capacity. Their
stable `operationKey` binds kind, destination, exact amount, fee ceiling, input
set, prepared bytes, and transaction ID. Reusing a key with different facts is
rejected.

- `prepared`: status is read-only; execute/recover with the same key only.
- `submitting` or `ambiguous`: recovery observes the exact source inputs and
  transaction before considering a resubmit.
- `completed`: use the recorded transaction ID; do not send again.
- `failed_terminal` or `conflict`: operator review is required.

A vault deposit's principal is an internal transfer into the protected vault;
its network fee consumes software-policy capacity. A wallet/vault payment to a
third party consumes principal plus its actual fee. Never change accounting by
editing the policy log or journal.

## Expired Purchase with staged funds

Expiry prevents new authorization, signing, Treasury staging, and exact
payment. It does not erase a staging UTXO already broadcast. Recovery must
first determine whether the immutable exact payment won, the pre-authorized
recovery sweep won, neither is yet visible, or the observations conflict.

Do not import the staging key into a general wallet or construct an ad-hoc
sweep. Use `purchase_recover`; it uses the journaled recovery plan and races
only the exact payment transaction against the exact recovery transaction.
Detailed staging controls are in [`STAGING_RECOVERY.md`](STAGING_RECOVERY.md).

## Escalation evidence

For terminal operator review, preserve without publishing secrets:

- Sompi version and Git commit;
- UTC time and network;
- Purchase ID or operation key;
- projected state and bounded error code;
- recorded transaction IDs/outpoints and evidence digests;
- authority issuer/key ID, Merchant issuer IDs, and policy digest;
- node endpoint identity and observation/finality result.

Do not paste wallet keys, authority MAC material, private JWKs, signed payment
headers, raw prepared transactions, full fulfilment bodies, local paths, or raw
exceptions into an issue or Agent conversation.
