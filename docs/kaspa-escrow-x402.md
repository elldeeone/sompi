# kaspa-escrow x402 wire spec

Status: draft for Sompi v0.8 agent UX and interoperability work.

This document describes the wire protocol. User-facing agent responses should
show KAS/tKAS first, but protocol amounts are exact integer sompi strings.

## Overview

`kaspa-escrow` lets an HTTP client pay a server after receiving `402 Payment
Required`.

The client funds a covenant escrow once. Each paid request then sends a
cumulative off-chain voucher in `X-Payment`. The server can claim at most the
latest voucher amount. After the refund timeout, the client can reclaim the
unspent escrow balance.

## HTTP 402 offer

Servers reply with HTTP `402` and JSON:

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "kaspa-escrow",
      "network": "testnet-10",
      "serverPublic": "<32-byte x-only public key hex>",
      "refundTimeout": "<DAA score decimal string>",
      "minDepositSompi": "90000000",
      "pricePerRequestSompi": "1000000",
      "description": "optional human description"
    }
  ]
}
```

Field rules:

- `scheme` must be `kaspa-escrow`.
- `network` must match the client's wallet network.
- `serverPublic` is the server's x-only public key.
- `refundTimeout` is the DAA score after which the client refund path is valid.
- `minDepositSompi` is the minimum escrow deposit.
- `pricePerRequestSompi` is the incremental voucher amount per paid request.

## Escrow parameters

The escrow address is derived from:

- client x-only public key
- server x-only public key
- refund timeout
- network

The client funds that address with at least `minDepositSompi` and records the
full funding outpoint:

- funding txid
- funding output index

## Payment header

Paid requests send an HTTP header:

```http
X-Payment: <base64-json>
```

Decoded JSON:

```json
{
  "scheme": "kaspa-escrow",
  "clientPublic": "<32-byte x-only public key hex>",
  "voucherAmountSompi": "2000000",
  "voucherHex": "<64-byte Schnorr signature hex>",
  "outpointTxid": "<funding txid>",
  "outpointIndex": 0
}
```

`voucherAmountSompi` is cumulative. For a price of `1000000`, the first paid
request authorizes `1000000`, the second authorizes `2000000`, and so on.

## Voucher digest

The voucher signs:

```text
sha256(
  sha256("sompi:escrow-voucher:v2") ||
  sha256(network) ||
  sha256(serialized active input scriptPublicKey) ||
  outpointTxid32 ||
  outpointIndex_le32 ||
  voucherAmountSompi_le64
)
```

The covenant rebuilds this message from transaction introspection and verifies
the voucher with `OpCheckSigFromStack`.

## Outpoint binding

The voucher is bound to the exact funding outpoint. This matters because the
claim path returns unclaimed change to the escrow script under a new outpoint.
A voucher signed for the original outpoint cannot be replayed against the change
outpoint.

## Claim behavior

The server stores the latest valid voucher per client/channel. To claim, the
server spends the escrow UTXO through the claim path:

- output 0 pays the server at most `voucherAmountSompi`
- output 1 returns the remainder to the same escrow script
- the voucher must verify for the active input script, full outpoint, and amount

If the claim amount is too small to cover the transaction fee, the server should
wait for more requests before claiming.

## Refund behavior

After `refundTimeout`, the client can spend the current escrow UTXO through the
refund path with its client key. This reclaims the remaining escrow balance
minus the network fee.

## Error cases

Implementations should reject:

- unsupported `x402Version`
- missing `kaspa-escrow` offer
- network mismatch
- invalid public keys
- deposit below `minDepositSompi`
- missing or unindexed funding outpoint
- voucher signed for the wrong network
- voucher signed for the wrong scriptPublicKey
- voucher signed for the wrong txid or output index
- voucher amount below the server's cumulative owed amount
- claim amount above the voucher amount
- refund before `refundTimeout`

## UX guidance

Agents should not expose this wire protocol by default. A normal receipt should
say something like:

```text
I paid 0.01 tKAS using the existing vault-funded escrow. No new deposit was needed.
```

Technical fields such as `voucherAmountSompi`, txids, outpoints, and DAA scores
should remain available when the user asks for details.
