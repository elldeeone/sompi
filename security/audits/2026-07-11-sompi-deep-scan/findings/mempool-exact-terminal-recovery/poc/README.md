# Mempool exact-winner terminal recovery PoC

This PoC exercises Sompi's real compiled `PurchaseJournal` and
`PurchaseCoordinator` from revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a`. It creates an authorised test
Purchase with a staged vault output, an immutable exact-payment candidate, and
an `accepted` recovery-finality requirement. It then records that candidate as
an `exact_payment_won` observation at only `mempool` finality.

After closing and reopening the SQLite journal, the script demonstrates that:

- the recovery Effect is durably `observed`;
- the Reservation remains `in_flight` and neither spend nor recovery accounting
  exists;
- the coordinator returns `exact_payment_won` without invoking the supplied
  observer; and
- the recovery Effect cannot be claimed for another observation.

The script checks SHA-256 hashes for the decisive source and compiled files
before it runs. A source checkout at a different revision or with stale build
output is rejected. The checkout must already contain `dist/` and
`node_modules/`; build it first if necessary:

```sh
cd sompi
npm ci
npm run build
```

From this PoC directory, pass a relative path to that checkout:

```sh
cd poc
./run.sh ../../../sompi
```

Adjust `../../../sompi` to match the location of the checkout. The PoC uses a
temporary, mode-`0700` directory and removes it on success or failure. It does
not connect to Kaspa RPC, broadcast a transaction, or use a real wallet. Set
`KEEP_POC=1` to retain the temporary SQLite journal for inspection.

Expected output is recorded in `representative-output.txt`.
