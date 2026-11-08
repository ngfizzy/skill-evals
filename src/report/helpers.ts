import type { Report, ReportCheckpoint, Summary } from './types.ts';

export function withSummary(report: Report): ReportCheckpoint {
  return { ...report, summary: summarize(report) };
}

function summarize(report: Pick<Report, 'results' | 'selected_cases'>): Summary {
  const assertions = report.results.flatMap((result) => result.assertions ?? []);

  return {
    passed: report.results.filter((result) => result.status === 'passed').length,
    failed: report.results.filter((result) => result.status === 'failed').length,
    errors: report.results.filter((result) => result.status === 'error').length,
    pending: report.selected_cases - report.results.length,
    assertion_score: assertions.length
      ? assertions.filter((entry) => entry.passed).length / assertions.length
      : null,
  };
}
