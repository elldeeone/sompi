# Security Hardening Proposal: Trusted operator provisioning and configuration provenance

## Decision

Move recovery ownership, Treasury policy, and supported Merchant transport
configuration behind one operator-controlled provisioning boundary. Choose
Option 2 for the current single-host product: an operator-only command validates
and atomically installs a versioned manifest in secure local state, and the
runtime durably records the exact manifest digest it applies. The Agent-facing
MCP surface consumes that configuration but cannot create or loosen it.

## Executive Recommendation

There are three meaningful designs. **Option 1, Local provenance guards**,
keeps separate configuration paths but hardens each one with SDK key parsing,
secure descriptor-based file reads, and HTTPS-only transport. **Option 2,
Operator-provisioned manifest**, unifies those values in one versioned,
securely installed control-plane object and removes first-run recovery authority
from MCP input. **Option 3, Signed offline bundle**, adds a dedicated
configuration signing trust root and monotonic bundle verification for
multi-host or offline distribution.

I recommend Option 2 because Sompi is currently a single package on one host,
already has strong `SecureLocalStateDirectory` primitives, and has no
demonstrated need for configuration PKI. It gives the operator one auditable
ceremony without creating another credential lifecycle. Option 3 becomes the
better choice if manifests are produced on a different host, deployed to a
fleet, or must remain verifiable after crossing an untrusted distribution
channel.

## Evidence

I inspected the vault creation flow, key embedding, runtime protocol parser,
Merchant authorization transition, policy loader, direct-Treasury composition,
and secure-local-state implementation. Four findings point to the same
structural condition.

| Evidence | Finding | What it establishes |
| --- | --- | --- |
| `CAN-001` | Agent can seize vault recovery authority | `vault_create` takes an Agent-selected owner key and cap at `src/mcp/server.ts:276-312`; `VaultManager.create` persists that key as unrestricted recovery authority at `src/vault.ts:238-277`. |
| `CAN-007` | Cleartext Merchant authorization | `src/runtime/config.ts:421-447` permits an explicit `http:` production profile; unsigned reflected Merchant acceptance can then gate a signed payment over unauthenticated transport. |
| `CAN-008` | Invalid vault recovery point | Vault creation checks only 64 hexadecimal characters and embeds bytes without using the pinned x-only public-key parser. |
| `CAN-032` | Policy-file provenance bypass | `src/policy.ts:43-74,145-156` follows a configured path and mtime without file, owner, mode, link, parent, or stable-descriptor checks before the values authorize direct wallet signing. |

**Observed:** Sompi documents these values as operator-owned, yet they enter the
runtime through three different mechanisms: Agent tool arguments, permissive
environment flags, and a hot-reloaded filesystem path. `SecureLocalStateDirectory`
already protects wallet, vault, and other local files with owner, mode,
no-follow, descriptor, inode, and atomic-replacement checks, but policy and
first-run recovery provisioning do not use an equivalent boundary.

**Inferred:** operator intent is a security principal in the architecture, but
it has no single authenticated representation. Prose instructing the Agent to
ask an operator, or a deployment convention that a path “should” be owned by
the operator, is being used where the runtime needs enforceable provenance.

## Current Design And Failure Mode

The vault path is the clearest privilege inversion. The Agent-facing MCP tool
accepts `ownerPublicKey` and the consensus cap, then calls `VaultManager.create`.
The method creates the Agent key locally but trusts the supplied recovery bytes
after a lexical test. Once a vault is funded, the corresponding owner private
key can take the unrestricted recovery branch. The code displays helpful
operator instructions, but no trusted operator channel authenticates the value.

The policy path has the opposite shape: it is outside MCP, but the runtime
trusts whatever bytes `statSync` and `readFileSync` reach. Symlink following,
replaceable ancestors, broad modes, or a changed inode can promote a
lower-privilege local process's JSON into the policy that authorizes direct
wallet movements. The durable policy snapshot faithfully records the wrong
authority.

Merchant transport configuration demonstrates why validation must include
semantics, not just provenance. HTTPS is the default, but an operator can opt
into HTTP through an otherwise valid runtime configuration. A perfectly
authentic manifest that permits cleartext would still expose unsigned
authorization stages and the broadcastable signed payment. The supported
profile therefore needs a schema-level HTTPS invariant, not merely trustworthy
storage.

These paths have different immediate fixes, yet the failure is shared: the
credential-bearing runtime cannot prove which exact configuration the operator
intended, whether the bytes are semantically valid, or whether the object
changed safely between validation and use.

## Desired Invariants

- Vault recovery authority and consensus cap are installed through a trusted
  operator ceremony, never supplied or replaced by the Agent-facing MCP call.
- Every recovery public key is parsed as a valid pinned secp256k1 x-only point
  before covenant bytes or durable configuration are created.
- The supported Treasury-capable profile permits authenticated HTTPS Merchant
  transport only. A development-only cleartext fixture, if retained at all,
  is a separate explicit unsupported profile with no real Treasury credentials.
- Every operator policy is read from a regular, owner-expected, mode-restricted,
  non-symlink file through a stable descriptor whose inode and parents satisfy
  the configured ownership rule.
- Runtime activation binds a version, network, canonical bytes, semantic
  validation result, and digest. Hot reload cannot silently roll back or swap
  the object between validation and use.
- The journal records the exact configuration digest and revision used for a
  policy reservation, vault creation, and relevant execution decision.
- Agent tools can inspect readiness and request Purchase or Treasury intent;
  they cannot create, sign, loosen, or select operator configuration.

## Constraints And Non-Goals

We preserve the isolated Trusted Authority and do not reuse its purchase-signing
credential for configuration. Purchase Authorization and Treasury Movement
remain separate; an operator manifest can define Treasury limits but cannot
replace per-Purchase AP2 approval. The manifest contains Sompi canonical
configuration, not AP2 or x402 SDK objects.

This proposal does not create a remote control plane, a generic secrets
manager, or a payment-rail framework. We do not change Kaspa-x402 or make it
understand operator provisioning. Root or the protected operator identity is
outside the lower-privilege attacker model; the design still validates bytes
and filesystem provenance to catch deployment mistakes. No configuration
reload latency or operator workflow budget was supplied.

## Before Architecture

The current data paths make operator intent advisory in one branch and
filesystem-dependent in another:

[Before: dispersed operator configuration](../diagrams/trusted-operator-provisioning-before.mmd)

The important feature is not that there are several files. It is that no owned
boundary establishes the same principal, semantic checks, activation digest,
and replacement rules before those values reach wallet or vault authority.

## Options

### Option 1: Local provenance guards

This option patches each existing path without introducing a manifest. The MCP
vault tool would no longer accept recovery authority from the Agent; instead,
vault creation would read an operator-created secure file or one-shot descriptor
using the same no-follow and ownership rules as local secret state. It would
parse the owner key through the pinned SDK before writing any vault file. The
policy loader would open a regular file with no-follow, verify expected UID,
mode, link count, parent provenance, and stable inode, then parse from the
descriptor. The normal runtime would reject `http:` entirely.

This is attractive when delivery time dominates. It changes few interfaces,
adds negligible steady-state memory, and adds only filesystem metadata checks
at startup or reload. The reliability cost is stricter startup: deployments
that currently work through a symlink or broad mode will fail closed until the
operator corrects them. Hot reload becomes more involved because replacement
must be atomic and revalidated rather than noticed by mtime alone.

What gives me pause is consistency. Each subsystem would still define its own
operator identity, file rules, schema, activation, and audit story. A future
configuration path could repeat the same mistake. Rollback is easy per patch,
but reverting HTTPS-only or provenance checks is not a safe operational
response; deployment repair is the correct recovery.

[Option 1 after: hardened local configuration paths](../diagrams/trusted-operator-provisioning-local-provenance-guards-after.mmd)

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Vault owner key | Agent tool argument and lexical hex check | Operator file plus pinned curve-point parse | Removes Agent authority and invalid-point persistence | New operator setup file/ceremony |
| Policy loading | Path-following mtime reload | Stable descriptor, owner/mode/link/parent checks | Prevents lower-privilege replacement | More complex safe reload |
| Merchant transport | HTTP opt-in accepted | HTTPS-only supported runtime | Removes cleartext forgery/capture path | Local HTTP fixtures need isolation |
| Audit | Separate ad hoc logs/state | Each subsystem records its accepted digest | Better incident evidence | Repeated code and schemas |

### Option 2: Operator-provisioned manifest

This option creates one versioned Sompi operator manifest containing the vault
owner public key and cap, Treasury policy, network/profile selection, Merchant
allow rules, and the supported HTTPS-only transport policy. An operator-only
command validates canonical structure, exact integer bounds, key points,
network, profiles, origins, and cross-field invariants; then it atomically
installs the bytes under secure local state. The runtime opens and revalidates
that object, computes its digest, and activates it as one configuration revision.

The MCP vault surface changes from “create using these values” to “report
whether operator provisioning is present and whether the configured vault is
funded.” That preserves the Agent UX without pretending the Agent is a trusted
configuration courier. Policy and egress components receive typed projections
from the verified manifest. They do not parse the file independently. The
journal records the manifest digest with the installed policy snapshot and
vault configuration, giving recovery and audit one stable identity.

The strongest case is ownership: we can answer which operator-controlled object
authorized a Treasury state transition without reconstructing environment,
tool prose, symlink targets, and mtime history. A single schema also makes
unsafe combinations—such as a real Treasury profile plus HTTP—unrepresentable.
The principal concern is blast radius. A parser or activation bug in the
manifest boundary affects several controls, so the module needs stronger tests,
small projections, exact versioning, and fail-closed behavior.

Performance and memory effects are close to neutral. Canonical parsing and
hashing occur at startup or deliberate reload, not per network packet. Keeping
one parsed immutable object costs little. Reliability improves through atomic
activation but planned reloads can fail closed; the runtime should keep the
last verified revision only if policy explicitly permits that behavior, never
silently fall back after a malformed replacement. Operability improves through
one command and digest, while upgrades require a documented schema migration
and rollback ceremony.

We can introduce the manifest without a permanent compatibility path. The
provisioning command can import current operator values once, emit the canonical
object for review, and install it only after validation. During the clean
cutover, remove Agent-supplied recovery fields, independent policy-file hot
reload, and HTTP support together. Rollback is a Git operation plus restoring a
previous verified manifest revision; it must not reactivate the old untrusted
inputs.

[Option 2 after: one secure operator manifest](../diagrams/trusted-operator-provisioning-operator-provisioned-manifest-after.mmd)

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Provisioning principal | Agent prose, environment, and file convention | Operator-only installer into secure local state | Makes operator authority enforceable | New command and runbook |
| Semantic validation | Per-caller partial checks | One exact versioned schema and cross-field validation | Prevents invalid key and HTTP/Treasury combinations | Central module becomes high assurance |
| Activation | Immediate tool call or mtime reload | Atomic revision and durable digest | Removes validation/use and audit ambiguity | Reload/migration protocol |
| Consumers | Parse raw values separately | Receive immutable typed projections | Reduces control drift | Integration across vault, policy, and runtime config |

### Option 3: Signed offline bundle

This option keeps the manifest schema but signs its canonical bytes with a
dedicated configuration key held outside the MCP and Trusted Authority
processes. The runtime pins the public trust root, verifies signature, profile,
network, expiry if used, and a monotonic revision before activation. It records
bundle digest, signer identity, and revision durably. Distribution storage may
be untrusted because authenticity is checked at consumption.

The attractive part is portability. An offline administration host can prepare
one bundle, and several Sompi instances can independently verify the same
operator decision. A writable or symlinked local delivery path cannot change
the policy without invalidating the signature, while monotonic activation
defeats simple rollback. This is the strongest option if configuration crosses
hosts or administrative domains.

The signature does not remove semantic validation or secure runtime state.
Sompi must still reject invalid x-only points and HTTP in the supported profile,
protect the pinned trust root and active revision, and define key rotation and
recovery. A signing-key compromise can authorize every receiving instance, so
the blast radius is larger than the single-host manifest. That new credential,
its ceremony, expiry, rotation, revocation, and backup are the main operational
and reliability costs.

Verification adds negligible CPU and memory at activation. Distribution may
become more reliable because bytes can be copied through ordinary channels,
but losing the signing key or monotonic-revision state can block updates. We
could migrate from Option 2 because the manifest bytes remain the same; the
signature envelope and trust root are additive. Rollback requires an explicitly
signed higher-revision rollback bundle, not replay of an older object.

[Option 3 after: signed configuration bundle](../diagrams/trusted-operator-provisioning-signed-offline-bundle-after.mmd)

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Authenticity | Depends on local path provenance | Dedicated signature plus runtime trust root | Survives untrusted distribution | New high-value signing key |
| Rollback | mtime/path state has no monotonic meaning | Revision is verified and durable | Rejects replay of older permissive policy | Recovery ceremony is more complex |
| Fleet use | Per-host operator setup | One reviewable bundle can serve many hosts | Consistent policy and provenance | Larger compromise blast radius |
| Runtime storage | Raw configured path | Verified bundle plus protected active revision | Separates delivery from authority | Still requires secure trust-root/revision state |

## Comparison

No reload or provisioning benchmark was run; the effects below follow directly
from the proposed mechanisms.

| Dimension | Option 1: local guards | Option 2: operator manifest | Option 3: signed bundle |
| --- | --- | --- | --- |
| Security | Addresses current paths but leaves dispersed ownership | Strong single-host provenance and semantic consistency | Strongest across untrusted distribution; introduces signing-key risk |
| Performance | Neutral; metadata checks on load/reload | Neutral; one parse/hash per activation | Neutral; one signature verification per activation |
| Memory | Neutral | Neutral to one immutable parsed manifest | Neutral to manifest, trust metadata, and verification buffers |
| Reliability | Bad path/mode blocks each subsystem independently | Atomic activation gives coherent fail-closed startup/reload | Distribution tolerant, but key/revision loss can block all updates |
| Operability | Several files and rules | One provisioning command, digest, revision, and runbook | Key custody, rotation, revocation, signing, distribution, and audit |
| Migration | Lowest source change; repeated rollout | Medium clean cutover across MCP, policy, vault, and config | Builds on Option 2, then adds trust-root and envelope migration |
| Developer ergonomics | Familiar but easy to implement inconsistently | Typed projections and one schema make safe use routine | Same runtime ergonomics; administration is more specialized |

The signed option is not inherently “more secure” for today's topology. On one
host, a secure installer and protected local state have a smaller credential
surface. Its advantage appears when bytes must cross a boundary that local
ownership cannot authenticate.

## Recommendation

I recommend Option 2 for the current single-host release. It uses an existing
secure-local-state capability, cleanly removes recovery authority from MCP,
and gives policy and transport one versioned operator identity without creating
a configuration PKI. Keep Option 1's direct validations inside the manifest
boundary as defence in depth; centralization must not weaken curve, file, or
HTTPS checks.

Option 1 should win only for a short stabilization window when a coordinated
cutover is not feasible. Option 3 should win when manifests are authored or
distributed outside the protected host, when several instances need identical
operator intent, or when auditable offline approval outweighs the added key
lifecycle.

## Evidence Coverage And Residual Risk

| Evidence | Option 1 | Option 2 | Option 3 | Tactical fix still required |
| --- | --- | --- | --- | --- |
| `CAN-001` — Agent-controlled recovery authority | Addresses by removing owner key/cap from MCP input | Addresses through operator-only manifest | Addresses through signed operator bundle | Yes |
| `CAN-007` — Cleartext Merchant authorization | Addresses by rejecting HTTP in the supported runtime | Addresses with HTTPS-only manifest schema | Addresses with signed HTTPS-only schema | Yes |
| `CAN-008` — Invalid recovery point | Addresses with pinned SDK parsing | Addresses in manifest validation | Addresses in signed-bundle validation | Yes |
| `CAN-032` — Policy-file provenance bypass | Addresses with secure descriptor/path checks | Addresses by secure local installation and typed projection | Addresses authenticity through signature and protected revision | Yes |

Residual risk includes operator compromise, incorrect but intentionally
approved policy, loss of the offline owner private key, malicious HTTPS
Merchant behavior within valid signed terms, TLS trust-root compromise, and
bugs in the central parser. A signed bundle does not make unsafe semantics safe,
and a secure manifest does not replace per-Purchase Trusted Authority approval.

## Migration And Rollout

- **Tactical protections:** disable HTTP in the Treasury-capable profile, parse
  owner points with the pinned SDK, stop accepting recovery authority through
  MCP, and apply secure descriptor checks to the current policy file.
- **Schema and ceremony:** define the manifest version and canonical encoding;
  build an operator-only preview/validate/install command; document owner-key
  custody, cap selection, policy, Merchant origins, network, and rollback.
- **Read-only import:** read current values, produce a manifest preview and
  digest, but do not activate it automatically. Require the operator to review
  and install the canonical object.
- **Atomic cutover:** activate typed manifest projections in vault, policy, and
  runtime config; record the digest; remove Agent recovery fields, independent
  policy hot reload, and HTTP support in the same clean cutover.
- **Optional reload:** if reload is accepted, add monotonic revision,
  descriptor-stable read, full revalidation, atomic activation, observability,
  and a deliberate rollback revision. Otherwise require restart after install.
- **Rollback:** restore a previously verified manifest revision understood by
  the same runtime. Do not fall back to environment/tool values or an
  unvalidated path.

## Validation Plan

- Re-run the four finding PoCs and require rejection before vault creation,
  Merchant authorization, key persistence, policy snapshot activation, wallet
  signing, or broadcast.
- Test invalid/off-curve x-only points, wrong networks, overflowed amounts,
  duplicate fields, unknown profiles, HTTP origins, permissive policy
  combinations, and noncanonical encodings.
- Exercise regular files, symlinks, hardlinks, broad modes, wrong owners,
  replaceable ancestors, inode swap, concurrent replacement, partial writes,
  fsync failure, restart, and rollback. Activation must be all-or-nothing.
- Verify that the MCP process exposes only readiness/status and cannot choose
  recovery authority or alter the manifest through any registered tool.
- Verify that a manifest digest is bound to the installed policy snapshot,
  vault configuration, and relevant operation records, and that audit output
  does not reveal private keys.
- Benchmark startup and reload with representative manifests. Measure parse,
  validation, signature (Option 3), activation latency, failure duration, and
  RSS; set acceptance thresholds from the deployment budget.
- For Option 3, test trust-root rotation, lost signer, revoked signer, duplicate
  revision, rollback bundle, damaged monotonic state, and cross-host
  consistency before adoption.

## Implementation Work Packages

- Specify the canonical operator manifest, versioning, semantic invariants,
  digest, projections, and error model.
- Build the operator-only validate/preview/install command using secure local
  state and atomic durable replacement.
- Change vault provisioning so MCP cannot supply recovery authority and the
  pinned key parser validates every owner point.
- Replace raw policy-file reads with the verified manifest projection and bind
  the manifest digest to policy snapshots and Treasury operations.
- Make HTTPS-only transport part of the supported runtime profile and isolate
  any cleartext development fixture from real credentials.
- Add reload or restart activation semantics, metrics, audit output, migration,
  rollback, and runbook evidence.
- If selected later, add the signed envelope, dedicated trust root, monotonic
  revision, rotation, revocation, and offline administration procedures.

## Open Questions

- Should the current product support hot reload at all, or is operator install
  plus process restart a safer and adequate ceremony?
- Which OS identity owns manifest installation, and which UID/GID must the MCP
  runtime require when it opens the active object?
- Does the operator want one manifest to include Merchant trust roots and RPC
  identities, or should those remain separate secure objects linked by digest?
- Is any cleartext Merchant fixture still needed? If so, how will it be made
  incapable of reaching real wallet/vault credentials and public security
  claims?
- What event justifies the additional signing key and fleet semantics of
  Option 3?
