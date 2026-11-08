import test from 'node:test';
import assert from 'node:assert/strict';

import { CliRenderEvents, TextAttributes } from '@opentui/core';
import type { CapturedSpan } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { act } from 'react';
import { createRoot } from '@opentui/react';

import { RunView, type ViewSnapshot } from '../src/display/components/index.ts';
import { createInteractive } from '../src/display/interactive.tsx';
import { withSummary } from '../src/report/index.ts';
import { sha256 } from '../src/utils/sha256.ts';
import { candidatePrompt } from '../src/prompts/operator.ts';
import { palette } from '../src/display/view-model.ts';
import type { CaseResult, EvaluationCase } from '../src/evaluation/index.ts';

import { reportFixture } from './helpers/fixture.ts';
import { contrastRatio, hex } from './helpers/contrast.ts';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const skill = '# Loaded synthetic skill\nSKILL-SECRET-TEXT\nKeep uncertainty.';
const result: CaseResult = {
  key: 'routing/one',
  skill: 'routing',
  id: 'one',
  title: 'Keeps uncertainty',
  prompt: 'The service may be slow because its queue is full. Explain this more simply.',
  source: 'fixture',
  source_sha256: 'fixture',
  skill_sha256: sha256(skill),
  skill_instructions: skill,
  candidate_input: 'EXACT-PROMPT-MARKER\n' + skill,
  response: 'It might be slow because too much work is waiting.',
  criteria: [{ id: 'uncertain', text: 'Keeps uncertainty.', required: true }],
  assertions: [
    {
      id: 'uncertain',
      text: 'Keeps uncertainty.',
      required: true,
      passed: true,
      reason: 'Uses might instead of promising certainty.',
      evidence: 'It might be slow because too much work is waiting.',
      evidence_ids: ['line-1'],
    },
  ],
  status: 'passed',
  score: 1,
};

const press = async (
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  key: string,
): Promise<void> => {
  await act(async () => {
    setup.mockInput.pressKey(key);
  });
  await setup.flush();
};

test('native React view opens pass details, hides skill/prompt, toggles safely and keeps selection during results', async () => {
  const setup = await createTestRenderer({ width: 140, height: 60 });
  const root = createRoot(setup.renderer);
  const report = reportFixture(2);
  report.results = [result];
  let snapshot: ViewSnapshot = {
    report: withSummary(report),
    entries: [result, { ...result, key: 'routing/two', title: 'Second case' }],
    path: 'synthetic.json',
    finished: false,
  };
  let exits = 0;
  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(
        <RunView
          snapshot={snapshot}
          options={{ color: 'never', progress: 'none' }}
          onExit={() => exits++}
          onFailure={assert.fail}
        />,
      );
    });
    await setup.flush();
  };
  try {
    await render();
    let frame = setup.captureCharFrame();
    assert.ok(frame.includes(result.prompt));
    assert.ok(frame.includes(result.response!));
    assert.ok(frame.includes(result.assertions![0]!.reason));
    assert.match(frame, /✓ PASS uncertain · Must/);
    assert.match(frame, /Evidence/);
    assert.match(frame, /CASES\s+1 of 2/, 'wide terminals show the case list');
    assert.match(frame, /✓ PASSED\s+routing\/one/);
    assert.match(frame, /1 of 1 criteria met/);
    assert.match(frame, /1\/2 complete/);
    assert.match(frame, /▸ Loaded skill\s+\d+ B · hidden · s to show/);
    assert.match(frame, /▸ Exact operator prompt\s+\d+ B · hidden · p to show/);
    assert.doesNotMatch(frame, /SKILL-SECRET-TEXT|EXACT-PROMPT-MARKER/);
    await act(async () => {
      setup.mockInput.pressKey('s');
    });
    await setup.flush();
    frame = setup.captureCharFrame();
    assert.match(frame, /SKILL-SECRET-TEXT/);
    await act(async () => {
      setup.mockInput.pressKey('s');
    });
    await setup.flush();
    assert.doesNotMatch(setup.captureCharFrame(), /SKILL-SECRET-TEXT/);
    await act(async () => {
      setup.mockInput.pressKey('p');
    });
    await setup.flush();
    assert.match(setup.captureCharFrame(), /EXACT-PROMPT-MARKER/);
    await act(async () => {
      setup.mockInput.pressKey('p');
    });
    await setup.flush();
    report.results = [...report.results, { ...result, key: 'routing/two' }];
    snapshot = {
      ...snapshot,
      report: withSummary(report),
      current: { key: 'routing/two', phase: 'judge' },
    };
    await render();
    frame = setup.captureCharFrame();
    assert.match(
      frame,
      /✓ PASSED\s+routing\/one/,
      'navigation pins the reading pane while results arrive',
    );
    assert.match(frame, /case 1 of 2\s+·\s+f to follow the live case/);
    assert.match(frame, /pass\s+routing\/two/);
    assert.match(frame, /2\/2 complete/);
    await act(async () => setup.resize(40, 20));
    await setup.flush();
    frame = setup.captureCharFrame();
    assert.match(frame, /skill-evals/);
    assert.doesNotMatch(
      frame,
      /CASES/,
      'narrow terminals fold the case list into the reading pane',
    );
    assert.match(frame, /\? help/, 'footer key hints stay whole when they wrap');
    await act(async () => {
      setup.mockInput.pressKey('q');
    });
    await setup.flush();
    assert.match(setup.captureCharFrame(), /Stop this run/);
    await act(async () => {
      setup.mockInput.pressKey('n');
    });
    await setup.flush();
    assert.equal(exits, 0);
    report.results = [result];
    snapshot = { ...snapshot, report: withSummary(report), finished: true };
    await render();
    assert.match(setup.captureCharFrame(), /INCOMPLETE/);
    assert.match(setup.captureCharFrame(), /1 pending/);
    assert.doesNotMatch(setup.captureCharFrame(), /Finished/);
    await act(async () => {
      setup.mockInput.pressKey('q');
    });
    await setup.flush();
    assert.equal(exits, 1);
  } finally {
    await act(async () => root.unmount());
    await setup.dispose();
  }
});

for (const stage of ['root', 'render'] as const) {
  test(`UI initialization restores native renderer after ${stage} failure`, async () => {
    const setup = await createTestRenderer({ width: 40, height: 20 });
    let destroyed = false,
      unmounted = false;
    setup.renderer.on('destroy', () => {
      destroyed = true;
    });
    const controller = new AbortController();
    try {
      await assert.rejects(
        createInteractive(
          {
            report: withSummary(reportFixture()),
            entries: [],
            path: 'fixture.json',
            finished: false,
          },
          { color: 'never', progress: 'none' },
          () => {},
          controller.signal,
          {
            createRenderer: async () => setup.renderer,
            createRoot: () => {
              if (stage === 'root') throw new Error('Synthetic initialization failure');
              return {
                render: () => {
                  throw new Error('Synthetic initialization failure');
                },
                unmount: () => {
                  unmounted = true;
                },
              };
            },
          },
        ),
        /Synthetic initialization failure/,
      );
      assert.equal(destroyed, true);
      assert.equal(unmounted, stage === 'render');
      await setup.renderer.closed;
    } finally {
      controller.abort();
      await setup.dispose();
    }
  });
}

test('large loaded skill stays lazy, scrolls, closes, and cannot inject terminal controls', async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const root = createRoot(setup.renderer);
  const report = reportFixture();
  const text = 'Skill sentence with spaces.\n'.repeat(190000) + 'END-OF-LARGE-SKILL\u001b[2J\u202e';
  report.results = [{ ...result, skill_instructions: text }];
  try {
    await act(async () => {
      root.render(
        <RunView
          snapshot={{
            report: withSummary(report),
            entries: report.results,
            path: 'large.json',
            finished: true,
          }}
          options={{ color: 'never', progress: 'none' }}
          onExit={() => {}}
          onFailure={assert.fail}
        />,
      );
    });
    await setup.flush();
    assert.doesNotMatch(setup.captureCharFrame(), /Skill sentence/);
    await act(async () => {
      setup.mockInput.pressKey('s');
    });
    await setup.flush();
    await act(async () => {
      setup.mockInput.pressKey('END');
    });
    await setup.flush();
    const frame = setup.captureCharFrame();
    assert.match(frame, /END-OF-LARGE-SKILL/);
    assert.match(frame, /\\u001b\[2J\\u202e/);
    await act(async () => {
      setup.mockInput.pressKey('s');
    });
    await setup.flush();
    assert.match(setup.captureCharFrame(), /▸ Loaded skill\s+\d+\.\d MB · hidden · s to show/);
    assert.doesNotMatch(setup.captureCharFrame(), /END-OF-LARGE-SKILL/);
  } finally {
    await act(async () => root.unmount());
    await setup.dispose();
  }
});

/** Native cells, not characters: text whose foreground equals its background, or inverse video, is unreadable. */
function assertReadable(spans: CapturedSpan[], context: string): void {
  for (const span of spans) {
    if (!span.text.trim()) continue;
    assert.equal(
      span.attributes & TextAttributes.INVERSE,
      0,
      `${context}: inverse video on ${JSON.stringify(span.text)}`,
    );
    assert.ok(
      !span.fg.equals(span.bg),
      `${context}: foreground equals background on ${JSON.stringify(span.text)}`,
    );
  }
}

test('no-color selection stays readable in native spans: marker and bold, no inverse or same-color fill', async () => {
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const root = createRoot(setup.renderer);
  const report = reportFixture(2);
  report.results = [result, { ...result, key: 'routing/two', title: 'Second case' }];
  report.finished_at = '2026-01-01T00:00:01Z';
  let finished = true;
  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(
        <RunView
          snapshot={{
            report: withSummary(report),
            entries: report.results,
            path: 'no-color.json',
            finished,
          }}
          options={{ color: 'never', progress: 'none' }}
          onExit={() => {}}
          onFailure={assert.fail}
        />,
      );
    });
    await setup.flush();
  };
  const sidebarRow = (key: string): CapturedSpan[] => {
    for (const line of setup.captureSpans().lines) {
      const cut = line.spans.findIndex((span) => span.text.includes('│'));
      const row = cut < 0 ? line.spans : line.spans.slice(0, cut);
      if (row.some((span) => span.text.includes(key))) return row;
    }
    return assert.fail(`No sidebar row for ${key}`);
  };
  try {
    for (const [press_, key] of [
      [undefined, 'routing/one'],
      [']', 'routing/two'],
    ] as const) {
      if (press_) {
        await press(setup, press_);
      } else {
        await render();
      }
      const row = sidebarRow(key);
      const text = row.map((span) => span.text).join('');
      assert.match(
        text,
        new RegExp(`› ✓ pass\\s+${key}`),
        'selected row keeps its visible marker and label',
      );
      assertReadable(row, `selected ${key}`);
      assert.ok(
        row.some((span) => span.text.includes(key) && span.attributes & TextAttributes.BOLD),
        'selected key is bold',
      );
    }
    finished = false;
    report.selected_cases = 3;
    await render();
    await press(setup, 'q');
    const prompt = setup
      .captureSpans()
      .lines.find((line) => line.spans.some((span) => span.text.includes('Stop this run')));
    assert.ok(prompt, 'stop confirmation is shown');
    assertReadable(prompt.spans, 'stop confirmation');
    await press(setup, 'n');
  } finally {
    await act(async () => root.unmount());
    await setup.dispose();
  }
});

for (const variant of ['passed', 'error'] as const) {
  test(`a ${variant} result renders in the next frame without moving the prompt or section focus`, async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const root = createRoot(setup.renderer);
    const entry: EvaluationCase = {
      key: result.key,
      skill: result.skill,
      id: result.id,
      title: result.title,
      prompt: result.prompt,
      criteria: result.criteria,
      source: result.source,
      source_sha256: result.source_sha256,
    };
    const longSkill =
      '# Long skill\n' +
      Array.from(
        { length: 300 },
        (_, index) => `PROMPT-LINE-${String(index + 1).padStart(4, '0')}`,
      ).join('\n');
    const longText = (label: string): string =>
      Array.from(
        { length: 40 },
        (_, index) => `${label}-${index + 1} adds a full line of text.`,
      ).join('\n');
    const base = {
      ...result,
      skill_instructions: longSkill,
      skill_sha256: sha256(longSkill),
      candidate_input: candidatePrompt(entry, longSkill),
      response: longText('RESPONSE'),
    };
    const completed: CaseResult =
      variant === 'passed'
        ? {
            ...base,
            assertions: [
              {
                ...result.assertions![0]!,
                reason: longText('REASON'),
                evidence: longText('RESPONSE'),
              },
            ],
          }
        : {
            ...base,
            status: 'error',
            score: null,
            error_stage: 'grading',
            error: longText('ERROR'),
            judgment: longText('RAW'),
          };
    if (variant === 'error') delete completed.assertions;
    const report = reportFixture(1);
    const snapshot: ViewSnapshot = {
      report: withSummary(report),
      entries: [entry],
      path: 'anchor.json',
      finished: false,
      current: { key: entry.key, phase: 'judge' },
      bundles: new Map([[entry.key, longSkill]]),
    };
    const render = async (): Promise<void> => {
      await act(async () => {
        root.render(
          <RunView
            snapshot={{ ...snapshot, report: withSummary(report) }}
            options={{ color: 'never', progress: 'none' }}
            onExit={() => {}}
            onFailure={assert.fail}
          />,
        );
      });
      await setup.flush();
    };
    const visibleLines = (frame: string): string[] =>
      frame
        .split('\n')
        .flatMap(
          (line, row) => line.match(/PROMPT-LINE-\d{4}/g)?.map((mark) => `${row}:${mark}`) ?? [],
        );
    try {
      await render();
      await press(setup, 'p');
      for (let step = 0; step < 40; step++) await press(setup, 'ARROW_DOWN');
      let frame = setup.captureCharFrame();
      const before = visibleLines(frame);
      assert.ok(before.length > 5, 'reading inside the expanded prompt');
      assert.doesNotMatch(
        frame,
        /Exact operator prompt|Grader verdict/,
        'the prompt heading is above the viewport',
      );
      report.results = [completed];
      let firstFrame: { text: string; responseHeight: number } | undefined;
      setup.renderer.once(CliRenderEvents.FRAME, () => {
        firstFrame = {
          text: setup.captureCharFrame(),
          responseHeight: setup.renderer.root.findDescendantById('block-response')?.height ?? 0,
        };
      });
      await render();
      assert.ok(firstFrame, 'the result produced a frame');
      frame = firstFrame.text;
      assert.ok(
        firstFrame.responseHeight > 40,
        'the long response is laid out in the first frame after the result',
      );
      assert.deepEqual(visibleLines(frame), before, 'the same prompt lines stay on the same rows');
      assert.doesNotMatch(
        frame,
        /RESPONSE-|REASON-|ERROR-|RAW-/,
        'new content above did not push into view',
      );
      await press(setup, 'RETURN');
      frame = setup.captureCharFrame();
      // A numeric focus would now name the skill (error inserts raw judgment above) and Enter would open it.
      assert.match(
        frame,
        /›\s+▸ Exact operator prompt/,
        'Enter still acts on the prompt the reader selected',
      );
      assert.doesNotMatch(frame, /PROMPT-LINE-|RAW-|▾ Raw judgment|▾ Loaded skill/);
    } finally {
      await act(async () => root.unmount());
      await setup.dispose();
    }
  });
}

// Borders, bars and scrollbar cells carry no text, so only text spans are held to contrast rules.
const DECORATIVE = /^[\s│─━░█┃▐▌▀▄▕▏]+$/;

for (const mode of ['dark', 'light', 'unknown'] as const) {
  test(`${mode} theme keeps selected case, status labels and controls readable in colored native spans`, async () => {
    const setup = await createTestRenderer({ width: 120, height: 32 });
    const root = createRoot(setup.renderer);
    const colors = palette(true, mode);
    const owned = new Set(Object.values(colors));
    const report = reportFixture(3);
    const { assertions: _assertions, ...unscored } = result;
    report.results = [
      result,
      {
        ...result,
        key: 'routing/failed',
        status: 'failed',
        score: 0,
        assertions: [{ ...result.assertions![0]!, passed: false }],
      },
      {
        ...unscored,
        key: 'routing/error',
        status: 'error',
        score: null,
        error_stage: 'judge',
        error: 'Timed out',
      },
    ];
    report.finished_at = '2026-01-01T00:00:01Z';
    try {
      await act(async () => {
        root.render(
          <RunView
            snapshot={{
              report: withSummary(report),
              entries: report.results,
              path: 'themed.json',
              finished: true,
            }}
            options={{ color: 'always', progress: 'none' }}
            themeMode={mode}
            onExit={() => {}}
            onFailure={assert.fail}
          />,
        );
      });
      await setup.flush();
      const lines = setup.captureSpans().lines;
      let selectedRow: CapturedSpan[] | undefined;
      for (const line of lines) {
        assertReadable(
          line.spans.filter((span) => !DECORATIVE.test(span.text)),
          `${mode} frame`,
        );
        const cut = line.spans.findIndex((span) => span.text.includes('│'));
        const row = cut < 0 ? line.spans : line.spans.slice(0, cut);
        if (
          row.some((span) => span.text.includes('›')) &&
          row.some((span) => span.text.includes('routing/one'))
        )
          selectedRow = row;
        for (const span of line.spans) {
          const fg = hex(span.fg);
          if (!span.text.trim() || DECORATIVE.test(span.text) || !owned.has(fg)) continue;
          // Owned text colors must work on every background the theme allows.
          const backgrounds =
            mode === 'unknown'
              ? ['#000000', '#ffffff']
              : mode === 'dark'
                ? ['#000000', '#1e1e1e']
                : ['#ffffff', '#f5f5f5'];
          for (const background of backgrounds) {
            assert.ok(
              contrastRatio(fg, background) >= 4.5,
              `${mode}: ${fg} on ${background} for ${JSON.stringify(span.text)}`,
            );
          }
        }
      }
      assert.ok(selectedRow, 'selected sidebar row is rendered with its marker');
      assert.match(selectedRow.map((span) => span.text).join(''), /› ✓ pass\s+routing\/one/);
      const key = selectedRow.find((span) => span.text.includes('routing/one'))!;
      assert.ok(key.attributes & TextAttributes.BOLD, 'selected key is bold');
      if (colors.selectedBg) {
        assert.equal(
          hex(key.fg),
          colors.selectedFg,
          'a fill always comes with its paired foreground',
        );
        for (const span of selectedRow) {
          if (span.text.trim())
            assert.ok(
              contrastRatio(hex(span.fg), colors.selectedBg) >= 4.5,
              `${mode}: ${JSON.stringify(span.text)} on selection fill`,
            );
        }
      } else {
        assert.equal(mode, 'unknown');
        assert.equal(
          colors.selectedFg,
          undefined,
          'unknown backgrounds get no fill and no forced foreground',
        );
        const fills = new Set([
          palette(true, 'dark').selectedBg,
          palette(true, 'light').selectedBg,
        ]);
        assert.ok(
          selectedRow.every((span) => !fills.has(hex(span.bg))),
          'no theme-specific fill is assumed',
        );
      }
    } finally {
      await act(async () => root.unmount());
      await setup.dispose();
    }
  });
}

test('an unreported terminal theme is treated as unknown rather than dark', async () => {
  const setup = await createTestRenderer({ width: 120, height: 24 });
  const root = createRoot(setup.renderer);
  const report = reportFixture(1);
  report.results = [result];
  report.finished_at = '2026-01-01T00:00:01Z';
  try {
    await act(async () => {
      root.render(
        <RunView
          snapshot={{
            report: withSummary(report),
            entries: report.results,
            path: 'detect.json',
            finished: true,
          }}
          options={{ color: 'always', progress: 'none' }}
          onExit={() => {}}
          onFailure={assert.fail}
        />,
      );
    });
    await setup.flush();
    if (setup.renderer.themeMode === null) {
      const used = new Set(
        setup
          .captureSpans()
          .lines.flatMap((line) => line.spans.flatMap((span) => [hex(span.fg), hex(span.bg)])),
      );
      const dark = palette(true, 'dark'),
        unknown = palette(true, 'unknown');
      assert.ok(
        !used.has(dark.selectedBg!) && !used.has(dark.accent!),
        'dark palette is not assumed',
      );
      assert.ok(used.has(unknown.accent!), 'the background-neutral palette is used');
    }
  } finally {
    await act(async () => root.unmount());
    await setup.dispose();
  }
});

test('waiting states explain the actual phase and list pending criteria without invented progress', async () => {
  const setup = await createTestRenderer({ width: 120, height: 50 });
  const root = createRoot(setup.renderer);
  const report = reportFixture(2);
  const entries = [result, { ...result, key: 'routing/two', title: 'Second case' }];
  const render = async (snapshot: ViewSnapshot): Promise<void> => {
    await act(async () => {
      root.render(
        <RunView
          snapshot={snapshot}
          options={{ color: 'always', progress: 'plain' }}
          onExit={() => {}}
          onFailure={assert.fail}
        />,
      );
    });
    await setup.flush();
  };
  try {
    await render({
      report: withSummary(report),
      entries,
      path: 'waiting.json',
      finished: false,
      current: { key: 'routing/one', phase: 'candidate' },
    });
    let frame = setup.captureCharFrame();
    assert.match(frame, /◐ RUNNING/);
    assert.match(frame, /operator responding/);
    assert.match(frame, /Waiting for the operator's response/);
    assert.match(frame, /Grading starts after the operator responds/);
    assert.match(frame, /Criteria to check/);
    assert.match(frame, /○ uncertain · Must\s+Keeps uncertainty\./);
    assert.match(frame, /0\/2 complete/);
    assert.match(frame, /following the live case/);
    assert.match(frame, /queued\s+routing\/two/);
    assert.doesNotMatch(frame, /awaiting operator response|not graded yet|%|ETA/);
    await render({
      report: withSummary(report),
      entries,
      path: 'waiting.json',
      finished: false,
      current: { key: 'routing/one', phase: 'judge' },
    });
    frame = setup.captureCharFrame();
    assert.match(frame, /grader reviewing/);
    assert.match(frame, /Response received/);
    assert.match(frame, /checking the response against 1 criterion/);
  } finally {
    await act(async () => root.unmount());
    await setup.dispose();
  }
});

test('failure, unscored error and interruption stay distinct; raw judgment is escaped and never a verdict', async () => {
  const setup = await createTestRenderer({ width: 120, height: 70 });
  const root = createRoot(setup.renderer);
  const report = reportFixture(3);
  const failed: CaseResult = {
    ...result,
    key: 'routing/failed',
    status: 'failed',
    score: 0.5,
    criteria: [
      ...result.criteria,
      { id: 'no-promise', text: 'Does not promise a fix.', required: false },
    ],
    assertions: [
      result.assertions![0]!,
      {
        id: 'no-promise',
        text: 'Does not promise a fix.',
        required: false,
        passed: false,
        reason: 'Promises the queue will clear.',
        evidence: '',
        evidence_ids: [],
      },
    ],
  };
  const errored: CaseResult = {
    ...result,
    key: 'routing/error',
    status: 'error',
    score: null,
    error_stage: 'grading',
    error: 'Invalid JSON\u001b[2J',
    judgment: '{"assertions":‮',
  };
  delete errored.assertions;
  report.results = [failed, errored];
  report.interrupted = true;
  try {
    await act(async () => {
      root.render(
        <RunView
          snapshot={{
            report: withSummary(report),
            entries: report.results,
            path: 'partial.json',
            finished: true,
          }}
          options={{ color: 'always', progress: 'none' }}
          onExit={() => {}}
          onFailure={assert.fail}
        />,
      );
    });
    await setup.flush();
    let frame = setup.captureCharFrame();
    assert.match(frame, /■ INTERRUPTED/);
    assert.doesNotMatch(frame, /FINISHED|Finished/);
    assert.match(frame, /✗ FAILED\s+routing\/failed/);
    assert.match(frame, /1 of 2 criteria met/);
    assert.match(frame, /✗ FAIL no-promise · Must not/);
    assert.match(frame, /Evidence\s+\(none quoted\)/);
    assert.match(frame, /1 pending/);
    assert.match(frame, /▲ 1 error(?!s)/, 'a single error is counted in the singular');
    assert.doesNotMatch(frame, /1 errors/);
    await press(setup, ']');
    frame = setup.captureCharFrame();
    assert.match(frame, /▲ ERROR\s+routing\/error/);
    assert.match(frame, /unscored · grading stage/);
    assert.match(frame, /Invalid JSON\\u001b\[2J/);
    assert.match(frame, /▸ Raw judgment \(unvalidated\)\s+unvalidated · not a verdict/);
    assert.doesNotMatch(
      frame,
      /✓ PASS|✗ FAIL|\\u202e/,
      'raw judgment stays collapsed and is never rendered as a verdict',
    );
    for (let index = 0; index < 3; index++) await press(setup, 'TAB');
    await press(setup, 'RETURN');
    frame = setup.captureCharFrame();
    assert.match(frame, /▾ Raw judgment/);
    assert.match(frame, /\{"assertions":\\u202e/);
    assert.doesNotMatch(frame, /\u001b|‮/);
    await press(setup, '?');
    assert.match(setup.captureCharFrame(), /Keyboard[\s\S]*Report\s+partial\.json/);
    await press(setup, '?');
    assert.match(setup.captureCharFrame(), /▲ ERROR\s+routing\/error/);
  } finally {
    await act(async () => root.unmount());
    await setup.dispose();
  }
});
