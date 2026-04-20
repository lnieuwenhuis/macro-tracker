<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Workspace Cleanup

After finishing code or test changes, remove generated test artifacts before handing off or committing. In `apps/web`, that includes `/.playwright-db-*`, `playwright-report`, `test-results`, and `coverage` unless the user explicitly asks to keep them.
