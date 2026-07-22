# Exact-payment staging recovery

Scope: one observed Testnet-10 staging UTXO for one Purchase.

The staging key and recovery plan belong to that Purchase and runtime.
Loss of the Journal or staging keys can make the value unrecoverable.

## Supported cases

Recovery supports two cases:

1. An immutable exact-payment candidate exists.
2. Durable state proves that no exact candidate was created.

The exact-payment candidate and saved recovery sweep can spend the same staging output.
The recovery destination is the manifest-bound Sompi wallet.

## Procedure

1. Stop repeated Purchase calls.
2. Preserve the Purchase ID, request key, version, manifest, state path, node, and witness settings.
3. Read status.
4. If settlement exists, recover fulfillment or receipt instead.
5. Back up the complete API state.
6. Recover the original Purchase once.
7. Read status again.

Do not import the staging key, edit SQLite, replace bytes, or create a manual sweep.

## Outcomes

| Outcome | Action |
|---|---|
| Exact payment won | Continue settlement and fulfillment recovery. |
| Recovery sweep is not final | Wait and observe. |
| Recovery sweep reached finality | Close without payment. |
| No winner is proven | Keep the operation pending. |
| Unknown spender or conflict | Stop and escalate. |

When trusted evidence changes, call recovery again for the same Purchase ID.
Read status after each bounded call.
Never create a new sweep or payment.

Sompi reuses saved bytes only under its single-use durable proof.
It never rebuilds the transaction.

The total staging and recovery fee must stay within the original additional-cost limit.
The agent cannot increase this limit.

Keep public identifiers, values, fees, finality, and evidence digests.
Do not publish keys, transaction bytes, credentials, headers, paths, or node URLs.
