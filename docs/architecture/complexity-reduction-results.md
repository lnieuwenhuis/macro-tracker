# Complexity-reduction results

Closing record for the plan in `complexity-reduction-plan.md`.
Measured on `dev` at `cb72c117` (after PR #159); the plan's baseline was
`origin/dev` at `b14980e4`. Line numbers in the plan refer to that commit.

## Outcome

| Area | Before | After | Delta |
| --- | ---: | ---: | ---: |
| `apps/backend/src` (incl. tests) | 20,538 | 19,575 | −963 |
| `apps/web/components` | 13,732 | 13,455 | −277 |
| `apps/web/lib` | 4,525 | 4,297 | −228 |
| `apps/web/app` | 3,300 | 3,253 | −47 |
| `apps/web/tests` | 11,828 | 11,848 | +20 |
| `packages/db/src` | 2,696 | 2,472 | −224 |
| `packages/db/tests` | 5,299 | 5,219 | −80 |
| Listed areas, total | 61,918 | 60,119 | −1,799 |
| Tracked source lines (excl. generated/vendored) | ~62,000 | 60,689 | ~−1,300 |

Comment lines (same `awk` procedure as the plan):

| Area | Before | After |
| --- | ---: | ---: |
| `apps/backend/src` | 1,113 (5%) | 373 (2%) |
| `apps/web/components` | 264 (2%) | 82 (1%) |
| `apps/web/lib` | 391 (9%) | 77 (2%) |
| `apps/web/app` | 59 (2%) | 12 (0%) |
| `packages/db/src` | 161 (6%) | 45 (2%) |
| `apps/web/tests` | 411 (3%) | 200 (2%) |
| `packages/db/tests` | 89 (2%) | 51 (1%) |
| Production total | ~2,000 | 589 |

Gates on the closing commit:

- `pnpm audit:duplicates`: 0 clones (was 13).
- `pnpm audit:unused` (knip): clean.
- `cargo clippy -p macro-tracker-backend --all-targets`: zero warnings (was 1).
- Production comment lines: 589, below the 800 target. No production file
  keeps a comment longer than one line except where the merging review
  accepted a two-line security one-liner pair (split only for line length,
  e.g. API-03, SEC-08).
- Full CI gate (unit, DB package, typecheck/lint/build, browser E2E) is green
  on every merged PR below, including E2E for all component/app touches.
- No file under the plan's do-not-edit list changed.

## Merged PRs

#137 (plan doc), #138 F4, #139 D1, #140 T2, #141 C1 group 1, #142 B1,
#143 T1, #144 C1 group 3, #145 F1, #146 B2+B5, #147 B3, #148 C1 group 5,
#149 B4, #150 F2, #151 T3, #152 C1 group 2, #153 C1 group 4, #154 C1 group 6
(TS tests), #155 Rust test modules, #156 E2E flake fix (slot-chip wait),
#157 backend sweep, #158 components sweep, #159 web/lib/app sweep.

Recorded as skipped/deferred per the plan: F3 (no second FormData consumer
appeared), T4 (owned by the godfiles audit). `apps/web/tests` grew by 20
lines because comment removals there were paired with new pinning tests
(API traversal caveat, CSRF boundary, bootstrap nonce, idempotency key).

Honest note: the line-count reduction (~1,800 in the listed areas) came in
below the plan's 3,500–5,500 estimate. The comment-text goal (below 800,
from ~2,000) is met, duplicates are at zero, and clippy is clean. No scope
was widened to chase the estimate.
