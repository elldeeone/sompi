# Policy-file provenance bypass PoC

This harness loads Sompi's production `PolicyEngine` from a built checkout.
It gives the engine a configured path that is a symlink to a mode-`0666`
file. The file initially contains a restrictive policy. The harness then
rewrites the followed target with valid permissive JSON, advances its
modification time, and repeats the same authorization request.

The harness does not create a wallet, sign a transaction, call MCP, or contact
a Kaspa node. It only exercises the policy boundary in a temporary directory,
which it removes before exiting.

## Requirements

- Node.js 22 or newer.
- A POSIX-like filesystem with symbolic-link and Unix mode support.
- A built Sompi checkout. The exact validated target was revision
  `4ebb82d4f82bac46ae3addd112c4752f29630a8a`, whose package metadata reports
  version `0.8.0`.

For portable relative commands, place this report directory next to the Sompi
checkout:

```text
workspace/
├── sompi/
└── policy-file-provenance-bypass/
```

Then run:

```sh
cd sompi
git checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm ci
npm run build
node ../policy-file-provenance-bypass/poc/policy-symlink-reload.mjs . 2>&1
```

The harness prints hashes for `src/policy.ts` and `dist/policy.js`. For the
validated revision, both `exactPolicySourceMatch` and
`exactPolicyModuleMatch` are `true`. A vulnerable run first reports a
`PolicyViolation` and then reports `allowed: true` for the identical
destination and amount. See `representative-output.txt` for a complete run.

On a fixed build, the desired result is rejection of the symlink or insecure
file before policy parsing. The harness then prints `reproduced: false` and
exits nonzero. A patch that preserves hot reload may instead accept an
operator-owned replacement only after validating the newly opened descriptor's
owner, mode, type, link count, and identity.

No cleanup is required; the temporary directory is removed in a `finally`
block.
