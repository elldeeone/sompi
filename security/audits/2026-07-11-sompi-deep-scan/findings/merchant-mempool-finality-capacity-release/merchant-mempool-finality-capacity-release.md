# Merchant-Controlled Mempool Finality Prematurely Releases Recovery Capacity

## Executive Summary

Sompi revision `4ebb82d4f82bac46ae3addd112c4752f29630a8a`, whose package
metadata identifies it as version `0.8.0`, lets a configured Merchant choose
`mempool` as the finality required for an exact payment. The requirements
verifier accepts that value without applying a Sompi-controlled minimum. The
Trusted Authority neither receives nor displays the decoded choice, and the
staging-recovery adapter later copies it into the durable recovery plan.

This becomes security-significant when Sompi observes its immutable recovery
transaction in a node's mempool while the accepted staging output is still
unspent. The recovery classifier deliberately reports a provisional
`recovery_won` result. Because the Merchant-selected threshold is also
`mempool`, the Purchase Journal treats that provisional result as final: it
records the principal as returned, releases the in-flight reservation, and
terminalizes the Purchase. If the recovery subsequently disappears and the
competing exact payment becomes the one accepted by consensus, the Merchant
has received the payment while Sompi has already made the corresponding policy
capacity available for reuse.

The practical impact is false durable treasury accounting that can permit
later reservations beyond the operator's intended hourly capacity. It is not a
direct key compromise or a conventional double spend. Kaspa's one-spend
consensus rule still prevents the recovery transaction and exact transaction
from both being accepted. The flaw is that Sompi makes an irreversible local
accounting decision before consensus has selected that one winner.

I reviewed revision `4ebb82d4f82bac46ae3addd112c4752f29630a8a`
directly and ran the bundled PoC against a clean build of that revision. The
PoC exercises the real verifier, recovery-plan propagation, provisional winner
classifier, and SQLite Journal release path, including a durable reopen. I did
not reproduce mempool eviction, a later exact winner on a second RPC view, or
reuse of the released capacity; those remain explicit conditions for the full
economic consequence. I found no fixing revision, and I have not established
when the behavior was introduced. This issue is rated **medium severity, P2**:
the accounting impact can be high, but realizing it requires a configured
malicious Merchant and a multi-step network race.

## Background

Sompi's stable security object is a `Purchase`. A Purchase binds Merchant
terms, human authorization, treasury reservation, exact-payment preparation,
chain observations, and recovery into a durable SQLite state machine. The
Merchant is authenticated by its configured signing identity, but remains
semantically untrusted: a valid signature proves who supplied an artifact, not
that every policy choice in that artifact is safe for Sompi.

For the supported Kaspa-x402 exact flow, the Merchant supplies a
`PAYMENT-REQUIRED` artifact. Its digest is bound into the signed Checkout, and
the Kaspa-x402 adapter verifies amount, asset, network, destination, transaction
shape, and other exact facts. One of the artifact's fields is the finality
threshold. Sompi models the three supported levels in
`src/purchase/finality.ts`:

```ts
export const PAYMENT_FINALITIES = ["mempool", "accepted", "confirmed"] as const;

const FINALITY_RANK = Object.freeze({
  mempool: 0,
  accepted: 1,
  confirmed: 2,
});

export function paymentFinalityMeets(actual: string, required: string): boolean {
  const actualFinality = requirePaymentFinality(actual, "actual payment finality");
  const requiredFinality = requirePaymentFinality(required, "required payment finality");
  return FINALITY_RANK[actualFinality] >= FINALITY_RANK[requiredFinality];
}
```

`mempool` is intentionally provisional. Seeing a transaction in a mempool does
not establish that it will be accepted, and the source UTXO may still appear in
the accepted set. `accepted` and `confirmed` represent stronger observations.

The Trusted Authority is a separate, deterministic, human-present process. It
independently verifies Merchant Checkout evidence, displays canonical Purchase
facts, and signs the human's decision. The agentic MCP process does not hold the
authority credential. This separation makes the exact set of displayed and
signed facts important: an opaque digest can bind bytes without informing the
human which decoded policy those bytes select.

Treasury staging adds a second relevant state machine. Sompi can first move
funds to a staging output, then prepare an exact transaction that pays the
Merchant. If execution is abandoned, it also prepares an immutable recovery
transaction returning the staged principal. The exact and recovery
transactions compete for the same input, so consensus can accept only one.
While that race is unresolved, the original policy reservation must remain
charged. It is safe to release principal only after sufficiently strong chain
evidence proves the recovery was the accepted winner.

## Vulnerability Details

We first reach the Merchant-controlled threshold in
`KaspaX402PaymentRequirementsVerifier.assertExactPaymentRequired` at
`src/adapters/kaspa-x402/payment-requirements-verifier.ts:63-86`. The verifier
allows all known enum values, but it does not compare the chosen value with an
operator minimum:

```ts
if (
  parsed.paymentRequired.resource.url !== finalUrl ||
  accepted.scheme !== "exact" ||
  accepted.network !== TESTNET ||
  accepted.asset !== "KAS" ||
  accepted.amount !== terms.amountAtomic ||
  accepted.payTo !== terms.payTo ||
  // ...exact transaction and reservation checks...
  !["mempool", "accepted", "confirmed"].includes(String(accepted.extra.finality)) ||
  !Number.isFinite(checkoutExpiry) ||
  !Number.isFinite(reservationExpiry) ||
  reservationExpiry <= nowMs ||
  reservationExpiry < checkoutExpiry
) {
  throw new Error("PAYMENT-REQUIRED does not match the signed Checkout Terms");
}
```

The Checkout signature and requirements digest prevent an intermediary from
silently changing `accepted` to `mempool`. They do not constrain a configured
Merchant that binds a `mempool` artifact into its signed Checkout from the
outset. Once we carry that authenticated but unsafe value toward authorization,
the next control is incomplete.

`AuthorityApprovalFacts` in `src/authority/protocol.ts:43-70` ends with the
approved additional-cost ceiling and contains no normalized payment-finality
fact:

```ts
export interface AuthorityApprovalFacts {
  // Purchase, Merchant, request, price, payee, expiry, and digest facts...
  readonly checkoutDigest: Sha256Digest;
  readonly purchaseAuthorizationRequestDigest: Sha256Digest;
  readonly purchaseAuthorizationNonceDigest: Sha256Digest;
  readonly purchaseAuthorizationFactsDigest: Sha256Digest;
  readonly additionalCostCeilingAtomic: string;
}
```

Correspondingly, `displayFacts` in
`src/adapters/ap2/human-authority.ts:179-204` renders the Merchant, request,
price, Checkout digest, expiry, and additional-cost ceiling, but not finality.
We therefore get the same trusted display for `mempool` and `accepted` when all
other facts are equal. The human could decode raw protocol evidence out of
band, but the normal approval ceremony does not ask them to do that.

After authorization, `KaspaStagingRecoveryModule.exactRequirement` reparses the
same artifact. At `src/adapters/kaspa-x402/staging-recovery-module.ts:228-251`
it again treats each enum value as valid and returns it unchanged:

```ts
const accepted = parsed.accepted;
const requiredFinality = accepted.extra.finality;
if (
  accepted.scheme !== SCHEME ||
  accepted.network !== NETWORK ||
  accepted.asset !== ASSET ||
  accepted.amount !== input.terms.amountAtomic ||
  accepted.payTo !== input.terms.payTo ||
  accepted.extra.paymentOutputIndex !== 1 ||
  (requiredFinality !== "mempool" &&
    requiredFinality !== "accepted" &&
    requiredFinality !== "confirmed")
) {
  throw new Error("staging recovery payment requirements differ from Checkout Terms");
}
return { requiredFinality };
```

The module places this value in `PreparedStagingRecovery.requiredFinality`, and
the Purchase Journal stores it in `treasury_staging_recovery_plans`. We have
now crossed from Merchant protocol data into durable recovery policy without
an independent Sompi threshold.

The decisive observation occurs in
`AbandonedStagingRecovery.classifyObservation` at
`src/adapters/kaspa-x402/abandoned-staging-recovery.ts:785-800`:

```ts
if (staging.status === "unspent") {
  // The accepted UTXO set can still contain the source while one candidate
  // is only in mempool. That is a provisional explicit winner, not a
  // contradiction.
  if (exact.status === "observed" && exact.finality === "mempool") {
    return conflict("exact_payment_won", evidenceDigest,
      envelope.exactPayment!.transactionId, exact.finality);
  }
  if (recovery.status === "observed" && recovery.finality === "mempool") {
    return recoveryWon(envelope, recovery.finality, evidenceDigest);
  }
  // ...
}
```

Calling this a provisional winner is internally consistent. The vulnerability
appears when the downstream Journal interprets it using the Merchant's equally
provisional requirement. At `src/purchase/journal.ts:2802-2812`, the observation
passes exact transaction, outpoint, and amount checks before the threshold
comparison succeeds:

```ts
} else if (input.status === "recovery_won") {
  if (
    input.winningTransactionId !== plan.recoveryTransactionId ||
    input.recoveryOutpoint !== plan.recoveryOutpoint ||
    input.recoveryAmountAtomic !== plan.recoveryAmountAtomic ||
    !input.winningFinality
  ) {
    throw new JournalInvariantError("staging recovery winner differs from its immutable plan");
  }
  if (paymentFinalityMeets(input.winningFinality, plan.requiredFinality)) {
    this.finalizeTreasuryStagingRecoveryInternal(plan, effect, lease, input, now);
  }
}
```

For `winningFinality = "mempool"` and
`plan.requiredFinality = "mempool"`, `paymentFinalityMeets` returns true. The
finalizer then inserts recovery accounting, updates the reservation from
`in_flight` to `released`, marks the payment attempt failed, and transitions a
recoverable Purchase to `failed_terminal` at
`src/purchase/journal.ts:5082-5186`:

```ts
this.db.prepare(
  `INSERT INTO treasury_staging_recovery_accounting (... finality, ...)
   VALUES (..., ?, ...)`
).run(/* ... */, input.winningFinality, /* ... */);

const released = this.db.prepare(
  `UPDATE treasury_reservations
      SET state = 'released', release_evidence_digest = ?, updated_at_ms = ?
    WHERE id = ? AND state = 'in_flight'`
).run(input.evidenceDigest, now, reservation.id);

// The attempt becomes failed and failed_recoverable becomes failed_terminal.
```

All exact identity and value checks can pass here. The missing invariant is not
transaction binding; it is that a principal-bearing reservation must never be
released from a mempool-only winner observation. The durable terminal state
also means a later network correction does not naturally restore the charged
capacity.

## Exploitability Analysis

The strongest realistic route begins with a configured Merchant that holds its
legitimate signing key. We can have it issue otherwise valid Checkout and exact
requirements with `extra.finality = "mempool"`. No artifact forgery is needed,
and the Merchant directly controls this field. The human sees the correct
price, payee, expiry, Checkout digest, and treasury-cost ceiling, but not the
decoded finality downgrade, so approving the displayed Purchase does not
amount to informed approval of this recovery threshold.

We next need the Purchase to reach abandoned staging. Sompi prepares the
immutable recovery transaction and observes the exact-versus-recovery race.
The selected RPC reports the recovery transaction in its mempool while the
staging outpoint remains unspent in the accepted UTXO set. That is a normal
short-lived network state immediately after broadcast, although a stale,
partitioned, or colluding RPC can make it easier to obtain at a useful time.
The Merchant alone does not control Kaspa consensus, and this dependency is
why the path is not rated as high likelihood.

At this point the deterministic part of the primitive is complete. The
classifier returns `recovery_won` at `mempool`; the Journal compares it with the
Merchant's `mempool` requirement; and the reservation is released. In the
bundled PoC, a reservation charging 70 units of gross capacity falls to 5 units
of recorded recovery costs. The remaining 65 units become available even
though the accepted UTXO view still says the shared source has not been spent.

To turn that accounting error into an overspend relative to policy, the
recovery transaction must then disappear or lose the race, the exact payment
must become the accepted spender in another or later network view, and Sompi
must reuse some of the released capacity. This sequence does not require both
transactions to be accepted. In fact, they cannot be: the exact and recovery
transactions spend the same staging outpoint. The recovery's mempool presence
is only the premature local proof; the exact payment is the eventual consensus
winner. A later Purchase can consume the capacity Sompi incorrectly believes
was returned, while the first Merchant payment is no longer represented in the
policy total.

Several controls meaningfully constrain the attack:

- The Merchant must already be configured and authenticated; this is not an
  arbitrary public request surface.
- Exact amount, network, payee, staging input, recovery output, and transaction
  identity checks prevent redirecting the recovery or substituting unrelated
  bytes.
- The operator's per-payment limit, wallet balance, and other policy controls
  still bound each subsequent transaction.
- Real reliability depends on propagation, eviction, conflicting transaction
  availability, RPC selection, and how quickly released capacity is reused.

Those controls also identify useful dead ends. Replacing the signed
requirements in transit fails the Checkout digest check. Supplying a different
recovery transaction fails immutable-plan comparisons. Attempting to have both
the recovery and exact payment accepted fails at consensus. None of these
barriers repairs the actual primitive, because an authentic unsafe threshold
and a genuine provisional observation are sufficient to release capacity.

A colluding RPC can improve timing by maintaining a tailored view, but it is
not necessary to explain the root cause. Conversely, an honest well-connected
RPC, rapid recovery acceptance, and no competing exact transaction make the
full consequence much less likely. The result is a repeatable, policy-bounded
accounting attack rather than direct theft: one affected reservation per
provisional recovery winner, potentially repeated across Purchases for the same
configured Merchant.

## Proof of Concept

The `poc/` directory contains `reproduce.mjs`, a Makefile, instructions, and a
representative transcript. The script takes a built Sompi checkout by relative
path and first verifies source hashes for the reviewed revision. It then:

1. creates a valid exact `PAYMENT-REQUIRED` artifact with
   `finality = "mempool"` and passes it through the real verifier;
2. checks the reviewed authority-facts and display source blocks to confirm
   that neither contains a finality field;
3. passes the same artifact through `KaspaStagingRecoveryModule.prepare` with
   local adapter doubles and observes `requiredFinality = "mempool"`;
4. calls the compiled recovery classifier with a matching mempool recovery and
   an accepted-set `unspent` staging source, obtaining `recovery_won`;
5. constructs a complete authorized Purchase and in-flight reservation through
   public Journal methods, records that observation, and verifies durable
   release after reopening SQLite.

From the report directory, a checkout placed three levels above can be tested
with:

```sh
cd poc
make check TARGET=../../../sompi
```

No Merchant, Kaspa node, or external network is contacted. The PoC uses a
temporary journal and deletes it automatically. A successful run produces:

```text
[+] exact source hashes match vulnerable revision 4ebb82d4f82bac46ae3addd112c4752f29630a8a
[+] Merchant PAYMENT-REQUIRED with finality=mempool passed verification
[+] authority facts and display omit decoded finality
[+] recovery plan copied requiredFinality=mempool
[+] classifier returned recovery_won at mempool while staging status=unspent
[+] journal state before observation: reservation=in_flight, capacity=70
[+] journal state after observation: reservation=released, capacity=5, purchase=failed_terminal
[+] durable reopen preserved released reservation and recovery accounting
[+] primitive reproduced: provisional recovery released 65 units of policy capacity
[!] not claimed: no dual acceptance or direct theft; one-spend consensus still applies
[!] not exercised: eviction, later exact winner, and capacity reuse
```

I ran this exact command against a clean build of the reviewed revision and
observed the transcript above. The recovery classifier is exercised through
its compiled method with synthetic, exactly matching evidence; this avoids
creating or broadcasting a real recovery transaction while still reaching the
decisive branch. The Journal portion is not a model: it uses Sompi's public
methods and real SQLite transitions. The PoC intentionally stops before the
network-dependent eviction, second-view exact winner, and capacity-reuse
interleaving, and its output states that limit explicitly.

## Remediation

The invariant to restore is straightforward: Merchant-selected finality may be
stricter than Sompi's policy, but it must never weaken Sompi's independent
minimum for releasing principal. The Trusted Authority should also approve the
normalized finality fact that execution will use. A digest binding alone is not
a substitute for displaying that fact.

At minimum, the requirements verifier should reject a Merchant threshold below
an operator-controlled floor, and the Journal should independently enforce the
same or a stronger recovery-release floor. For the current testnet profile,
`accepted` is a reasonable minimum consistent with the existing default
fixtures; deployments may choose `confirmed`. The defensive Journal check is
important even after validation is fixed, because it prevents a future adapter
regression from turning provisional evidence into durable capacity release:

```ts
// payment-requirements-verifier.ts
const SOMPI_MINIMUM_PAYMENT_FINALITY = "accepted" as const;

if (!paymentFinalityMeets(
  String(accepted.extra.finality),
  SOMPI_MINIMUM_PAYMENT_FINALITY,
)) {
  throw new Error("PAYMENT-REQUIRED finality is below Sompi policy");
}

// purchase/journal.ts, before finalizing recovery accounting
const RECOVERY_CAPACITY_RELEASE_MINIMUM = "accepted" as const;
const merchantThresholdMet = paymentFinalityMeets(
  input.winningFinality,
  plan.requiredFinality,
);
const localReleaseThresholdMet = paymentFinalityMeets(
  input.winningFinality,
  RECOVERY_CAPACITY_RELEASE_MINIMUM,
);

if (merchantThresholdMet && localReleaseThresholdMet) {
  this.finalizeTreasuryStagingRecoveryInternal(plan, effect, lease, input, now);
} else {
  this.recordPendingStagingRecoveryFinality(plan, effect, lease, input, now);
}
```

The exact helper name in the final patch can follow the existing Journal
structure; the critical point is that the local release threshold is not read
from Merchant data. A mempool observation should remain pending or ambiguous,
even if it is useful operational evidence.

In parallel, we should add a protocol-neutral `requiredPaymentFinality` field to
the normalized approval facts, display it on the trusted terminal, include it
in the authority facts digest, and compare the authority-approved value with
the verified adapter result before preparation. This keeps x402 wire types at
the execution adapter seam while still making the Purchase security fact
explicit. The operator minimum itself belongs to trusted configuration and
must be parsed, pinned to the supported profile, and fail closed on unknown
values.

Regression coverage should include all of the following:

- a Merchant `mempool` requirement is rejected when the local minimum is
  `accepted`, while `accepted` and `confirmed` remain valid;
- changing only finality changes the authority display and signed facts digest;
- a mempool recovery observed with the staging source still unspent never
  releases a reservation or terminalizes the Purchase;
- an accepted recovery with exact immutable output facts does release it once;
- restart preserves the pending state without weakening the threshold;
- a two-view fixture lets a provisional recovery disappear and an exact
  transaction win later, then proves policy capacity remains charged throughout;
- unknown finality values and missing trusted configuration fail closed.

The recovery accounting row should retain every observation, including the
provisional one, as evidence. What must change is its authority to release
principal. That separation makes later reconciliation and incident analysis
possible without treating a transient mempool event as settled truth.

## Summary

A configured Merchant can authenticate an exact-payment requirement whose
`mempool` finality is valid protocol syntax but unsafe local recovery policy.
Sompi accepts it, omits it from human authorization, copies it into durable
recovery state, and uses it to release an in-flight reservation on a
provisional mempool winner. The bundled PoC demonstrates that complete
deterministic path and shows the released state surviving a Journal reopen.

We do not need, and cannot obtain, two consensus winners. The consequential
sequence is a provisional recovery first, the exact payment as the one later
accepted spender, and reuse of capacity released in between. Enforcing a
trusted minimum at both verification and Journal finalization, while adding
normalized finality to the authority ceremony, restores the intended boundary.
The most valuable follow-up research is a disposable two-RPC end-to-end race
that measures how reliably eviction, the later exact winner, and rapid capacity
reuse can be composed under real Testnet-10 propagation conditions.
