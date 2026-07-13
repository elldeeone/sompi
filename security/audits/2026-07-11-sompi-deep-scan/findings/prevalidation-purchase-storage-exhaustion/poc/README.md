# Pre-validation Purchase storage PoC

This bounded local reproduction demonstrates that Sompi persists an untrusted
Purchase body before its egress policy rejects the destination. It uses the
real built MCP input adapter, Purchase coordinator, journal, egress policy, and
evidence store. Checkout is never contacted.

## Requirements

- Node.js 22 or newer
- an `@elldeeone/sompi` checkout at revision
  `4ebb82d4f82bac46ae3addd112c4752f29630a8a`
- dependencies installed and `dist/` built in that checkout

From a directory containing this report directory, prepare a sibling target
and run:

```sh
git clone https://github.com/elldeeone/sompi.git target
git -C target checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm --prefix target ci
npm --prefix target run build
cd prevalidation-purchase-storage-exhaustion/poc
node reproduce.mjs --target ../../target
```

The default run makes three calls and retains 3 MiB only long enough to measure
it. `--calls` may be set from 1 through 16 for bounded experiments:

```sh
node reproduce.mjs --target ../../target --calls 4
```

The script creates a mode-0700 temporary directory, closes the journal, and
recursively removes all disposable state whether the assertions pass or fail.
It does not perform DNS resolution, contact a Merchant, request authority
approval, or submit a payment. No manual cleanup is required.

On the affected revision, each call should report `host_denied` while the
corresponding Purchase remains `created` and evidence bytes increase by exactly
1,048,576. See `representative-output.txt` for a complete three-call run.

A repaired build should reject the destination before allocating a Purchase or
evidence file. In that case the vulnerable-state assertions intentionally fail
and the process exits nonzero after cleanup.
