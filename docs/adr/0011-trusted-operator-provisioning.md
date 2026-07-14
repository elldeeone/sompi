# ADR-0011: Install immutable operator configuration outside MCP

- Status: Accepted
- Date: 2026-07-13
- Amends: ADR-0008

## Context

The Agent-facing runtime can currently choose vault recovery authority, read a
mutable policy path, and enable cleartext Merchant transport. Those paths let
the principal being constrained create or loosen the constraints. Static vault
parameters also determine the funded covenant script and cannot be safely
hot-reloaded as ordinary policy.

## Decision

Add one short-lived `sompi-operator` command in the existing package. It runs
outside the MCP session and installs one canonical Operator Manifest through a
capability-separated filesystem implementation.

The Operator Manifest has an exact schema, monotonic revision, canonical
encoding, SHA-256 digest, and immutable projections for:

- the supported network/protocol profile;
- vault recovery and generated Agent x-only public keys, template, derived
  address/configuration digest, cap, and window;
- Treasury policy and additional-cost ceilings;
- HTTPS-only Merchant hosts and ports;
- trusted Chain Evidence sources and per-operation Finality Floors.

The production installer runs as an operator/root principal and publishes a
regular manifest readable through one fixed runtime group but not writable by
the MCP principal. It generates the vault Agent key, transfers only that
mode-`0600` signing file to the MCP principal, and binds its public key and the
exact vault-configuration digest in the operator-owned manifest. Replacing the
runtime key or vault configuration therefore fails closed instead of changing
funded-vault authority. Same-UID manifest injection is permitted only through
hermetic test composition and is unavailable to production startup.

Provisioning validates real secp256k1 x-only points, safe integer/string
semantics, cross-field invariants, ownership, file type, link count, modes,
safe ancestors, descriptor stability, and crash-safe publication. Runtime
activation is restart-only. The MCP process receives read-only projections and
cannot install, replace, or loosen the manifest.

Vault configuration, policy snapshots, Purchases, Chain Evidence, and Treasury
operations record the accepted manifest revision and digest. Changing a static
funded-vault fact requires an explicit owner recovery/recreation ceremony; it
is not a live configuration update.

Remove `vault_create` and owner-key generation from MCP, mutable policy-file
loading, production HTTP enablement, and environment fallbacks for manifest
facts. The Trusted Authority credential is separate and is never reused for
operator provisioning.

## Consequences

- Operator trust has one auditable source and strong locality.
- Future manifest revisions can change inside the Operator Provisioning module
  without teaching protocol adapters or MCP how to parse operator state.
- A compromised MCP process cannot silently replace the recovery key or loosen
  policy/transport/finality requirements.
- Development-only configuration and vault state are recreated; no migration
  or compatibility reader is retained.

## Rejected alternatives

- MCP provisioning tool: preserves Agent reachability to operator authority.
- mtime-based hot reload: lacks atomic activation, rollback, and provenance.
- Reuse `sompi-authority`: mixes AP2 Purchase Authorization with Treasury
  administration.
- Separate repository/package: no independent release or ownership need exists.
