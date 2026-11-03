import type { DatasetConfig } from './DatasetConfig';

export interface MissingDataStatistics {
    readonly missingIntervalCount: number;
    readonly duplicateTimestampCount: number;
    readonly outOfOrderCount: number;
    readonly invalidOhlcvCount: number;
    readonly htf15mGapCount: number;
    readonly htf1hGapCount: number;
}

export interface IntegrityAuditResults {
    readonly passed: boolean;
    readonly chronologyValid: boolean;
    readonly identityUnique: boolean;
    readonly inputOutcomeSeparationValid: boolean;
    readonly remarks: readonly string[];
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

    readonly featureVersion: string;
    readonly teacherVersion: string;
    readonly outcomeVersion: string;

    readonly missingDataStats: MissingDataStatistics;
    readonly buildConfig: DatasetConfig;
    readonly buildTimestamp: number;
    readonly auditResults: IntegrityAuditResults;
}
