# Proof of concept

This probe contrasts the same staging race before and after the winning exact
payment output is spent. It loads Sompi's built production observer and
classifier, then runs the two project regressions that cover fail-closed
classification and the durable coordinator state.

## Requirements

- Node.js and npm versions supported by the target revision
- GNU Make or a POSIX shell
- a Sompi checkout at revision
  `4ebb82d4f82bac46ae3addd112c4752f29630a8a`

Place the checkout at `../../sompi` relative to this directory, then build and
run:

```sh
git -C ../../sompi checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm --prefix ../../sompi ci
npm --prefix ../../sompi run build
make SOMPI_TARGET=../../sompi
```

If the checkout is elsewhere, pass a different relative path as
`SOMPI_TARGET`. The probe performs no RPC network connection, signing,
submission, or wallet mutation. It uses a deterministic in-process RPC stub
and creates only the temporary files already used by the project's targeted
tests. Those tests clean up their own temporary directories.

The decisive output is:

```text
[+] before secondary spend: exact=observed, recovery=absent
[+] after secondary spend: exact=absent, recovery=absent
[+] attributed staging spender: <missing>
[+] classifier after: conflict/unknown_staging_spender
[+] coordinator regression confirmed failed_terminal with in_flight reservation
```

`expected-output.txt` contains representative output from the complete run.
