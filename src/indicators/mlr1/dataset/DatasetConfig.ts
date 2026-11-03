export interface DatasetDateRange {
    readonly startTimestamp: number;
    readonly endTimestamp: number;
}

export interface IntegrityPolicy {
    readonly rejectInvalidSource: boolean;
    readonly rejectInvalidOhlcv?: boolean; // Decoupled from source validity; defaults to rejectInvalidSource if omitted
    readonly rejectDuplicateTimestamp: boolean;
    readonly rejectOutOfOrder: boolean;
    readonly requireMinimumUptimeFraction?: number;
}

export interface ExportConfiguration {
    readonly exportTierA: boolean;
    readonly exportTierB: boolean;
    readonly exportTierC: boolean;
    /** True only when Tier B teacher rows and Tier C outcome labels are separate files. */
    readonly separateFiles: boolean;
}

export interface DatasetConfig {
    readonly symbol: string;
    readonly baseTimeframe: string;
    readonly datasetVersion: number;
    readonly representationSchemaVersion: string;
    readonly modelInputSchemaVersion: string;
    readonly sourceIntervalMs: number;
    readonly featureConfigVersion: string;
    readonly teacherVersion: string;
    readonly outcomeConfigVersion: string;
    readonly dateRange: DatasetDateRange;
    readonly integrityPolicy: IntegrityPolicy;
    readonly exportConfig: ExportConfiguration;
}
