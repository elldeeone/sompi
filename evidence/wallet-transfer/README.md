# Wallet and Transfer canary

This directory records the funded Testnet-10 canary for Sompi `0.9.0`.

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
