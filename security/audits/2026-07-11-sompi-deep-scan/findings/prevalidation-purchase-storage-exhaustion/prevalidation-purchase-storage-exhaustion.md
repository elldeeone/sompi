# Pre-validation Purchase bodies can exhaust Sompi's durable storage

## Executive Summary

Sompi 0.8.0 at revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a` accepts Purchase request bodies
from its untrusted Agent-facing MCP tool and stores them as immutable evidence
before it applies egress policy, contacts a Merchant, or asks the Trusted
Authority for approval. Each body is limited to 1 MiB, but there is no
aggregate byte quota, Purchase-count limit, caller rate limit, or retention
boundary. A caller with an ordinary local MCP session can therefore submit
unique near-limit bodies and unique request keys, choose a destination that is
guaranteed to fail egress validation, and make durable storage grow linearly
without ever reaching Checkout or authority review.

This is an uncontrolled resource-consumption issue (CWE-400), assessed as
**low severity / P3**. It can consume the finite data volume used by one Sompi
instance and eventually deny journal, evidence, Purchase, treasury, or recovery
operations that share that storage. The shipped transport is inherited local
stdio, each call is bounded, and a practical outage requires many calls and
enough time to consume the available capacity. I did not establish a public
network path, host-wide denial of service, unauthorized spending, or secret
disclosure.

I reviewed the exact revision directly and ran the included bounded PoC against
a clean `npm ci` build of it. Three requests that the egress policy rejected
before Checkout left three durable Purchases and three distinct 1 MiB evidence
files. I deliberately stopped at 3 MiB, removed the disposable state after the
measurement, and did not attempt to fill a filesystem or benchmark a deployed
service. No fixed revision was available for comparison.

## Background

Sompi's supported profile treats the LLM, prompts, MCP caller, and tool
arguments as fully untrusted. The Agent may initiate a Purchase, but the
Purchase module, egress policy, Merchant adapter, Trusted Authority, and
treasury controls are supposed to keep that request from becoming an
unauthorized external effect.

The shipped `sompi-mcp` process is not a network listener. `src/index.ts`
constructs an MCP server on an inherited stdio transport:

```ts
const server = createSompiMcpServer(runtime, packageVersion(), treasuryOperations);
const transport = new StdioServerTransport();
// ...
await server.connect(transport);
```

Within that local channel, however, `purchase` is a normal Agent-facing tool.
Its schema allows a fresh request key and a base64 body large enough to encode
1 MiB on every invocation (`src/mcp/server.ts`):

```ts
register(
  "purchase",
  {
    inputSchema: {
      requestKey: PURCHASE_REQUEST_KEY,
      url: z.string().max(2_048).url(),
      method: HTTP_METHOD,
      bodyBase64: z.string().max(1_398_104).optional(),
      // ...
    },
  },
  "PURCHASE_FAILED",
  async (input) => publicPurchaseView(await purchases.purchase(input))
);
```

The thin input adapter correctly enforces canonical padded base64 and a 1 MiB
decoded limit. In `src/mcp/purchase-tools.ts`, that check is strictly per call:

```ts
function strictBase64(value: string): Uint8Array {
  if (value.length === 0 || value.length > 1_398_104 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Purchase body must be canonical padded base64 and at most 1 MiB");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || decoded.byteLength > 1024 * 1024) {
    throw new Error("Purchase body must be canonical padded base64 and at most 1 MiB");
  }
  return Uint8Array.from(decoded);
}
```

Sompi deliberately makes Purchase intent and evidence durable before an
irreversible payment or Merchant side effect. That is an important recovery
invariant. The bug is not that evidence is durable; it is that untrusted input
can allocate that durable, intentionally hard-to-delete state before cheap
admission checks and without any aggregate capacity boundary.

## Vulnerability Details

We first enter `PurchaseCoordinator.purchase`. The coordinator canonicalizes
the Agent's intent and calculates its request fingerprint, but then creates a
Purchase and persists the body before it acquires the coordination lease or
enters the state machine (`src/purchase/coordinator.ts`):

```ts
async purchase(intent: PurchaseIntent): Promise<PurchaseView> {
  const canonicalIntent = canonicalIntentCopy(intent);
  const fingerprint = requestFingerprint(canonicalIntent.resource);
  const purchase = this.journal.createPurchase({
    id: createPurchaseId(this.entropy(16)),
    requestKey: canonicalIntent.requestKey,
    resourceUrl: canonicalIntent.resource.url,
    method: canonicalIntent.resource.method,
    resourceFingerprint: fingerprint,
    // ...
  });
  this.persistRequestBody(purchase.id, canonicalIntent);

  const lease = this.journal.acquireLease(
    `purchase-coordinate:${purchase.id}`,
    this.workerId,
    PURCHASE_COORDINATION_TTL_MS
  );
  // ...
}
```

`createPurchase` inserts a new `purchases` row and its initial transition for
each unique request key. `persistRequestBody` immediately carries the exact
decoded bytes into the evidence path:

```ts
private persistRequestBody(purchaseId: PurchaseId, intent: PurchaseIntent): void {
  const body = intent.resource.body ?? new Uint8Array();
  this.journal.storeEvidence(purchaseId, {
    bytes: body,
    mediaType: intent.resource.mediaType ?? "application/octet-stream",
    profile: REQUEST_BODY_PROFILE,
    issuer: "purchase-intent",
    kind: "purchase-request-body",
  });
}
```

Only after both durable operations does the `created` state call `bindTerms`.
That method constructs its egress session before invoking Checkout:

```ts
private async bindTerms(purchase: PurchaseRecord, intent: PurchaseIntent): Promise<void> {
  const discovered = await this.checkout.discover({
    purchaseId: purchase.id,
    resourceFingerprint: purchase.resourceFingerprint,
    egress: await this.createEgressSession(intent),
  });
  // ...
}
```

This ordering gives us a clean trigger. If we use a syntactically valid URL
whose hostname is not on the exact egress allowlist, `createEgressSession`
throws `EgressPolicyError` with `host_denied`. Checkout is never called, but the
Purchase and its request body already exist. The Purchase remains in its
initial `created` state, so failure does not provide a terminal lifecycle that
could justify or drive cleanup.

The evidence sink compounds the ordering mistake. `EvidenceStore.store` hashes
the bytes, reuses a file only when that exact digest already exists, and
otherwise writes and fsyncs a new file before atomically renaming it
(`src/purchase/evidence-store.ts`):

```ts
const content = Buffer.from(bytes);
const digest = evidenceDigest(content);
const stored = this.referenceFor(digest, content.byteLength);
const target = this.pathFor(stored.storageRef);

if (pathExists(target)) {
  const existing = this.read(digest, content.byteLength);
  // ...
  return stored;
}

// ...
fs.writeFileSync(descriptor, content);
fs.fsyncSync(descriptor);
// ...
fs.renameSync(temporary, target);
fsyncDirectory(this.directory);
```

The journal then inserts `evidence_artifacts` metadata and an `evidence_links`
row for the Purchase. Its schema explicitly rejects updates and deletions of
evidence-artifact rows. We could submit the same body repeatedly and let
content addressing reuse the blob, but a one-byte change gives us a new digest,
a new file, and another MiB of durable growth. A fresh request key simultaneously
bypasses Purchase idempotency.

The bounded reproduction makes the growth concrete:

| Call | Egress result | Checkout calls | Durable Purchase state | Evidence files | Evidence bytes |
|---:|---|---:|---|---:|---:|
| 1 | `host_denied` | 0 | `created` | 1 | 1,048,576 |
| 2 | `host_denied` | 0 | `created` | 2 | 2,097,152 |
| 3 | `host_denied` | 0 | `created` | 3 | 3,145,728 |

The important invariant failure is therefore an ordering and accounting pair:
known-invalid requests reach durable storage before validation, and no global
admission control bounds the state that otherwise-valid repeated requests may
create.

## Exploitability Analysis

The strongest route is intentionally uneventful. We retain a normal local MCP
session, generate a unique request key per call, fill a 1 MiB buffer, vary at
least one byte between calls, and use a hostname that the configured egress
policy will deny. We need no Merchant cooperation, authority credential,
policy approval, wallet key, vault key, successful DNS response, or successful
payment. The rejection happens after the file and journal records are durable,
which makes failures repeatable rather than self-limiting.

Content-addressed deduplication is useful counterevidence but not a practical
aggregate limit. Reusing identical bytes collapses the large blob to one file;
unique Purchase and link metadata still accumulate, but much more slowly. For
the file-growth route we can change one byte, producing a different SHA-256
digest with negligible effort. The per-call base64 and decoded-length checks
also work as intended: they cap a single contribution at 1 MiB, so exploitation
requires repetition rather than one oversized request.

Using an allowed Merchant origin is an alternative path, because persistence
still precedes Checkout validation, but it is less attractive. It introduces
DNS, network, Merchant behavior, and possibly rate limiting when the denied-host
route reaches the same storage sink locally and deterministically. Conversely,
submitting an invalid base64 body or malformed request key is a dead end: the
MCP adapter rejects those values before the coordinator sees them.

The practical time to an outage depends on free blocks and inodes, filesystem
quota, request throughput, fsync latency, and whether an operator notices the
growth. Filling a 100 GiB free volume at 1 MiB per call needs roughly 102,400
successful allocations, and synchronous fsync makes this slower than an
in-memory request flood. External quotas or monitoring may intervene even
though the application does not configure an equivalent control. These
constraints are why the issue remains low severity rather than a claim of an
immediate or remote outage.

If the data volume does reach a resource threshold, later SQLite and evidence
writes can fail, making the Purchase module and workflows that depend on the
same durable state unavailable until an operator restores capacity and safely
repairs or relocates state. We have not shown that the authority service or the
entire host shares this filesystem, so we limit the demonstrated blast radius
to one Sompi data context. The primitive neither reads secrets nor bypasses
authorization, and it does not create an unauthorized treasury movement.

## Proof of Concept

The `poc/reproduce.mjs` program imports the built MCP input adapter,
`PurchaseCoordinator`, `EgressPolicy`, and `PurchaseJournal` from the target
revision. It creates a disposable journal, submits three distinct 1 MiB bodies,
and configures an allowlist that excludes the requested hostname. After each
expected denial it checks the real journal and evidence directory. Checkout is
instrumented to fail the test if it is ever reached.

Build the exact target in a sibling `target` directory, then run the PoC from
this report bundle:

```sh
git clone https://github.com/elldeeone/sompi.git target
git -C target checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm --prefix target ci
npm --prefix target run build
cd prevalidation-purchase-storage-exhaustion/poc
node reproduce.mjs --target ../../target
```

Node.js 22 or newer is required. The default run is deliberately bounded to
three calls and 3 MiB. The script accepts `--calls` values from 1 through 16 for
small local experiments, always removes its temporary journal and evidence
directory, and never contacts a Merchant or public service.

Representative output from the vulnerable revision is:

```text
[+] target package: @elldeeone/sompi 0.8.0
[+] call=1 egress=host_denied purchase=created files=1 bytes=1048576
[+] call=2 egress=host_denied purchase=created files=2 bytes=2097152
[+] call=3 egress=host_denied purchase=created files=3 bytes=3145728
[+] checkout calls: 0
[+] vulnerable behavior reproduced: 3 denied requests retained 3145728 evidence bytes
[+] disposable state removed
```

A repaired target should reject the denied destination before it creates a
Purchase or request-body artifact; the PoC will then exit nonzero because its
vulnerable-state assertions no longer hold.

## Remediation

The invariant to restore is: **untrusted intake must pass reversible admission
checks and reserve bounded aggregate capacity before it creates immutable
Purchase evidence**. Sompi must still commit durable intent before any
irreversible Merchant or blockchain effect, but egress policy validation and
local capacity admission are not such effects.

As a minimal ordering repair for the demonstrated denied-host path, create the
egress session before `createPurchase` and pass that already-validated session
into `bindTerms`:

```ts
async purchase(intent: PurchaseIntent): Promise<PurchaseView> {
  const canonicalIntent = canonicalIntentCopy(intent);
  const egress = await this.createEgressSession(canonicalIntent); // no Merchant request

  const purchase = this.journal.createPurchase({
    id: createPurchaseId(this.entropy(16)),
    requestKey: canonicalIntent.requestKey,
    resourceUrl: canonicalIntent.resource.url,
    method: canonicalIntent.resource.method,
    resourceFingerprint: requestFingerprint(canonicalIntent.resource),
    expectedMerchantId: canonicalIntent.expectedMerchant?.id,
    expectedMerchantOrigin: canonicalIntent.expectedMerchant?.origin,
  });
  this.persistRequestBody(purchase.id, canonicalIntent);
  // Carry `egress` into bindTerms instead of validating after persistence.
}
```

That change closes the exact rejected-host trigger, but it is not a complete
resource policy. We should also reserve evidence bytes and Purchase count in a
transactional global budget before writing the blob, commit that reservation
with the evidence link, and release it on any failed write. Because the stdio
surface does not provide a strong authenticated per-Agent identity, a global
service quota is essential even if per-session rate limits are added. The quota
must account for concurrent processes, evidence files, SQLite/WAL growth, and
metadata; a check based only on a non-atomic directory size is raceable.

For requests that fail before Checkout, we should either retain no body at all
or store only a bounded audit record such as the request key, canonical
destination, body digest, length, and rejection reason. If full failed-request
evidence is a product requirement, define a finite retention tier and an
auditable compaction/checkpoint process rather than silently weakening the
immutability guarantees of accepted Purchase evidence.

Regression coverage should include:

- a denied hostname with a 1 MiB body leaves no Purchase, transition, evidence
  artifact, evidence link, or evidence file;
- unique allowed requests stop at the configured aggregate byte and count
  limits with a stable public quota error;
- identical bodies receive correct deduplication accounting without allowing
  unbounded link or Purchase metadata;
- concurrent workers cannot oversubscribe the same capacity reservation;
- injected file-write, fsync, SQLite, and `ENOSPC` failures release admission
  reservations and leave restart-consistent state; and
- recovery of an already-admitted Purchase does not consume capacity again.

## Summary

Sompi correctly limits each Agent-supplied Purchase body to 1 MiB, but it turns
that bounded input into unbounded durable state by persisting the Purchase and
body before egress validation and by omitting an aggregate quota. We followed
the exact source path from the local MCP tool through `toolIntent`,
`PurchaseCoordinator`, `PurchaseJournal`, and `EvidenceStore`, then reproduced
one MiB of new immutable evidence for every request that failed before
Checkout.

The result is a repeatable local storage-exhaustion primitive against one Sompi
data context. It requires many local calls, finite shared storage, and enough
time to overcome synchronous persistence; identical bodies deduplicate and
host-wide impact remains unproven. Moving reversible rejection ahead of
durability closes the cleanest trigger, while transactional aggregate capacity
and a deliberate failed-request retention policy address the underlying
resource invariant. Further useful work is to measure startup cost at large
Purchase counts and to exercise restart and operator recovery under controlled
`ENOSPC` fault injection.
