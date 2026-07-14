# A single selected Kaspa RPC can fabricate exact-payment inclusion and finality

## Executive Summary

Sompi 0.8.0 at revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a` allows the one Kaspa RPC selected
by the runtime to provide every fact used to decide that an exact-payment
output exists and has reached the requested finality. The adapter checks the
returned transaction ID, outpoint, amount, script, network, and finality rank,
but it derives chain membership, block DAA score, virtual DAA score, and node
health from that same unauthenticated source. These are consistency checks;
they are not independent evidence that the transaction is on the canonical
chain.

The strongest practical route requires two cooperating actors that the Sompi
threat model already treats as untrusted: the selected RPC and the Merchant.
The Merchant receives the legitimate, policy-bounded signed exact transaction,
withholds it instead of broadcasting it, and returns a successful response
bound to that transaction. The RPC then invents a matching UTXO and enough DAA
depth. Sompi can consequently write an observed spend, consume the reservation,
and transition the Purchase to `settled` even though the transaction is absent
from the network. If the inputs remain spendable, the Merchant may later submit
the retained transaction after the false observation has fallen out of Sompi's
one-hour software-policy window.

The issue is **Medium severity / P2** (CWE-345, insufficient verification of
data authenticity). It does not expose a key, change the approved payee, or
allow an arbitrary amount to be signed. The current supported profile is
human-present AP2 v0.2 plus Kaspa-x402 exact on Testnet-10; this report makes no
mainnet-loss claim. Control of an arbitrary Internet host is also insufficient:
the attacker must control the configured or resolver-selected RPC, and a fully
false durable Settlement requires a malicious Merchant response.

I reviewed the exact revision above and executed the local reproduction against
its compiled production `RpcChainObservationSource`. The reproduction uses a
fake in-memory RPC with no blockchain and was accepted as `observed` and
`confirmed`. I did not deploy a malicious Testnet-10 node, contact a public
service, submit a transaction, or exercise the delayed-broadcast consequence.
No fixed revision was available when this report was prepared.

## Background

Sompi's Purchase module separates payment preparation from settlement
verification. After a human-present authorization, the Kaspa-x402 adapter
constructs one exact Testnet-10 transaction whose transaction ID, Merchant
output, payee, amount, funding source, and required finality are persisted
before submission. The prepared payment is sent to the Merchant in the normal
x402 request. A successful `PAYMENT-RESPONSE` is then checked against those
immutable facts.

That Merchant response is intentionally not supposed to be chain truth. The
`KaspaExactChainVerifier` separately asks a `ChainObservationSource` whether
the exact Merchant output exists. The production runtime, however, gives that
seam only one implementation and one wallet RPC:

```typescript
// src/runtime/purchase-runtime.ts:188-199
const chainVerifier = new KaspaExactChainVerifier({
  stagingMetadata: new JournalChainTreasuryMetadataSource(
    canonicalStaging,
    observedStaging,
    now
  ),
  chain: new RpcChainObservationSource({ rpc: wallet, now }),
  merchantResponses:
    dependencies.merchantResponses ?? new AbsentMerchantPaymentResponseLookup(),
  addressCodec: new KaspaTestnet10AddressCodec(),
  now,
});
```

This boundary matters because both relevant external actors are untrusted.
The Merchant controls its HTTP response and may keep the submitted signed
payment. The selected RPC controls outbound wRPC responses and network timing.
Sompi itself holds Treasury execution capability, while the separate Trusted
Authority holds approval credentials; neither arrangement makes Merchant or
RPC claims authoritative.

The surrounding controls are substantial. Before asking the chain source,
Sompi rehydrates the canonical signed transaction and verifies its ID, fixed
two-input/two-output shape, Testnet-10 network, Merchant output index, amount,
script, KIP-10 reservation, fees, staging outpoint, authorization bindings,
and required finality. The Merchant response must report success and echo the
same transaction, amount, network, request hash, output index, template,
reservation, and borrow outpoint. These checks prevent substitution. What they
cannot establish is whether the pinned transaction actually entered canonical
consensus.

The durable policy model also bounds the consequence. Each Purchase is limited
by an operator policy snapshot, including a per-payment cap, a rolling one-hour
cap, an optional payee allowlist, and an optional approval threshold. The
example and default values are 1 KAS per transaction and 5 KAS per hour. A
consensus covenant vault can impose a separate rolling DAA-window cap. The bug
does not bypass those signing-time and covenant limits; it falsifies the
software's later observation and accounting of an already approved payment.

## Vulnerability Details

### From Merchant assertion to chain assertion

We first reach `KaspaExactChainVerifier.verify` after the payment module has
decoded and applied a successful Merchant response. The verifier rechecks the
immutable payment and response, then asks the chain seam for exactly one
observation:

```typescript
// src/adapters/kaspa-x402/chain-verifier.ts:338-390
const parsed = parseExactPayment(
  input.context,
  input.paymentRequired,
  input.paymentPayload,
  input.transactionId,
  this.addressCodec,
  { allowExpired: input.source === "recovery-observer", nowMs: readClock(this.now) }
);
validateSettlementResponse(input.response, parsed);

// Staging fees and complete Treasury bounds are checked here.

const responseFinality = settlementFinality(input.response);
const minimumFinality = strongerFinality(parsed.requiredFinality, responseFinality);
const chainObservation = await this.observeChain(parsed, minimumFinality, deadlineAtMs);
if (chainObservation.status !== "observed") {
  throw error("chain_mismatch", "Merchant exact output is not attested by the Kaspa chain source");
}
validateChainObservation(chainObservation, parsed, minimumFinality, readClock(this.now));
this.recordFinality(parsed, chainObservation.finality);
```

The phrase "attested by the Kaspa chain source" is the missed invariant. In the
runtime, that source is not an authenticated consensus proof or a quorum. It is
one remote node describing its own state.

### One peer supplies the complete proof

Inside `RpcChainObservationSource`, we can carry attacker-controlled values
from `getServerInfo()` directly into the finality decision. The same peer then
claims that the expected outpoint is in its UTXO index:

```typescript
// src/adapters/kaspa-x402/chain-verifier.ts:577-622
const rpc = await raceSignal(this.rpcProvider.client(), request.signal);
const info = await raceSignal(rpc.getServerInfo(), request.signal);
if (
  !info.isSynced ||
  !info.hasUtxoIndex ||
  ![SDK_NETWORK, NETWORK].includes(info.networkId as typeof SDK_NETWORK | typeof NETWORK)
) {
  throw error("source_failure", "Kaspa RPC node is unsynced, lacks the UTXO index, or is not testnet-10");
}

const utxos = await raceSignal(
  rpc.getUtxosByAddresses([request.merchantAddress]),
  request.signal
);
const matches = (utxos.entries as unknown[]).filter((entry) => {
  const outpoint = rpcOutpoint(entry);
  return outpoint?.transactionId === request.transactionId &&
    outpoint.index === request.outputIndex;
});

const entry = requireRecord(matches[0], "Kaspa UTXO entry");
const blockDaaScore = rpcBigInt(
  entry.blockDaaScore ??
    requireRecord(entry.entry, "Kaspa UTXO entry").blockDaaScore,
  "Kaspa UTXO DAA score"
);
const amount = rpcBigInt(
  entry.amount ?? requireRecord(entry.entry, "Kaspa UTXO entry").amount,
  "Kaspa UTXO amount"
);
const script = rpcScriptPublicKey(
  entry.scriptPublicKey ??
    requireRecord(entry.entry, "Kaspa UTXO entry").scriptPublicKey
);
const virtualDaaScore = BigInt(info.virtualDaaScore);
const depth = virtualDaaScore >= blockDaaScore
  ? virtualDaaScore - blockDaaScore
  : 0n;
const finality = blockDaaScore === 0n
  ? "mempool"
  : depth >= this.confirmedDaaDepth ? "confirmed" : "accepted";
```

We control both operands of `depth` when we control the RPC. Reporting
`blockDaaScore = 100` and `virtualDaaScore = 200`, for example, produces a
depth of 100 and therefore `confirmed` under the default threshold of 10. The
code never obtains the accepting block, a membership proof, or a second view
of that outpoint.

The adapter does compare the returned UTXO with the expected immutable tuple:

```typescript
// src/adapters/kaspa-x402/chain-verifier.ts:1095-1111
const wantedOutpoint = `${parsed.transactionId}:${parsed.merchantOutputIndex}`;
if (
  observation.network !== NETWORK ||
  requireHash(observation.transactionId, "chain-observed transaction ID") !== parsed.transactionId ||
  observation.outpoint !== wantedOutpoint ||
  uint64(observation.amountAtomic, "chain-observed Merchant amount", { positive: true }) !==
    uint64(parsed.context.execution.terms.amountAtomic, "Merchant price", { positive: true }) ||
  canonicalScript(observation.scriptPublicKey, "chain-observed Merchant script") !== parsed.merchantScript
) {
  throw error("chain_mismatch", "Kaspa chain observation does not attest the exact Merchant output");
}
if (FINALITY_RANK[finality] < FINALITY_RANK[minimumFinality]) {
  throw error("finality_downgrade", `chain finality ${finality} is below required ${minimumFinality}`);
}
```

Those comparisons are useful, but a colluding Merchant knows every expected
field because it received the prepared payment. We are therefore comparing a
lie with values available to the liar's collaborator. Nothing in this branch
binds the returned UTXO to canonical consensus.

### The false observation becomes durable state

After the observation passes, the verifier emits a verified Settlement detail
digest containing the RPC-supplied Merchant outpoint, amount, script, and
finality. The coordinator treats that result like any genuine observation:

```typescript
// src/purchase/coordinator.ts:1453-1465
const input = this.validatedSettlementInput(purchase, claim.effect.id, settlement);
this.journal.recordObservedSpend(claim.lease, input);
const digest = input.evidenceDigest;
const current = this.journal.requirePurchase(purchase.id);
if (current.state === "submitted" || current.state === "failed_recoverable") {
  this.journal.transitionPurchase(
    purchase.id,
    current.state,
    "settled",
    "kaspa_settlement_verified",
    digest
  );
}
```

`recordObservedSpend` inserts an immutable `treasury_spends` row, changes the
reservation from `in_flight` to `spent`, marks the payment attempt and effect
`observed`, and then permits the Purchase transition above. The journal
correctly rechecks transaction, amount, payee, network, finality, reservation,
and evidence linkage. By this point, however, the false chain claim has already
been wrapped as verifier evidence, so those downstream integrity checks cannot
distinguish it from a real inclusion.

The broken invariant can be stated narrowly: **one untrusted peer must not be
able to provide both the claim that an exact output exists and all data used to
decide that it is final enough for durable Settlement.**

## Exploitability Analysis

### Strongest route: withhold, falsely settle, then delay broadcast

The most consequential route uses the Merchant and selected RPC together:

1. The operator approves a normal exact Testnet-10 Purchase. Sompi persists the
   policy reservation and prepares a signed transaction bound to the approved
   Merchant, amount, request, and KIP-10 reservation.
2. The Merchant receives that valid transaction through the normal x402
   payment request but does not submit it to Kaspa. It returns a syntactically
   valid successful `PAYMENT-RESPONSE` containing the correct immutable fields.
3. The selected RPC reports itself synced, UTXO-indexed, and on Testnet-10. For
   the known Merchant address it returns an invented entry at the expected
   transaction ID and output index, with the exact approved amount and script.
4. The RPC chooses a nonzero block DAA score and a sufficiently larger virtual
   DAA score. We now pass the default ten-DAA `confirmed` threshold without a
   block or chain.
5. Sompi records the Purchase as settled and the reservation as spent. This is
   already a durable integrity violation even if no transaction is ever sent.
6. If the transaction inputs remain live, the Merchant may retain the signed
   transaction until the false `treasury_spends.observed_at_ms` is older than
   one hour. Sompi's software capacity calculation then stops counting that
   row. A later real broadcast can create movement that no longer appears in
   the active one-hour software-policy total.

The last step is conditional rather than demonstrated. The signed transaction
must remain valid, neither input may be spent by another path, and the Merchant
must be able to submit it later. It also remains restricted to the already
approved payee and amount. A covenant vault's on-chain rolling cap still applies
at the earlier staging withdrawal, so this is not a way to mint capacity beyond
consensus rules.

### Immediate integrity impact without delayed movement

We do not need the timing route to prove the security boundary failure. A false
Settlement changes the Purchase state machine, records fabricated evidence,
marks the payment effect observed, and prevents operators from relying on the
journal as a truthful account of network state. Follow-on fulfilment and receipt
logic may proceed from a payment that the chain has never seen. This route has
fewer assumptions: Merchant/RPC cooperation is still required, but no later
broadcast or policy-window timing is needed.

### Constraints and useful dead ends

- **RPC control alone does not manufacture a successful Merchant response.**
  The normal settled path still needs a valid response bound to the prepared
  transaction. This is why the complete false-Settlement route explicitly
  requires a malicious Merchant rather than merely any bad public node.
- **The attackers cannot substitute a payee or enlarge the amount.** The exact
  transaction is finalized and rehydrated locally, authorization facts are
  rebound, fees are checked, and the journal compares the Settlement with the
  immutable preparation. This is not arbitrary signing or key compromise.
- **Node-health flags do not help against a semantic liar.** `isSynced`,
  `hasUtxoIndex`, `networkId`, and `virtualDaaScore` all come from the node whose
  honesty is in question.
- **The explorer drift guard is not an inclusion check.** Resolver-selected
  public nodes are compared with a public explorer's broad DAA score, but an
  unavailable explorer fails open. Explicitly configured nodes are returned
  even when the guard emits a warning. A plausible virtual DAA score still says
  nothing about the specific transaction or output.
- **Present economic impact is intentionally limited.** The code supports
  Testnet-10 and an experimental native-KAS profile. Mainnet safety, autonomous
  authorization, and production Merchant onboarding are outside this release's
  accepted profile.

Once both named actors are under control, the core primitive is deterministic:
the RPC needs no blockchain, race, or cryptographic forgery. It only needs the
expected tuple and two chosen DAA scores.

## Proof of Concept

The accompanying PoC exercises the production `RpcChainObservationSource`
directly. It creates an in-memory object with the narrow wRPC methods used by
the adapter. There is deliberately no node, blockchain, socket, DNS lookup, or
HTTP request behind that object.

The fake RPC returns:

- self-reported synced, UTXO-indexed Testnet-10 state;
- a UTXO whose outpoint, amount, and script match the immutable request;
- `blockDaaScore = 100` and `virtualDaaScore = 200`;
- an assertion that the mempool path must never be reached.

We then call `observeExactOutput` with a required finality of `confirmed`. The
PoC asserts that the production adapter returns `status: "observed"` and
`finality: "confirmed"`, and that it made only the two attacker-backed calls.

Build the vulnerable revision first, then point the portable PoC at that source
root. The path can be relative:

```sh
# In the Sompi source checkout
git checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm ci
npm run build

# In this report directory
cd poc
SOMPI_SOURCE_ROOT=relative/path/to/sompi node reproduce.mjs
```

Representative output is also included in `poc/representative-output.txt`:

```text
[+] loaded Sompi RPC observation adapter
[+] fake RPC calls: serverInfo=1 utxos=1 mempool=0
{"acceptedFabrication":true,"status":"observed","finality":"confirmed"}
```

The PoC is local and read-only. It does not connect to Kaspa, load a wallet,
write Sompi state, or broadcast a transaction, so there is no cleanup step.
It demonstrates the decisive trust primitive, not the malicious Merchant or
journal transitions; those later transitions are established by the source
walk-through above. A fixed implementation should reject the demonstration
because one uncorroborated source cannot satisfy the Settlement invariant.

## Remediation

The required invariant is stronger than validating the shape of an RPC reply:
**no durable Settlement may be derived from chain membership and finality facts
that are all controlled by one untrusted RPC.** Keep every existing immutable
tuple, Merchant-response, fee, deadline, and finality check, then add an
independent authenticity requirement before `KaspaExactChainVerifier.verify`
can return verified evidence.

The strongest design is an inclusion/finality proof checked against locally
verified Kaspa consensus state. If an appropriate proof is not available at the
current protocol seam, a practical first patch is to require corroboration from
independently operated, separately configured observers and fail closed on
absence or disagreement. At least one observer should not share the selected
wallet RPC's resolver, operator, or transport path. A two-source sketch is:

```typescript
class CorroboratedChainObservationSource implements ChainObservationSource {
  constructor(
    private readonly primary: ChainObservationSource,
    private readonly witness: ChainObservationSource,
  ) {}

  async observeExactOutput(request: Readonly<ChainObservationRequest>) {
    const [left, right] = await Promise.all([
      this.primary.observeExactOutput(request),
      this.witness.observeExactOutput(request),
    ]);

    if (left.status !== "observed" || right.status !== "observed") {
      throw new Error("exact output lacks independent corroboration");
    }

    const sameOutput =
      left.network === right.network &&
      left.transactionId === right.transactionId &&
      left.outpoint === right.outpoint &&
      left.amountAtomic === right.amountAtomic &&
      left.scriptPublicKey === right.scriptPublicKey;
    if (!sameOutput ||
        !finalityMeets(left.finality, request.minimumFinality) ||
        !finalityMeets(right.finality, request.minimumFinality)) {
      throw new Error("independent chain observations disagree");
    }

    return left;
  }
}
```

This is a minimal risk-reduction concept, not a substitute for proof validation:
two colluding or operationally dependent nodes can still agree on a lie. The
production configuration should therefore record observer identity and
independence, reject duplicate endpoints, and bind those identities into the
Settlement evidence. For resolver-selected nodes, make external corroboration
mandatory rather than failing open when the reference is unavailable. For
explicitly configured nodes, an off-chain verdict must reject the node rather
than merely warn. A reference DAA score alone is insufficient; corroboration
must address the exact transaction/outpoint and finality.

The coordinator should also require the stronger evidence profile before
calling `recordObservedSpend`. That defence-in-depth check prevents a future
single-source adapter from silently reintroducing the issue at the seam.

Regression tests should cover the real failure path:

1. A single fake RPC returning the exact tuple and arbitrary DAA scores is
   rejected when no independent witness is available.
2. Primary `observed` plus witness `pending`, absent, timed out, or disagreeing
   never creates verified Settlement evidence.
3. Two independent sources that agree on the exact output and required
   finality succeed; disagreement in any tuple field or finality fails closed.
4. A resolver-selected node cannot proceed when exact-output corroboration is
   unavailable, and a configured off-chain node is rejected rather than
   accepted with a warning.
5. An end-to-end test with a malicious successful Merchant response and one
   fabricated RPC leaves the attempt unresolved: no `treasury_spends` row is
   inserted, the reservation is not marked `spent`, and the Purchase is not
   `settled`.
6. Advancing the clock beyond one hour after that rejected observation does not
   release software-policy capacity as though a real spend had been observed.

## Summary

Sompi correctly pins the signed exact transaction to the human-approved
Merchant, amount, request, network, reservation, fees, and finality
requirements. The remaining gap is authenticity: the runtime asks one
explicitly untrusted RPC whether that transaction exists, then lets the same
peer provide every number used to call it confirmed.

We demonstrated that a fake RPC with no blockchain can satisfy the production
observation adapter and return an invented output as `observed/confirmed`.
Combined with a malicious Merchant's valid but false success response, that
primitive reaches immutable spend accounting and a durable `settled` Purchase.
The optional delayed-broadcast route can further separate a later real,
policy-bounded movement from Sompi's active one-hour accounting, but it remains
conditional on transaction validity and timing.

The appropriate Medium/P2 fix is to restore the missing source-authenticity
invariant before durable Settlement: verify canonical inclusion/finality from
locally checked consensus evidence, or at minimum require independently
operated exact-output observers and fail closed on absence or disagreement.
Future work should evaluate which Kaspa proof or trusted-observer design gives
Sompi a stable, auditable chain-evidence seam without turning one remote node's
self-description into consensus truth.
