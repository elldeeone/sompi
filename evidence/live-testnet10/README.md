# Live Testnet-10 Purchase evidence

`report.json` is the secret-free public-facts report from a real Sompi Purchase
against the operator-pinned node `ws://10.0.3.26:17210` on 2026-07-11.

The run reached `receipted` for Purchase
`pur_q8GkLG5V83EEsbJkEcUGAg`. Kaspa-x402 exact transaction
`e1dfb3ca7afd06b07ea84ce3d0fc290ccc56552bf66520bb2a3e02746a6d4586`
paid the Merchant output at index 1 and continued the KIP-10 inventory at
index 0.

Independent readback established:

- one durable Purchase, payment attempt, exact payment, and consumed Merchant
  reservation;
- inputs of `100000000 + 32000000` sompi, outputs of
  `110000000 + 20000000` sompi, and an exact fee of `2000000` sompi;
- the KIP-10 script commits the `10000000`-sompi additive threshold;
- a calculated conservative fee floor of `1984000` sompi;
- both outputs in the node's UTXO index and one current virtual-chain
  acceptance;
- one Merchant and one Payment Receipt joined to the receipted Purchase; and
- a second invocation against the same private proof root returned the same
  Purchase and transaction without another funding or payment effect.

The private proof root, wallet keys, authority material, signed protocol
artifacts, and SQLite stores are intentionally not committed. The runner
created `report.json` with mode `0600` and rejected private-state overlap.

The command shape was:

```bash
SOMPI_NODE_URL=ws://10.0.3.26:17210 \
  node scripts/run-live-testnet-e2e.mjs \
  --directory <private-proof-root> \
  --source-wallet <funded-testnet-10-wallet> \
  --report evidence/live-testnet10/report.json
```

This run intentionally used the in-process auto-approval fixture to isolate
the live Kaspa execution proof. As `report.json` states, it is not a claim that
this particular run exercised the human-present terminal or the separate-UID
authority boundary. Those are independent release gates.
