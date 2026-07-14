# Cleartext Merchant authorization proof

This proof exercises the affected Sompi modules from a built source checkout.
It demonstrates three linked facts without contacting a Merchant or Kaspa node:

1. the real AP2 commerce-authorization adapter accepts two unsigned reflected
   stage responses and synthesizes a verified acceptance artifact;
2. the real egress policy accepts an HTTP Merchant hop after explicit protocol
   and port opt-in; and
3. the same source revision forwards `PAYMENT-SIGNATURE` through a transport
   that selects `node:http` for that hop.

The script does not perform a live man-in-the-middle attack, sign a new
transaction, or broadcast to Testnet-10. It is safe to run offline.

## Requirements

- Node.js 22 or newer;
- a source checkout of Sompi revision
  `4ebb82d4f82bac46ae3addd112c4752f29630a8a`;
- dependencies installed and `dist/` built in that checkout.

From the Sompi checkout:

```sh
git checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm ci
npm run build
```

Then, from this `poc/` directory, pass a relative path to that checkout:

```sh
node reproduce.mjs ../../sompi
```

The command exits non-zero if the adapter rejects the reflected responses, if
HTTP cannot be enabled, or if the payment-header-to-HTTP source chain is absent.
Expected output is recorded in `representative-output.txt`.

No cleanup is required.
