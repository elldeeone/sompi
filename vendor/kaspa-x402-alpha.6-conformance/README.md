# Kaspa-x402 alpha.6 conformance artifact

`exact-transaction.json` is an unmodified copy of
`vectors/x402-http/exact-transaction.json` from Kaspa-x402 commit
`28ac222d3a375b9a2a56c11396f388086eeeae76`.

- bytes: `7162`
- SHA-256: `15b5a878df6453d456b06b36bab3e17f872430bb744efd716a8008a0fbe17a9f`
- licence: MIT; the upstream licence is included beside the vector

This is the only upstream runtime/vector payload copied into Sompi. The
conformance test validates its canonical HTTP headers with the published
alpha.6 packages, then supplies Sompi's required official Payment Identifier
extension before exercising the Purchase execution adapter seam. Sompi does
not copy Kaspa-x402 runtime mechanics.
