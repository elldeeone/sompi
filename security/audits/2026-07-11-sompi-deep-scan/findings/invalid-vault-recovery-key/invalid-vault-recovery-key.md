# Invalid x-only key validation can permanently disable vault-owner recovery

## Executive Summary

Sompi accepts an operator recovery public key when it creates its covenant
vault. At revision `4ebb82d4f82bac46ae3addd112c4752f29630a8a`
(`@elldeeone/sompi` 0.8.0), the MCP schema and the underlying vault manager
only require this value to contain 64 hexadecimal characters. They do not
verify that those bytes encode a valid secp256k1 x-only public key.

An untrusted caller with first-run access to the local MCP process can therefore
provide a value such as 32 bytes of `ff`. Sompi accepts the value, incorporates
it into the covenant, and stores it as the operator's durable recovery
authority. The pinned Kaspa SDK rejects the same value as an x-only public key.
Because owner recovery later starts from a valid private key and compares its
derived x-only public key with the stored bytes, no valid owner private key can
match this configuration.

The validation pattern first appeared when caller-supplied owner keys were
introduced in version 0.2.1 and remains present in the reviewed 0.8.0 source.
No fixed revision was available at the time of writing. I reviewed the exact
source revision above, built it from a clean source snapshot, and ran the
included local differential PoC against that build. The PoC confirmed that the
SDK rejects the point while `VaultManager.create` accepts it, writes it to
`config.json`, and accepts the same configuration after restart. I did not fund
a covenant or submit a Testnet-10 transaction; the practical balance impact is
therefore reasoned from the verified key-validation mismatch and recovery gate.

This is a low-severity, P3 availability and security-control issue. It can
remove independent owner recovery and eventually strand one vault's Testnet-10
balance, but it does not give the caller a spending key. Exploitation is also
bounded by one-time local provisioning, visible public configuration, later
funding, and the additional need for the capped Agent key or its state to become
unavailable.

## Background

Sompi's current profile runs on Kaspa Testnet-10 and exposes its Agent-facing
tools through a locally launched stdio MCP process. The Agent, prompts, MCP
caller, and tool arguments are explicitly untrusted. This matters here because
`vault_create` is presented on that interface even though the recovery identity
is operator configuration.

The vault has two authorization branches. Sompi generates and stores an Agent
key whose withdrawals are constrained by a rolling consensus cap. Separately,
the human operator is expected to generate an owner key on a trusted machine,
retain its private half offline, and provide only the x-only public half during
vault creation. The owner branch is an unrestricted escape path if the Agent
key, Agent state, or capped path can no longer recover the funds.

The operator runbook captures the intended division clearly: `gen-owner-key`
creates the pair, only the public value goes to `vault_create`, and owner
recovery is deliberately not an MCP tool. Normal use therefore depends on a
simple invariant:

> The 32 bytes stored as `ownerPublic` must be the canonical encoding of a
> valid secp256k1 x-only public point for which the operator controls the
> corresponding private key.

An x-only public key is not merely an arbitrary 32-byte string. Its bytes are a
field element that the secp256k1 parser must be able to lift to a curve point.
Values outside the field, and in-field values that do not lift, have the right
length but cannot be derived from any valid private key. The all-`ff` value used
below is an especially clear test case because it is greater than the
secp256k1 field modulus and the pinned SDK rejects it deterministically.

## Vulnerability Details

We first reach the issue through the registered `vault_create` tool in
`src/mcp/server.ts:277-312`. The schema checks only the textual shape, then
passes the caller-controlled string directly to the manager:

```typescript
ownerPublicKey: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),

// ...
const created = vault.create(
  cap,
  ownerPublicKey,
  windowSizeDaa === undefined ? undefined : BigInt(windowSizeDaa)
);
```

The human-oriented response asks the operator to use `gen-owner-key`, but that
guidance is not an authorization or validation boundary. A normal MCP caller
can choose all 32 bytes without holding an owner key, authority credential,
wallet key, or filesystem capability.

We then carry the value into `VaultManager.create` at
`src/vault.ts:238-276`. The manager normalizes case and repeats the same length
and hex check:

```typescript
const ownerPublic = ownerPublicKey.trim().toLowerCase();
if (!/^[0-9a-f]{64}$/.test(ownerPublic)) {
  throw new Error("ownerPublicKey must be a 32-byte x-only public key in hex (64 hex chars). " +
    "Ask your human operator to run `npx @elldeeone/sompi gen-owner-key` on THEIR machine and " +
    "give you the `public:` line; the private half must stay with them.");
}

// ...
const address = this.deriveAddress(
  agentPublic,
  ownerPublic,
  maxOutflowSompi,
  windowSizeDaa,
  state
);
const config: VaultConfig = { /* ... */ ownerPublic, address };
// ...
this.state.createFileExclusive("config.json", configBytes, MAX_VAULT_CONFIG_BYTES);
```

This is the root-control failure: the message calls the string an x-only public
key, but the code never constructs the pinned `XOnlyPublicKey` type. Sompi has
already generated the capped Agent key by the time it derives the address, and
it then durably writes both the Agent secret and the poisoned owner value.

Address derivation does not close the gap. `buildRedeemScript` in
`src/vault/template.ts:98-142` turns both strings into bytes, checks only that
they are 32 bytes long, and pushes the owner bytes into the recovery branch:

```typescript
const agent = hexToBytes(agentPublicHex);
const owner = hexToBytes(ownerPublicHex);
if (agent.length !== 32 || owner.length !== 32) {
  throw new Error("public keys must be 32-byte x-only (64 hex chars)");
}

// ... final owner branch ...
pushData(owner),
hexToBytes(SEGMENT_13)
```

The covenant address is a hash of this script, so script hashing succeeds even
when the pushed bytes are not a curve point. We now have a syntactically valid
address whose recovery branch names an unusable authority.

The defective state also survives a restart. `assertCurrentConfig` at
`src/vault.ts:1487-1574` again accepts any lowercase 64-hex `ownerPublic`, then
recomputes the same address from those bytes. The address-consistency check is
useful against unrelated corruption, but it cannot distinguish a valid key
from an invalid key that was present when the address was originally derived.

Finally, when recovery is needed, `recoverVaultWithOwner` at
`src/vault.ts:1084-1104` accepts only a real private key and gates the spend on
its derived x-only key:

```typescript
privateKey = new PrivateKey(params.privateKey.trim());
if (!privateKeyMatchesXOnly(privateKey, params.config.ownerPublic)) {
  throw new Error("vault owner key does not match the configured public key");
}
```

`privateKeyMatchesXOnly` converts the private key to a keypair and compares its
canonical x-only public value with `ownerPublic`. For `ff...ff`, the SDK has
already established that there is no corresponding x-only point. We therefore
cannot choose a different valid private key that makes this equality pass; the
failure is structural, not a lost-password scenario.

## Exploitability Analysis

The strongest practical route is a lifecycle attack during initial setup:

1. We reach a fresh Sompi instance through its intended local MCP stdio
   channel before a vault exists.
2. We call `vault_create` with a positive cap and a 64-hex value that is known
   not to encode an x-only point.
3. Sompi returns a created configuration and exposes the covenant address. The
   invalid owner bytes are already durable and cannot be replaced through a
   second `vault_create` call.
4. The operator follows the normal next step and funds or deposits into the
   Testnet-10 vault without independently parsing the displayed public key.
5. The capped Agent branch continues to work, so the defect can remain latent.
   If that local Agent key or its associated state is later lost, corrupted, or
   deliberately retired, the offline owner recovery procedure cannot match the
   configured bytes.

An attacker should use a deterministically invalid point rather than a random
32-byte value. Some random x-coordinates are valid curve points, which would
weaken the demonstration. `ff` repeated 32 times is reliable: it passes both
regular expressions but lies outside the secp256k1 field and is rejected by the
pinned SDK's parser.

Several constraints materially limit the result. The tool is local stdio, not
a network listener. Creation is one-time, so an already configured vault is not
affected through this path. The owner public value and cap are not secret and
are visible in status output, while the documented ceremony tells the operator
to generate the key locally. Funding must occur after poisoning, and the Agent
branch still has its consensus cap and remains useful while its private state
survives. The vulnerability therefore does not cause immediate loss by itself.

The primitive also does not disclose the legitimate owner private key, grant
the caller a signature, raise the rolling cap, or bypass the Agent branch. Its
security consequence is removal of an independent recovery control. A final
balance lockout requires the compound condition that funds remain in the vault
when the other branch becomes unavailable. This is foreseeable—recovery exists
for precisely that class of failure—but I did not exercise the funded chain
state, and no mainnet deployment or mainnet impact is claimed.

## Proof of Concept

The `poc/reproduce.mjs` program performs a safe differential test against a
built Sompi source tree. It gives the same all-`ff` value to the pinned
`XOnlyPublicKey` constructor and to the real `VaultManager`. If the target is
vulnerable, the parser rejects it while the manager creates the vault. The PoC
then reads the durable configuration and instantiates a new `VaultManager` to
show that restart validation accepts the poisoned value.

Place this report directory and a Sompi checkout next to one another, then run:

```sh
cd sompi
git checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm ci
npm run build
cd ../invalid-vault-recovery-key/poc
node reproduce.mjs ../../sompi
```

Representative output from the reviewed revision is:

```text
[+] package version: 0.8.0
[+] candidate: ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
[+] pinned SDK accepts candidate: false
[+] VaultManager.create accepts candidate: true
[+] persisted ownerPublic matches candidate: true
[+] restart accepts poisoned configuration: true
[+] vulnerability reproduced: invalid x-only recovery authority persisted
[+] cleanup: temporary vault state removed
```

The program uses a new mode-`0700` temporary directory and removes it in a
`finally` block. It does not start MCP, connect to a node, use a wallet, fund a
vault, or broadcast a transaction. On a fixed build, `VaultManager.create`
should reject the candidate before creating `agent-key` or `config.json`; the
PoC reports that as `not reproduced` with exit status 2.

## Remediation

The invariant should be enforced in the deepest module that accepts or reloads
the recovery authority: `ownerPublic` must be a canonical, parser-accepted
secp256k1 x-only public key before Sompi generates an Agent key, derives a
covenant address, or writes any state. MCP-side validation is useful for a good
error response, but it must not be the only fix because `VaultManager` is also
called outside the registered tool.

A minimal source shape is to construct the pinned key type and return its
canonical encoding:

```typescript
// src/kaspa-wasm.ts
export const XOnlyPublicKey = kaspa.XOnlyPublicKey;
export type XOnlyPublicKey =
  import("../vendor/kaspa-wasm/kaspa.js").XOnlyPublicKey;

// src/vault.ts
import { XOnlyPublicKey } from "./kaspa-wasm.js";

function canonicalXOnlyPublicKey(value: string, label: string): string {
  let key: XOnlyPublicKey | undefined;
  try {
    key = new XOnlyPublicKey(value.trim());
    const canonical = String(key).toLowerCase();
    if (canonical !== value.trim().toLowerCase()) {
      throw new Error(`${label} is not canonically encoded`);
    }
    return canonical;
  } catch (error) {
    throw new Error(`${label} must be a valid secp256k1 x-only public key`, {
      cause: error,
    });
  } finally {
    key?.free();
  }
}

// Validate before Keypair.random() or any durable write.
const ownerPublic = canonicalXOnlyPublicKey(ownerPublicKey, "ownerPublicKey");
```

The same helper, or an equivalent typed parser, should validate
`record.ownerPublic` in `assertCurrentConfig`. That makes restart fail closed if
an older or corrupted configuration contains a non-point. The project should
define an explicit operator migration procedure for an unfunded invalid
configuration; it must not silently rewrite the covenant identity, because an
address derived with different owner bytes is a different vault.

Regression coverage should include:

- `ff...ff`, the field modulus, values greater than the modulus, and an
  in-field x-coordinate that cannot be lifted to a curve point;
- rejection at `VaultManager.create` before either `agent-key` or `config.json`
  appears;
- rejection when an invalid point is injected into a persisted configuration,
  even when its address is recomputed consistently;
- acceptance of the canonical public key returned by `gen-owner-key`; and
- an MCP-level test proving that an invalid point produces a stable public
  input error rather than a partially configured vault.

As defense in depth, the operator-facing creation response can display a short
fingerprint of the validated owner key and require a trusted, human-present
confirmation before principal-bearing deposit. That does not replace point
validation, but it reinforces the intended separation between untrusted tool
input and operator recovery configuration.

## Summary

Sompi confuses the serialized length of an x-only public key with validity as a
secp256k1 curve point. We followed a caller-controlled value from the local MCP
schema through vault creation, script construction, durable configuration, and
the owner-recovery equality gate. The bundled PoC demonstrates the decisive
parser differential and confirms that the invalid recovery authority remains
accepted after restart.

The issue is bounded but durable: it affects one Testnet-10 vault, needs
first-run provisioning and later funding, and becomes a balance lockout only if
the capped Agent branch is no longer available. Enforcing a canonical pinned-SDK
key parse inside the vault module, before any side effect, restores the intended
invariant and creates a useful foundation for variant analysis of every other
persisted public key or covenant identity.
