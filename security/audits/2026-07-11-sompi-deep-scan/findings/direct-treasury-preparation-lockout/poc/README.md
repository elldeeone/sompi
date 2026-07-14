# Direct Treasury preparation lockout PoC

This local-only harness invokes the real registered `send_payment` and
`treasury_operation_recover` handlers, production direct-Treasury module,
wallet adapter, journal, policy engine, and pinned Kaspa SDK. It replaces the
Kaspa RPC client with a deterministic in-process fixture, so it neither uses a
live node nor submits a transaction.

## Requirements

- Node.js 22 or newer.
- A clean checkout of Sompi revision
  `4ebb82d4f82bac46ae3addd112c4752f29630a8a`.
- The checkout must have its exact dependencies installed and TypeScript
  output built.

From this report directory, prepare a disposable target beside `poc/`:

```sh
git clone https://github.com/elldeeone/sompi.git target
git -C target checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm --prefix target ci
npm --prefix target run build
git -C target status --short
```

The last command should print nothing. Run the PoC with relative paths:

```sh
cd poc
node reproduce.mjs ../target
```

The pinned SDK may print its handled address-parser panic hook to stderr. The
single JSON line on stdout is the result. It should match the facts in
`expected-output.txt`: the MCP field schema accepts the destination, the
operation remains `intent` across restart, 110 units of capacity remain
reserved, a second operation is blocked, and no submission occurs.

The script creates a temporary wallet, policy file, and SQLite journal under
the operating system's temporary directory and removes them on exit. It does
not modify the target checkout. No Testnet-10 funds or credentials are needed.
