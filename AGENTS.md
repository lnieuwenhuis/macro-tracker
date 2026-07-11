# Agent Guidance

## Branch Workflow

- Work on `dev` by default unless the user explicitly asks for a different branch.
- When work is complete, open a ready-for-review, non-draft pull request from `dev` into `staging` unless the user explicitly asks for a different target or says not to open a PR.
- Before publishing, verify the PR direction is `head=dev` and `base=staging`.

## Versioning Discipline

- Bump the app version when a feature is implemented, for example `2.06` to `2.07`.
- Bug fixes for that feature keep the same feature version, so fixes to `2.07` behavior remain `2.07`.
- Only major revisions, major new features, or major UI/UX overhauls should bump the major version, and major releases restart the minor number, for example `2.07` to `3.01`.
- Mention any intended version bump in the change summary or PR notes when applicable.

## Token-Efficient Execution

- Prefer targeted `rg` searches, bounded file ranges, and path-specific diffs over broad file or log dumps.
- Batch independent inspections and verification commands when doing so keeps their output readable.
- Run focused tests for the changed behavior first, then run the broader required suites once the change is stable.
- Keep command output concise while preserving the exact failures, warnings, and evidence needed to diagnose problems.
- Reuse established repository facts and prior command results instead of rereading unchanged files without a concrete reason.
