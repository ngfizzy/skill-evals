export type SourceKind = 'file' | 'directory' | 'missing' | 'other';

export interface DirectoryListing {
  readonly identity: string;
  readonly names: readonly string[];
}

/** Paths are relative to this root. A child directory creates a new containment boundary. */
export interface SkillRoot {
  directory(path: string): Promise<SkillRoot>;
  list(path?: string): Promise<DirectoryListing>;
  kind(path: string): Promise<SourceKind>;
  readText(path: string, maxBytes: number): Promise<string>;
  source(path: string): string;
}

export type RootInput = { kind: 'local'; directory: string } | GitRootInput;

export interface GitRootInput {
  readonly kind: 'git';
  readonly url: string;
  readonly revision: string;
}

export interface GitSource {
  readonly url: string;
  readonly commit: string;
}
