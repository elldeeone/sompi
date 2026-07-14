# Sompi deep security scan — 2026-07-11

This directory preserves the canonical and reviewer-facing outputs of the
completed Codex Security deep scan of immutable revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a`.

The scan produced 21 validated findings: 8 medium and 13 low, with no high or
critical findings. They are remediated as three structural workstreams:

1. trusted Operator Provisioning and configuration provenance;
2. typed Chain Evidence, retained accepted history, and explicit finality floors;
3. bounded per-module operation lifecycles.

Contents:

- `report.md`: generated human-readable scan report;
- `scan-manifest.json`: immutable target and scan provenance;
- `findings.json`: canonical findings;
- `coverage.json`: canonical reviewed-surface coverage;
- `findings/`: detailed finding write-ups and compact PoC/supporting files;
- `hardening/`: selected structural proposals, comparisons, and diagrams;
- `exports/results.sarif`: machine-readable projection.

Large worker-local discovery/context copies are intentionally not committed.
They are neither canonical results nor required to reproduce the recorded
findings. Fix verification is tracked in `fix-report.md` and the implementation
plan as remediation proceeds.
