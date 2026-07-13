# Proof of concept

This local-only harness exercises Sompi's production
`TerminalAuthorityApprovalPrompt`. It queues 128 approval ceremonies, leaves
the first unanswered, and verifies that none of the returned promises settles
and that the second ceremony never renders. The harness uses in-memory streams
and the implementation's test-only non-TTY option.

It does not open the authority Unix socket, use an IPC MAC, parse a Merchant
Checkout, contact an RPC, or submit a transaction. The component proof is
therefore safe to run on a developer machine. It demonstrates the queue's
head-of-line behavior; the accompanying report traces reachability from the
authenticated authority endpoint through the production service and runtime.

## Requirements

- Node.js 22 or a compatible later release
- npm
- Git

## Build and run

From the directory containing the report and `poc/`, create the exact affected
checkout as `target/`:

```sh
git clone https://github.com/elldeeone/sompi target
git -C target checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm --prefix target ci
npm --prefix target run build
cd poc
node reproduce.mjs
```

`reproduce.mjs` loads `../target` by default. To use another relative checkout
or build location, set `SOMPI_TARGET`, for example:

```sh
SOMPI_TARGET=../../sompi node reproduce.mjs
```

On the affected revision, the script reports 128 queued promises, zero settled
promises after the observation interval, and only the first rendered
ceremony. A fixed implementation should bound admission and give each queued
and active prompt a cancellation signal and deadline. The corresponding
regression test should abort the first request and observe the next legitimate
ceremony render promptly.

## Cleanup

The harness destroys its in-memory streams before exit and creates no state.
If the checkout was created only for this reproduction, return to the report
directory and remove it:

```sh
cd ..
rm -rf target
```
