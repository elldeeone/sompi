# Hardening analysis context

Analysis ID: `hardening_final`
Source scan: `ccc03842-b6f7-41d2-b169-cc7b9e6b90da`
Scan root: `/tmp/codex-security-scans-u5YlLn/sompi/4ebb82d4f82bac46ae3addd112c4752f29630a8a_20260711T145619Z_75jg_ull`
Source root: `/home/luke/projects/sompi`
Target revision: `4ebb82d4f82bac46ae3addd112c4752f29630a8a`
Target tree: `e1f6224f9bf18d8c4e1299c138789e41e9476655`
Source drift at analysis: `none` (HEAD and tracked worktree matched the target revision).

This is a scan-backed analysis produced during final reporting. The canonical
scan manifest and seal did not yet exist when the analysis began, so this file
does not claim sealed integrity. The immutable target revision, the per-finding
validation and attack-path artifacts, and each dedicated report provide the
evidence identity used below.

## Architecture evidence

The analysis used Sompi's accepted modular-monolith architecture and all ten
accepted ADRs. The principal constraints were the stable Purchase model, the
separate AP2 authorization and Kaspa-x402 execution seams, journal-first
recovery, the isolated Trusted Authority, clean cutover without compatibility
paths, testnet-only human-present exact payment, and the prohibition on a
universal payment-rail system or Sompi-driven changes to the sibling
Kaspa-x402 repository.

| Document | SHA-256 |
| --- | --- |
| `CONTEXT.md` | `4e3772d5c06df380ab141111177ac0f0db0f787d8674d4d882767b3ca1fc4ede` |
| `docs/architecture/SOMPI_ARCHITECTURE.md` | `0155c0c6f1339a72b01ca90518607d6cd566218d0c9a61f979fe481b1a0f5739` |
| `docs/adr/0001-clean-cutover.md` | `406c10fa52fb0849a4f0be58639d2f6dfc5311abe16c9d3c036f56a165595737` |
| `docs/adr/0002-modular-monolith-and-purchase-module.md` | `0c273f8d88568ba2b3c7535dd3dbd40b495f4b7d34e4106597270e94b709500d` |
| `docs/adr/0003-protocol-ownership.md` | `149f9322cb3020277f438ab9f1ec0b2ed6b98b4a90b21dc550c5159b7c518d50` |
| `docs/adr/0004-transactional-journal-first.md` | `6f10f784d7a846e27feba431753924954eb7d69f87f5a672fdd43c7160b4254e` |
| `docs/adr/0005-isolated-trusted-authority.md` | `3564389ea633745bbf2ffee27e9601608d74ae045a88d25d2c592914a12e47a3` |
| `docs/adr/0006-versioned-protocol-adapters.md` | `042d2187f5ff2a5054c8c7d8264887dc48714043e73cf409256052a3a4995cea` |
| `docs/adr/0007-initial-delivery-scope.md` | `d15b06d0a14e6f35fef6873883d47846e04c46cee232599bdc62d3eeb2fb44ca` |
| `docs/adr/0008-repository-and-runtime-topology.md` | `a86c4b99786337dc6fdaa6041d0e117bb9f54b96f0de25d23eccd4e903b7476b` |
| `docs/adr/0009-kaspa-x402-integration.md` | `26eece93dcddb3b47ec0ece57e38e19f3c3699b8291b332de6dad78eb661b8b2` |
| `docs/adr/0010-native-kas-ap2-profile.md` | `110d98367f0d7bb5e29f52222d3dc9a22a569eb2f41e135b14196b86be41e0e0` |

The canonical threat model is
`artifacts/01_context/threat_model.md` (SHA-256
`656c7e453c984b2c1afb5c3f193066aff49e654a74ed3369ed90f1cc7b679079`).
It treats the Agent, Merchant, RPC, lower-privilege local process, crashes,
configuration bytes, and aggregate resource use as untrusted or failure-prone
inputs. The scan-wide validation and attack-path summaries have SHA-256 values
`c62218185ded34320f991e895ba0cfcd2c083394502a04b173495b96a45e3e16`
and `108a442639e4283123880e286d0ca2069040017cb01cf8ba6457c0c7236a886e`.

## Final finding inventory

Every row below has a dedicated report plus candidate-specific validation and
attack-path analysis. Paths are relative to the scan root. Hash columns are in
the order report, validation, attack path.

| Evidence | Severity | Finding | Paths | SHA-256 (report / validation / attack) |
| --- | --- | --- | --- | --- |
| `CAN-001` | medium / P2 | MCP vault provisioning lets an untrusted Agent seize owner recovery authority | `findings/vault-recovery-authority-hijack/vault-recovery-authority-hijack.md`; `artifacts/05_findings/CAN-001/validation_report.md`; `artifacts/05_findings/CAN-001/attack_path_analysis_report.md` | `31c8826b62dec8cca45a0766e18ea21686a234d5bdc4bb13166c29e65766244f` / `e57126519efa71b24c4263eb443f7dcbb293fe453f5a5c3f7eea517450535610` / `84968d70765674a563ec0c3b707a1c5a33ff65670f2b96298a70d1b4bc5140e9` |
| `CAN-003` | medium / P2 | A single selected Kaspa RPC can fabricate exact-payment inclusion and finality | `findings/untrusted-rpc-false-settlement/untrusted-rpc-false-settlement.md`; `artifacts/05_findings/CAN-003/validation_report.md`; `artifacts/05_findings/CAN-003/attack_path_analysis_report.md` | `04c8c462c42eff40d6c943a4ead55258debe1926d2181220b866fbcf4e2ca901` / `8c83b2fe7a1f960fa7eff492e6d9a2e8b4a4915b5a4997deff93e1e9d99951d2` / `7dd65cc2960fa373260181d58e913f86c48e68465e444b09dfde0d46bb8460a2` |
| `CAN-004` | medium / P2 | Untrusted RPC can forge recovery finality and release policy capacity | `findings/untrusted-rpc-forged-recovery-finality/untrusted-rpc-forged-recovery-finality.md`; `artifacts/05_findings/CAN-004/validation_report.md`; `artifacts/05_findings/CAN-004/attack_path_analysis_report.md` | `7a9cc91d33c2af738d889e201c730e0c37f505be9bacf1f4a31a8d8ed96a3c35` / `ffc63bc81924181fb1953c82b1c857aca6acff6d4c8c741617aa44503108822c` / `5b9fb4bb51d18e75f13c77d160322fd4f3b5a07f7991ff9988015bb3d02642be` |
| `CAN-006` | low / P3 | Generic Kaspa RPC errors become recovery absence evidence | `findings/rpc-error-as-absence/rpc-error-as-absence.md`; `artifacts/05_findings/CAN-006/validation_report.md`; `artifacts/05_findings/CAN-006/attack_path_analysis_report.md` | `6647edc85b2f4cda3c8aab911e2822e2f63c9df1f70190161114f9e663e822fc` / `b30f1cc436a2774e580f729d32d36dadc0979dcf702d93dbc88ee3f3327e9f20` / `4786c21f1eb3ecadd00d90db7dd885d33d5886331fbaf3cfc10b78bb71594230` |
| `CAN-007` | low / P3 | Cleartext Merchant authorization permits forged acceptance and signed-payment capture | `findings/cleartext-merchant-authorization/cleartext-merchant-authorization.md`; `artifacts/05_findings/CAN-007/validation_report.md`; `artifacts/05_findings/CAN-007/attack_path_analysis_report.md` | `ef860d06d212c7ed0745ff187f33cc23c8d7ab13fb02f61239d0548891a82861` / `aa579dceca26a78cd383c884bf5d1cc812817727a1db87a47953d703e28ca383` / `7e2fcbec9f4d626c10b6a364e3fa5e5beb1919426037764603972c98cf4b7042` |
| `CAN-008` | low / P3 | Invalid x-only key validation can permanently disable vault-owner recovery | `findings/invalid-vault-recovery-key/invalid-vault-recovery-key.md`; `artifacts/05_findings/CAN-008/validation_report.md`; `artifacts/05_findings/CAN-008/attack_path_analysis_report.md` | `10348c648ade8852e1f709a5e814ffc82ef60f502bdc3b1894dd91d7e0d15e83` / `eafe1180cdb7065896a1ac89750c596fb6a73e57d139f71175a6f111fcf658d5` / `abdf3732d918a065832ba28c10ded279c69e7f62d0f30aeec12868a9c5b48f9b` |
| `CAN-009` | low / P3 | Unbounded pre-authentication authority sockets permit approval-service exhaustion | `findings/authority-preauth-socket-exhaustion/authority-preauth-socket-exhaustion.md`; `artifacts/05_findings/CAN-009/validation_report.md`; `artifacts/05_findings/CAN-009/attack_path_analysis_report.md` | `1a196bb777f78258e5a9b56dd55c5a2389d6be38c89209d9a7dab74c84b69b6f` / `abe83ae4729f822e77e885e3698de37f06c327588198f098d69bc3ac3ac6e404` / `0b0227366b4bf89e42edd440b0ad8fb049b85e9553da7767cb066fc725692294` |
| `CAN-013` | low / P3 | Authenticated authority requests can indefinitely block the human approval queue | `findings/authority-prompt-queue-dos/authority-prompt-queue-dos.md`; `artifacts/05_findings/CAN-013/validation_report.md`; `artifacts/05_findings/CAN-013/attack_path_analysis_report.md` | `0958a447ebab696a44abe1e8fa60b2700648691fa6dfa43aabba32fce648cb15` / `c54154eeb72577a7a69a9c0c04e1825696512e0b9f2b137be37fbf05adf69c99` / `afc3a8fa8652d3618c11a8592c12cf07dec9232356683d9edefde42ee8770c9d` |
| `CAN-016` | low / P3 | Untrusted RPC metadata can spoof mempool transaction identity | `findings/rpc-mempool-id-spoof/rpc-mempool-id-spoof.md`; `artifacts/05_findings/CAN-016/validation_report.md`; `artifacts/05_findings/CAN-016/attack_path_analysis_report.md` | `8d830a681202cf5784b0f3e02e926e80685399ffc1a848d16400e7f077602ef7` / `ad6853e5783e015c70a9923b947ad82f70878274700bb1456722abef14c33e0e` / `e1c01163e36d6ae3ce2bc3a5aee643a50ac9d03855fc3e01c3ec0c2aa573ca61` |
| `CAN-017` | low / P3 | Spent Merchant outputs become invisible to exact-payment recovery | `findings/spent-payment-evidence-loss/spent-payment-evidence-loss.md`; `artifacts/05_findings/CAN-017/validation_report.md`; `artifacts/05_findings/CAN-017/attack_path_analysis_report.md` | `8caf1b78cd027c2afdbf6ed47ac002bbe7068b2bfcdd754a82e83a64baa21e57` / `767d7ec5efd5deceba294d7b22c31338ae49a530b262f0a80f8f68f7885bdb0e` / `cae872297057a2f5be0def82634b286025f5257a63997ae4e5d29749cab9b456` |
| `CAN-018` | low / P3 | Single-RPC absence evidence can authorize a competing staging-recovery transaction | `findings/single-rpc-absence-recovery-race/single-rpc-absence-recovery-race.md`; `artifacts/05_findings/CAN-018/validation_report.md`; `artifacts/05_findings/CAN-018/attack_path_analysis_report.md` | `819b235ebcb7f7f0ccd93809a96e9f50c4327267c5a0c9861ebdf40bdb1e4cae` / `081e458c0b06be7d0145bb95f7cebedb64782738c0d3d24961553950592638ff` / `0705456461b095ff91c327adfaa061e0b02cbbb87752b22140927df115a890a0` |
| `CAN-020` | medium / P2 | Provisional exact-payment evidence permanently closes staging recovery | `findings/mempool-exact-terminal-recovery/mempool-exact-terminal-recovery.md`; `artifacts/05_findings/CAN-020/validation_report.md`; `artifacts/05_findings/CAN-020/attack_path_analysis_report.md` | `0b5066f03912c0e59d68099b64af41e1d521a413100829266305ce6b6515929c` / `b3b07f86cbfc3e6e3baa0d4179e3789d89eeab3b2dab07496d63be4cd4de9a24` / `9223cf81a035b449b8a13f0e9758b2cd28b04f30a9f452ec73ef67cf300cb90f` |
| `CAN-023` | low / P3 | Mempool-only RPC evidence can permanently complete a direct wallet send | `findings/provisional-wallet-send-finality/provisional-wallet-send-finality.md`; `artifacts/05_findings/CAN-023/validation_report.md`; `artifacts/05_findings/CAN-023/attack_path_analysis_report.md` | `d63fc1eeb254b9277115a4a2eaccb6774d7653032bfb741c5ddfb3accd3e4b79` / `4c62cd2ef65cf4de374df5f91aab6a3230131d17d8df8b84088405f4cd44e5d6` / `d0b4b0ba91f7c3a63309ef7178707d394d43f77d3b5f384ebee3df262c310e97` |
| `CAN-024` | low / P3 | Provisional Kaspa evidence can advance Sompi's durable vault continuation | `findings/provisional-vault-send-continuation/provisional-vault-send-continuation.md`; `artifacts/05_findings/CAN-024/validation_report.md`; `artifacts/05_findings/CAN-024/attack_path_analysis_report.md` | `dd44d4c0115bb77fcddc9a34a95455af1e87fb6fefd30d63e9270cdf4acd136e` / `66ca8e7080a38a0d981903f37da602954b1beee616fbbee3cf5cfed9a543655f` / `0455990ef5df02500beabdc6d08f78628c4862e3aefd0a537ef27ed5e8931cc6` |
| `CAN-025` | low / P3 | Provisional single-RPC evidence can persist a nonexistent vault deposit | `findings/provisional-vault-deposit-finality/provisional-vault-deposit-finality.md`; `artifacts/05_findings/CAN-025/validation_report.md`; `artifacts/05_findings/CAN-025/attack_path_analysis_report.md` | `eff2c9a0b3ec0c59d292d86dccaa144da1e82c39dc5d6b54697aed79695f3fa6` / `681d99343ecd7d60a5c6c0b12fb97e268fb353be7c96c3d4bd0a8fc309b5a781` / `8570cd05c5ccb33d78ca4fcacaacc8ba76631695788b36a0c3bc20ce696ec159` |
| `CAN-026` | low / P3 | Provisional Purchase staging is committed before accepted finality | `findings/provisional-purchase-staging-finality/provisional-purchase-staging-finality.md`; `artifacts/05_findings/CAN-026/validation_report.md`; `artifacts/05_findings/CAN-026/attack_path_analysis_report.md` | `90e9f80604a630ef50e4b287dde610a3eff6917487ce4d362074da8b05d2bc0f` / `640a198a018492d19768727d7ab9eda127337ee00cbb86f0d8e84a4e6bbb5332` / `2794b55c56b978b952c8880fbd54bb0a9b7e6cb9393c559fe991a569de92ecb7` |
| `CAN-027` | low / P3 | Pre-validation Purchase bodies can exhaust Sompi's durable storage | `findings/prevalidation-purchase-storage-exhaustion/prevalidation-purchase-storage-exhaustion.md`; `artifacts/05_findings/CAN-027/validation_report.md`; `artifacts/05_findings/CAN-027/attack_path_analysis_report.md` | `289fd8e90e536d37683be3d4966a6621a5bff5542557b88f98c739e9cd6d899d` / `d821ca4f7a978783dbb0d2218b5da96552a30a02252925c145daf1259160b724` / `e24498ca8ceab2a659a3cd76df3bac0934d03dcca26e99aed00a150bce769a72` |
| `CAN-030` | medium / P2 | Merchant-controlled mempool finality prematurely releases recovery capacity | `findings/merchant-mempool-finality-capacity-release/merchant-mempool-finality-capacity-release.md`; `artifacts/05_findings/CAN-030/validation_report.md`; `artifacts/05_findings/CAN-030/attack_path_analysis_report.md` | `88baf6ecfe52191f0275f05f5d0505db5f869b25573107dfcdeb2059af2c2cd2` / `5ba5c379deaa827d1926ee42488e653816551294b7319ba7bbb2aa726bd341e9` / `47e94c428dc10763dd17ee8681f8d269b83e9726a6c8c6a578de29fa0c79761a` |
| `CAN-031` | medium / P2 | Direct Treasury preparation failure permanently locks all direct movements | `findings/direct-treasury-preparation-lockout/direct-treasury-preparation-lockout.md`; `artifacts/05_findings/CAN-031/validation_report.md`; `artifacts/05_findings/CAN-031/attack_path_analysis_report.md` | `0311c2ff59035c5090d947b37ee00e3f775ec3dccf67b78d097c6a789016c00a` / `11553ba7d566670d93980c5bbea95826c55f455bfc51f3dcee718477a3c6ba46` / `a0d9810f6e41fea98f44be31c2484044a71a40ab3a2722928377c84ead883804` |
| `CAN-032` | medium / P2 | Unchecked policy-file provenance lets a local Agent process replace operator authority | `findings/policy-file-provenance-bypass/policy-file-provenance-bypass.md`; `artifacts/05_findings/CAN-032/validation_report.md`; `artifacts/05_findings/CAN-032/attack_path_analysis_report.md` | `b259044e537034bc540c761285abd060ccc442ebdd9b1de82a70bd5839c97f11` / `9e2a2aefc55207fcee86de11d2b30d87e720d43450471560e33a4c7f647221d5` / `42d92ff56bd4ce3cf44152c61fcf344e224e6985320a43b096f26510de63fe3a` |
| `CAN-033` | medium / P2 | Spending a staging-race winner erases evidence needed to close recovery accounting | `findings/spent-staging-winner-evidence-loss/spent-staging-winner-evidence-loss.md`; `artifacts/05_findings/CAN-033/validation_report.md`; `artifacts/05_findings/CAN-033/attack_path_analysis_report.md` | `6c7e0cea57ec8c9b705a59439e8ec5088d5deb0951b36db225209c091f06b6ec` / `d19308e7a50d239419dbfa064104b59f0215d345be1a2883decabc9ab7d0f8c1` / `9754a826c1f79073ebb667c9501716dbe0c3b34f10a7aca7f646ce01dd4b5e2f` |

## Opportunity clustering

- `proof-backed-chain-evidence`: `CAN-003`, `CAN-004`, `CAN-006`,
  `CAN-016`, `CAN-017`, `CAN-018`, `CAN-020`, `CAN-023`, `CAN-024`,
  `CAN-025`, `CAN-026`, `CAN-030`, and `CAN-033` all cross from
  current-view RPC or Merchant-selected finality into durable Settlement,
  winner, vault, or capacity state. The repeated control is proof level,
  identity, history, and finality ownership.
- `trusted-operator-provisioning`: `CAN-001`, `CAN-007`, `CAN-008`, and
  `CAN-032` all depend on trusted operator intent being represented by raw
  Agent input, permissive runtime flags, or a file whose provenance is not
  enforced at the consumption boundary.
- `bounded-operation-lifecycles`: `CAN-009`, `CAN-013`, `CAN-027`, and
  `CAN-031` retain descriptors, prompt jobs, immutable disk, policy capacity,
  or a global operation slot without one aggregate admission and release
  lifecycle.

All twenty-one reportable findings are represented exactly once in this
inventory. This clustering is a design diagnosis, not a remediation claim.

## Evidence limitations

- The source and proofs are for Testnet-10 and the current human-present exact
  profile. No production deployment or mainnet behavior was measured.
- No latency, throughput, peak-memory, node-storage, evidence-retention, or
  availability budget was supplied. Tradeoffs are source-derived or
  hypothetical unless an individual finding reproduction states otherwise.
- A proof-verifying Kaspa inclusion interface was not demonstrated in the
  repository. The chain-evidence options therefore separate the owned Sompi
  boundary from the backend that can satisfy it.
- The operator configuration distribution model is currently single-host.
  The signed-bundle option is intentionally conditional on future multi-host or
  offline administration needs.
- No implementation output was created. Every proposed option still requires
  tactical fixes, tests, rollout evidence, and revalidation of the original
  PoCs before a finding can be considered closed.
