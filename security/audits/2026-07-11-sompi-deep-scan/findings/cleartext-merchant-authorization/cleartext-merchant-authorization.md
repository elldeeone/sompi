# Cleartext Merchant authorization permits forged acceptance and signed-payment capture

## Executive Summary

Sompi package version 0.8.0 at revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a` supports an explicitly
configured cleartext HTTP path for Merchant traffic. On that path, the AP2
commerce-authorization adapter accepts two unsigned JSON responses whose
security-relevant fields merely reflect values that Sompi sent in the request.
The adapter then labels a locally synthesized document as verified Merchant
acceptance. That acceptance allows the Purchase to advance toward Treasury
execution, after which the finalized Kaspa-x402 exact payment is placed in the
`PAYMENT-SIGNATURE` header and sent through the same cleartext transport.

An on-path attacker can therefore forge the Merchant's stage acceptance,
observe the resulting signed transaction, and broadcast that transaction while
withholding the paid resource request from the real Merchant. The practical
result is a policy-bounded, paid-but-unfulfilled Purchase and disclosure of the
authorization and payment artifacts carried on the wire.

This is a **low-severity / P3** issue because HTTPS is the default, HTTP requires
an explicit operator opt-in and an exact host/port allow rule, the current
runtime is limited to Kaspa Testnet-10, and the signed transaction remains bound
to the authorized Merchant payee and amount. The attacker cannot redirect the
payment to another address, recover a signing key, or create arbitrary Treasury
spend.

I reviewed the affected revision directly, ran the included module-level proof
against its clean archive build with Node.js v24.15.0, and reran the five
targeted test files with 33 tests passing. I did not perform a live
man-in-the-middle interception or broadcast a transaction to Testnet-10. No
fixed revision was available for comparison, and I did not determine the first
revision that introduced the HTTP option.

## Background

Sompi's stable security object is a `Purchase`. Its Purchase module binds exact
Merchant terms and human-present AP2 authorization before handing payment
execution to the separate Kaspa-x402 adapter. Merchant and network responses
remain untrusted until they have been cryptographically and semantically
verified. In the affected profile, payment execution is Kaspa-x402 `exact` on
`kaspa:testnet-10`.

The production composition root creates one `EgressPolicy` and one
`NodePinnedHttpTransport`, then gives that transport to both the Merchant
commerce-authorization adapter and the exact-payment adapter. The relevant
shape in `src/runtime/purchase-runtime.ts` is:

```ts
const transport = dependencies.transport ?? new NodePinnedHttpTransport();
const egress = new EgressPolicy({
  allowRules: config.egressAllowRules,
  resolver: dependencies.resolver ?? systemResolver,
  allowedProtocols: config.egressProtocols,
  now,
});

const commerceAuthorization = new Ap2HttpCommerceAuthorizationModule({
  evidenceSource: commerceEvidence,
  transport,
  now,
});

const payment = new KaspaX402ExactPaymentModule({
  // other exact-payment dependencies omitted
  transport,
  settlementVerifier: chainVerifier,
  recoveryObserver: chainVerifier,
  paidResponseVerifier,
  now,
});
```

The egress policy has several worthwhile controls. It uses exact hostname and
port rules, rejects non-public resolved addresses, pins the approved address,
preserves the original HTTP authority, bounds responses, and revalidates
redirects. It also defaults to HTTPS. However, the production configuration
parser deliberately accepts `http:` when the operator opts in. In
`src/runtime/config.ts`, both environment and programmatic configuration reach
this normalization function:

```ts
function parseProtocols(value: string | undefined): readonly EgressProtocol[] {
  if (value === undefined) return Object.freeze(["https:"] as const);
  // JSON parsing omitted
  return normalizeProtocols(candidate);
}

function normalizeProtocols(candidate: unknown): readonly EgressProtocol[] {
  if (
    !Array.isArray(candidate) ||
    candidate.length === 0 ||
    candidate.length > 2 ||
    candidate.some((item) => item !== "https:" && item !== "http:") ||
    new Set(candidate).size !== candidate.length
  ) {
    throw new SompiRuntimeConfigError(
      "SOMPI_EGRESS_PROTOCOLS may contain only unique https: and http: entries"
    );
  }
  return Object.freeze([...(candidate as EgressProtocol[])]);
}
```

This is not an opportunistic downgrade. The operator must both admit `http:`
and allow the corresponding port, and the signed Checkout must identify that
HTTP Merchant origin. Once those conditions hold, though, address pinning does
not provide confidentiality or peer authentication. It only ensures that
Sompi connects to the resolved address it already approved.

## Vulnerability Details

### Unsigned reflected responses become verified evidence

Before contacting the Merchant, the commerce-authorization adapter loads and
checks the verified Checkout and human-present mandates. Those controls prevent
an attacker from changing the Purchase, Merchant, amount, payee, or mandate.
The adapter then sends the Checkout mandate and payment mandate to two
same-origin endpoints. Each endpoint is expected to return a stage-acceptance
document.

The acceptance contains no signature, MAC, certificate-bound proof, or other
Merchant-authenticated value. In
`src/adapters/ap2/commerce-authorization-module.ts`, validation is limited to
canonical shape, reflected request fields, and a timestamp no more than five
minutes in the future:

```ts
function assertStageAcceptance(
  value: Ap2CommerceAuthorizationStageAcceptance,
  request: Ap2CommerceAuthorizationPresentation,
  now: () => number
): void {
  const current = readClock(now);
  if (
    value.profile !== AP2_COMMERCE_AUTHORIZATION_ACCEPTANCE_PROFILE ||
    value.version !== 1 ||
    value.status !== "accepted" ||
    value.stage !== request.stage ||
    value.purchaseId !== request.purchaseId ||
    value.paymentIdentifier !== request.paymentIdentifier ||
    value.checkoutDigest !== request.checkoutDigest ||
    value.mandateDigest !== request.mandateDigest ||
    !Number.isSafeInteger(value.acceptedAtMs) ||
    value.acceptedAtMs <= 0 ||
    value.acceptedAtMs > current + 300_000
  ) {
    throw new Error("Merchant AP2 stage acceptance is differently bound");
  }
}
```

Over HTTPS, the authenticated channel supplies the missing origin proof. Over
HTTP, every field needed to satisfy this predicate appears in the request body,
and the attacker can choose a current `acceptedAtMs`. We can therefore parse
each cleartext request and construct a passing response without possessing a
Merchant credential.

The adapter next hashes the two unauthenticated responses into a new document.
It assigns the configured Merchant identifier as `issuer` and records a local
verifier identifier, even though no cryptographic Merchant verification has
occurred:

```ts
function verifiedAcceptanceArtifact(
  value: Ap2CommerceAuthorizationAcceptance,
  issuer: string
): VerifiedArtifact {
  const bytes = encodeCanonicalJson(value);
  const digest = evidenceDigest(bytes);
  return Object.freeze({
    bytes: Uint8Array.from(bytes),
    mediaType: MEDIA_TYPE,
    profile: AP2_COMMERCE_AUTHORIZATION_ACCEPTANCE_PROFILE,
    issuer,
    declaredDigest: digest,
    verification: Object.freeze({
      verifierId: "sompi:ap2-commerce-http:v1",
      profile: AP2_COMMERCE_AUTHORIZATION_ACCEPTANCE_PROFILE,
      detailDigest: digest,
    }),
  });
}
```

The important distinction is that the exact field comparisons prove
correlation, not authorship. They stop a response for one Purchase from being
substituted into another, but an on-path actor sees all of those correlated
values and can reflect them faithfully.

### The synthesized artifact gates Treasury work

The Purchase coordinator treats the adapter result as the Merchant's durable
acceptance. `ensureCommerceAuthorization()` stores the artifact and marks the
effect observed:

```ts
const result = await this.commerceAuthorization.present({
  context,
  effect: claim.effect,
  egress: await this.createEgressSession(this.persistedIntent(purchase.id)!),
  signal: abortController.signal,
});

this.journal.markEffectSubmitted(activeClaim, result.submissionDigest);
if (result.status === "submitted") return false;
const acceptanceDigest = this.storeVerifiedArtifact(
  purchase.id,
  "merchant-authorization",
  result.acceptance,
  attemptNumber
);
this.journal.recordEffectObservation(effect.id, lease, {
  status: "observed",
  resultDigest: acceptanceDigest,
  detailDigest: acceptanceDigest,
});
return true;
```

The caller immediately uses that `true` result as the gate for Treasury
staging. Durable intent, policy reservation, and exact bindings remain in
place, so this is not an arbitrary-spend primitive. It is nevertheless the
transition that lets forged Merchant acceptance cause a legitimate,
policy-authorized transaction to be prepared and signed.

### The signed payment crosses the same cleartext boundary

The exact transaction builder signs the staging input, finalizes the
transaction, validates its output layout, and serializes it into the payment
payload. `src/adapters/kaspa-x402/exact-transaction-builder.ts` returns:

```ts
const stagingSignature = createInputSignature(
  transaction,
  1,
  privateKey,
  SighashType.All
).toLowerCase();
// signature shape and fee checks omitted
const transactionId = String(transaction.finalize()).toLowerCase();
const artifact = transaction.serializeToSafeJSON();
validateFinalArtifact(artifact, transactionId, input, borrowArgs, stagingSignature);
return Object.freeze({
  transaction: artifact,
  transactionEncoding: KIP10_EXACT_TRANSACTION_ENCODING,
  transactionId,
  paymentOutputIndex: 1,
  payerAddress: input.staging.address,
  fundingSource: FUNDING_SOURCE,
});
```

The exact-payment module rehydrates that immutable payload, encodes it, and
places it in `PAYMENT-SIGNATURE`. Its one-hop send forwards the header and the
original resource body:

```ts
const signatureHeader = encodePaymentSignatureHeader(
  rehydrated.payment.paymentPayload
);

const headers: Array<readonly [string, string]> = [
  [PAYMENT_SIGNATURE_HEADER, signatureHeader],
];
const response = await this.transport.send({
  hop,
  headers: Object.freeze(headers),
  body: Uint8Array.from(context.request.body),
  signal: controller.signal,
});
```

Finally, `src/http/node-pinned-transport.ts` selects the client solely from the
validated hop protocol:

```ts
const client = hop.protocol === "https:" ? https : http;
const outgoing = client.request({
  protocol: hop.protocol,
  hostname: hop.hostname,
  port: hop.port,
  path: `${target.pathname}${target.search}`,
  method: hop.method,
  headers,
  lookup,
  ...(hop.connection.serverName ? { servername: hop.connection.serverName } : {}),
  agent: false,
  signal: request.signal,
}, (response) => {
  // bounded response handling follows
});
```

With an HTTP hop there is no TLS record protection or certificate validation.
The finalized transaction and the resource request are visible to, and
modifiable by, the on-path actor.

## Exploitability Analysis

The strongest practical route is a transparent interception of an operator's
explicitly configured HTTP Merchant:

1. We allow the legitimate signed Checkout to reach Sompi. It already fixes the
   Merchant origin, Testnet-10 network, resource fingerprint, exact amount, and
   payee, so replacing it would add no value and would require the Merchant's
   signing key.
2. When Sompi posts the Checkout-authorization presentation, we read its JSON
   body and return `status: "accepted"` with the same `stage`, `purchaseId`,
   `paymentIdentifier`, `checkoutDigest`, and `mandateDigest`, plus a current
   `acceptedAtMs`.
3. We repeat that reflection for the payment-authorization presentation. Both
   documents pass `assertStageAcceptance()`, and Sompi records the locally
   synthesized artifact as verified Merchant acceptance.
4. We let the workflow advance through the existing human approval, policy
   reservation, Treasury staging, and exact transaction preparation. Those
   controls keep the payment bounded but do not re-authenticate the earlier
   Merchant response.
5. On the paid retry, we copy the `PAYMENT-SIGNATURE` header. The encoded
   payment payload contains the finalized signed exact transaction. We can
   decode and broadcast that transaction, but drop the HTTP request so the real
   Merchant never sees the payment proof or returns the resource.

This route is reliable after the network and configuration prerequisites are
met because it does not depend on a race or secret guessing. The attacker
reflects values that are already on the wire. Repeating the interception can
affect further policy-bounded Purchases directed to the same configured HTTP
Merchant.

A passive-only attacker can still observe the mandate and payment artifacts,
including the broadcastable transaction, but cannot create the forged
acceptance that determines payment timing. An active attacker can also delay or
drop selected responses to force ambiguous recovery, but that is weaker than
accepting the authorization and capturing the resulting payment.

Several tempting escalation paths do not work:

- Changing `purchaseId`, `paymentIdentifier`, either digest, stage, or
  acceptance profile is rejected by the exact comparisons.
- Replacing the Merchant, resource, amount, network, or payee conflicts with the
  signed Checkout, human-present authorization, payment requirements, and final
  transaction validation.
- Changing the transaction after capture invalidates its signatures. The
  attacker cannot redirect value to an attacker-controlled address.
- Address pinning and public-address validation prevent an untrusted request
  from turning this into arbitrary SSRF or a DNS-rebinding path. They do not
  authenticate an already allowed HTTP peer.
- No private signing key travels in the header. Capturing the serialized signed
  transaction grants broadcast capability for that transaction only.
- A normal HTTPS deployment defeats this network path through TLS server
  authentication and confidentiality, assuming the host trust store is sound.

The impact is consequently one policy-bounded Testnet-10 payment at a time,
with the exact approved Merchant still receiving the on-chain output. The harm
is unauthorized payment timing, paid-but-unfulfilled Purchase state, and
evidence disclosure rather than attacker-directed theft.

## Proof of Concept

The accompanying `poc/reproduce.mjs` uses the affected build's real
`Ap2HttpCommerceAuthorizationModule` and `EgressPolicy`. A local transport acts
as the on-path responder and constructs both acceptance documents only from the
cleartext request fields. The script then proves that explicit configuration
admits an HTTP hop and checks the affected source for the
`PAYMENT-SIGNATURE`-to-`node:http` send chain.

The proof is intentionally offline. It does not open a listener, contact a
Merchant, access a wallet, sign a transaction, or broadcast to Testnet-10. To
run it from an unpacked report directory with a sibling Sompi checkout:

```sh
cd ../sompi
git checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm ci
npm run build
cd ../cleartext-merchant-authorization/poc
node reproduce.mjs ../../sompi
```

I ran that proof against the affected archive build. It exited successfully
and produced:

```text
{
  "node": "v24.15.0",
  "unsignedReflectedAcceptances": [
    { "stage": "checkout", "signatureOrMacPresent": false },
    { "stage": "payment", "signatureOrMacPresent": false }
  ],
  "moduleResult": "accepted",
  "synthesizedVerifierId": "sompi:ap2-commerce-http:v1",
  "configuredCleartextHop": {
    "protocol": "http:",
    "authority": "merchant.example",
    "port": 80
  },
  "sourceChain": {
    "paymentSignatureForwarded": true,
    "nodeHttpSelected": true
  },
  "liveMitmOrBroadcastPerformed": false
}
```

The script exits non-zero if the real adapter rejects either reflected
response, if the policy rejects the explicit HTTP configuration, or if the
affected payment-header transport chain is absent. `poc/README.md` contains the
same run requirements, and `poc/representative-output.txt` preserves the full
output. No cleanup is required.

## Remediation

The invariant to restore is straightforward: a Treasury-capable runtime must
never promote Merchant acceptance or transmit a signed payment over a channel
that lacks peer authentication and confidentiality. The safest immediate fix
is to remove HTTP from the production runtime configuration entirely. Because
`normalizeProtocols()` revalidates environment and programmatic configuration,
a minimal cutover can be contained there:

```ts
function normalizeProtocols(candidate: unknown): readonly EgressProtocol[] {
  if (
    !Array.isArray(candidate) ||
    candidate.length !== 1 ||
    candidate[0] !== "https:"
  ) {
    throw new SompiRuntimeConfigError(
      "Purchase runtime egress requires exactly https:"
    );
  }
  return Object.freeze(["https:"] as const);
}
```

The production composition root should also assert `https:` immediately before
constructing the shared egress policy. That defence keeps a future alternate
configuration loader from silently restoring the cleartext path. If local HTTP
is useful for isolated fixtures, it should remain behind a test-only dependency
injection and must not be expressible through production environment or
programmatic configuration.

HTTPS fixes the exploitable channel, but the acceptance artifact should also
be made self-authenticating. We recommend replacing the reflected stage JSON
with a pinned-profile Merchant-signed artifact that binds at least:

- profile and version;
- stage and acceptance status;
- Purchase and payment identifiers;
- Checkout, authorization-evidence, and mandate digests;
- Merchant issuer, key identifier, issued-at time, and expiry or nonce.

The AP2 adapter should verify that signature against the configured Merchant
trust root before constructing a `VerifiedArtifact`. The recorded `issuer` and
`verifierId` should describe that cryptographic verification, not a local hash
of unauthenticated bytes. This deeper change preserves evidence authenticity
even if a future transport or proxy weakens channel assumptions.

Regression coverage should include:

1. environment and programmatic runtime configuration reject `http:` even with
   an exact port-80 allow rule;
2. an HTTP origin in otherwise valid Checkout terms fails before Merchant
   acceptance is persisted or Treasury staging begins;
3. unsigned, wrong-key, expired, cross-stage, and cross-Purchase acceptance
   artifacts all fail closed;
4. the production transport path cannot send `PAYMENT-SIGNATURE` on a non-TLS
   hop; and
5. HTTPS with the correct Merchant signature still completes the existing
   human-present Testnet-10 exact flow.

The existing exact field bindings, address pinning, response limits, policy
reservation, correct-payee checks, and settlement verification should remain.
They materially constrain this issue and provide useful independent layers.

## Summary

Sompi's affected runtime allows an operator to opt into cleartext Merchant
egress, but its commerce-authorization stage relies on unsigned reflected
fields for Merchant acceptance. We showed that the real adapter accepts those
reflections and synthesizes a verified artifact, that the egress policy admits
the configured HTTP hop, and that the subsequent finalized exact transaction
is forwarded in `PAYMENT-SIGNATURE` through `node:http`.

An on-path attacker can use that chain to trigger and capture a legitimate,
policy-bounded Testnet-10 payment without the real Merchant's acceptance or
fulfilment. Exact bindings prevent payee substitution and key theft, while
HTTPS-by-default and explicit operator opt-in keep the issue at low / P3.
Removing HTTP from Treasury-capable runtime composition and cryptographically
authenticating Merchant acceptance restores the intended boundary. Future
variant review should focus on any other adapter-local artifact whose
`VerifiedArtifact` label is derived from correlation checks or transport trust
rather than a durable cryptographic proof of origin.
