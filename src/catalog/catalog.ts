import { readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { EvaluationCase } from '../evaluation/index.ts';
import type { Options } from '../runner/index.ts';
import {
  array,
  containedPath,
  exists,
  mapping,
  nonempty,
  readBounded,
  sha256,
  strings,
} from '../utils/index.ts';

import { criteria, jsonCriteria, parseYaml, referenceFiles, validateReference } from './helpers.ts';
import type { CaseDraft, EvalSource, Skill } from './types.ts';

export class Catalog {
  readonly skills = new Map<string, Skill>();
  readonly cases: EvaluationCase[] = [];

  static async load(roots: string[]): Promise<Catalog> {
    const catalog = new Catalog();
    for (const root of roots) await catalog.loadRoot(await realpath(root));

    if (!catalog.cases.length) throw new Error('No behavioral cases found');
    return catalog;
  }

  select(options: Pick<Options, 'skills' | 'cases' | 'list' | 'limit'>): EvaluationCase[] {
    const unknown = [
      ...options.skills.filter((name) => !this.skills.has(name)),
      ...options.cases.filter((key) => !this.cases.some((entry) => entry.key === key)),
    ];
    if (unknown.length) throw new Error(`Unknown skills or cases: ${unknown.join(', ')}`);

    const selected = this.cases.filter(
      (entry) =>
        (!options.skills.length || options.skills.includes(entry.skill)) &&
        (!options.cases.length || options.cases.includes(entry.key)),
    );
    if (!selected.length) throw new Error('No behavioral cases match the filters');

    return options.list ? selected : selected.slice(0, options.limit);
  }

  async bundle(name: string, selectedReferences?: readonly string[]): Promise<string> {
    return this.collectBundle(name, new Set(), selectedReferences);
  }

  private async collectBundle(
    name: string,
    visited: Set<string>,
    selectedReferences?: readonly string[],
  ): Promise<string> {
    if (visited.has(name)) return '';
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Missing dependency ${name}; add its repository with --root`);

    visited.add(name);
    const parts: string[] = [];
    for (const dependency of skill.requires)
      parts.push(await this.collectBundle(dependency, visited));

    const files = [join(skill.path, 'SKILL.md')];
    const references = join(skill.path, 'references');
    if (selectedReferences !== undefined) {
      for (const reference of selectedReferences) {
        await validateReference(reference, skill.path);
        const path = join(skill.path, reference);
        files.push(path);
      }
    } else if (await exists(references))
      files.push(...(await referenceFiles(references, skill.path)));

    for (const path of files) {
      const content = await readBounded(await containedPath(path, skill.path), BUNDLE_LIMIT);
      parts.push(
        `\n--- ${name}/${relative(skill.path, path).split('\\').join('/')} ---\n${content}`,
      );
      if (Buffer.byteLength(parts.join('\n')) > BUNDLE_LIMIT)
        throw new Error(`Skill bundle exceeds 512 KiB: ${name}`);
    }

    return parts.join('\n');
  }

  private async loadRoot(root: string): Promise<void> {
    const directory = await containedPath(join(root, 'skills'), root);
    const manifest = join(root, 'external-skills.yaml');
    const external = (await exists(manifest))
      ? mapping(
          mapping(parseYaml(await readBounded(await containedPath(manifest, root), SOURCE_LIMIT)))
            .references ?? {},
        )
      : {};

    for (const name of (await readdir(directory)).sort()) {
      const entry = join(directory, name, 'SKILL.md');
      if (!(await exists(entry))) continue;
      if (this.skills.has(name)) throw new Error(`Duplicate skill ${name} across roots`);

      const path = await containedPath(join(directory, name), directory);
      await containedPath(entry, path);
      if (this.skills.size >= 10_000) throw new Error('Catalog exceeds 10000 skills');

      this.skills.set(name, { path, requires: strings(external[name] ?? []) });
      await this.loadEvals(name, path);
    }
  }

  private async loadEvals(name: string, path: string): Promise<void> {
    const yaml = join(path, 'eval.yaml');
    const json = join(path, 'evals', 'evals.json');
    const hasYaml = await exists(yaml);
    const hasJson = await exists(json);
    if (hasYaml && hasJson) throw new Error(`Ambiguous eval formats for ${name}`);
    if (!hasYaml && !hasJson) return;

    const sourcePath = hasYaml ? yaml : json;
    const content = await readBounded(await containedPath(sourcePath, path), SOURCE_LIMIT);
    const document = mapping(hasYaml ? parseYaml(content) : JSON.parse(content));
    const source = { path: sourcePath, hash: sha256(content) };

    if (hasYaml) await this.addYamlCases(name, document, source);
    else await this.addJsonCases(name, document, source);
  }

  private async addYamlCases(
    skill: string,
    document: Record<string, unknown>,
    source: EvalSource,
  ): Promise<void> {
    if (document.skill !== skill) throw new Error(`Eval skill name mismatch: ${source.path}`);
    this.skills.get(skill)!.requires.push(...strings(document.requires ?? []));

    for (const [index, value] of array(document.behaviors).entries()) {
      const behavior = mapping(value);
      await this.addCase(skill, source, {
        id: `behavior-${index + 1}`,
        title: behavior.name,
        prompt: behavior.given,
        assertions: [...criteria(behavior.must, true), ...criteria(behavior.must_not ?? [], false)],
        references: behavior.references,
      });
    }
  }

  private async addJsonCases(
    skill: string,
    document: Record<string, unknown>,
    source: EvalSource,
  ): Promise<void> {
    if ('skill_name' in document && document.skill_name !== skill)
      throw new Error(`Eval skill name mismatch: ${source.path}`);

    for (const value of array(document.evals)) {
      const evaluation = mapping(value);
      await this.addCase(skill, source, {
        id: evaluation.id,
        title: evaluation.id,
        prompt: evaluation.prompt,
        assertions: jsonCriteria(evaluation),
        references: evaluation.references,
      });
    }
  }

  private async addCase(
    skill: string,
    source: EvalSource,
    { id: rawId, title, prompt, assertions, references }: CaseDraft,
  ): Promise<void> {
    const id = nonempty(rawId);
    const key = `${skill}/${id}`;

    if (this.cases.some((entry) => entry.key === key)) throw new Error(`Duplicate case ${key}`);
    if (assertions.length > 128) throw new Error(`Case ${key} exceeds 128 criteria`);

    const selected = references === undefined ? undefined : strings(references);
    if (selected)
      for (const reference of selected)
        await validateReference(reference, this.skills.get(skill)!.path);
    if (!assertions.length) throw new Error(`Case ${key} has no assertions`);
    if (this.cases.length >= 10_000) throw new Error('Catalog exceeds 10000 cases');

    this.cases.push({
      key,
      skill,
      id,
      title: nonempty(title),
      prompt: nonempty(prompt),
      criteria: assertions.map((entry, index) => ({ ...entry, id: `assertion-${index + 1}` })),
      source: source.path,
      source_sha256: source.hash,
      ...(references !== undefined ? { references: selected! } : {}),
    });
  }
}

const BUNDLE_LIMIT = 524_288;
const SOURCE_LIMIT = 2_097_152;
