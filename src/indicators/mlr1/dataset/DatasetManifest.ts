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
    readonly htf3mGapCount?: number;
    readonly htf5mGapCount?: number;
    readonly htf3mResetCount?: number;
    readonly htf5mResetCount?: number;
    readonly htf3mIncompleteWindowCount?: number;
    readonly htf5mIncompleteWindowCount?: number;
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

export interface ExperimentalTeachersMetadata {
    readonly dtfxStrictCbc?: {
        readonly enabled: true;
        readonly version: 'DTFX_STRICTCBC_v1';
        readonly baseTimeframe: '1m';
        readonly zoneTimeframes: readonly ('1m' | '3m' | '5m' | '15m')[];
    };
}

export interface DatasetManifest {
    readonly datasetId: string;
    readonly sourceIdentity: string;
    readonly datasetVersion: number;
    readonly representationSchemaVersion: string;
    readonly modelInputSchemaVersion: string;
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
    readonly experimentalTeachers?: ExperimentalTeachersMetadata;
    readonly teacherTimeframes?: {
        readonly phl: readonly ('1m' | '3m' | '5m')[];
        readonly dtfxStrictCbc: readonly ('1m' | '3m' | '5m')[];
    };
    readonly outcomeAccounting?: {
        readonly totalCandidateEvents: number;
        readonly eligibleEvents: number;
        readonly excludedMissingNextOpen: number;
        readonly excludedUnwarmedAtr: number;
        readonly excludedIncompleteHorizon: number;
    };
    readonly fileChecksums?: Readonly<Record<string, string>>;
    readonly zoneLifecycleAccounting?: {
        readonly dtfxCreatedCount: number;
        readonly dtfxRetestedCount: number;
        readonly dtfxBrokenCount: number;
        readonly dtfxEvictedCount: number;
        readonly dtfxGapResetCount: number;
        readonly phlCreatedCount: number;
        readonly phlRetestedCount: number;
        readonly phlBrokenCount: number;
        readonly phlEvictedCount: number;
        readonly phlSupersededCount: number;
        readonly phlGapResetCount: number;
    };
}
