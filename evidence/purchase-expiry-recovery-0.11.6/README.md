# Purchase expiry and staging recovery

Date: 2026-07-20

Purchase `pur_YvcF1tum0LGGEaOfBjzLpw` used a 60-second standard-native offer
from `demo.kaspa-x402.org`. Human approval completed with about 10 seconds of
offer lifetime remaining. Sompi submitted the Treasury staging transaction,
observed it after the Checkout expired, and correctly refused to submit the
Merchant payment.

The staging transaction was accepted on Testnet-10:

- transaction: `34a0fc7d4cdee06fa73dc403c1d852ab3cb9e15ffca09b3cd07f08e0713446af`;
- staged output: `34a0fc7d4cdee06fa73dc403c1d852ab3cb9e15ffca09b3cd07f08e0713446af:0`;
- staged amount: `0.22 tKAS`.

No Merchant payment or fulfilment occurred. The immutable recovery transaction
returned the remaining staged value to Sompi:

- transaction: `64703a37cf9fbe8416798f25bd117eac71fa8609fda8ad6ef227179b03a9aa2d`;
- returned amount: `0.21 tKAS`;
- staging plus recovery fees: `0.0655027 tKAS`;
- finality: depth-confirmed;
- reservation: released;
- pending wallet balance after recovery: `0 tKAS`.

Both transaction bodies and accepted-chain anchors were independently read
from `api-tn10.kaspa.org` after recovery.

The `0.11.6` fix reserves 30 seconds of a single-transaction offer for staging
and first Merchant submission. Authority expires at that earlier boundary, so
a late approval cannot start staging. It also distinguishes temporarily
uncorroborated candidate absence from malformed partial evidence during
staging recovery. A fully recovered purchase with no Merchant payment now
ends as `expired`, allowing a later explicit user instruction to obtain fresh
terms without weakening replay protection for unresolved payments.
