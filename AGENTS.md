# NavApp Agent Instructions

## Documentation & Implementation Plans

- **Always save all implementation plans in `devops/docs/`** (e.g., `devops/docs/<feature>-implementation-plan.md`), rather than keeping them only in temporary agent artifact directories.
- If an implementation plan has companion PRD or specification documents (e.g., `devops/docs/<feature>-prds.md`), save those in `devops/docs/` as well and link to them using relative paths (e.g., `[feature-prds.md](./feature-prds.md)`).
- Inside files stored in `devops/docs/`, use relative repository paths (e.g., `../../src/...`, `../...`) instead of machine-specific `file:///` absolute paths.
- When adding a new plan or specification document to `devops/docs/`, add a brief entry for it in `devops/docs/README.md`.
