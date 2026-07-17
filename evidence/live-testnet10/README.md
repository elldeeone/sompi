# Alpha.8 live Testnet-10 evidence

These files are the secret-free public reports from Sompi's funded
Kaspa-x402 `0.1.0-alpha.8` Testnet-10 proofs. They replace the superseded
alpha.6 report; no alpha.6 borrow-inventory or dual-payment evidence remains in
the active tree.

| Report | What it proves | Canonical report digest |
|---|---|---|
| `standard-native.json` | HTTP Purchase ingress, version-0 exact payment, exact 20,000,000-sompi Merchant gain, fee/mass/finality, restart recovery, receipt | `b17898cc726f46e8ee35bbad07c800e19117536350996f7600b0006bb688e1a8` |
| `additive.json` | MCP-over-API compatibility ingress, version-1 additive payment, successor delta as the sole 20,000,000-sompi Merchant gain, fee/mass/finality, receipt | `4dd59afa4b64c62d52bf6674783ccd6f2ba9e5a5e521fc78357f1a2efd2202f2` |
| `batch.json` | Two separately authorized Purchases, monotonic vouchers, accepted claim, 28,000,000-sompi continuation, and strict-boundary refund | `8736ece032a8c2e517169319edf91c30a50f87de97f89ce47b22868be0fbb7f1` |
| `additive-contention.json` | Two pre-signed candidates for one reusable head, one accepted winner, trusted loser absence, and one separately authorized retry against the successor | `5198dadb90fde6249831418d6ac475ce36cb959c0d468f289415f9d8a3a8e42e` |

The canonical digests are SHA-256 over `JSON.stringify(report)`, matching the
corresponding repository proof helpers. File-byte hashes differ because the
committed JSON is formatted for review.

Notable accepted transaction identifiers:

- standard-native exact:
  `c4f456e31e7a24d148ac33e98b1c3a3ec60e144617c2cfe9eee392cf36809f9d`;
- additive exact:
  `732d16eb4dacfabdb85516f7fa28ff616904ac294a8b718c2d528ea469b8781d`;
- batch claim:
  `79fbe8071c7942ed26895fa00ef1b606f774f466926178a7720b9f9be0e2e5ea`;
- batch refund:
  `6772094be335e81a22276bc8f15916065721e58df91578b1819a27a7209f675d`;
- additive contention winner:
  `615267d395bc2419f9802a06ace97cbd550c033118dee811f9d4e91a7e6baaf0`;
- additive contention retry:
  `73b038dc22d2f5443949ac162ca3514f465c6c1e503b6d8c8702ff81de1a928c`.

The standard, additive, and batch funded runners deliberately used the
in-process auto-approval fixture to isolate blockchain execution. They do not
claim that those particular funded runs exercised the separate-UID
human-present terminal. The separate deterministic Authority, its exact human
display/decision, credential isolation, transport, cancellation, and AP2
evidence are independent release gates covered by process-boundary and
end-to-end tests. No mainnet claim is made.

Private proof roots, wallet keys, authority material, signed protocol payloads,
and SQLite stores are intentionally excluded.
