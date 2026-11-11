import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Inspect the TypeScript package without executing lifecycle scripts.
const cache = mkdtempSync(join(tmpdir(), 'skill-evals-pack-cache-'));
let result;

try {
  result = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json', '--cache', cache], {
    encoding: 'utf8',
  });
} finally {
  rmSync(cache, { recursive: true, force: true });
}

assert.equal(result.status, 0, result.stderr);
const files = (JSON.parse(result.stdout) as { files: { path: string }[] }[])[0]!.files
  .map((entry) => entry.path)
  .sort();

const expected = [
  'package.json',
  'bunfig.toml',
  'tsconfig.json',
  'README.md',
  'LICENSE',
  'PROVENANCE.md',
  'src/cli.ts',
  'src/adaptors/codex-helpers.ts',
  'src/adaptors/codex.ts',
  'src/adaptors/index.ts',
  'src/adaptors/types.ts',
  'src/catalog/catalog.ts',
  'src/catalog/helpers.ts',
  'src/catalog/index.ts',
  'src/catalog/root.ts',
  'src/catalog/types.ts',
  'src/display/components/index.ts',
  ...[
    'assertion-item',
    'badge',
    'body',
    'case-heading',
    'case-list',
    'case-sections',
    'confirm-bar',
    'count',
    'error-verdict',
    'footer',
    'graded-verdict',
    'header',
    'help-panel',
    'notice',
    'pending-verdict',
    'quote',
    'response-body',
    'run-view',
    'section-header',
    'verdict-body',
    'view-boundary',
  ].map((name) => `src/display/components/${name}.tsx`),
  'src/display/contexts/theme-context.ts',
  'src/display/hooks/use-anchored-case.ts',
  'src/display/hooks/use-run-elapsed.ts',
  'src/display/hooks/use-run-layout.ts',
  'src/display/hooks/use-run-navigation.ts',
  'src/display/hooks/use-section-sizes.ts',
  'src/display/hooks/use-theme.ts',
  'src/display/index.ts',
  'src/display/interactive.tsx',
  'src/display/output.ts',
  'src/display/run-display.ts',
  'src/display/sections.ts',
  'src/display/terminal.ts',
  'src/display/types.ts',
  'src/display/view-model.ts',
  'src/display/theme.ts',
  'src/evaluation/batch-runner.ts',
  'src/evaluation/helpers.ts',
  'src/evaluation/index.ts',
  'src/evaluation/orchestrator.ts',
  'src/evaluation/protocol.ts',
  'src/evaluation/schemas.ts',
  'src/evaluation/types.ts',
  'src/judge/helpers.ts',
  'src/judge/index.ts',
  'src/judge/judge.ts',
  'src/judge/output-schema.ts',
  'src/judge/types.ts',
  'src/operator/index.ts',
  'src/operator/operator.ts',
  'src/operator/types.ts',
  'src/process/index.ts',
  'src/process/process.ts',
  'src/process/types.ts',
  'src/prompts/index.ts',
  'src/prompts/judge.ts',
  'src/prompts/operator.ts',
  'src/report/helpers.ts',
  'src/report/index.ts',
  'src/report/inspection.ts',
  'src/report/types.ts',
  'src/report/writer.ts',
  'src/runner/console-io.ts',
  'src/runner/help.ts',
  'src/runner/helpers.ts',
  'src/runner/index.ts',
  'src/runner/options.ts',
  'src/runner/runner.ts',
  'src/runner/types.ts',
  ...['git-command', 'git-tree', 'git', 'index', 'input', 'local', 'resolve', 'types'].map(
    (name) => `src/sources/${name}.ts`,
  ),
  'src/utils/files.ts',
  'src/utils/index.ts',
  'src/utils/message.ts',
  'src/utils/sha256.ts',
  'src/utils/terminal-text.ts',
  'src/utils/validation.ts',
  ...['cases', 'reports', 'adapter'].map((name) => `docs/${name}.md`),
  'examples/basic/external-skills.yaml',
  'examples/basic/skills/routing/SKILL.md',
  'examples/basic/skills/routing/eval.yaml',
  'examples/basic/skills/routing/references/routes.md',
  'examples/basic/skills/caution/SKILL.md',
  'examples/basic/skills/caution/evals/evals.json',
].sort();

assert.deepEqual(files, expected, 'Tarball content must match the reviewed allowlist exactly');

const PRIVATE_MATERIAL_PATTERN =
  /\/Users\/|Documents\/Codex|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|sk-(?:proj-)?[A-Za-z0-9_-]{24,}/;

for (const path of files) {
  const content = readFileSync(path, 'utf8');
  assert.doesNotMatch(content, PRIVATE_MATERIAL_PATTERN, `Private material in ${path}`);
}
console.log(
  `Pack content check passed: ${files.length} reviewed files; no reports, tests, source workspaces or credentials.`,
);
