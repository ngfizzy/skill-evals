import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, unlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { Catalog } from '../src/catalog/index.ts';
import { readBounded } from '../src/utils/files.ts';

import { temporary, skill, jsonCase, yamlCase } from './helpers/fixture.ts';

const options = { skills: [], cases: [], list: true, limit: 1 };

test('both formats preserve IDs, polarity, hashes, filters and candidate/rubric separation', async (t) => {
  const root = await temporary(t);
  const path = await skill(root);
  await skill(root, 'negative', yamlCase, 'yaml');
  await mkdir(join(path, 'references'));
  await writeFile(join(path, 'references', 'route.md'), 'Reference instruction.');
  const catalog = await Catalog.load([root]);
  assert.equal(catalog.cases.length, 2);
  const entry = catalog.cases.find((entry) => entry.skill === 'routing');
  assert.ok(entry);
  assert.equal(
    entry.source_sha256,
    createHash('sha256').update(JSON.stringify(jsonCase())).digest('hex'),
  );
  assert.equal(entry.criteria.length, 2);
  assert.equal(catalog.cases[0]!.criteria[1]!.required, false);
  const bundle = await catalog.bundle('negative');
  assert.match(bundle, /routing\/SKILL.md/);
  assert.match(bundle, /Reference instruction/);
  assert.doesNotMatch(bundle, /Selects Routine\.|Choose a review route|expected_output/);
  assert.equal(catalog.select(options).length, 2);
  assert.equal(catalog.select({ ...options, list: false }).length, 1);
  assert.equal(catalog.select({ ...options, cases: ['routing/small'] })[0]!.key, 'routing/small');
  assert.throws(() => catalog.select({ ...options, skills: ['missing'] }), /Unknown/);
  assert.throws(
    () => catalog.select({ ...options, cases: ['routing/small'], skills: ['negative'] }),
    /No behavioral/,
  );
  await assert.rejects(Catalog.load([root, root]), /Duplicate skill/);
});

test('cross-root manifest dependencies, cycles and missing dependencies', async (t) => {
  const root = await temporary(t),
    other = await temporary(t);
  await skill(root);
  await skill(other, 'negative', yamlCase, 'yaml');
  await writeFile(join(root, 'external-skills.yaml'), 'references:\n  routing: [negative]\n');
  const catalog = await Catalog.load([root, other]);
  const bundle = await catalog.bundle('routing');
  assert.equal((bundle.match(/--- routing\/SKILL.md/g) ?? []).length, 1);
  assert.match(bundle, /negative\/SKILL.md/);
  await assert.rejects(
    (await Catalog.load([root])).bundle('routing'),
    /Missing dependency negative/,
  );
});

for (const [name, doc] of [
  ['null', null],
  ['array', []],
  ['invalid evals', { evals: 'invalid' }],
  ['null case', { evals: [null] }],
  ['missing expected', { evals: [{ id: 'x', prompt: 'x' }] }],
  ['blank expected', { evals: [{ id: 'x', prompt: 'x', expected_output: '' }] }],
  ['numeric id', { evals: [{ id: 1, prompt: 'x', expected_output: 'x' }] }],
  ['wrong skill', { ...jsonCase(), skill_name: 'wrong' }],
  ['duplicate case', { ...jsonCase(), evals: [jsonCase().evals[0]!, jsonCase().evals[0]!] }],
])
  test(`rejects malformed metadata: ${name}`, async (t) => {
    const root = await temporary(t);
    await skill(root, 'routing', doc);
    await assert.rejects(Catalog.load([root]));
  });

test('rejects ambiguous, duplicate-key, alias and custom-tag YAML', async (t) => {
  const root = await temporary(t),
    path = await skill(root);
  await writeFile(join(path, 'eval.yaml'), 'skill: routing\nbehaviors: []\n');
  await assert.rejects(Catalog.load([root]), /Ambiguous/);
  await unlink(join(path, 'evals', 'evals.json'));
  for (const source of [
    'skill: routing\nskill: routing',
    'skill: &a routing\nbehaviors: [*a]',
    'skill: !ruby/object routing',
  ]) {
    await writeFile(join(path, 'eval.yaml'), source);
    await assert.rejects(Catalog.load([root]));
  }
});

for (const kind of [
  'skill-directory',
  'entrypoint',
  'yaml-eval',
  'json-eval',
  'skills-directory',
  'manifest',
  'references-file',
  'references-directory',
]) {
  test(`rejects symlink escape: ${kind}`, async (t) => {
    const root = await temporary(t),
      outside = await temporary(t);
    const path = await skill(root),
      other = await skill(outside);
    if (kind === 'skill-directory') {
      await rm(path, { recursive: true });
      await symlink(other, path);
    }
    if (kind === 'entrypoint') {
      await unlink(join(path, 'SKILL.md'));
      await symlink(join(other, 'SKILL.md'), join(path, 'SKILL.md'));
    }
    if (kind === 'yaml-eval') {
      await unlink(join(path, 'evals', 'evals.json'));
      await writeFile(join(outside, 'eval.yaml'), 'skill: routing\nbehaviors: []');
      await symlink(join(outside, 'eval.yaml'), join(path, 'eval.yaml'));
    }
    if (kind === 'json-eval') {
      await unlink(join(path, 'evals', 'evals.json'));
      await symlink(join(other, 'evals', 'evals.json'), join(path, 'evals', 'evals.json'));
    }
    if (kind === 'skills-directory') {
      await rm(join(root, 'skills'), { recursive: true });
      await symlink(join(outside, 'skills'), join(root, 'skills'));
    }
    if (kind === 'manifest') {
      await writeFile(join(outside, 'external.yaml'), 'references: {}');
      await symlink(join(outside, 'external.yaml'), join(root, 'external-skills.yaml'));
    }
    if (kind.startsWith('references')) {
      await mkdir(join(path, 'references'));
      await symlink(
        kind.endsWith('file') ? join(other, 'SKILL.md') : other,
        join(path, 'references', kind.endsWith('file') ? 'escape.md' : 'escape'),
      );
      await assert.rejects((await Catalog.load([root])).bundle('routing'), /escapes/);
    } else await assert.rejects(Catalog.load([root]), /escapes/);
  });
}

test('reference cycles and oversized bundles are bounded; invalid UTF-8 is rejected', async (t) => {
  const root = await temporary(t),
    path = await skill(root);
  await mkdir(join(path, 'references'));
  await symlink(join(path, 'references'), join(path, 'references', 'loop'));
  const catalog = await Catalog.load([root]);
  await assert.rejects(catalog.bundle('routing'), /cycle/);
  await unlink(join(path, 'references', 'loop'));
  await writeFile(join(path, 'references', 'large.md'), 'x'.repeat(524289));
  await assert.rejects(catalog.bundle('routing'), /exceeds/);
  await writeFile(join(path, 'bad'), Buffer.from([0xff]));
  await assert.rejects(readBounded(join(path, 'bad'), 32));
});

test('focused references and explicit criteria are opt-in and do not leak other references', async (t) => {
  const root = await temporary(t);
  const path = await skill(root, 'routing', {
    evals: [
      {
        id: 'atomic',
        prompt: 'Choose a route.',
        references: ['references/a.md'],
        criteria: { must: ['Chooses Routine'], must_not: ['Claims external action'] },
      },
    ],
  });
  await mkdir(join(path, 'references'));
  await writeFile(join(path, 'references/a.md'), 'Chosen reference');
  await writeFile(join(path, 'references/b.md'), 'Unrelated reference');
  const catalog = await Catalog.load([root]);
  assert.deepEqual(
    catalog.cases[0]!.criteria.map((c) => c.required),
    [true, false],
  );
  const focused = await catalog.bundle('routing', catalog.cases[0]!.references);
  assert.match(focused, /routing\/SKILL.md/);
  assert.match(focused, /Chosen reference/);
  assert.doesNotMatch(focused, /Unrelated reference|Chooses Routine/);
  assert.match(await catalog.bundle('routing'), /Unrelated reference/);
  assert.doesNotMatch(await catalog.bundle('routing', []), /Chosen reference/);
  for (const reference of [
    'references/../SKILL.md',
    '../SKILL.md',
    '/etc/secret.md',
    'references/./a.md',
    'references/none.md',
  ]) {
    await assert.rejects(catalog.bundle('routing', [reference]));
  }
  await symlink(join(path, 'references/a.md'), join(path, 'references/alias.md'));
  assert.match(
    await catalog.bundle('routing', ['references/alias.md']),
    /routing\/references\/alias.md/,
  );
  const outside = await temporary(t);
  await writeFile(join(outside, 'secret.md'), 'Private outside');
  await symlink(join(outside, 'secret.md'), join(path, 'references/escape.md'));
  await assert.rejects(catalog.bundle('routing', ['references/escape.md']), /escapes/);
});

for (const criteria of [{}, { must: [] }, { must: ['Valid'], unexpected: [] }]) {
  test(`rejects invalid explicit rubric ${JSON.stringify(criteria)}`, async (t) => {
    const root = await temporary(t);
    await skill(root, 'routing', { evals: [{ id: 'x', prompt: 'x', criteria }] });
    await assert.rejects(Catalog.load([root]));
  });
}
test('rejects ambiguous old/new rubric instead of silently discarding expected output', async (t) => {
  const root = await temporary(t),
    doc = jsonCase();
  doc.evals[0]!.criteria = { must: ['New'] };
  await skill(root, 'routing', doc);
  await assert.rejects(Catalog.load([root]), /cannot be combined/);
});

for (const reference of [
  'references/../SKILL.md',
  'references/missing.md',
  'references/directory.md',
]) {
  test(`invalid declared reference fails catalog load before listing/full context: ${reference}`, async (t) => {
    const root = await temporary(t),
      doc = jsonCase();
    doc.evals[0]!.references = [reference];
    const path = await skill(root, 'routing', doc);
    await mkdir(join(path, 'references/directory.md'), { recursive: true });
    await assert.rejects(Catalog.load([root]));
  });
}
test('declared reference symlink escapes fail at catalog load and excessive criteria fail closed', async (t) => {
  const root = await temporary(t),
    outside = await temporary(t),
    doc = jsonCase();
  doc.evals[0]!.references = ['references/escape.md'];
  const path = await skill(root, 'routing', doc);
  await mkdir(join(path, 'references'));
  await writeFile(join(outside, 'secret.md'), 'secret');
  await symlink(join(outside, 'secret.md'), join(path, 'references/escape.md'));
  await assert.rejects(Catalog.load([root]), /escapes/);
  delete doc.evals[0]!.references;
  doc.evals[0]!.assertions = Array(128).fill('criterion');
  await skill(root, 'routing', doc);
  await assert.rejects(Catalog.load([root]), /128 criteria/);
});
