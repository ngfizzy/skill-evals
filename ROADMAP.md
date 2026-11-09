# Skill Evals roadmap

Updated 9 November 2026.

The current CLI runs response-only evaluations through the Codex CLI. The operator and judge run in
separate sessions with independently selectable models. Keep that mode available as the project adds
providers and new ways to evaluate skills.

## 1. Compare the Codex CLI and Codex SDK

Run the same synthetic operator and judge cases through both interfaces. Compare fresh sessions,
tool and inherited-context isolation, model selection, structured judge output, authentication,
cancellation, and report replay. Use the current CLI as the reference and record the results in a
decision note. Migrate the adapter if the SDK preserves the evaluation contract and offers a clear
maintenance or capability benefit.

## 2. Add a Claude Code adapter

Verify that Claude Code can run operator and judge calls with fresh sessions, explicit models, and
controls for inherited instructions, hooks, and tools. Check native authentication, account usage,
final-response extraction, and judge output against the shared grading contract. Use synthetic cases
to prove the isolation and failure paths before adding the provider option.

## 3. Add a GitHub Copilot adapter

Check that the installed Copilot CLI can isolate sessions and control inherited instructions, hooks,
and tools. Add provider selection and record the provider, runtime version, and model choices in
reports. Verify the packaged CLI with synthetic pass, fail, and error cases.

## 4. Run sandboxed outcome and simulation evals

Add a separate mode where the operator can call explicitly allowed tools in a disposable
environment. Start with synthetic files or mock services, capture the tool trace, and grade the
resulting state with deterministic assertions where possible. Include a simulation where the
operator must recover from a tool failure. Prove that the environment enforces filesystem, network,
and credential boundaries, including cleanup on cancellation.

## 5. Grade skill usage across sessions with a sidecar

Build a read-only grader that can review all sessions in a user-authorized scope, including
historical sessions and new sessions as they finish. Grade whether a skill was relevant, whether it
was loaded, and whether the agent followed it. Report each verdict separately and link it to session
evidence and the skill version when available. Mark missing evidence as unobservable and report
review coverage. Keep feedback in a private sidecar report separate from the active sessions.
