# ADR-0021: Owner-approved policy changes and guided vault migration

- Status: Accepted
- Date: 2026-07-20
- Amends: ADR-0011, ADR-0018, ADR-0019, and ADR-0020

## Context

Sompi presents one wallet and one stable receive address, but changing its
limits still exposes operator implementation details. The Agent cannot loosen
policy, which is correct, yet the only existing administrative path is full
manifest provisioning. Everyday spending limits and the SilverScript vault's
on-chain outflow bound have different security and operational meanings.

The active Journal already retains immutable policy snapshots. The current
runtime nevertheless treats the initial Operator Manifest projection as the
only policy for the process lifetime. The vault cap and window are compiled
into the funded covenant and therefore cannot be hot-reloaded or changed by a
policy snapshot.

## Decision

### One-wallet experience

Normal user interfaces expose one stable receive address, one combined
balance, maximum per payment, maximum in a rolling hour, the fact that every
outgoing payment requires owner approval, and one advanced `vault protection`
summary.

Vault addresses, covenant IDs, DAA windows, policy digests, manifest digests,
and atomic amounts remain available as technical evidence but do not appear in
ordinary wallet, receipt, Telegram, CLI, skill, or MCP summaries.

### Policy Change

Add one deep `Policy Change module`. An Agent may propose an exact change but
cannot approve or activate it. The isolated Authority displays and signs one
domain-separated `sompi.policy-change.1` decision bound to:

- the change and request identities;
- exact current and proposed limits;
- the active policy digest and expected next revision;
- the unchanged allowlist and fee ceilings;
- the vault-protection cap;
- the Operator Manifest identity; and
- expiry and replay data.

Approval activates one immutable Journal policy snapshot through compare-and-
swap against both the expected active digest and a monotonically increasing
activation generation. It is also bound to the exact active vault-protection
digest reviewed by the owner. An A-B-A content cycle therefore cannot revive
an older approval, and a separately approved vault replacement cannot compose
with a stale policy decision. A stale, replayed, substituted, expired,
out-of-bound, or concurrently superseded change fails closed. Existing
Purchases, Transfers, Reservations, and Treasury Movements remain bound to
their original policy snapshot. The new policy governs only new admission.

Every outgoing Purchase and Transfer remains human-present. Remove
`approvalThreshold` from the active product and user model; autonomous or
recipient-grant authorization remains separately gated.

The initial Operator Manifest policy is the first active policy. The current
vault protection is the absolute outflow bound for a chat-approved everyday
policy: maximum per payment must not exceed maximum per hour, and neither may
exceed the current vault maximum outflow. Policy Change cannot alter keys,
vault script facts, Merchant egress, Chain Evidence, admission budgets,
allowlists, fee ceilings, credentials, or recovery authority.

### Vault Migration

Add one separate deep `Vault Migration module`. The Agent may propose and read
a migration, and the Authority may approve the exact old/new protection facts,
but Telegram approval is not owner recovery authority.

Execution requires the offline owner key through an operator-only adapter. The
module durably fences outward work and Funding Intake, proves in one Journal
transaction that no unresolved direct Treasury operation or Purchase staging
effect can conflict, prepares the replacement vault using the same stable
receive identity, obtains the owner-signed old-vault recovery transaction,
requires independent recovery evidence at the configured finality floor before
launching the replacement, launches and observes the replacement vault, atomically
activates it, resumes work, and issues one migration receipt.

The approved migration is bound to the active policy digest and activation
generation. Policy activation and migration execution are mutually excluded at
their Journal transition boundary. A prepared vault spend also checks the
local migration fence immediately before submission. Existing Treasury
operations continue under the immutable policy snapshot that admitted them;
new policy activation cannot strand their recovery.

Migration must not manufacture fresh spending capacity. It carries the current
window start and spent amount forward when compatible. If the new cap is below
the amount already spent, outward work stays unavailable until that window
expires. Vault protection cannot be lowered below the active everyday hourly
limit; the owner lowers everyday limits first. This is checked both when the
plan is proposed and immediately before execution. Unknown submission or chain
evidence remains in reconciliation and never causes a replacement recovery or
launch transaction.

The public success message is `Vault protection updated; your receive address
has not changed.` Old and new vault addresses remain technical evidence only.

### Interfaces

The authenticated local interface adds policy-change proposal/status/recovery
and vault-migration proposal/status. The operator-only recovery interface adds
vault-migration execution/recovery. `sompi-agent` uses the Agent interface.
MCP remains a stateless compatibility adapter and receives no owner key,
operator credential, policy activation capability, or migration executor.

Onboarding displays recommended everyday limits and vault protection together.
The privileged bootstrap still creates the owner recovery key and vault; the
Agent never sees either secret.

## Consequences

- Users can ask their Agent to change ordinary limits and approve the exact
  change in the same Telegram conversation.
- The Agent remains unable to approve or install its own limits.
- Vault protection remains on-chain and owner-recoverable rather than becoming
  chat authority.
- Stable receive identity survives internal vault replacement.
- Policy and vault changes gain durable restart and recovery semantics.
- API, CLI, skill, MCP, Telegram, receipts, and errors share one user model.

## Rejected alternatives

- Let the Agent edit policy: makes the constrained principal its own operator.
- Mutable policy file or mtime reload: lacks signed intent, atomic activation,
  provenance, and restart recovery.
- Treat Telegram approval as the owner recovery signature: exposes the vault's
  ultimate control to bot or Authority compromise.
- Show both receive and vault addresses as wallet addresses: creates two-wallet
  UX for one product.
- Reset the spending window during migration: allows limit bypass by rotation.
- Keep `approvalThreshold`: misrepresents the human-present product and creates
  a hidden autonomous-spending control.
