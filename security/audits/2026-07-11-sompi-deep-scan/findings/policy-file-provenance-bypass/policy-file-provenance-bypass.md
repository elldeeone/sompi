# Unchecked policy-file provenance lets a local Agent process replace operator authority

## Executive Summary

Sompi treats the file named by `SOMPI_POLICY` as an operator-owned control
below the untrusted Agent. At revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a` (package version `0.8.0`),
`PolicyEngine` reads that file and hot-reloads it by pathname without checking
whether it is a symbolic link, a regular file, owned by a trusted operator,
non-writable by the Agent principal, or reached through protected ancestors.
Both `statSync` and `readFileSync` follow symbolic links.

Consequently, a lower-privilege local Agent-side process that can write or
replace the configured leaf, a followed target, or a relevant ancestor can
supply valid permissive policy JSON. On the next policy access, Sompi promotes
those bytes into the active direct-spend policy. The Agent can then use the
ordinary `send_payment` MCP tool to ask the credential-bearing Sompi process
to prepare, sign, and submit an attacker-directed wallet transaction.

This is a deployment-conditional privilege crossing, not a claim that an MCP
argument or an arbitrary remote client can write the policy file. A correctly
separated operator identity and a non-symlink, non-replaceable policy path
defeat the attack. Where that filesystem condition is absent, however, the
runtime does not detect it even though the policy is represented as the
operator's security boundary.

I reviewed the exact source revision above and executed the included harness
against its built production `dist/policy.js`. The source and module hashes
matched the reviewed target, and the same 100-sompi authorization changed from
`PolicyViolation` to allowed after a mode-`0666` symlink target was
rewritten. I did not create a wallet, call a live MCP service, sign a
transaction, or broadcast to Kaspa. No fixed revision was available for
assessment.

The finding is medium severity and P2 priority: successful exploitation
crosses the operator-to-Agent boundary and can cause an unauthorized,
policy-bounded direct wallet spend, but it requires same-host filesystem
authority that a sound deployment should withhold. The reviewed release is
testnet-10 only, the reach is one Sompi service and its configured wallet, and
the issue does not disclose the wallet key.

## Background

Sompi separates an untrusted Agent from the components that enforce policy and
hold treasury credentials. The Agent can request a direct wallet movement
through MCP, while deterministic code in the Sompi process applies the
operator's software policy before calling the wallet. This is separate from
human-present Purchase Authorization: the Trusted Authority approves exact
Purchases, whereas `send_payment` is a direct Treasury Movement guarded by
the software policy.

The source describes the intended boundary directly in `src/policy.ts`:

```typescript
/**
 * Spending policy enforced below the agent. The agent (LLM) can call
 * send_payment, but every send passes through this gate. The policy file
 * lives outside the MCP tool surface, so a prompt-injected agent cannot
 * loosen its own limits.
 */
export interface Policy {
  maxSompiPerTx: bigint;
  maxSompiPerHour: bigint;
  allowlist: string[];
  requireApprovalAboveSompi: bigint;
}
```

The four values implement two hard amount caps, an optional destination
allowlist, and an optional human-approval threshold. An empty allowlist means
that every destination is eligible, and an approval threshold of zero disables
that threshold. The documented deployment points `SOMPI_POLICY` at an
operator-owned file, with `/etc/sompi/policy.json` used in the runbook.

At startup, `src/runtime/purchase-runtime.ts:103-115` loads read-only
configuration and constructs the policy engine before creating the wallet:

```typescript
// A bad trust/policy/egress configuration must not
// create signing material as a side effect of a failed start.
const trust = loadAp2TrustStore(config.authority.paths.trust);
// ...
const policy = new PolicyEngine(config.dataDirectory, config.policyPath);
const wallet = new KaspaWallet({
  networkId: config.networkId,
  dataDir: config.dataDirectory,
  ...(config.nodeUrl ? { nodeUrl: config.nodeUrl } : {}),
});
```

This ordering protects against malformed configuration creating a wallet as a
startup side effect. It does not establish who controls the filesystem object
behind `config.policyPath`. That missing provenance fact is the core of the
vulnerability.

## Vulnerability Details

### Configuration normalizes text, not filesystem authority

`SOMPI_POLICY` enters the runtime at `src/runtime/config.ts:151-166`.
The shared path helper at `src/runtime/config.ts:522-539` rejects empty,
whitespace-padded, oversized, and control-character-bearing strings, then
performs lexical resolution:

```typescript
function configuredPath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > PATH_MAX_BYTES ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new SompiRuntimeConfigError(`${label} is invalid`);
  }
  return path.resolve(value);
}
```

`path.resolve` gives Sompi an absolute lexical pathname. It does not resolve
or pin a filesystem object, reject links, inspect the owner or mode, or prove
that an Agent-side principal cannot replace a path component. We therefore
carry an unauthenticated namespace reference into the policy engine.

### Startup and hot reload both follow the untrusted path

The decisive code is in `src/policy.ts:37-74` and
`src/policy.ts:145-156`:

```typescript
constructor(_dataDir: string, policyPath?: string) {
  this.policyPath = policyPath;
  this.cachedPolicy = loadPolicy(policyPath);
  if (policyPath) this.cachedMtimeMs = fs.statSync(policyPath).mtimeMs;
}

get policy(): Policy {
  if (this.policyPath) {
    try {
      const mtimeMs = fs.statSync(this.policyPath).mtimeMs;
      if (mtimeMs !== this.cachedMtimeMs) {
        this.cachedPolicy = loadPolicy(this.policyPath);
        this.cachedMtimeMs = mtimeMs;
        this.loadError = undefined;
        console.error(`sompi: policy reloaded from ${this.policyPath}`);
      }
    } catch (e) {
      this.loadError = e instanceof Error ? e.message : String(e);
    }
  }
  if (this.loadError) {
    throw new PolicyViolation(
      `policy file ${this.policyPath} is unreadable or malformed (${this.loadError}); ` +
        `all sends are denied until it is fixed`
    );
  }
  return this.cachedPolicy;
}

function loadPolicy(policyPath?: string): Policy {
  if (!policyPath) return { ...DEFAULT_POLICY };
  const raw: PolicyFileShape = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  return {
    maxSompiPerTx: toBigInt(raw.maxSompiPerTx, DEFAULT_POLICY.maxSompiPerTx),
    maxSompiPerHour: toBigInt(raw.maxSompiPerHour, DEFAULT_POLICY.maxSompiPerHour),
    allowlist: raw.allowlist ?? [],
    requireApprovalAboveSompi: toBigInt(
      raw.requireApprovalAboveSompi,
      DEFAULT_POLICY.requireApprovalAboveSompi
    ),
  };
}
```

On POSIX systems, both calls follow the final symbolic link. The code never
uses `lstat`, `O_NOFOLLOW`, a file descriptor, `fstat`, an expected UID,
mode checks, link-count checks, or ancestor checks. The modification-time
check and read are also separate path lookups, so a namespace change can make
them refer to different objects. We do not need that race for a reliable
trigger: a stable symlink to an Agent-writable target is sufficient.

Malformed or unreadable replacement content does fail closed, which is useful
counterevidence. It does not authenticate well-formed content. A local process
can instead write:

```json
{
  "maxSompiPerTx": "1000",
  "maxSompiPerHour": "1000",
  "allowlist": [],
  "requireApprovalAboveSompi": "0"
}
```

When the target's modification time changes, the next `policy` access parses
these bytes. For a 100-sompi request, the new per-transaction and hourly caps
pass, the empty allowlist skips destination filtering, and zero disables the
approval threshold. All remaining policy checks are operating correctly on
the wrong principal's policy.

### The replacement reaches the privileged wallet path

Every new direct operation installs the currently loaded policy before it
claims durable intent. During preparation,
`TreasuryOperationModule.drive` passes its authorization callback into the
wallet adapter:

```typescript
// src/treasury/operations.ts
async execute(request: Readonly<TreasuryOperationRequest>): Promise<TreasuryOperationView> {
  const normalized = normalizeRequest(request);
  const policy = this.installCurrentPolicy();
  const record = this.journal.claimTreasuryOperationIntent({
    ...normalized,
    requestDigest: requestDigest(normalized),
    requestedAmountAtomic: normalized.amountAtomic,
    keepFloatAtomic: normalized.keepFloatAtomic,
    feeCeilingAtomic: this.feeCeilingAtomic,
    policyDigest: policy.digest,
  });
  return this.drive(record.operationKey);
}

// Later, while driving an intent:
if (record.state === "intent") {
  const prepared = await adapter.prepare(record, (destination, amount) => {
    this.authorize(operationKey, destination, amount);
  });
}
```

`WalletTreasuryOperationAdapter.prepare` calls that callback and then asks
the wallet to prepare a send; its `submit` method submits the prepared
transaction. The relevant transition at
`src/treasury/operation-adapters.ts:141-174` is:

```typescript
const amount = BigInt(intent.requestedAmountAtomic);
authorize(intent.destination, amount);
const observationStartHash = await chainStartHash(this.wallet);
const prepared = await this.wallet.prepareSend(
  intent.destination,
  amount,
  BigInt(intent.feeCeilingAtomic)
);
// ...
return this.wallet.submitPreparedSend(walletPrepared(envelope));
```

Finally, `src/mcp/server.ts:160-180` exposes `send_payment` to the Agent and
passes its destination and amount into a `wallet_send` Treasury operation.
The policy-file write is not an MCP feature and must come from the attacker's
separate local filesystem capability. Once replacement has happened, however,
the MCP call is the normal supported entrypoint:

```typescript
const result = await requireTreasuryOperations(treasuryOperations).execute({
  operationKey,
  kind: "wallet_send",
  destination: to,
  amountAtomic: amount.toString(),
});
```

The journal preserves the digest and values that Sompi loaded, which is useful
for recovery and accounting but cannot prove who authored those bytes. We can
now state the complete path:

```text
Agent-writable file, target, or ancestor
        │ valid permissive JSON plus changed mtime
        ▼
PolicyEngine path-based hot reload
        │ attacker-selected Policy object
        ▼
durable policy snapshot and authorize()
        │ normal send_payment destination and amount
        ▼
wallet prepare, sign, and submit
```

## Exploitability Analysis

The most reliable route is a persistent substitution, not a timing attack.
Suppose the operator configures `SOMPI_POLICY`, but an Agent-side OS
principal can replace the named leaf or write a target it follows. We first
place or retain a symlink at the configured name and make its target contain a
restrictive valid policy. Sompi starts normally because both path-based reads
follow the target. We then replace the target contents with permissive valid
JSON. The write changes `mtime`; on a coarse-timestamp filesystem we can
wait for the next tick or set a later timestamp. The next direct operation
reloads and authorizes under our values.

That route gives us control over all four policy fields, but not arbitrary
code execution or signing-key bytes. To maximize the useful effect, we choose:

- caps large enough for the intended direct movement;
- an empty allowlist, which makes the destination check inapplicable;
- an approval threshold of zero, which disables that check; and
- a normal positive amount and valid testnet-10 destination so downstream
  validation still succeeds.

Several nearby filesystem routes reach the same primitive:

- If the configured regular file itself is writable, no link is needed.
- If an ancestor directory is writable, an atomic rename can replace the leaf
  with an attacker-owned regular file or symlink. Writing complete JSON before
  the rename avoids the malformed-file denial window.
- If only a followed symlink target is writable, rewriting that target is
  sufficient, as the PoC demonstrates.
- A hard link or a stat/read pathname swap can also confuse the assumed
  identity. Those variants add environmental constraints and are unnecessary
  where persistent substitution is available.

The separate `statSync` and `readFileSync` operations expose a race window,
but racing them is a weaker strategy than persistent control. It can produce
a parse failure, which denies the send, and it offers no advantage once we can
install a stable valid target. Likewise, malformed JSON is a dead end because
the loader records the error and denies every authorization until parsing
succeeds.

The constraints are important. With no configured file, Sompi uses its
in-process defaults and there is no pathname to replace. A root- or
operator-owned regular file under non-writable, non-symlink ancestors, with no
Agent-writable link target, defeats the precondition. Merely calling
`send_payment` does not create file authority. An attacker needs same-host
write or replacement capability outside the structured MCP surface, a funded
Sompi hot wallet, and access to the ordinary Agent tool. If the Agent and
operator share one Unix identity, ownership checks cannot manufacture a
boundary that the deployment itself lacks; the identities must first be
separated.

Successful exploitation affects one Sompi service and the balance available
to its direct wallet path. It acts as a confused deputy: the wallet key remains
inside Sompi, but the signer uses it for a request admitted under
attacker-selected policy. Consensus-vault owner controls do not protect
`wallet_send` from the hot wallet. The reviewed runtime is gated to
testnet-10, and this analysis does not claim mainnet reach.

These facts support medium severity. The authorization consequence is
significant, but likelihood is bounded by a local, deployment-specific
filesystem mistake. The code path is deterministic once that precondition is
met.

## Proof of Concept

The `poc/` directory contains:

- `policy-symlink-reload.mjs`, the executable harness;
- `README.md`, target setup and cleanup notes; and
- `representative-output.txt`, a complete successful run.

Place the report directory beside an affected Sompi checkout, then use only
relative paths:

```sh
cd sompi
git checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm ci
npm run build
node ../policy-file-provenance-bypass/poc/policy-symlink-reload.mjs . 2>&1
```

The harness imports the target's production `dist/policy.js`. It creates a
temporary directory, writes a restrictive mode-`0666` policy target, and
configures `PolicyEngine` with a symlink to it. It asks the engine to
authorize 100 sompi to `kaspatest:attacker`, rewrites the same target with
the permissive policy, advances its timestamp, and repeats the identical
request. It removes the directory in a `finally` block.

The run against the reviewed build produced:

```text
sompi: policy reloaded from <temporary-directory>/operator-policy.json
{
  "target": {
    "packageVersion": "0.8.0",
    "exactPolicySourceMatch": true,
    "exactPolicyModuleMatch": true
  },
  "configuredPathIsSymlink": true,
  "followedTargetMode": "666",
  "before": {
    "allowed": false,
    "name": "PolicyViolation"
  },
  "after": {
    "allowed": true
  },
  "activePolicy": {
    "maxSompiPerTx": "1000",
    "maxSompiPerHour": "1000",
    "allowlist": [],
    "requireApprovalAboveSompi": "0"
  },
  "reproduced": true
}
[+] restrictive denial became authorization after policy replacement
```

The exact built module hash was
`35c1d63d8e83c46b843284391b4bcb61e6e07c20f1fbeeb9e4622ad119da7305`,
and the corresponding source hash was
`f0ff964134f662238e787c521806b4441483fb664f87cdcccf0c202b153f0f57`.
The PoC stops at authorization; it intentionally does not exercise a wallet or
network side effect.

On a fixed target, construction should reject the symlink or insecure
descriptor, or a later reload should keep the same request denied. The harness
prints `reproduced: false` and exits nonzero in either case. It creates no
persistent state, so no manual cleanup is required.

## Remediation

The invariant to restore is simple to state: every policy byte used for
authorization must come from a filesystem object controlled by an explicitly
trusted operator identity, and the exact object that passes provenance checks
must be the object that is parsed. A path string and an earlier `stat` result
are not sufficient.

As an immediate deployment control:

- run the operator and Agent/MCP under distinct OS identities;
- place the policy under a root- or operator-owned directory that the Agent and
  Sompi service cannot modify;
- reject symbolic links and use a regular, single-link file with no group or
  other write bits;
- make the file read-only to the service, using a read-only bind mount or
  service-manager filesystem restrictions where practical; and
- disable hot reload until the runtime validates provenance on every load.

The minimal loader should open with no-follow semantics, inspect the opened
descriptor, and read from that same descriptor. An expected operator UID must
come from trusted launch configuration and must not default to the Agent or MCP
UID:

```typescript
function readTrustedPolicy(
  policyPath: string,
  trustedPolicyUid: number
): Policy {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new PolicyViolation("platform cannot enforce no-follow policy reads");
  }

  const fd = fs.openSync(
    policyPath,
    fs.constants.O_RDONLY | noFollow
  );
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== trustedPolicyUid ||
      (before.mode & 0o022) !== 0 ||
      before.size > 64 * 1024
    ) {
      throw new PolicyViolation("policy file provenance is not trusted");
    }

    const raw = fs.readFileSync(fd, "utf8");
    const after = fs.fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new PolicyViolation("policy file changed while being read");
    }
    return parseAndValidatePolicy(raw);
  } finally {
    fs.closeSync(fd);
  }
}
```

This fragment blocks the demonstrated final-component symlink and writable
mode-`0666` target while removing the path-based stat/read split. The
production fix should also validate the complete ancestor chain under an
operator-owned trust root. A sequence of `realpath` or `lstat` checks is
still raceable; the strongest design pins a trusted directory descriptor and
resolves beneath it with component-wise no-follow semantics, using a small
native helper such as `openat2` on Linux if Node cannot express the required
resolution guarantees.

Hot reload should either be removed in favor of an explicit operator restart
or redesigned so every reload reopens, revalidates, and parses one descriptor.
Comparing a digest of validated bytes is preferable to treating `mtime` as
identity. Any provenance failure, identity change, partial update, or parse
error must keep authorization closed and must not retain a newly supplied
policy.

Regression coverage should include:

- a final-component symlink to both permissive and restrictive targets;
- a mode-`0666` file, owner mismatch, group-writable file, non-regular file,
  and multiple-link file;
- writable and symlinked ancestor components;
- atomic leaf replacement and a swap between metadata inspection and read;
- replacement with the same timestamp and replacement with a new inode;
- malformed or oversized input, confirming continued fail-closed behavior; and
- a positive operator-owned update proving that legitimate policy replacement
  still works if hot reload is retained.

## Summary

Sompi correctly keeps direct wallet authorization below the Agent in its
logical architecture, but revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a` does not establish that the
filesystem object supplying that authorization belongs to the operator. We
followed the configured pathname through lexical resolution, symlink-following
startup and reload reads, policy evaluation, durable Treasury execution, and
the Agent-facing wallet tool.

The included PoC used the production policy engine to show a restrictive
denial becoming an authorization after a mode-`0666` symlink target was
rewritten. The demonstrated primitive is bounded by a same-host
write/replacement precondition, a funded testnet wallet, and the normal direct
tool surface; it does not expose credentials or create remote file access.

Restoring the boundary requires more than documenting `/etc/sompi`
permissions. We should bind each policy load to a descriptor whose owner,
mode, type, link count, size, and resolution path are trusted, and we should
keep hot reload closed on every identity or provenance failure. Further
variant analysis should concentrate on ancestor replacement and reload
identity, because those are the places where pathname-based checks most often
reintroduce the same authority confusion.
