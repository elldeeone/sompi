# Local reproduction

This PoC shows that Sompi's production `RpcChainObservationSource` accepts
chain membership and confirmed finality fabricated by one RPC object with no
blockchain behind it. It is local and read-only: it opens no socket, loads no
wallet, writes no Sompi state, and broadcasts no transaction.

## Requirements

- Node.js 22 or newer.
- A source checkout at revision
  `4ebb82d4f82bac46ae3addd112c4752f29630a8a`.
- Dependencies installed and the TypeScript source built in that checkout.

## Build and run

Build the target source:

```sh
cd relative/path/to/sompi
git checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm ci
npm run build
```

Then run the PoC from this directory. `SOMPI_SOURCE_ROOT` may be any relative
or absolute source-root path; the artifact itself embeds no machine-specific
path.

```sh
cd relative/path/to/report/poc
SOMPI_SOURCE_ROOT=relative/path/to/sompi node reproduce.mjs
```

The source-root path may instead be passed as the first argument:

```sh
node reproduce.mjs relative/path/to/sompi
```

Expected output is stored in `representative-output.txt`. On the vulnerable
revision, the final JSON line reports `acceptedFabrication: true` with
`observed` and `confirmed`. A fixed implementation should reject the call
because there is no independent chain evidence.

## Safety and cleanup

The fake RPC is an in-memory JavaScript object. No public or private service is
contacted, and the PoC changes no target state. No cleanup is required.

The PoC isolates the decisive chain-observation primitive. It does not create a
Purchase, impersonate a Merchant, write the journal, or attempt the conditional
delayed-broadcast route described in the report.
