export const HELP = `Usage: skill-evals [options]

Response-only skill evaluations. Live runs require an explicit model.
  --root SOURCE       Directory or git+https://HOST/OWNER/REPO.git[#REV]; repeatable
                      (default: current directory; explicit roots replace default)
  --load-skill NAME   Load cases only for this skill; repeatable
  --skill NAME        Skill filter; repeatable
  --case KEY          Full skill/case key; repeatable; intersects skill filters
  --list              List ALL filtered cases, ignoring limit; no agent calls
  --limit N           Maximum live cases (default: 5)
  --timeout N         Seconds per agent call (default: 120)
  --model MODEL       Candidate model; required for live runs
  --judge-model MODEL Judge model (default: candidate model)
  --context MODE      full (default) or focused per-case references
  --effort LEVEL      Candidate reasoning: low (default), medium, high, xhigh
  --judge-effort LEVEL Judge reasoning (same choices; default: low)
  --codex PATH        Override the project Codex executable (audited: 0.165.0)
  --output PATH       New private JSON report; refuses overwrite
  --color MODE        auto (default), always or never; auto honors NO_COLOR
  --progress MODE     auto (TTY live/non-TTY plain), plain or none
  --width N           Display width (default: terminal width; no pipe wrapping)
  --ui MODE           auto (TTY interactive), interactive or plain
  --view PATH         Inspect a saved report; no model calls
  --full-input        Include the exact operator prompt in plain output
  -h, --help          Show help

Git roots use default HEAD or a full branch/tag ref or commit ID. Rerun with the
commit saved in the report, e.g. git+https://HOST/OWNER/REPO.git#COMMIT.
Exit: 0 all passed/list/help; 1 behavioral failures; 2 execution/config/grading errors.
Each case uses two fresh model sessions. No tools or live integrations are evaluated.
Interactive: [/] cases, Tab sections, Enter toggle, s skill, p prompt, arrows scroll,
Home/End jump, f follow current case, ? help, q quit (confirms while running).
`;
