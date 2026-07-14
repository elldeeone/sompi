# Invalid vault recovery-key PoC

This safe local probe compares Sompi's vault-creation behavior with the x-only
public-key parser shipped in the same source tree. It does not start MCP,
connect to Kaspa, fund a vault, or broadcast a transaction.

## Requirements

- Node.js 22 or newer
- a Sompi source checkout at the revision under test
- the target's dependencies and TypeScript output built locally

Arrange the checkout and report directory as siblings:

```text
work/
  sompi/
  invalid-vault-recovery-key/
    poc/
```

Build the affected revision and run the probe with relative paths:

```sh
cd sompi
git checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm ci
npm run build
cd ../invalid-vault-recovery-key/poc
node reproduce.mjs ../../sompi
```

Exit status `0` means the vulnerability was reproduced: the SDK rejected the
candidate, but the manager persisted it and accepted it on restart. Exit status
`2` means the target rejected the invalid point and the issue was not
reproduced. Other nonzero statuses indicate setup or probe failure.

The probe creates a mode-`0700` temporary state directory and removes it even
if validation fails. No separate cleanup is required.
