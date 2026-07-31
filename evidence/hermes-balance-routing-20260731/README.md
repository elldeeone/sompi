# Hermes balance routing repair

This evidence records the repair on 2026-07-31.

## Fault

Two faults caused the first wrong answer:

- An obsolete Hermes skill claimed the same wallet balance questions as the
  canonical Sompi skill.
- The Hermes command launcher named a removed Sompi `0.12.0` compatibility
  venv in its shebang and editable package location.

The Sompi API and active wallet were healthy.

## Repair

- The obsolete skill was removed from the active Hermes skill tree.
- The canonical Sompi skill now owns direct KAS and tKAS balance questions.
- The Hermes editable package and command launcher now use the stable Hermes
  checkout.
- The gateway environment puts the stable Hermes venv first in `PATH`.
- Host Bootstrap has a regression test for this stable path.

## Verification

- The package release test passed all six checks.
- The disposable root-container Host Bootstrap proof passed all 46 checks.
- The Hermes gateway restarted and remained active.
- `hermes --version` ran from the normal user launcher.
- One live question returned `0.8333003 tKAS available (Testnet-10)`.
- A continuation rechecked total, available, incoming, and pending funds.
- A historical-balance question said that older funds can belong to a retired
  epoch. It did not call those funds stale or lost.

## Retired epoch

The epoch-19 archive passed its complete SHA-256 checksum set.
The owner recovery record remains a root-owned mode-`0600` file.

Public Testnet-10 evidence showed:

- `9,992.2138806 tKAS` in the retired vault;
- `0.1 tKAS` at the retired receive address.

These funds are separate from the active epoch-20 balance.
No owner key was read.
No recovery transaction was created or broadcast.
