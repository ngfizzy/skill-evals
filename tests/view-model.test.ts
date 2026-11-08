import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CASE_STATUS,
  caseState,
  colorEnabled,
  formatBytes,
  formatElapsed,
  palette,
  progressCells,
  runState,
  runStatus,
} from '../src/display/view-model.ts';
import { resultSections, verdictItems } from '../src/display/sections.ts';
import type { CaseResult } from '../src/evaluation/index.ts';

import { contrastRatio } from './helpers/contrast.ts';

const passed: CaseResult = {
  key: 'routing/one',
  skill: 'routing',
  id: 'one',
  title: 'Case',
  prompt: 'Scenario text',
  source: 'fixture',
  source_sha256: 'fixture',
  skill_sha256: 'fixture',
  response: 'Reply',
  status: 'passed',
  score: 1,
  criteria: [{ id: 'absent', text: 'Avoids certainty.', required: false }],
  assertions: [
    {
      id: 'absent',
      text: 'Avoids certainty.',
      required: false,
      passed: true,
      reason: 'No promise.',
      evidence: '',
      evidence_ids: [],
    },
  ],
};

test('case and run states keep pass, failure, error, running, pending, not-run, interrupted and incomplete distinct', () => {
  assert.equal(caseState('a', undefined, { key: 'a' }, false), 'running');
  assert.equal(caseState('b', undefined, { key: 'a' }, false), 'pending');
  assert.equal(caseState('a', undefined, { key: 'a' }, true), 'not-run');
  for (const status of ['passed', 'failed', 'error'] as const)
    assert.equal(caseState('a', { ...passed, status }, undefined, false), status);
  assert.equal(runState(false, undefined, undefined, 2), 'running');
  assert.equal(runState(true, true, undefined, 1), 'interrupted');
  assert.equal(
    runState(true, undefined, undefined, 0),
    'incomplete',
    'crash-partial reports are never Finished',
  );
  assert.equal(runState(true, undefined, '2026-01-01T00:00:01Z', 1), 'incomplete');
  assert.equal(runState(true, undefined, '2026-01-01T00:00:01Z', 0), 'finished');
  assert.equal(runStatus('finished', { failed: 0, errors: 1 }).tone, 'error');
  const labels = Object.values(CASE_STATUS).map((item) => item.label);
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(
    Object.values(CASE_STATUS).every((item) => item.icon && /^[A-Z ]+$/.test(item.label)),
    'every icon has a word label',
  );
});

test('progress counts completed cases only, and formatting stays honest', () => {
  assert.deepEqual(progressCells(0, 4, 20), { filled: 0, empty: 20 });
  assert.deepEqual(progressCells(1, 4, 20), { filled: 5, empty: 15 });
  assert.deepEqual(progressCells(9, 4, 20), { filled: 20, empty: 0 });
  assert.deepEqual(progressCells(0, 0, 8), { filled: 0, empty: 8 });
  assert.equal(formatElapsed(14.9), '14s');
  assert.equal(formatElapsed(74), '1m 14s');
  assert.equal(formatElapsed(3720), '1h 02m');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});

test('color honors --color, NO_COLOR and dumb terminals; disabled color supplies no palette', () => {
  assert.equal(colorEnabled('auto', { TERM: 'xterm' }), true);
  assert.equal(colorEnabled('auto', { TERM: 'xterm', NO_COLOR: '1' }), false);
  assert.equal(colorEnabled('auto', { TERM: 'dumb' }), false);
  assert.equal(colorEnabled('always', { NO_COLOR: '1' }), true);
  assert.equal(colorEnabled('never', { TERM: 'xterm' }), false);
  assert.deepEqual(palette(false, 'dark'), {});
  assert.deepEqual(palette(false, 'unknown'), {});
  assert.notDeepEqual(palette(true, 'dark'), palette(true, 'light'));
});

test('each palette pairs its fills and keeps text colors at 4.5:1 on the backgrounds it may meet', () => {
  const text = ['accent', 'pass', 'fail', 'error', 'muted'] as const;
  const cases = [
    ['dark', ['#000000', '#1e1e1e']],
    ['light', ['#ffffff', '#f5f5f5']],
    ['unknown', ['#000000', '#ffffff']],
  ] as const;
  for (const [mode, backgrounds] of cases) {
    const colors = palette(true, mode);
    for (const name of text) {
      for (const background of [
        ...backgrounds,
        ...(colors.selectedBg ? [colors.selectedBg] : []),
      ]) {
        assert.ok(
          contrastRatio(colors[name]!, background) >= 4.5,
          `${mode} ${name} on ${background}`,
        );
      }
    }
    assert.equal(
      colors.selectedBg === undefined,
      colors.selectedFg === undefined,
      `${mode} selection fill is paired`,
    );
    assert.equal(
      colors.alertBg === undefined || colors.alertFg !== undefined,
      true,
      `${mode} alert fill is paired`,
    );
    if (colors.selectedBg) assert.ok(contrastRatio(colors.selectedFg!, colors.selectedBg) >= 7);
    if (colors.alertBg) assert.ok(contrastRatio(colors.alertFg!, colors.alertBg) >= 7);
  }
  const unknown = palette(true, 'unknown');
  assert.equal(unknown.selectedBg, undefined, 'an unreported background gets no fills');
  assert.equal(unknown.alertBg, undefined);
  assert.ok(
    contrastRatio(unknown.alertFg!, '#000000') >= 4.5 &&
      contrastRatio(unknown.alertFg!, '#ffffff') >= 4.5,
  );
});

test('shared sections mark owned placeholders and verdict items preserve saved evidence verbatim', () => {
  const waiting = resultSections(passed);
  assert.equal(waiting.find((item) => item.id === 'response')!.placeholder, true);
  assert.equal(waiting.find((item) => item.id === 'verdict')!.placeholder, true);
  const done = resultSections(passed, passed);
  assert.equal(done.find((item) => item.id === 'response')!.placeholder, undefined);
  assert.equal(done.find((item) => item.id === 'response')!.text, 'Reply');
  assert.deepEqual(
    verdictItems(passed).map((item) => item.note),
    ['none; judge found the prohibited behavior absent'],
  );
  const quoted = {
    ...passed,
    assertions: [{ ...passed.assertions![0]!, evidence: 'line one\n\u001b[2J line two' }],
  };
  assert.equal(
    verdictItems(quoted)[0]!.evidence,
    'line one\n\u001b[2J line two',
    'escaping happens at display time only',
  );
  assert.deepEqual(verdictItems({ ...passed, status: 'error', score: null }), []);
});
