import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { reportSchema } from '../evaluation/schemas.ts';
import { reconstructAssertions } from '../judge/index.ts';
import { responseSegments } from '../evaluation/protocol.ts';
import type { CaseResult } from '../evaluation/schemas.ts';
import { hasDuplicates, sha256 } from '../utils/index.ts';

import { withSummary } from './helpers.ts';
import type { Report, ReportCheckpoint } from './types.ts';

/** A viewer reads data only: it never loads a catalog, agent, or executable from a report. */
export async function readReport(path: string): Promise<ReportCheckpoint> {
  const document: unknown = JSON.parse(await readReportText(path));
  if (!reportSchema.validate(document)) throw new Error('Invalid saved report structure');
  validateReportIntegrity(document);

  return withSummary(document);
}

async function readReportText(path: string): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Report must be a regular JSON file');
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 64 * 1024 * 1024) throw new Error('Report exceeds the 64 MiB inspection limit');
      chunks.push(buffer);
    }
  } finally {
    await file.close();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function validateReportIntegrity(report: Report): void {
  if (report.selected_cases < report.results.length) throw new Error('Invalid selected case count');

  const keys = new Set<string>();
  for (const result of report.results) {
    validateCaseIntegrity(result);
    if (keys.has(result.key)) throw new Error('Duplicate case key in report');
    keys.add(result.key);
  }
}

function validateCaseIntegrity(result: Readonly<CaseResult>): void {
  const { criteria, skill_instructions, skill_sha256 } = result;
  if (hasDuplicates(criteria.map((criterion) => criterion.id)))
    throw new Error('Duplicate saved criteria');
  if (skill_instructions !== undefined && sha256(skill_instructions) !== skill_sha256)
    throw new Error('Stored skill does not match its hash');

  if (result.status === 'error') {
    if (result.score !== null || result.assertions !== undefined)
      throw new Error('Error case must be unscored');
  } else {
    validateSavedGrading(result);
  }
}

function validateSavedGrading(result: Readonly<CaseResult>): void {
  const { assertions, criteria, response, score, status } = result;
  if (response === undefined || assertions === undefined)
    throw new Error('Graded report requires the operator response and assertions');

  const validated = reconstructAssertions(assertions, criteria, responseSegments(response));
  const savedById = new Map(assertions.map((item) => [item.id, item]));

  for (const expected of validated) {
    const assertion = savedById.get(expected.id)!;
    if (assertion.text !== expected.text || assertion.required !== expected.required)
      throw new Error('Saved assertion differs from its criterion');
    if (assertion.evidence !== expected.evidence)
      throw new Error('Saved evidence does not match the operator response');
  }

  const passed = validated.filter((item) => item.passed).length;
  if (
    score !== passed / assertions.length ||
    (status === 'passed') !== (passed === assertions.length)
  )
    throw new Error('Saved verdict does not match assertions');
}
