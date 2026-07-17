# Additive head and batch channel recovery

Status: testnet-10 operator runbook for Kaspa-x402 alpha.8

This runbook covers the two stateful Kaspa-x402 lifecycles used by Sompi:

- a reusable `additive` exact head; and
- a separately capitalized `batch-settlement` channel epoch.

Neither is repaired by constructing a replacement transaction. Sompi persists
the selected head/channel, immutable signed artifact, submission fence, and
chain evidence before it may advance local state. Recovery observes those
exact facts and either adopts the proven winner or remains blocked.

## Hard rules

- Keep the same Sompi version, data directory, Operator Manifest, wallet,
  authority trust, Merchant trust, and testnet-10 node identity.
- Use `purchase_status` before `purchase_recover`; keep the original Purchase
  ID and request key.
- Never resubmit, re-sign, or manually broadcast a different payment to make a
  failed Purchase complete.
- Never select an output merely because it uses the same address or script.
  Additive successors require exact input lineage, output index, script,
  amount-delta, transaction, and finality evidence.
- Never edit `exact_heads`, `batch_channels`, Movements, prepared artifacts, or
  channel-store rows directly.
- A transient node/explorer failure, empty UTXO view, or missing transaction is
  not proof of absence.
- Mainnet is unsupported.

## Additive contention

Several unpaid `402` offers may safely name the same additive head. Issuing an
offer does not reserve or consume that head. The first accepted transaction
spending it wins and advances the head by exactly the advertised payment.

When another independently signed candidate loses:

1. Keep the losing Purchase and its signed artifact unchanged.
2. Read `purchase_status`. A corrective `402` may identify the proven accepted
   successor, but it does not authorize Sompi to sign another payment.
3. Run `purchase_recover` only for that original Purchase. Recovery must prove
   the candidate absent through the trusted operator source and independent
   witness, and must prove its staging output remains unspent.
4. The losing Purchase terminates without payment. A retry is a new Purchase
   with a new request key, fresh authority decision, fresh staging capability,
   and the then-current head.

If the known head disappears and the spender or exact successor lineage cannot
be proven, the additive profile fails closed. Continue only through an
available `standard-native` offer or a separately known additive head. Do not
adopt the largest same-address output or guess the successor.

## Batch claim and continuation

A batch Purchase authorizes one cumulative voucher ceiling against one exact
channel epoch. The active outpoint, serialized escrow script, refund DAA,
resource, network, and authorization ceiling are immutable joins.

For an interrupted Merchant claim:

1. Stop new vouchers on that epoch and preserve every Purchase ID and signed
   ceiling.
2. Read each affected Purchase and run `purchase_recover` only where requested.
3. Recovery first checks whether the active channel is still unspent. If it is
   spent, it follows bounded accepted transaction history and validates the
   exact claim input, Merchant payout, continuation amount/script/index, fee
   accounting, and required finality.
4. A proven claim advances the durable channel and its Purchase-bound Movement
   atomically. A merely broadcast or ambiguous claim remains fenced and is not
   rebuilt or rebroadcast.

The continuation must equal the prior active amount minus the authorized
cumulative claim. The Merchant claim fee cannot be taken from the continuation
unless the protocol authorization explicitly accounts for it; alpha.8 pays it
from the Merchant side or separate Merchant inputs.

## Refund race

Refund uses the exact active epoch and is valid only after the chain DAA is
strictly greater than the absolute `refundTimeoutDaa`. A wall clock, relative
duration, explorer timestamp, or equality at the boundary is insufficient.

Before refund:

1. Stop new Purchases for the channel.
2. Reconcile any planned, submitted, or ambiguous claim and every open voucher
   Movement.
3. Confirm the active outpoint, owner key, refund script, exact amount, and DAA
   through the configured node and independent witness.
4. Persist the refund Movement and immutable transaction before submission.

If claim and refund candidates race, only independently proven accepted-chain
evidence may select the winner. The losing candidate remains historical
evidence and must never be resubmitted.

## Cancellation and expiry

Cancellation or expiry before Merchant submission atomically terminalizes a
`planned` Purchase-bound voucher Movement while preserving the monotonic signed
ceiling. A later Purchase may plan from that ceiling on the same unchanged
outpoint. If a Movement remains non-terminal or any Merchant effect may have
started, recovery stays fenced; do not clear it manually.

## When to rotate

Rotate to a separately capitalized channel epoch only after the current epoch
is conclusively terminal and all funds and evidence are accounted for. Sompi
does not perform an in-place top-up. Rotation is not recovery for an ambiguous
claim, refund, missing head, or corrupt journal.

If state is missing or corrupt, stop and follow [`JOURNAL.md`](JOURNAL.md).
A clean testnet reset is permitted only after every retained outpoint and
Movement is conclusively accounted for as described in
[`TESTNET_RESET.md`](TESTNET_RESET.md).

## Evidence to retain

Record only public or content-addressed facts:

- Sompi and Kaspa-x402 versions and Git revisions;
- Purchase ID, payment identifier, profile, channel/head ID and version;
- transaction IDs, outpoints, amounts, fees, mass, DAA and finality;
- operator and witness evidence digests; and
- the bounded projected state and required operator action.

Do not publish raw payment headers, serialized signed transactions, voucher
bytes, wallet or authority keys, local paths, node URLs, private fulfilment
bodies, or unbounded exceptions.
