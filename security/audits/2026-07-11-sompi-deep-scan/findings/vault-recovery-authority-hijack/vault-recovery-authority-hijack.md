# MCP vault provisioning lets an untrusted Agent seize owner recovery authority

## Executive Summary

Sompi exposes first-run covenant-vault creation as the Agent-facing MCP tool
`vault_create`. The tool accepts an `ownerPublicKey` supplied by the MCP caller
and persists it as the vault's unrestricted owner-recovery identity. Sompi's
own threat model treats the Agent, MCP caller, and tool arguments as fully
untrusted, yet this transition has no operator authentication, trusted
confirmation, or comparison with an operator-pinned key.

An attacker who controls the normal MCP session during initial setup can
therefore generate a keypair, submit its public half, and retain the private
half. If that vault is later funded, the attacker can use the shipped owner
recovery path to send the entire current vault UTXO, minus the transaction fee,
to an address it controls. The consensus rolling cap applies to the Agent
branch, but not to owner recovery.

The affected source declares itself as `@elldeeone/sompi` 0.8.0. I reviewed
revision `4ebb82d4f82bac46ae3addd112c4752f29630a8a` directly and ran the bundled
non-broadcasting PoC against compiled modules from that revision. I reproduced
the untrusted key assignment and durable persistence locally. I did not fund a
vault or submit a recovery transaction to Testnet-10, and I found no fixed
revision to assess. The `vault_create` surface entered the tree in commit
`52080d1278e8514dbfe453b352d71396d64fee50` on 2026-07-11.

The practical preconditions are significant but realistic: the vault must be
unconfigured, the malicious MCP caller must win the one-time setup action, an
operator must subsequently fund the resulting Testnet-10 vault, and the
poisoned owner key must not be noticed first. There is no public network
listener in this path; the shipped server uses inherited stdio. We therefore
rate the issue **medium severity / P2**: impact is high for the affected vault,
while likelihood is medium because exploitation is local, configuration- and
ordering-dependent, visible after the fact, and limited by the current
Testnet-10-only release.

## Background

Sompi separates an untrusted Agent from the treasury controls that authorize
and execute payments. The MCP process is intentionally capable of treasury
execution, but the Agent is meant to initiate and observe rather than acquire
key custody or operator authority. In the affected release, that MCP server is
connected over stdio:

```ts
// src/index.ts, main()
const server = createSompiMcpServer(runtime, packageVersion(), treasuryOperations);
const transport = new StdioServerTransport();
// ...
await server.connect(transport);
```

This matters for exposure: we are not describing an unauthenticated Internet
endpoint. We are describing a privilege boundary inside the intended local
Agent integration. A malicious model, prompt-injected Agent, or MCP client with
the ordinary tool channel can exercise the vulnerable transition without
compromising the `sompi-mcp` operating-system account.

The covenant vault has two materially different signing branches:

- Sompi generates and retains an Agent key for ordinary withdrawals. Consensus
  script state enforces the configured rolling outflow cap on that branch.
- An operator supplies an x-only owner public key. Its matching private key is
  meant to remain offline and selects the unrestricted recovery branch.

The owner key is consequently more than descriptive configuration. It is the
identity for an emergency path that can sweep the current vault balance. The
documentation describes an operator ceremony in which the owner generates the
key on a trusted machine and provides only its public half. That ceremony is
good operational guidance, but the code exposes its decisive assignment to the
untrusted MCP caller:

```ts
// src/mcp/server.ts, registerSompiTools()
register(
  "vault_create",
  {
    description:
      "Create the testnet covenant-vault configuration from an operator-owned recovery public key and rolling cap.",
    inputSchema: {
      maxOutflowSompi: POSITIVE_ATOMIC.optional(),
      ownerPublicKey: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
    },
  },
  "VAULT_CREATE_FAILED",
  async ({ maxOutflowKas, maxOutflowSompi, windowSizeDaa, ownerPublicKey }) => {
    // ...
    const created = vault.create(
      cap,
      ownerPublicKey,
      windowSizeDaa === undefined ? undefined : BigInt(windowSizeDaa)
    );
    return { status: "created_needs_deposit", ...publicVaultConfig(created) };
  }
);
```

`payment_status` and `vault_status` also direct the Agent to ask for a recovery
key and then call `vault_create`. The intended human handoff is expressed in
prose and tool descriptions, not in an enforceable trust-boundary check.

## Vulnerability Details

We can follow the vulnerable state transition in five steps:

| State | Security-relevant event |
|---|---|
| Unconfigured | No owner identity has yet been bound to the vault. |
| MCP call | The untrusted caller supplies its own public key and a valid cap. |
| Durable creation | Sompi writes that key into `config.json` and derives the covenant address from it. |
| Funding | Testnet KAS is deposited into the resulting covenant. |
| Recovery | The attacker's matching private key selects the owner branch and sweeps the current UTXO. |

We first reach the one-time handler while `vault.configured` is false. The
handler asks for a key, says that it should belong to the operator, and rejects
replacement after creation. None of those checks establishes who selected the
key:

```ts
// src/mcp/server.ts, vault_create handler
if (!ownerPublicKey || (maxOutflowKas === undefined && maxOutflowSompi === undefined)) {
  return {
    status: "needs_input",
    userAction:
      "Ask the operator to run `sompi-mcp gen-owner-key`, retain the private key, and provide only its public key plus the desired cap.",
  };
}
if (vault.configured) {
  throw new McpPublicError(
    "VAULT_ALREADY_EXISTS",
    "A vault is already configured; inspect vault_status instead of replacing it."
  );
}
const created = vault.create(
  cap,
  ownerPublicKey,
  windowSizeDaa === undefined ? undefined : BigInt(windowSizeDaa)
);
```

An adversarial caller simply ignores the instruction and supplies a key it
generated itself. The fact that the private key never enters MCP does not help:
the attacker wants to keep that private key.

If we carry the caller's public key into `VaultManager.create`, the only
key-specific control is a 64-hex-character shape check. Sompi then uses it to
derive the initial covenant address and writes it durably as `ownerPublic`:

```ts
// src/vault.ts, VaultManager.create()
const ownerPublic = ownerPublicKey.trim().toLowerCase();
if (!/^[0-9a-f]{64}$/.test(ownerPublic)) {
  throw new Error("ownerPublicKey must be a 32-byte x-only public key in hex");
}

agent = Keypair.random();
const agentPublic = String(agent.xOnlyPublicKey);
const address = this.deriveAddress(
  agentPublic, ownerPublic, maxOutflowSompi, windowSizeDaa, state
);
const config: VaultConfig = {
  template: VAULT_TEMPLATE_VERSION,
  agentPublic,
  ownerPublic,
  maxOutflowSompi: maxOutflowSompi.toString(),
  // ...rolling-window state and derived address...
  address,
};

this.state.createFileExclusive("agent-key", agentBytes, MAX_VAULT_AGENT_KEY_BYTES);
configBytes = encodeVaultConfig(config);
this.state.createFileExclusive("config.json", configBytes, MAX_VAULT_CONFIG_BYTES);
```

The one-time and exclusive-file semantics are valuable against accidental
replacement, but here they lock in the attacker's win. The owner key is also
embedded into the redeem script by `buildRedeemScript()`, so changing a JSON
field later would not safely repair a funded covenant.

Once value enters that address, owner recovery checks only that the supplied
private key matches the configured public key. With an attacker-selected key,
that check succeeds by construction:

```ts
// src/vault.ts, recoverVaultWithOwner()
privateKey = new PrivateKey(params.privateKey.trim());
if (!privateKeyMatchesXOnly(privateKey, params.config.ownerPublic)) {
  throw new Error("vault owner key does not match the configured public key");
}
return await spendVault({
  wallet: params.wallet,
  config: params.config,
  fn: "recover",
  signingKey: privateKey,
  destination: params.destination,
});
```

From here we reach the recovery branch in `spendVault()`. It deliberately does
not calculate a capped withdrawal or continuation output. Instead, it subtracts
the fee from the selected current UTXO, sends the remainder to the supplied
destination, signs with the owner key, and submits the transaction:

```ts
// src/vault.ts, spendVault()
if (fn === "recover") {
  const amountSompi = utxo.amount - feeSompi;
  const tx = buildTransaction({
    inputs: [txInput(utxo, "")],
    outputs: [{ value: amountSompi, scriptPublicKey: destSpk }],
    lockTime: 0n,
  });
  const pushedSig = createInputSignature(tx, 0, params.signingKey, SighashType.All);
  setInputScripts(tx, [payToScriptHashSignatureScript(
    redeem, buildSigArgs(hexToBytes(pushedSig).slice(1), "recover")
  )]);
  const { transactionId } = await (rpc as any).submitTransaction({
    transaction: tx,
    allowOrphan: false,
  });
  return { txid: String(transactionId), amountSompi, feeSompi };
}
```

The shipped `scripts/vault-recover.js` utility makes the sink operational. It
accepts a mode-`0600` private-key file, verifies equality with
`config.ownerPublic`, connects to a Testnet-10 node, and calls
`recoverVaultWithOwner()` with a caller-selected destination. File-mode checks
protect a legitimate operator's key; they do not distinguish an attacker's own
perfectly well-protected key file.

The violated invariant is therefore precise: a value chosen in the fully
untrusted Agent zone becomes the identity for an unrestricted operator
recovery branch without a trusted act that authorizes that assignment.

## Exploitability Analysis

The strongest route is a provisioning race during normal setup. We begin with
an instance whose wallet and MCP process are running but whose vault has not
been configured. The malicious Agent generates a secp256k1 keypair and calls:

```json
{
  "name": "vault_create",
  "arguments": {
    "ownerPublicKey": "<attacker x-only public key>",
    "maxOutflowSompi": "100000000"
  }
}
```

Choosing a plausible cap is useful because it keeps the public configuration
consistent with an operator's likely expectations. The handler returns
`created_needs_deposit`, and subsequent status output openly reports the owner
key. If the operator checks that fingerprint against a separately recorded key,
the attack is detected. If the operator checks only readiness, cap, address, or
funding state, the poisoned identity can survive into the next step.

The attacker can then wait for the operator to fund the documented vault
address. Where the wallet already has testnet funds and the normal deposit
prerequisites are met, the ordinary setup flow can shorten that wait, but the
core primitive does not depend on bypassing deposit policy: later legitimate
funding is sufficient.

After funding, we already possess the only secret required by the owner branch.
The vault configuration and current outpoint are public operational data, and
the recovery destination is attacker-controlled. We can put our private scalar
in a mode-`0600` file and use the packaged recovery utility, or call the exported
recovery function from another local program with access to a Testnet-10 RPC
node. Recovery is not exposed as an MCP tool, but that is not a blocker once we
own the identity enforced by the covenant.

Several alternative routes and constraints sharpen the assessment:

- A malicious MCP client wrapper can perform the same first call even when the
  model behaves correctly. The primitive belongs to the tool boundary, not to
  a particular prompt-injection technique.
- We do not need to steal, disclose, or brute-force the legitimate operator's
  private key. Substitution at provisioning is simpler and deterministic.
- Calling the capped Agent withdrawal branch is an unhelpful dead end for a
  full-balance theft because consensus still applies its rolling limit. Owner
  recovery is the useful branch.
- Calling recovery through MCP is also a dead end because the project
  intentionally omits that tool. The exported function and packaged utility
  provide the viable route outside the Agent session.
- A remote unauthenticated attacker cannot directly reach this surface in the
  shipped topology. Control of the local Agent/MCP session is required.
- The window is one-time. A legitimately configured vault rejects a second
  `vault_create` call. Conversely, a malicious first call cannot be safely
  overwritten in place; the covenant address already commits to the key.
- Exploitation remains latent until the vault is funded, is conspicuous to an
  operator who verifies the expected owner-key fingerprint, and applies only
  to the release's Testnet-10 configuration. We make no mainnet loss claim.

These conditions make reliability high once the malicious key is persisted and
the vault is funded, but reduce the likelihood of reaching that state. That is
why the issue remains medium/P2 despite a full-vault impact at the sink.

## Proof of Concept

The accompanying PoC exercises the real `registerSompiTools()` implementation
and the real `VaultManager` from a built vulnerable source tree. It captures the
registered `vault_create` handler in the same way an MCP server exposes it,
generates an attacker-controlled keypair, calls the handler while the vault is
unconfigured, and reopens the durable configuration to prove that the chosen
key became `ownerPublic`.

The PoC deliberately stops before funding, transaction construction, RPC
connection, or broadcast. It creates only a temporary local state directory and
removes it before exit. Never fund the deterministic demonstration key.

From the report directory, with a vulnerable checkout available at a relative
path:

```sh
cd poc
export SOURCE_ROOT=../../../sompi
npm --prefix "$SOURCE_ROOT" ci
npm --prefix "$SOURCE_ROOT" run build
node ./vault-recovery-authority-hijack.mjs --source-root "$SOURCE_ROOT"
```

The equivalent convenience target is:

```sh
cd poc
make SOURCE_ROOT=../../../sompi
```

Representative output from revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a` is:

```json
{
  "vulnerable": true,
  "packageVersion": "0.8.0",
  "network": "testnet-10",
  "mcpAccepted": true,
  "configured": true,
  "attackerOwnerPersisted": true,
  "attackerPrivateMatchesOwnPublic": true,
  "ownerPublic": "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
  "broadcastAttempted": false
}
```

On a fixed build, the preferred result is that `vault_create` is not registered
on the MCP surface at all. The PoC reports `vulnerable: false` when the tool is
absent or when the untrusted assignment no longer succeeds. Full instructions,
requirements, cleanup behavior, and the recorded output are included in
`poc/README.md` and `poc/representative-output.txt`.

## Remediation

The invariant to restore is straightforward: **an Agent/MCP argument must never
select or replace the key that authorizes unrestricted vault recovery**.
Syntax, one-time creation, visibility, and instructions are not substitutes for
trusted provenance.

The strongest fix is to remove `vault_create` from `registerSompiTools()` and
move first-run creation into a separate operator-only command. That command
should run outside the Agent/MCP process, read an operator-approved bootstrap
record from a regular non-symlink file with verified owner and mode, display the
network, owner-key fingerprint, cap, and derived address, then require explicit
human confirmation before committing state. MCP should expose only read-only
setup status until that ceremony is complete.

A minimal source-shape change looks like this:

```diff
 // src/mcp/server.ts, registerSompiTools()
-register("vault_create", vaultCreateSchema, "VAULT_CREATE_FAILED",
-  async ({ ownerPublicKey, maxOutflowSompi, windowSizeDaa }) =>
-    vault.create(BigInt(maxOutflowSompi), ownerPublicKey, BigInt(windowSizeDaa))
-);
+// Deliberately do not register vault creation on the Agent-facing server.
+// An operator-only initializer creates the vault before MCP is connected.

 // Read-only MCP behavior when initialization has not happened:
 return {
   status: "needs_operator_setup",
   configured: false,
   nextStep: "Run sompi-vault-init outside the Agent/MCP security context."
 };
```

The new trusted initializer can still call `VaultManager.create()`; the security
change is which principal supplies its arguments:

```ts
// Operator-only process, never registered as an MCP tool.
const approved = readVerifiedOperatorBootstrap(options.bootstrapFile);
displayAndConfirm({
  network: "testnet-10",
  ownerKeyFingerprint: sha256(approved.ownerPublicKey),
  maxOutflowSompi: approved.maxOutflowSompi,
});
vault.create(
  approved.maxOutflowSompi,
  approved.ownerPublicKey,
  approved.windowSizeDaa,
);
```

If project constraints require retaining an MCP initiation step, it must carry
only a nonce or reference to a separately authenticated, single-use operator
approval that binds the exact owner public key, cap, window, network, data
directory, and expiry. The MCP caller must not be able to supply or alter those
facts. No authority credential should enter the MCP process.

Before funding any vault created by an affected build, operators should compare
`ownerPublic` with a fingerprint recorded independently during key generation.
An unexpected key means the covenant should be treated as poisoned. Because a
funded address commits to the key, editing `config.json` is not remediation;
stop use, preserve evidence, and follow a deliberate Testnet-10 recovery/reset
plan. Unfunded poisoned state should be discarded and initialized again through
the trusted path.

Regression coverage should include:

1. Enumerate the MCP tools and assert that `vault_create` is absent.
2. Send a raw MCP `tools/call` for `vault_create`; expect tool-not-found and
   verify that neither `agent-key` nor `config.json` appears.
3. Run the operator initializer with a valid approved record and verify that the
   exact displayed fingerprint is the one embedded in the derived covenant.
4. Reject bootstrap files that are symlinks, have the wrong owner or mode,
   target another network/data directory, are expired, or have already been
   consumed.
5. Prove that an Agent cannot alter key, cap, window, or network between human
   confirmation and the durable write.
6. Retain end-to-end tests showing that the approved owner key can recover and
   that the independent Agent branch remains rolling-cap constrained.

## Summary

Sompi correctly separates its capped Agent key from an unrestricted recovery
key, but the affected release lets the untrusted Agent choose who owns that
recovery key during first-run MCP setup. We traced the caller-controlled public
key from `vault_create`, through syntax-only validation and durable covenant
configuration, to the owner branch that sends the current vault UTXO minus its
fee to an arbitrary destination. The included local PoC reproduces the decisive
assignment without touching a node or blockchain.

The issue is medium/P2 because the resulting authority can have high impact on
one funded vault, while exploitation requires local MCP control during a
one-time unconfigured state, later Testnet-10 funding, and missed operator
detection. Removing vault initialization from the Agent surface restores the
cleanest boundary. Follow-on review should treat every first-run assignment of
an operator identity with the same question: what trusted act, rather than what
instructional prose, proves the provenance of the value being committed?
