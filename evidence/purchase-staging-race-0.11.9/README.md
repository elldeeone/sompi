# Purchase staging-race closure

Date: 2026-07-20

Release `@elldeeone/sompi@0.11.9` closes the short-lived observation race that
followed a successful exact payment from staged Treasury funds. Chain Evidence
now performs the required bounded second absence read inside one recovery
request. It does not resubmit either candidate transaction.

The funded Testnet-10 canary used Purchase
`pur_L0ZdrqqwdNTEJsUuhREI4w` against
`https://demo.kaspa-x402.org/exact/report`:

- staging transaction:
  `02276c7780d3f01f0acdb2626cf416bb744baebc7dcf9131dc09855df73af400`;
- exact payment transaction:
  `1ca0d3425228172da951c032aedaab40ee708927a1842a5f05a95fa82d9950ea`;
- Merchant payment: `0.2 tKAS`;
- planned but never submitted recovery transaction:
  `9828e6f89791dd8557e0ad27129a0c6cf1e10b7b9625a207bb83224fb2ec946f`.

Independent TN10 indexer reads report the staging and exact transactions as
accepted and the recovery transaction as absent. Sompi records the staging,
exact payment, and losing recovery effects as `observed`; the Treasury
reservation is `spent`; the Purchase is `receipted`; the Merchant report and
receipt evidence are present; and `userAction` is `none`. A recovery call on
the deployed `0.11.9` runtime returned that same completed Purchase without a
new approval, signature, submission, payment, or fulfilment request.

The release commit and tag are `3dfdc55` and `v0.11.9`. The 218-file registry
artifact has npm SHA-1
`e114261cf7030a7a4402f6719f233056862e59d1` and integrity
`sha512-EmrknBaSlppG2K7mFRcnpFYT/MFzDtYSpot/c3UY2YASTG0l2I8AULczoCIP0vCX55dKIXNkiOSbFziQyuSwVg==`.
The complete release verifier ran 525 tests: 524 passed and the expected
root-only ownership test was skipped. The deployed Authority, API, and Hermes
gateway services are healthy and run the byte-verified `0.11.9` package.

The deterministic test exercises the new single-call corroboration through the
real `ChainEvidenceModule`. The live canary proves exactly-once settlement and
clean post-deployment recovery; it does not claim that the already-reconciled
live Purchase re-entered the original race after deployment.
