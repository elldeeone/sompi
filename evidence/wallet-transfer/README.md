# Wallet and Transfer canary

This directory records the funded Testnet-10 wallet and Transfer canaries.

The run used a clean Journal epoch, a fresh SilverScript vault, the isolated
Telegram Authority, the local Sompi API, and the installed Hermes skill on
Terah. It proves:

- wallet balance, address, limits, and activity queries;
- a human-approved native KAS Transfer;
- the same Transfer initiated from a natural-language Hermes instruction;
- exact recipient amounts and bounded fees;
- normal recovery from submitted to receipted;
- unchanged Kaspa-x402 `standard-native` Purchase settlement; and
- fail-closed handling before broadcast for an uneconomic tiny output.

The report contains no wallet key, Authority key, API credential, Telegram
token, recovery key, prepared transaction, or private node URL.

`terah-transfer-limit-0.9.1.json` records the `0.9.1` regression canary. A
human-approved Transfer sent exactly the configured per-transfer maximum of
`100,000,000` sompi while accounting for its fee separately. The old failed
Transfer remained terminal and was not retried.

`terah-automatic-funding-0.10.0.json` records the `0.10.0` wallet-UX canary.
Terah detected funds at the same receive address, secured them through one
durable vault-deposit transaction without an approval prompt, preserved epoch
16, and exposed the resulting balance and activity in tKAS.
