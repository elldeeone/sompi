# Terah Phase 11 evidence

Generated on 2026-07-18. This evidence is Testnet-10 only. Private keys,
credentials, Telegram identifiers, private host addresses, Journals, and raw
protocol artifacts are excluded.

## Human-present integration

The live Terah Hermes gateway delivered an Authority-created inline Telegram
prompt through the generic callback hook and packaged Sompi plugin. The
operator-approved decision reached the distinct `sompi-authority` process and
the production Purchase stack completed as `receipted` for
`pur_QUFBQUFBQUFBQUFBQUFBQQ`.

This proof used the deterministic in-memory Testnet-10 boundary. It proves the
Hermes, Telegram, Unix-socket, AP2, Purchase, fulfilment, and receipt joins; it
does not claim a funded chain transaction.

The deployed isolation checks also established that Hermes can read the agent
API credential and callback socket, but cannot read the Authority private key
or join the Authority IPC group. A callback from another Telegram user/chat
was rejected as `unauthorized`.

## Funded standard-native exact

- Generated: `2026-07-18T06:00:25.014Z`
- Profile: `kaspa-exact-v2:standard-native`
- Ingress: canonical HTTP API
- Purchase: `pur_0gKEeq5yjz64U3iUSHbQgw` (`receipted`)
- Exact transaction: `331137376e0115aabda2a323402aa7ac3889c39fa2ede391a055cbdba37c4223`
- Merchant amount: `20000000` sompi
- Payer cost: `22000000` sompi, including a `2000000` sompi fee
- Transaction version/mass: `0` / `4546`
- Node: `rusty-kaspa 2.0.0`, synced Testnet-10 with UTXO index
- Public report digest: `7dd5ccfed60e61aa92f9b32a559caa28ed71b6e81a685365c4e404eed27be37b`
- Public report file SHA-256: `345a2b1cc44859949ae2e4148ae89206851b2cf458fc47a42834cbf922857258`

The duplicate Purchase returned the same ID, the duplicate Merchant retry
returned the same transaction, and only one exact Merchant transaction was
accepted.

## Funded batch

- Generated: `2026-07-18T06:04:49.515Z`
- Two Purchases reached `receipted`, each with a separately authorized voucher
- Claim transaction: `7570929e5fd6a72b05bba1627647c8c89d80bc667dc5df81ef763e3ff7bbf6dc`
- Claim continuation: `28000000` sompi
- Refund transaction: `229324d2d1a129ee8bb85afe62d678455cac132c1208fca059900e857b984699`
- Refund output: `38000000` sompi
- Public report digest: `5137bc4ef56f41fea1a8a5bdf3894fea7c30d04190ef8e744708885e91c8ddec`
- Public report file SHA-256: `9d1110d32fbd5e66c72048240f4b6d4ef4b3dbcbcc39701d5c0d94d7d60fe9d8`

The first process broadcast the claim but stopped during temporary independent
Chain Evidence lag. A restart derived the committed transaction ID, obtained
accepted evidence, and used Kaspa-x402's recovery API without rebroadcasting.
The refund similarly completed from the same durable state after the strict
DAA boundary. This is the intended ambiguous-settlement recovery path.

The funded exact and batch proofs used an isolated Terah source wallet funded
from the existing Forge bootstrap wallet. The bootstrap private key never left
Forge. Their in-process Authority fixture does not make a human-present claim;
that boundary is established separately above and by the retained canonical
funded human-present report under `evidence/live-testnet10/`.
