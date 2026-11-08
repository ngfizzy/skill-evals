# Agent instructions

This repository owns the standalone `skill-evals` CLI. Keep private planning, reports, credentials,
source checkout locations and real consumer cases outside this checkout. Use synthetic fixtures for
automated tests and live smoke tests.

Keep the executable entrypoint thin. The catalog, evaluator, adapter and report writer own their
existing boundaries. Preserve the response-only protocol and keep malformed grading separate from
candidate failure. Fail closed when the Codex isolation surface has not been audited for a new CLI
version.

Author application code, tests and maintenance scripts in TypeScript with explicit `.ts` or `.tsx`
imports. Run directly with Bun; do not restore a generated JavaScript source tree. Keep Bun's
automatic environment-file loading disabled. Use Prettier's 100-column target across the repository.
Run `bun run format` to apply formatting and `bun run format:check` to verify it.

Group imports by runtime built-ins, third-party packages, shared project modules, and local
siblings. Use one blank line between groups. Inside functions, use blank lines between distinct
steps such as validation, setup, persistence, and result handling. Keep statements that perform the
same step together.

Load OpenTUI dynamically for interactive mode only. Keep plain output usable without initializing
the native renderer. Share case sections across both views, and never infer skill boundaries by
splitting the recorded prompt. Keep each interactive React component in its own file under
`src/display/components/`. Define custom hooks in `src/display/hooks/` and context objects in
`src/display/contexts/`. Components import the hooks and context they use. When a component chooses
between distinct views, return a named component for each branch.

Run `bun run check`, `bun test`, `bun run pack:check`, `bun run install:check` and markdownlint on
touched Markdown before handoff. Live tests are explicit and bounded. Any source change requires the
workspace's fresh-context review gate. Public release, npm publish, repository visibility, merge and
consumer migration remain separate actions.
