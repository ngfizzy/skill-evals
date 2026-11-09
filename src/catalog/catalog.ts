import type { EvaluationCase } from '../evaluation/index.ts';
import type { Options } from '../runner/index.ts';
import type { SkillRoot } from '../sources/index.ts';
import { array, mapping, nonempty, sha256, strings, message } from '../utils/index.ts';

import {
  criteria,
  jsonCriteria,
  parseYaml,
  referenceFiles,
  validateReference,
  validateSkillName,
} from './helpers.ts';
import { CatalogRoot, SOURCE_LIMIT } from './root.ts';
import type { CaseDraft, CatalogLoadOptions, EvalSource, Skill } from './types.ts';

export class Catalog {
  private readonly skills = new Map<string, Skill>();
  private readonly dependencies = new Map<string, Skill>();
  private readonly roots: CatalogRoot[] = [];
  readonly cases: EvaluationCase[] = [];

  private constructor(private readonly scoped: boolean) {}

  static async load(
    roots: readonly SkillRoot[],
    options: CatalogLoadOptions = {},
  ): Promise<Catalog> {
    const names = [...new Set(options.loadSkills)].sort();
    names.forEach(validateSkillName);

    const catalog = new Catalog(names.length > 0);
    for (const root of roots) await catalog.loadRoot(root, names);

    const unknown = names.filter((name) => !catalog.skills.has(name));
    if (unknown.length) throw new Error(`Unknown requested skills: ${unknown.join(', ')}`);

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
    const skill =
      this.skills.get(name) ?? this.dependencies.get(name) ?? (await this.loadDependency(name));
    if (!skill) throw new Error(`Missing dependency ${name}; add its repository with --root`);

    visited.add(name);
    const parts: string[] = [];
    for (const dependency of skill.requires)
      parts.push(await this.collectBundle(dependency, visited));

    const files = ['SKILL.md'];
    if (selectedReferences !== undefined) {
      for (const reference of selectedReferences) {
        await validateReference(skill.root, reference);
        files.push(reference);
      }
    } else if ((await skill.root.kind('references')) !== 'missing') {
      files.push(...(await referenceFiles(skill.root, 'references')));
    }

    for (const path of files) {
      const content = await skill.root.readText(path, BUNDLE_LIMIT);
      parts.push(`\n--- ${name}/${path.split('\\').join('/')} ---\n${content}`);
      if (Buffer.byteLength(parts.join('\n')) > BUNDLE_LIMIT)
        throw new Error(`Skill bundle exceeds 512 KiB: ${name}`);
    }

    return parts.join('\n');
  }

  private async loadRoot(root: SkillRoot, names: readonly string[]): Promise<void> {
    const source = await CatalogRoot.open(root);
    this.roots.push(source);

    for (const name of this.scoped ? names : await source.names()) {
      const skill = await source.find(name);
      if (!skill) continue;

      this.addSkill(name, skill);
      await this.loadEvals(name, skill);
    }
  }

  private async loadDependency(name: string): Promise<Skill | undefined> {
    if (!this.scoped) return undefined;
    validateSkillName(name);

    let dependency: Skill | undefined;
    for (const source of this.roots) {
      const found = await source.find(name);
      if (!found) continue;
      if (dependency) throw new Error(`Duplicate skill ${name} across roots`);
      dependency = found;
    }
    if (!dependency) return undefined;

    try {
      if ((await dependency.root.kind(YAML_EVAL)) !== 'missing') {
        const document = mapping(
          parseYaml(await dependency.root.readText(YAML_EVAL, SOURCE_LIMIT)),
        );
        dependency.requires.push(...strings(document.requires ?? []));
      }
    } catch (error) {
      throw new Error(`Invalid dependency metadata for ${name}: ${message(error)}`);
    }

    this.checkSkillLimit();
    this.dependencies.set(name, dependency);
    return dependency;
  }

  private addSkill(name: string, skill: Skill): void {
    if (this.skills.has(name)) throw new Error(`Duplicate skill ${name} across roots`);
    this.checkSkillLimit();
    this.skills.set(name, skill);
  }

  private checkSkillLimit(): void {
    if (this.skills.size + this.dependencies.size >= 10_000)
      throw new Error('Catalog exceeds 10000 skills');
  }

  private async loadEvals(name: string, skill: Skill): Promise<void> {
    const { root } = skill;
    const hasYaml = (await root.kind(YAML_EVAL)) !== 'missing';
    const hasJson = (await root.kind(JSON_EVAL)) !== 'missing';
    if (hasYaml && hasJson) throw new Error(`Ambiguous eval formats for ${name}`);
    if (!hasYaml && !hasJson) return;

    const sourcePath = hasYaml ? YAML_EVAL : JSON_EVAL;
    const content = await root.readText(sourcePath, SOURCE_LIMIT);
    const document = mapping(hasYaml ? parseYaml(content) : JSON.parse(content));
    const source = { path: root.source(sourcePath), hash: sha256(content) };

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
        await validateReference(this.skills.get(skill)!.root, reference);
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
const YAML_EVAL = 'eval.yaml';
const JSON_EVAL = 'evals/evals.json';
