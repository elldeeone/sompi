# Purchase Journal contract

Status: Phase 2 implementation contract

The Purchase Journal is Sompi's durable source of truth for Purchase state,
treasury capacity, prepared execution, external-effect ambiguity, evidence, and
recovery coordination. It does not perform AP2 verification, x402 parsing,
Kaspa submission, Merchant requests, or Agent-facing projection.

## Durable storage

For a journal at `purchase.sqlite`, the default storage set is:

- `purchase.sqlite`: SQLite workflow facts, mode `0600`;
- `purchase.sqlite.evidence/`: immutable protocol evidence, directory mode
  `0700`, content files mode `0600`;
- `purchase.sqlite.prepared/`: immutable bytes required to execute or replay an
  effect, with the same secure modes.

SQLite uses WAL, `synchronous=FULL`, foreign keys, `trusted_schema=OFF`, a busy
timeout, an application identifier, migration checksum, and schema fingerprint.
The containing directory must be owned by the current user and inaccessible to
group or other users.

Evidence and prepared bytes are content-addressed. The database retains only
their SHA-256 digest, exact byte length, and relative storage reference. Every
security-sensitive use rereads and rehashes the file.

## Durable facts

The schema separates facts that must not be conflated:

- Purchase state and append-only transition history;
- immutable Evidence Attachments and append-only verification facts;
- immutable policy snapshots and one active snapshot;
- Treasury Reservations and their capacity state;
- Payment Attempts and append-only transition history;
- immutable payment preparation, including exact amount, asset, network,
  payee, required finality, transaction identity, and prepared bytes;
- planned effects, execution claims, submission acknowledgements, and
  append-only observations;
- immutable observed treasury spends;
- monotonic recovery leases and typed reconciliation records.

Prepared payment material, evidence, transitions, observations, policy
snapshots, and spends have no update or delete path. SQLite triggers reject
mutation of immutable fact tables.

## Effect state contract

```text
planned -> executing -> submitted -> observed
              |             |
              +-> ambiguous-+
                     |
                     +-> retryable -> executing
                     +-> observed
                     +-> failed_terminal
```

- `planned` means the effect is durable but has never been claimed. The normal
  executor may claim it once.
- `executing` is committed before any external call. A crash in this state is
  ambiguous, even if no local submission acknowledgement exists.
- `submitted` means an external acknowledgement digest was recorded. It is not
  Settlement.
- `ambiguous` requires observation; it is never blindly retried.
- `retryable` requires an append-only, proof-bearing not-found observation.
- `observed` requires an immutable result digest. Payment effects reach it only
  in the same transaction that records the observed treasury spend.
- `failed_terminal` cannot be automatically retried.

An effect claim has its own lease and generation. Recovery cannot inspect or
change an effect while that executor fence remains live. Once the claim expires,
the global recovery lease may record observations. A stale generation cannot
write, even if its network call later returns.

## Payment submission transaction

`beginPaymentSubmission` is the only payment-effect claim operation. One
immediate SQLite transaction:

1. verifies the active policy and unexpired Treasury Reservation;
2. verifies immutable preparation bytes against their digest and reference;
3. checks the effect references that exact preparation;
4. changes the Reservation from `active` to `in_flight`;
5. changes the Payment Attempt from `prepared` to `submitted`;
6. changes the effect from `planned` or proof-backed `retryable` to
   `executing` and records its fencing generation.

Only after this transaction commits may an adapter perform the external call.
An `in_flight` reservation never expires automatically.

## Reservation and spend accounting

Reservations use one persisted policy snapshot rather than caller-supplied
limits. A reservation records exact payment amount, bounded additional-cost
ceiling, payee, expiry, policy digest, and—when required—the exact verified
authorization evidence/profile/verifier.

Capacity is calculated as:

```text
active unexpired reservation ceilings
+ all in-flight reservation ceilings
+ actual observed spends inside the rolling policy window
```

The reservation ceases to count only when an immutable spend replaces it or a
proof-backed not-found result permits abandonment. Spend finalization requires
exact equality with the immutable preparation for amount, asset, network,
payee, transaction identity, and required finality. Actual additional cost may
be lower than, but never exceed, its ceiling.

## Recovery rules

- A live executor is reported as `executor_active`; recovery does not call its
  observer.
- A planned effect is reported as `ready_to_execute`, not “safe to retry”. The
  reconciler does not execute it.
- An executing, submitted, or ambiguous effect requires its registered
  observer after the executor fence expires.
- A retryable effect retains its in-flight capacity until the Purchase module
  either reclaims the same immutable payload or abandons it using the recorded
  not-found proof.
- A submitted Payment Attempt cannot be failed by the generic failure API.
  Only compound proof-backed reconciliation may fail it and release capacity.
- Reconciliation returns typed per-effect decisions and stores the same facts
  durably for later Purchase recovery.

## Startup validation

Every open fails closed unless all of the following pass:

- SQLite integrity and foreign-key checks;
- supported application and schema versions;
- migration checksum and exact schema fingerprint;
- Purchase and Payment Attempt current state replayed from immutable history;
- cross-table consistency among reservations, preparations, effects, spends,
  and their terminal states;
- readback and digest verification of every stored Evidence Attachment and
  prepared artifact.

No automatic reset, destructive repair, legacy JSON import, or compatibility
reader exists.

## Secret boundary

The journal accepts bounded codes, canonical facts, digests, and secure
references. It has no arbitrary transition-metadata or raw-error field.
Authority and wallet private keys must never be supplied as evidence or
prepared material, and are never stored in SQLite plaintext or emitted by the
reconciler.

## Verification gate

The Phase 2 suite covers transaction rollback hooks, abrupt `SIGKILL` before
and after commit boundaries, external-success-before-local-record recovery,
prepared/submitted/settled/fulfilled/receipted restart states, evidence and
prepared-byte tampering, stale fencing generations, semantic/schema/page
corruption, and real multi-process reservation and effect-claim races.
