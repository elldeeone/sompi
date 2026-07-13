# Authority pre-authentication socket exhaustion PoC

This harness demonstrates unbounded partial-frame retention in Sompi revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a`. It imports the revision's compiled
`AuthorityUnixServer`, starts it on a private temporary Unix socket, and never
contacts a configured authority service.

## Safety

Run this only against a disposable local build. The default count is a bounded
128 clients, and the script refuses counts above 4096. Every client, server, and
temporary directory is cleaned up automatically. Do not adapt the harness to a
live service: an unbounded connection count can deny approvals or exhaust the
host's resources.

## Requirements

- A Unix-like host with Unix-domain sockets
- Node.js 22 or later
- A compiled checkout of the affected revision

One convenient sibling layout is:

```text
target/
authority-preauth-socket-exhaustion/
  poc/
```

Build the target and run the proof with relative paths:

```sh
git clone https://github.com/elldeeone/sompi.git target
cd target
git checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm ci
npm run build

cd ../authority-preauth-socket-exhaustion/poc
node poc.mjs --target-dist ../../target/dist --count 128
```

The Makefile provides the same command:

```sh
cd poc
make TARGET_DIST=../../target/dist COUNT=128
```

## Expected result

The first JSON record reports that every incomplete, unauthenticated client is
retained while the request handler remains unused. The second reports that
periodic partial bytes keep a socket alive for longer than its configured
inactivity timeout. See `representative-output.txt` for an example.

A fixed target should enforce an aggregate pre-authentication ceiling and an
absolute frame deadline. Once those controls are present, the script should
exit with an assertion error instead of reporting both vulnerable states.

No manual cleanup is required. The process removes its private temporary
directories in `finally` blocks.
