# Authenticated authority requests can indefinitely block the human approval queue

## Executive Summary

Sompi's human-present Trusted Authority admits authenticated approval requests
without an aggregate in-flight limit, then serializes their terminal ceremonies
behind one Promise chain. Neither the authority transport nor the decision
service can cancel a queued or active ceremony when its client disconnects,
its request expires, its replay lease fails, or the authority begins shutting
down. The terminal's `readline.question` also has no deadline or abort signal.
Consequently, one unanswered ceremony blocks every later human-present
approval on that authority instance, while repeated distinct requests retain
additional promises, request state, and heartbeat timers.

The affected code is in package version 0.8.0. The prompt queue first appears
in commit `52080d1278e8514dbfe453b352d71396d64fee50`, and it remains present in
revision `4ebb82d4f82bac46ae3addd112c4752f29630a8a`. No fixed revision was
available when this report was prepared. I reviewed that exact revision and
executed the included local proof of concept against its compiled production
prompt implementation. I queued 128 ceremonies and observed that, with the
first left unanswered, zero promises settled and only the first ceremony
rendered. I did not run a destructive load against a live two-UID authority or
use real IPC credentials, Merchant artifacts, or Testnet-10 funds.

This is a low-severity, P3 availability issue (CWE-400). The attacker must
control the authenticated `sompi-mcp` context, which legitimately owns the IPC
MAC copy, and must submit valid configured-Merchant Checkout-backed work. One
valid request is enough for head-of-line blocking; sustained queue growth
requires many distinct valid Checkout-backed Purchases. The path is local to
the authority Unix socket and does not let the attacker forge a human decision,
bypass the MAC, obtain authority credentials, or move treasury funds. A trusted
operator can deny the visible request or restart the service, but until then
legitimate approvals behind it are unavailable.

## Background

Sompi deliberately separates its Agent-facing process from the Trusted
Authority. The lower-trust `sompi-mcp` operating-system user can connect to a
group-readable Unix-domain socket and owns a client copy of the IPC MAC key.
The distinct `sompi-authority` user owns the AP2 decision signer and displays
canonical Purchase facts in a trusted terminal. Compromise of the MCP process
is therefore expected to leave signing authority and human consent intact.

The production composition in `src/authority/runtime.ts` makes that boundary
concrete. We can see that the real runtime uses the terminal prompt, wraps it
in the AP2 human decision provider, and then exposes the service through the
Unix decision server:

```typescript
const humanDecision = new Ap2HumanAuthorityDecisionProvider({
  signer,
  trust,
  instrumentId: identity.instrumentId,
  prompt: new TerminalAuthorityApprovalPrompt(),
});
const service = new AuthorityService({
  replayStore: replay,
  decisionStore: decisions,
  authenticationProvider: authentication,
  humanDecision,
});
const server = new AuthorityUnixDecisionServer({
  socketPath: paths.socket,
  timeoutMs: AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS,
  endpoint: new AuthorityDecisionEndpoint(service),
});
```

Before a request reaches that prompt, Sompi verifies a canonical MAC envelope,
freshness, request identity, nonce, and durable replay state. It independently
verifies the Merchant Checkout and exact Purchase facts as well. Those are
important integrity controls: malformed, stale, unsigned, or exact duplicate
messages fail before the terminal. Fresh request IDs, nonces, and digests,
however, intentionally acquire independent replay work. Replay protection is
not an admission-control mechanism for distinct authenticated requests.

Serializing the terminal is also reasonable in isolation. Two simultaneous
`readline` interfaces would interleave facts and answers, undermining the
human-present ceremony. The required invariant is therefore not simply
"allow concurrent prompts." We need one visible ceremony at a time while
ensuring that the queue is bounded and every queued or active item has a
lifetime tied to its authenticated request.

## Vulnerability Details

We first cross the process boundary in `src/authority/transport.ts`. After a
client half-closes a complete one-frame connection, the server launches the
handler asynchronously. The socket's later `close`, `error`, or timeout path
can destroy the transport, but there is no controller or other lifetime object
to cancel the already-started handler:

```typescript
socket.on("close", () => {
  this.sockets.delete(socket);
  chunks = [];
});

socket.on("end", () => {
  // framing checks omitted
  void Promise.resolve()
    .then(() => this.options.handle(requestWire))
    .then((responseWire) => {
      if (failed || socket.destroyed) return;
      const response = encodeFrame(responseWire, AUTHORITY_MAX_RESPONSE_FRAME_BYTES);
      socket.end(response);
    })
    .catch(fail);
});
```

There is also no aggregate handler count around this dispatch. If we carry a
fresh, valid request into `AuthorityService.handleDecision` in
`src/authority/service.ts`, it passes the per-message replay checks and starts
an independent human decision. The service creates a lease-renewal timer and
then awaits the provider:

```typescript
const timer = setInterval(() => {
  try {
    renew();
  } catch {
    // The awaited decision is allowed to finish, but is discarded below.
  }
}, this.leaseHeartbeatMs);
timer.unref();
try {
  const decision = await this.options.humanDecision.decide(
    Object.freeze({
      request,
      recoveryRetry: request.acceptedAtMs >
        request.message.issuedAtMs + this.leaseHeartbeatMs,
      renewLease: renew,
    })
  );
  if (heartbeatError) throw heartbeatError;
  validateHumanDecision(decision);
  return Object.freeze({
    ...decision,
    signedEvidence: Uint8Array.from(decision.signedEvidence),
  }) as AuthorityHumanDecision;
} finally {
  clearInterval(timer);
}
```

The post-await `heartbeatError` check correctly prevents a stale decision from
being persisted or signed. It does not release the Promise while the human
provider is still pending. Request expiry behaves similarly: the AP2 provider
checks expiry before and after prompting, but it cannot make the prompt return
at the expiry boundary. Sompi's normal authority request TTL is 120 seconds
and the socket decision timeout is 150 seconds; neither deadline removes the
ceremony from the terminal queue.

The final transition occurs in
`src/adapters/ap2/human-authority.ts`. Every `approve()` call appends a closure
to `promptTail`, and `approveOne()` waits for terminal input without a signal
or timeout:

```typescript
private promptTail: Promise<void> = Promise.resolve();

async approve(display: AuthorityApprovalDisplay): Promise<boolean> {
  const prompt = this.promptTail.then(() => this.approveOne(display));
  this.promptTail = prompt.then(
    () => undefined,
    () => undefined,
  );
  return prompt;
}

private async approveOne(display: AuthorityApprovalDisplay): Promise<boolean> {
  // trusted-terminal and rendering checks omitted
  const rl = readline.createInterface({ input: this.input, output: this.output });
  try {
    const answer = await rl.question(
      `To approve, type the exact Purchase ID ${asciiJson(display.purchaseId)}; anything else denies: `,
    );
    return answer === display.purchaseId;
  } finally {
    rl.close();
  }
}
```

Suppose request A renders and the operator does not answer it. Request B's
closure is now reachable only after A's Promise settles. Closing A's client
socket does not settle it. Expiring A does not settle it. Losing A's replay
lease records an error that can only be checked after it settles. Destroying
the server sockets during shutdown likewise has no reference to this prompt.
Request B and every later ceremony therefore remain invisible even if they
belong to legitimate Purchases.

At higher volume, each distinct admitted service call contributes more than a
small queue node. It retains its verified request and decision context, the
Promise chain closure, and a heartbeat interval until its turn completes.
The exact memory ceiling and operational exhaustion rate depend on how many
valid Checkouts the compromised MCP can produce and how quickly the operator
responds; the defect itself supplies neither a queue ceiling nor backpressure.

## Exploitability Analysis

The strongest realistic route begins with compromise of `sompi-mcp`, an actor
the architecture already treats as untrusted at the authority boundary. The
attacker uses the MCP process's legitimate client MAC capability and a normal,
valid Checkout from a configured Merchant. We submit a fresh authority request
and allow its ceremony to render, then abandon the connection and leave the
question unanswered. From this point, any legitimate approval that arrives at
the same authority process is chained behind our unresolved Promise.

This route crosses a meaningful security boundary even though it is local.
The attacker does not merely deny service to its own MCP call; work admitted
from the lower-trust UID occupies the separately credentialed authority's one
human approval surface. It can delay unrelated legitimate Purchases until the
operator notices and denies the head request or restarts the authority.
Because transport cancellation is absent, waiting for the client-side timeout
does not restore service. Because expiry is checked only after the question
returns, waiting for the Purchase to expire does not restore service either.

Repeated requests provide a second, more constrained route. With many distinct
valid Checkout-backed Purchases, we can build a serialized backlog. That adds
retained Promises and heartbeat timers, increases manual clearance work, and
can create approval-fatigue pressure. I did not measure heap growth or timer
overhead in a live multi-UID deployment, so this report does not claim a
specific request rate or process-crash threshold. The deterministic primitive
is loss of approval availability; memory exhaustion is a plausible extension,
not a demonstrated outcome.

There is also a non-malicious failure mode worth preserving in the threat
model. A client can disconnect, time out, or crash after the ceremony begins.
The same stale prompt remains at the head of the terminal even when no attacker
is actively maintaining it. A busy operator who waits for the prompt to expire
may reasonably expect the next Purchase to appear, but the implementation does
not make that transition.

Several barriers materially cap severity. The socket is not remotely exposed;
the attacker needs the authenticated MCP identity and valid Merchant-backed
work. The terminal renders canonical, escaped facts and approval still
requires the exact Purchase ID. MAC verification, Checkout verification,
replay fencing, expiry, and the post-prompt lease check remain effective. If
the operator eventually types a denial, the queue advances. Restart also
clears the in-memory prompt chain. Most importantly, an expired or lease-lost
request is rejected after the answer, so occupying the queue does not become a
late signature, an approval forgery, authority-key access, or treasury
movement.

## Proof of Concept

The included `poc/reproduce.mjs` imports the affected compiled production
`TerminalAuthorityApprovalPrompt` and supplies in-memory input/output streams
through its test-only non-TTY option. We issue 128 `approve()` calls, wait for
the first Purchase ID to render, deliberately provide no answer, and inspect
the queue after 50 milliseconds. Assertions require all 128 promises to remain
pending, the first ceremony to be visible, the second to remain invisible, and
exactly one ceremony to have rendered.

From the report directory, build the affected revision and run the harness:

```sh
git clone https://github.com/elldeeone/sompi target
git -C target checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm --prefix target ci
npm --prefix target run build
cd poc
node reproduce.mjs
```

Representative output is:

```text
[+] affected revision: 4ebb82d4f82bac46ae3addd112c4752f29630a8a
[+] queued prompt promises: 128
[+] settled after 50 ms: 0
[+] first prompt rendered: true
[+] second prompt rendered: false
[+] rendered ceremonies: 1
[+] prompt queue remained blocked behind the unanswered first ceremony
[+] no socket, credential, Merchant, RPC, or blockchain operation was performed
```

The 50-millisecond interval is only an observation point, not a claimed
production timeout. There is no implementation event that would settle the
first question later: only terminal input or stream failure can do so. The PoC
directly proves the production queue primitive, while the source walkthrough
above establishes how authenticated transport handlers reach that same class
and why disconnect, expiry, lease loss, and shutdown do not signal it.

The harness does not create files, sockets, credentials, or blockchain state.
It destroys its in-memory streams before exit. Detailed requirements,
alternative target paths, and cleanup for the disposable checkout are in
`poc/README.md`.

## Remediation

The invariant to restore is straightforward: every admitted authority decision
must have one bounded lifetime that follows it across transport, service, AP2
provider, prompt queue, and active terminal question. No queued or active item
may outlive client disconnect, request expiry, replay-lease loss, service
shutdown, or an explicit human-decision deadline. The number of authenticated
in-flight and queued decisions must also have a small fixed ceiling.

We should first propagate an `AbortSignal` through the relevant seams. Node's
promise-based readline API accepts a signal for `question`, so the active
terminal operation can be cancelled without making prompts concurrent:

```typescript
export interface AuthorityApprovalPrompt {
  approve(display: AuthorityApprovalDisplay, signal: AbortSignal): Promise<boolean>;
}

private async approveOne(
  display: AuthorityApprovalDisplay,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const rl = readline.createInterface({ input: this.input, output: this.output });
  try {
    const answer = await rl.question(approvalQuestion(display), { signal });
    return answer === display.purchaseId;
  } finally {
    rl.close();
  }
}
```

The existing Promise tail should be replaced with a small bounded serial queue
whose `enqueue` operation accepts that signal and removes an aborted item even
while it is waiting. The AP2 provider should receive the same signal in
`AuthorityHumanDecisionContext` and pass it to `prompt.approve`. A service-side
controller should abort on replay-lease renewal failure and combine its signal
with the transport signal, service-shutdown signal, request-expiry deadline,
and a deliberately shorter prompt deadline:

```typescript
const signal = AbortSignal.any([
  transportSignal,
  shutdownSignal,
  replayLeaseController.signal,
  AbortSignal.timeout(Math.max(1, request.message.expiresAtMs - this.timestamp())),
  AbortSignal.timeout(MAX_HUMAN_DECISION_MS),
]);

const decision = await this.options.humanDecision.decide({
  request,
  recoveryRetry,
  renewLease: renew,
  signal,
});
```

At the transport boundary, create one controller for each accepted frame and
abort it on socket timeout/close and server shutdown. Do not abort merely on
the expected client half-close used to delimit a request. Independently, take
an authenticated in-flight permit after request verification and release it in
a `finally` block. Reject work with a fixed `busy` result when the permit or
bounded prompt queue is full; do not silently append it to another Promise
chain.

Regression coverage should exercise the real composed path rather than only a
queue utility. We should hold request A at the terminal, queue legitimate
request B, disconnect or expire A, and assert that A settles without a stored
decision and B promptly renders. Additional tests should abort B while it is
still queued, lose A's replay lease, close the server, and fill the configured
limit; in every case, queued entries, timers, and in-flight permits must return
to baseline. Existing tests for exact Purchase-ID confirmation, escaped
display data, replay rejection, and post-prompt expiry should remain to prove
that availability handling does not weaken authorization integrity.

## Summary

Sompi correctly isolates authority credentials and cryptographically validates
approval requests, but it lets distinct authenticated work accumulate behind
an uncancellable human prompt. We traced the path from concurrent Unix-socket
dispatch, through the service's retained lease heartbeat, into the production
terminal's unbounded Promise tail. The included component proof confirms that
128 ceremonies remain pending behind one unanswered question and that no later
ceremony renders.

The practical result is denial of human-approval availability on one local
authority instance, not approval forgery or fund movement. A compromised MCP
with valid Checkout-backed work can trigger it, while manual denial or restart
provides recovery. A bounded cancellable serial queue, end-to-end request
lifetime signal, explicit human deadline, and authenticated in-flight limit
would preserve Sompi's one-ceremony-at-a-time safety property while preventing
stale work from owning the terminal indefinitely.
