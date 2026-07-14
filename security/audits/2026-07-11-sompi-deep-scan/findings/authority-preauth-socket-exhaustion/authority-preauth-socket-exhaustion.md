# Unbounded pre-authentication authority sockets allow local approval-service exhaustion

## Executive Summary

Sompi revision `4ebb82d4f82bac46ae3addd112c4752f29630a8a`
(package version `0.8.0`) allows a lower-privilege local process with access to
the Trusted Authority Unix socket to retain an unbounded number of server-side
connections before presenting a complete frame or any authenticated request.
The server adds every accepted socket to a process-wide `Set`, installs several
listeners and a timer, and retains partial frame buffers. It does not first
enforce an aggregate connection limit or an absolute pre-authentication
deadline.

An admitted local process can therefore open many connections, send a partial
frame on each, and hold the resulting authority-process file descriptors and
JavaScript objects. The normal production timeout is 150 seconds of inactivity,
and further partial bytes renew it. At a deployment-specific resource limit,
the authority can no longer accept a legitimate request, so new human-present
Purchase approvals stop until the connections expire or the service is
restarted.

This is a local, availability-only vulnerability with low severity (P3). The
attacker needs operating-system permission to connect to the group-gated Unix
socket. The primitive does not disclose authority credentials, forge a human
decision, access the signing key, or move funds.

I reviewed the affected revision directly and ran the included PoC against its
compiled `AuthorityUnixServer`. It retained 128 of 128 incomplete,
unauthenticated clients while invoking the request handler zero times. I also
confirmed that a drip-fed connection survives beyond its configured inactivity
timeout. I deliberately stopped short of exhausting the test host's descriptor
limit, so the exact failure count remains deployment-dependent. No fixed
revision was available at the time of review.

## Background

Sompi places its human-present Trusted Authority in a process separate from the
Agent-facing MCP process. The two processes run as distinct non-root users. A
dedicated IPC group lets the lower-trust process connect to the authority socket
without granting access to the authority's signing key or permission to replace
the socket. This is a useful credential boundary, but socket members remain
untrusted clients from the authority's perspective.

The authority transport uses one length-prefixed request per Unix connection.
A client is expected to send a four-byte length, the complete request, and then
half-close its side of the connection. Only after that sequence does the
transport call the application endpoint. The endpoint eventually reaches
`AuthorityService.handleDecision`, where `parseAuthorityApprovalRequest`
validates the authenticated request. In other words, connection admission and
partial-frame storage happen before application authentication.

The server's state and configuration in `src/authority/transport.ts` make that
ordering visible:

```typescript
export interface AuthorityUnixServerOptions {
  readonly socketPath: string;
  readonly handle: (authenticatedRequestWire: string) => string | Promise<string>;
  readonly timeoutMs?: number;
  readonly socketGroupId?: number;
}

export class AuthorityUnixServer {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly timeoutMs: number;
  // ...
}
```

There is a per-socket timeout but no maximum connection count, aggregate buffer
budget, or separate pre-authentication deadline. The runtime then applies the
long decision timeout to the transport:

```typescript
// src/authority/transport.ts
export const AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS = 150_000;

// src/authority/runtime.ts
const server = new AuthorityUnixDecisionServer({
  socketPath: paths.socket,
  timeoutMs: AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS,
  // ...
});
```

That 150-second window accommodates a human approval ceremony after a valid
request arrives. Applying the same renewable window to unauthenticated partial
frames creates the resource-retention primitive.

## Vulnerability Details

We first reach `AuthorityUnixServer.accept` in
`src/authority/transport.ts:150-190`. The callback accounts for the new socket
only by placing it in an unbounded set, then immediately allocates its parser
state and timer:

```typescript
private accept(socket: net.Socket): void {
  this.sockets.add(socket);
  socket.setNoDelay(true);
  socket.setTimeout(this.timeoutMs);
  let chunks: Buffer[] = [];
  let total = 0;
  let expected: number | undefined;
  let failed = false;

  // ...
  socket.on("close", () => {
    this.sockets.delete(socket);
    chunks = [];
  });
```

There is no check of `this.sockets.size` before the insertion. Each accepted
client therefore owns one authority-process descriptor, a `net.Socket`, event
listeners, a timer, and a per-connection chunk array regardless of whether it
can construct an authenticated request.

If we now send a length prefix declaring a 100-byte body followed by only one
body byte, the data handler learns `expected = 100`, but none of its rejection
conditions are true:

```typescript
socket.on("data", (chunk: Buffer) => {
  if (failed) return;
  total += chunk.byteLength;
  if (total > FRAME_HEADER_BYTES + AUTHORITY_MAX_WIRE_BYTES) {
    fail();
    return;
  }
  chunks.push(Buffer.from(chunk));
  const buffered = Buffer.concat(chunks, total);
  if (expected === undefined && buffered.byteLength >= FRAME_HEADER_BYTES) {
    expected = buffered.readUInt32BE(0);
    if (expected === 0 || expected > AUTHORITY_MAX_WIRE_BYTES) {
      fail();
      return;
    }
  }
  if (expected !== undefined && total > FRAME_HEADER_BYTES + expected) fail();
});
```

The frame is valid so far, is below both byte ceilings, and remains incomplete.
As long as the client does not half-close, we never reach the `end` listener.
That listener is the first place where the transport requires an exact frame
length and calls `this.options.handle(requestWire)`. Request authentication is
further downstream in `src/authority/service.ts:136-145`:

```typescript
return await this.options.authenticationProvider.withAuthentication(async (authentication) => {
  const request = parseAuthorityApprovalRequest(authenticatedRequestWire, {
    ...authentication,
    replayStore: this.options.replayStore,
    now: this.now,
  });
  // ...
});
```

We can therefore reach the resource sink without a valid MAC, Checkout,
Purchase identifier, or authority message. The operating-system socket mode is
the only admission check needed for this path.

The timeout does not provide an aggregate bound. An entirely idle client lasts
up to 150 seconds in the production composition, which is already ample time to
open a large population. More importantly, `socket.setTimeout` is an inactivity
timer. If we periodically append a byte while keeping the declared body
incomplete and within `AUTHORITY_MAX_WIRE_BYTES`, activity renews that timer.
There is no non-renewable deadline from connection acceptance to a complete
frame.

For `N` partial clients, the authority retains approximately `N` descriptors,
`N` sockets, `N` timers, and `N` parser/listener sets. Frame-size validation
bounds each buffer, but the aggregate remains proportional to attacker-chosen
`N`. Once the process's descriptor limit, memory limit, cgroup limit, or kernel
accept/backlog capacity is reached, a legitimate MCP client cannot obtain an
approval connection. This crosses the intended MCP-to-Authority process
boundary, but only for availability.

## Exploitability Analysis

The strongest practical route is deliberately simple. We need control of a
local principal that the deployment has admitted to the authority socket, such
as a lower-trust process in the shared IPC group. We connect repeatedly and
write a plausible but incomplete length-prefixed frame on every connection.
Because the server inserts the sockets synchronously and has no admission
ceiling, replenishing clients faster than they expire grows the retained set
until an external resource limit intervenes.

An attacker can trade connection churn for a small amount of periodic traffic.
Idle partial frames need to be replaced roughly every 150 seconds. Alternatively,
we can send occasional body bytes beneath the declared length. This keeps each
connection alive beyond the nominal timeout while consuming only a few bytes
per interval. The included probe uses the latter technique with a shortened
test timeout and observes that the socket remains in the real server's retained
set after more than one complete timeout interval.

Several nearby approaches are less useful and clarify the primitive:

- A zero length or a length above `AUTHORITY_MAX_WIRE_BYTES` is rejected as
  soon as the four-byte header is parsed, so an attacker should use a valid
  declared length.
- Sending more bytes than the declared or global frame limit also destroys the
  connection. A small incomplete body is both cheaper and more reliable.
- Half-closing an incomplete connection triggers the `end`-path length check
  and cleanup. The attacker keeps the write side open instead.
- Sending a complete frame moves work toward application parsing and
  authentication. It is unnecessary for this pre-authentication resource sink.

The exact number of clients required to deny service is not universal.
`RLIMIT_NOFILE`, cgroup limits, other authority descriptors, kernel queue
settings, process memory, and restart policy all affect the degradation curve.
The bounded 128-client reproduction proves linear, unchecked retention, not a
particular production outage threshold. A live deployment could also recover
when clients close, time out, or the authority restarts, so the effect is not
persistent.

The scope constraints are significant. There is no TCP listener or remote
network route in this path, and an unrelated local user without socket access
cannot connect. The socket's ownership and mode checks also prevent replacement
attacks. Even after exhausting connections, the attacker has not entered the
request handler, obtained the authority's private key, approved a Purchase, or
altered durable decision state. Those constraints are why this remains a low
severity local denial of service rather than an authorization bypass.

## Proof of Concept

The `poc/` directory contains a dependency-free Node.js harness. It imports
`AuthorityUnixServer` from a build of the affected revision, starts that real
implementation on a private temporary Unix socket, and runs two safe scenarios:

1. `aggregate` opens 128 clients, sends one incomplete frame on each, and
   confirms that the server retains all 128 while the handler remains unused.
2. `drip` declares a longer body, sends one byte periodically, and confirms the
   same connection survives longer than its configured inactivity timeout.

The harness never contacts a configured or running authority service. It
destroys every client, closes the temporary server, and removes its temporary
directory in `finally` blocks. Do not repoint an exhaustion probe at a live
service; this demonstration is intended for a disposable local build.

Place the affected checkout and this report directory beside each other, then
run:

```sh
git clone https://github.com/elldeeone/sompi.git target
cd target
git checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm ci
npm run build

cd ../authority-preauth-socket-exhaustion/poc
node poc.mjs --target-dist ../../target/dist --count 128
```

Equivalently, the provided Makefile accepts the same relative build path:

```sh
cd poc
make TARGET_DIST=../../target/dist COUNT=128
```

A successful run against the affected revision produces output of this form:

```text
{"scenario":"aggregate","unauthenticatedPartialConnections":128,"serverRetainedSockets":128,"configuredTimeoutMs":150000,"handlerInvocations":0}
{"scenario":"drip","timeoutMs":500,"elapsedMs":603,"retainedAfterDrip":true,"handlerInvocations":0}
```

The elapsed value is scheduler-dependent. The assertions require it to exceed
the configured 500 ms timeout while the server still retains the connection.
A corrected implementation should reject connections above its configured
pre-authentication ceiling and destroy the drip-fed socket at a short absolute
deadline, causing the corresponding assertion to fail rather than printing a
vulnerable result.

## Remediation

The invariant to restore is: incomplete, unauthenticated peers must consume a
strictly bounded amount of aggregate authority-process state for a short,
non-renewable period. The long human-decision timeout should begin only after a
complete frame enters authenticated request handling; it must not govern
partial-frame admission.

A minimal transport change should combine a pre-authentication semaphore with
an absolute frame deadline. The following sketch shows the important lifecycle
edges; production code should expose the limits as validated configuration and
record overload metrics without logging request bytes:

```typescript
const MAX_PREAUTH_CONNECTIONS = 32;
const PREAUTH_FRAME_DEADLINE_MS = 2_000;

private preauthConnections = 0;

private accept(socket: net.Socket): void {
  if (this.preauthConnections >= MAX_PREAUTH_CONNECTIONS) {
    socket.destroy();
    return;
  }

  this.preauthConnections += 1;
  this.sockets.add(socket);
  let preauth = true;
  let deadline: NodeJS.Timeout | undefined;

  const releasePreauth = () => {
    if (!preauth) return;
    preauth = false;
    this.preauthConnections -= 1;
    if (deadline) clearTimeout(deadline);
  };
  const fail = () => {
    releasePreauth();
    socket.destroy();
  };

  deadline = setTimeout(fail, PREAUTH_FRAME_DEADLINE_MS);
  deadline.unref();
  socket.on("close", () => {
    releasePreauth();
    this.sockets.delete(socket);
  });

  socket.on("end", () => {
    if (!frameIsCompleteAndBounded()) {
      fail();
      return;
    }
    releasePreauth();
    socket.setTimeout(this.timeoutMs); // long decision window starts here
    void handleCompleteFrame();
  });
}
```

The counter and timer must be released exactly once on every close, parse
failure, timeout, handler transition, and shutdown path. An absolute `setTimeout`
is intentional here: unlike socket inactivity timeout, incoming bytes must not
renew it. The existing frame-size ceiling should remain in place.

A hard cap protects process resources but a continuously admitted local actor
can still occupy all pre-authentication slots. For stronger availability, pair
the cap and deadline with connection-rate throttling, narrow IPC-group
membership, conservative service-level descriptor/cgroup limits, overload
telemetry, and a supervised recovery policy. If uninterrupted service under a
hostile group member is required, move early proof-of-client authentication
ahead of any long-lived socket allocation rather than attempting to reserve an
indistinguishable unauthenticated slot.

Regression coverage should exercise the real Unix transport:

- open `MAX_PREAUTH_CONNECTIONS + 1` incomplete frames and assert that retained
  pre-authentication state never exceeds the cap;
- drip bytes more frequently than the inactivity timeout and assert that the
  absolute pre-authentication deadline still closes the socket;
- submit a complete authenticated frame within the short deadline and confirm
  it receives the separate human-decision timeout;
- cover error, disconnect, server-close, and malformed-frame paths to detect
  leaked semaphore permits; and
- churn hostile partial clients while attempting a legitimate request, then
  measure bounded descriptors, prompt latency, and overload recovery.

## Summary

The Trusted Authority correctly separates credentials from the lower-trust
MCP process, but its Unix transport allocates server-side state before it sees a
complete or authenticated request. Because accepted sockets have no aggregate
ceiling and use a renewable 150-second inactivity timeout, an admitted local
process can retain authority descriptors and parser state until legitimate
human-present approvals become unavailable.

We reproduced the primitive with 128 real partial connections and showed that
drip-fed bytes extend the pre-authentication lifetime. The result is limited to
one authority instance's availability: it does not grant approval power,
credentials, or fund access. A bounded admission semaphore, a short absolute
frame deadline, and separate post-authentication decision timing restore the
missing resource-lifecycle invariant. Deployment limits and sustained-overload
behavior remain useful areas for follow-up testing after the fix.
