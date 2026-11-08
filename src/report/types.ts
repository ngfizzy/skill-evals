import type { ReportData } from '../evaluation/schemas.ts';

export interface Summary {
  passed: number;
  failed: number;
  errors: number;
  pending: number;
  assertion_score: number | null;
}

export type Report = ReportData & { summary?: Readonly<Summary> };

export type ReportCheckpoint = Readonly<Report & { summary: Readonly<Summary> }>;
