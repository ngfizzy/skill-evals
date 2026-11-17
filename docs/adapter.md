# Codex adapter

The adapter runs the official `@openai/codex` dependency at `0.165.0` on macOS and Linux by default.
It resolves the package from the runner's installation and starts its launcher with Bun.
`--codex PATH` selects a different executable. Preflight checks the exact version, required flags
and named feature availability. New versions fail closed until their tool/configuration changes are
audited. The current evaluation adapter uses the existing Codex login. The internal authentication
service described below has a separate store and is not connected to evaluation commands yet.

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

## Dedicated authentication service

Run `skill-evals auth login`, `skill-evals auth status` or `skill-evals auth logout` to manage the
dedicated ChatGPT login. Login displays the sign-in URL. The evaluator still uses the existing Codex
login. The authentication service is internal to the package.

The store is `$XDG_DATA_HOME/skill-evals/codex-auth`, or `$HOME/.local/share/skill-evals/codex-auth`
when `XDG_DATA_HOME` is unset. The service rejects a store that resolves to the normal `CODEX_HOME`,
invalid ownership or permissions, symlinked store directories, linked credential files, and API-key
authentication. Directories require mode `0700`; credentials and the persistent `.auth.lock` file
require `0600`. Status validates local ChatGPT credentials; it does not contact OpenAI or establish
quota or subscription access.

Every operation acquires the same exclusive `flock(2)` lock before reading credentials or creating
an auth link. A waiter can cancel and has a 120-second default deadline. Login has a 15-minute
deadline; native version checks and logout each have 20 seconds. The trusted Bun launcher starts the
pinned native Codex binary directly and passes the lock as descriptor 3. Closing the launcher's
descriptor preserves a surviving native process's lock. The service never deletes the lock file or
explicitly unlocks a descriptor shared with a child.

Auth operations get a fresh home, working directory, XDG paths and temporary directory, with an
explicit environment allowlist. Codex starts browser login with an empty credential directory. The
guardian verifies and publishes the staged login after the worker group stops. Native logout
receives a temporary `auth.json` symlink to the managed file. The service removes the unchanged
managed target and preserves a file changed unexpectedly during logout. The guardian owns temporary
workspace cleanup, including cancellation. Errors use fixed reason codes. Only validated official
sign-in URLs are streamed to the caller.

Before exposing an auth link, the launcher creates an owner-only `.auth-context.json` cleanup record
in the managed store. It contains workspace identity and the cleanup guardian's PID, never
credentials. Before starting native authentication, the launcher transfers the same lock descriptor
to a guardian and an authenticated worker. The worker and native Codex run in a process group whose
ID is the guardian's live PID. The guardian moves back to its original group before authorizing the
worker. A bounded startup helper creates a control group if the original group has exited. The
guardian's live PID reserves the worker group's numeric ID, so it cannot signal a group that reused
an exited launcher's PID. On completion, timeout or parent loss, the guardian terminates and
confirms exit of its worker group, removes the matching workspace and cleanup record, then exits to
release its descriptor. Linux supervisors adopt and reap orphaned descendants. On macOS ARM64, the
supervisor queries kernel process status and confirms that any remaining group members have exited
and are awaiting reaping. The guardian monitors parent loss through `getppid(2)`. It rechecks the
login file under the lock after group shutdown and reports success only after cleanup completes.

Context cleanup removes and verifies the auth link before deleting other temporary files. If cleanup
fails, the guardian keeps the actual OS lock and retries cleanup; it never expires or steals
ownership. The caller gets `cleanup-required` after a bounded cleanup wait. Restoring access to the
original workspace lets cleanup finish. If the guardian itself is killed, its record still blocks
store reuse. Explicit recovery requires confirming that writers have stopped and removing the
recorded temporary workspace before removing that operation's record. Never remove a record or stop
a guardian merely to bypass a surviving writer. The record supplements `flock` rather than replacing
it.

This lock binding requires exactly Bun `1.4.4`. Audited targets are macOS ARM64 and Linux ARM64/x64
with glibc or musl, on allowlisted local filesystems. Bun FFI is experimental; runtime upgrades
require a new audit. An advisory lock protects participating callers, not hostile filesystem writers
or a Codex process launched separately against the managed store.

Run `bun run audit:auth-lock` to verify that the packaged native Codex retains the production lock
after its launcher dies and releases it on exit. It uses a temporary localhost mock without account
credentials or model calls. The audit accepts an optional native executable path for platform tests.

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
