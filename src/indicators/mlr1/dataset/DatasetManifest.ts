import type { DatasetConfig } from './DatasetConfig';

export interface MissingDataStatistics {
    readonly missingIntervalCount: number;
    readonly unexpectedIntervalCount: number;
    readonly duplicateTimestampCount: number;
    readonly outOfOrderCount: number;
    readonly invalidOhlcvCount: number;
    readonly invalidSourceCount: number; // Independent accounting of native source invalidity
    readonly offGridTimestampCount: number;
    readonly outOfRangeTimestampCount: number;
    readonly htf15mGapCount: number;
    readonly htf1hGapCount: number;
    readonly htf15mResetCount: number;
    readonly htf1hResetCount: number;
    readonly htf15mIncompleteWindowCount: number;
    readonly htf1hIncompleteWindowCount: number;
}

export interface IntegrityAuditResults {
    readonly passed: boolean;
    readonly chronologyValid: boolean;
    readonly identityUnique: boolean;
    readonly inputOutcomeSeparationValid: boolean;
    readonly remarks: readonly string[];
}

export interface ExportAccounting {
    readonly rawSourceCandleCount: number;
    readonly acceptedSourceObservationCount: number;
    readonly rejectedSourceObservationCount: number;
    readonly tierAContinuousObservationCount: number;
    readonly tierAEventRepresentationRowCount: number;
    readonly tierBConfirmedTeacherEventCount: number;
    readonly tierCOutcomeRowCount: number;
    /**
     * Data records in each generated file; CSV header rows are excluded.
     * Tier B and Tier C may share an archival event file; the allowlisted
     * representation file is the only model-input projection.
     */
    readonly actualFileRowCounts: Readonly<Record<string, number>>;
}

export interface DatasetManifest {
    readonly datasetId: string;
    readonly sourceIdentity: string;
    readonly symbol: string;
    readonly timeframe: string;
    readonly startTimestamp: number;
    readonly endTimestamp: number;
    readonly sourceRowCount: number;
    readonly acceptedObservationCount: number;
    readonly rejectedObservationCount: number;
    readonly totalExpectedObservations: number;
    readonly sourceAvailabilityFraction: number;
    readonly usableObservationFraction: number;
    readonly isUptimeValid: boolean;

    readonly featureVersion: string;
    readonly teacherVersion: string;
    readonly outcomeVersion: string;

    readonly missingDataStats: MissingDataStatistics;
    readonly buildConfig: DatasetConfig;
    readonly buildTimestamp: number;
    readonly auditResults: IntegrityAuditResults;
    readonly exportAccounting: ExportAccounting;
}
