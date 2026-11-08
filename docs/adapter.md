# Codex adapter

The adapter runs the official `@openai/codex` dependency at `0.165.0` on macOS and Linux by default.
It resolves the package from the runner's installation and starts its launcher with Bun.
`--codex PATH` selects a different executable. Preflight checks the exact version, required flags
and named feature availability. New versions fail closed until their tool/configuration changes are
audited. Authentication is supplied by the installed Codex CLI; this package stores no credentials
and does not copy authentication files.

The CLI executes TypeScript directly with Bun 1.4.4+. Its subprocess adapter continues to use the
Node-compatible child_process APIs, including POSIX process groups. Timeout, abort and leader-exit
cleanup are tested under Bun.

## Process and session boundaries

Each call uses a fresh temporary directory, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`,
`--strict-config`, `--sandbox read-only`, `--skip-git-repo-check`, `project_doc_max_bytes=0`,
`mcp_servers={}` and disabled host skill discovery. Web search is disabled. The adapter explicitly
disables shell, apps, plugins, hooks, memories, multi-agent, browser/computer use, image
generation/viewing, sleep, workspace dependencies, skill search, artifact, code mode, goals and
default-mode user-input tools. Candidate and judge reasoning are configured independently by
`--effort` and `--judge-effort`, each defaulting to `low`. Allowed values are `low`, `medium`,
`high` and `xhigh`; invalid values fail before execution. Both settings are passed explicitly and
recorded in the report. The candidate and judge use separate invocations, with no resumed state.

The CLI JSONL stream is parsed strictly. Only lifecycle events, reasoning and agent-message items
are accepted. Errors, tool items, unknown events, malformed JSON and missing turn/message completion
invalidate the call. Temporary response and schema files are removed after each call. Model response
files are bounded and must be regular UTF-8 files.

Processes run in their own POSIX group. Timeout, cancellation, combined stdout/stderr overflow and
leader exit terminate that group, including children holding inherited pipes open. The output bound
is 2 MiB per call; diagnostic errors retain a bounded tail. Windows is intentionally unsupported
until an equivalent process-tree cleanup implementation exists. This does not contain a malicious
process that creates an independent process group; use a trusted Codex binary. Caller SIGKILL cannot
run cleanup handlers; use SIGINT/SIGTERM to stop a run cleanly. Preflight probes have a 20-second
bound each.

The model still communicates with the provider. Managed host requirements can block an invocation.
Host authentication and policy remain trusted dependencies; this package cannot override enforced
policy safely. The actual evaluated input should contain synthetic or appropriately authorized
instructions and scenarios.

Run `bun run audit:codex` to inspect the actual Responses request using a temporary localhost mock
provider with provider authentication disabled. The audit checks that the adapter exposes zero tools
and forwards independent candidate/judge effort settings. It records no headers or prompt bodies and
makes no model calls.

## Provider extension boundary

The internal `Agent` interface supplies `preflight`, version metadata and bounded `call` operations
with model, reasoning effort, optional output schema and cancellation signal. The evaluator owns
prompts and deterministic validation; the adapter owns isolation, transport and response extraction.
No additional provider is required for this release. This internal boundary is not a supported
library API.

## Primary references

Flags and feature availability were checked against installed CLI help on 29 October 2026. Relevant
current official documentation:

- [Noninteractive Codex commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

The documented `--ignore-user-config` flag preserves authentication through `CODEX_HOME`; the
shell-tool feature controls command execution. These controls must be rechecked when the supported
CLI changes.
