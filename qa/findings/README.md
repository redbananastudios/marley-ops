# QA findings — the queue between the audit and the repair loop

One file per finding. The audit writes them; a GitHub Action turns each new file into a labelled issue; the repair agent (Codex) fixes `safe-fix` findings on a branch and PRs to `staging` (label `qa-repair`, auto-merges when CI is green); the NEXT audit run re-runs the exact repro and moves the file to `closed/`. `risky` findings are for Peter — automation never fixes them.

## Lifecycle

`open` → `fixing` (repair agent sets this when it starts, with the branch name) → `fixed-pending-verify` (repair PR merged) → moved to `closed/` by the audit that re-verified it. If re-verification fails: `reopened` (stays in `open/`, fresh evidence appended).

## Rules

- Filename = the id: `QA-YYYYMMDD-NN.md` (NN = per-day counter).
- The repro must be exact enough that a different AI with no other context can reproduce and re-verify it: URLs, role, steps, the SQL used as evidence, expected vs actual.
- `class: safe-fix` = display bugs, labels, copy, wrong-column reads/writes, missing revalidation, null-handling, test gaps. `class: risky` = anything touching money math, payments/reconciliation, RLS/permissions, schema, comms templates/sending, auth. When unsure, `risky`.
- Never include secret values or real customer data in a finding.
- The repair agent must add a regression test in its PR (or un-skip the spec the audit shipped skipped) — a fix without a test is not done.

## Template

```markdown
---
id: QA-20260819-01
status: open            # open | fixing | fixed-pending-verify | reopened | closed
class: safe-fix         # safe-fix | risky
severity: high          # high | medium | low
surface: /schedule/removals (appointment view dialog)
found_by_run: 2026-08-19T23:00Z
branch:                 # repair agent fills in
---

## Summary
One sentence: what is wrong, from the user's point of view.

## Repro
1. Role + login used (marker user).
2. Exact steps, URLs, values entered.
3. Expected vs actual (screenshot path in the run's artifacts if useful).

## Evidence
The SQL (or storage/API check) proving it, with the observed result pasted.

## Suspected cause
File:line if known — optional, the repair agent verifies independently.

## Verify
The exact assertion the next audit must re-run to close this.
```
