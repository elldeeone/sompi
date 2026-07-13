# Single-RPC absence recovery race PoC

This local harness exercises Sompi's real compiled staging-recovery observer,
classifier, and submitter against revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a`.

It creates two deterministic fake Kaspa RPC views:

- an alternate view where the immutable exact Merchant transaction is already
  observed; and
- the configured view where the same transaction and the recovery transaction
  are both absent while the staging outpoint still appears unspent.

Only the configured view is wired into `AbandonedStagingRecovery`. The harness
then verifies that Sompi emits `safe_to_submit` and invokes the real RPC
submission adapter with the competing recovery transaction.

The fake RPC intercepts submission, so this PoC does not contact a network,
move funds, or broadcast a transaction.

## Requirements

- Node.js 22 or newer;
- a clean checkout at the vulnerable revision; and
- dependencies and `dist/` built in that checkout.

The script verifies SHA-256 hashes of the two vulnerable source files before it
runs. It will fail closed on a different revision.

## Run

Arrange the vulnerable checkout and this report directory as siblings, then:

```sh
cd sompi
git checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm ci
npm run build
cd ../single-rpc-absence-recovery-race/poc
node reproduce.mjs --target ../../sompi
```

Expected output is recorded in `representative-output.txt`.

## Interpretation

The alternate observation shows that the exact candidate can exist in another
network view at the same time the configured node returns internally valid
negative evidence. The vulnerable behavior is the promotion of that one
selected node's snapshot to submission authority. The PoC uses an ordinary
transaction-not-found response, so it does not depend on generic RPC exception
classification.

No cleanup is needed beyond the harness's automatic temporary-directory
removal.
