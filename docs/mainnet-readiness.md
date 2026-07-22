# Mainnet is not supported

Status: explicit `0.12.0` release boundary.

Sompi supports only Kaspa Testnet-10.
It rejects each other network before it opens the Journal or creates signing material.
There is no mainnet override.

Do not remove this check or connect a testnet runtime to a mainnet node.
Kaspa-x402 is alpha software and all release evidence is from Testnet-10.

## Required work before mainnet

A mainnet proposal needs a separate ADR and release profile.
It must include:

- independent security review of all authority and money paths
- extended Testnet-10 evidence for every ambiguous crash and recovery edge
- reproducible protocol conformance and reviewed authorization
- production Merchant, payee, revocation, and retention policy
- production key custody, rotation, backup, and recovery
- separate OS identities, audited deployment, monitoring, and incident response
- tested Journal backup, corruption recovery, and disaster restoration
- fee and additional-cost limits calibrated to production network economics
- staged value limits and launch controls

Until these gates pass, use Testnet-10 only.
