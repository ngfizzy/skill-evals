import type { RootInput } from './types.ts';

export function parseRootInput(value: string): RootInput {
  if (value.startsWith('git+')) {
    const separator = value.indexOf('#');
    const endpoint = value.slice(4, separator === -1 ? undefined : separator);
    const revision = separator === -1 ? 'HEAD' : value.slice(separator + 1);
    const url = canonicalGitUrl(endpoint);

    const isCommitId = isCommit(revision);
    if (separator !== -1 && !isCommitId && !FULL_BRANCH_OR_TAG_REF_PATTERN.test(revision))
      throw new Error('Git revision must be a full branch ref, tag ref, or 40-character commit ID');
    if (ASCII_CONTROL_OR_SPACE_PATTERN.test(revision) || revision.length > 1024)
      throw new Error('Invalid Git revision');

    return { kind: 'git', url, revision: isCommitId ? revision.toLowerCase() : revision };
  }

  if (URL_SCHEME_PREFIX_PATTERN.test(value) || GIT_SCP_REMOTE_PATTERN.test(value))
    throw new Error('Remote skill roots must use git+https://HOST/OWNER/REPO.git');
  return { kind: 'local', directory: value };
}

export function canonicalGitUrl(value: string): string {
  const invalid = new Error(
    'Git root must be an HTTPS repository URL without credentials or query',
  );
  const rawPath = HTTPS_GIT_ENDPOINT_PATTERN.exec(value)?.groups?.path;
  if (rawPath === undefined || ASCII_CONTROL_OR_SPACE_PATTERN.test(value)) throw invalid;

  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== rawPath) throw invalid;
    for (const segment of url.pathname.slice(1).split('/')) {
      const decoded = decodeURIComponent(segment);
      if (decoded === '.' || decoded === '..' || PATH_SEPARATOR_OR_CONTROL_PATTERN.test(decoded))
        throw invalid;
    }
    return url.href;
  } catch {
    throw invalid;
  }
}

export function isCommit(value: string): boolean {
  return SHA1_COMMIT_PATTERN.test(value);
}

const FULL_BRANCH_OR_TAG_REF_PATTERN = /^refs\/(?:heads|tags)\/.+$/u;
const SHA1_COMMIT_PATTERN = /^[a-f0-9]{40}$/iu;
const ASCII_CONTROL_OR_SPACE_PATTERN = /[\x00-\x20\x7f]/u;

const URL_SCHEME_PREFIX_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;
const GIT_SCP_REMOTE_PATTERN = /^git@[^:]+:/u;
const HTTPS_GIT_ENDPOINT_PATTERN =
  /^https:\/\/[^/@?#\\\s]+(?<path>\/(?:[^/?#\\\s]+\/)+[^/?#\\\s]+\.git)$/u;
const PATH_SEPARATOR_OR_CONTROL_PATTERN = /[\/\\\x00-\x1f\x7f]/u;
