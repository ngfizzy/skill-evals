import type { SkillRoot } from '../sources/index.ts';
import { mapping, message, strings } from '../utils/index.ts';

import { parseYaml } from './helpers.ts';
import type { Skill } from './types.ts';

export class CatalogRoot {
  private manifest?: Promise<Record<string, unknown>>;

  private constructor(
    private readonly root: SkillRoot,
    private readonly skills: SkillRoot,
  ) {}

  static async open(root: SkillRoot): Promise<CatalogRoot> {
    return new CatalogRoot(root, await root.directory('skills'));
  }

  async names(): Promise<string[]> {
    // Full discovery validates the manifest even if the root has no skills.
    await this.externalDependencies();
    return [...(await this.skills.list()).names].sort();
  }

  async find(name: string): Promise<Skill | undefined> {
    if ((await this.skills.kind(`${name}/SKILL.md`)) === 'missing') return undefined;

    const root = await this.skills.directory(name);
    await root.kind('SKILL.md');

    return { root, requires: await this.requires(name) };
  }

  private externalDependencies(): Promise<Record<string, unknown>> {
    return (this.manifest ??= readManifest(this.root));
  }

  private async requires(name: string): Promise<string[]> {
    try {
      const dependencies = await this.externalDependencies();
      return Object.hasOwn(dependencies, name) ? strings(dependencies[name] ?? []) : [];
    } catch (error) {
      throw new Error(`Invalid dependency metadata for ${name}: ${message(error)}`);
    }
  }
}

async function readManifest(root: SkillRoot): Promise<Record<string, unknown>> {
  const path = 'external-skills.yaml';
  if ((await root.kind(path)) === 'missing') return {};

  const document = mapping(parseYaml(await root.readText(path, SOURCE_LIMIT)));
  return mapping(document.references ?? {});
}

export const SOURCE_LIMIT = 2_097_152;
