import type { DatasetDateRange } from '../dataset/DatasetConfig';
import type { DatasetManifest } from '../dataset/DatasetManifest';
import {
    MLR1_MODEL_INPUT_SCHEMA_VERSION,
    MLR1_REPRESENTATION_SCHEMA_VERSION
} from '../dataset/DatasetSchema';

/**
 * PHASE 5B: ML-R1 INTEGRATION CONTRACTS
 *
 * Defines the boundaries between validated ML-R1 datasets
 * and EcoChart application infrastructure.
 *
 * Milestones 1–4 remain authoritative for all dataset semantics.
 */

export type ML1DataTier = 'A' | 'B' | 'C';

export type ML1ExportProfile =
    | 'MODEL_INPUTS'
    | 'STRUCTURAL_TEACHER'
    | 'FORWARD_OUTCOMES';

export type ML1ExportOutputType = 'ZIP' | 'CSV' | 'JSON';

export type ML1ProcessingStatus =
    | 'PENDING'
    | 'IN_PROGRESS'
    | 'COMPLETED'
    | 'FAILED'
    | 'INTERRUPTED';

export type ML1ExportStatus =
    | 'PENDING'
    | 'AVAILABLE'
    | 'UNAVAILABLE'
    | 'FAILED';

export interface ML1DatasetReference {
    readonly datasetId: string;
    readonly symbol: string;
    readonly baseTimeframe: string;
    readonly datasetVersion: number;
    readonly sourceIdentity: string;
    readonly buildConfigVersion: string;
    readonly featureSchemaVersion: string;
    readonly teacherVersion: string;
    readonly outcomeVersion: string;
    readonly dateRange: DatasetDateRange;
    readonly integrityStatus: 'VALIDATED'; // 🔒 Enforces that only fully validated datasets are referenced
}

// 🔒 Explicit Configuration Schemas (Replaces Record<string, unknown>)
export interface ML1ExportConfig {
    readonly includeHeaders?: boolean;
    readonly compressionLevel?: number;
    // Strict schema: no generic catch-all keys permitted
}

export interface ML1DestinationConfig {
    readonly targetDirectory?: string;
    readonly overwriteExisting?: boolean;
    // Strict schema: no generic catch-all keys permitted
}

export interface ML1ExportRequest {
    readonly requestId: string;
    readonly datasetRef: ML1DatasetReference;
    readonly requestedOutputType: ML1ExportOutputType;
    
    readonly requestedDataTiers: readonly ML1DataTier[]; // 🔒 Array supports combined Tiers (e.g., A & B)
    readonly exportProfile: ML1ExportProfile; 

    readonly exportConfig: ML1ExportConfig;
    readonly schemaVersion: string;
    readonly destinationConfig: ML1DestinationConfig;
}

const VALID_TIERS = new Set<ML1DataTier>(['A', 'B', 'C']);
const VALID_PROFILES = new Set<ML1ExportProfile>([
    'MODEL_INPUTS',
    'STRUCTURAL_TEACHER',
    'FORWARD_OUTCOMES',
]);
const VALID_OUTPUT_TYPES = new Set<ML1ExportOutputType>(['ZIP', 'CSV', 'JSON']);
const REQUEST_KEYS = [
    'requestId',
    'datasetRef',
    'requestedOutputType',
    'requestedDataTiers',
    'exportProfile',
    'exportConfig',
    'schemaVersion',
    'destinationConfig'
] as const;
const DATASET_REFERENCE_KEYS = [
    'datasetId',
    'symbol',
    'baseTimeframe',
    'datasetVersion',
    'sourceIdentity',
    'buildConfigVersion',
    'featureSchemaVersion',
    'teacherVersion',
    'outcomeVersion',
    'dateRange',
    'integrityStatus'
] as const;
const DATE_RANGE_KEYS = ['startTimestamp', 'endTimestamp'] as const;
const PROFILE_SCHEMA_VERSIONS: Readonly<Record<ML1ExportProfile, string>> = {
    MODEL_INPUTS: MLR1_MODEL_INPUT_SCHEMA_VERSION,
    STRUCTURAL_TEACHER: MLR1_REPRESENTATION_SCHEMA_VERSION,
    FORWARD_OUTCOMES: MLR1_REPRESENTATION_SCHEMA_VERSION
};

function assertExactPlainObject(
    value: unknown,
    fieldName: string,
    expectedKeys: readonly string[],
    requiredKeys: readonly string[] = expectedKeys
): asserts value is Record<string, unknown> {
    if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
    ) {
        throw new Error(
            `ML1 Export Request Error: ${fieldName} must be a plain object.`
        );
    }

    const expected = new Set(expectedKeys);
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
            typeof key !== 'string' ||
            !expected.has(key) ||
            !descriptor ||
            !('value' in descriptor)
        ) {
            throw new Error(
                `ML1 Export Request Error: Invalid ${fieldName} property '${String(key)}'.`
            );
        }
    }
    for (const key of requiredKeys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            throw new Error(`ML1 Export Request Error: Missing ${fieldName}.${key}.`);
        }
    }
}

function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`ML1 Export Request Error: ${fieldName} must be a non-empty string.`);
    }
}

function validateDatasetReference(datasetRef: unknown): asserts datasetRef is ML1DatasetReference {
    assertExactPlainObject(datasetRef, 'datasetRef', DATASET_REFERENCE_KEYS);
    for (const key of [
        'datasetId',
        'symbol',
        'baseTimeframe',
        'sourceIdentity',
        'buildConfigVersion',
        'featureSchemaVersion',
        'teacherVersion',
        'outcomeVersion'
    ] as const) {
        assertNonEmptyString(datasetRef[key], `datasetRef.${key}`);
    }
    if (!Number.isSafeInteger(datasetRef.datasetVersion) || (datasetRef.datasetVersion as number) < 1) {
        throw new Error('ML1 Export Request Error: datasetRef.datasetVersion must be a positive safe integer.');
    }
    if (datasetRef.integrityStatus !== 'VALIDATED') {
        throw new Error("ML1 Export Request Error: datasetRef.integrityStatus must be 'VALIDATED'.");
    }

    assertExactPlainObject(datasetRef.dateRange, 'datasetRef.dateRange', DATE_RANGE_KEYS);
    const { startTimestamp, endTimestamp } = datasetRef.dateRange;
    if (!Number.isSafeInteger(startTimestamp) ||
        !Number.isSafeInteger(endTimestamp) ||
        (startTimestamp as number) < 0 ||
        (endTimestamp as number) <= (startTimestamp as number)) {
        throw new Error('ML1 Export Request Error: datasetRef.dateRange must contain ordered safe integer timestamps.');
    }
}

function validateConfiguration(
    value: unknown,
    fieldName: string,
    allowedKeys: readonly string[]
): asserts value is Record<string, unknown> {
    assertExactPlainObject(value, fieldName, allowedKeys, []);
}

/**
 * Validates untrusted export requests at runtime. MODEL_INPUTS is restricted to
 * Tier A and the M4 serializer's explicit Tier B allowlist; Tier C remains a
 * separate target artifact and is never part of the model-input projection.
 */
export function validateML1ExportRequest(request: unknown): asserts request is ML1ExportRequest {
    assertExactPlainObject(request, 'request', REQUEST_KEYS);
    assertNonEmptyString(request.requestId, 'requestId');
    assertNonEmptyString(request.schemaVersion, 'schemaVersion');
    validateDatasetReference(request.datasetRef);
    validateConfiguration(request.exportConfig, 'exportConfig', ['includeHeaders', 'compressionLevel']);
    validateConfiguration(request.destinationConfig, 'destinationConfig', ['targetDirectory', 'overwriteExisting']);

    if (typeof request.requestedOutputType !== 'string' ||
        !VALID_OUTPUT_TYPES.has(request.requestedOutputType as ML1ExportOutputType)) {
        throw new Error(`ML1 Export Request Error: Unknown output type '${String(request.requestedOutputType)}'.`);
    }
    if (typeof request.exportProfile !== 'string' ||
        !VALID_PROFILES.has(request.exportProfile as ML1ExportProfile)) {
        throw new Error(`ML1 Export Request Error: Unknown export profile '${String(request.exportProfile)}'.`);
    }
    if (request.schemaVersion !== PROFILE_SCHEMA_VERSIONS[request.exportProfile as ML1ExportProfile] ||
        request.datasetRef.featureSchemaVersion !== request.schemaVersion) {
        throw new Error(
            `ML1 Export Request Error: Unsupported schema version '${String(request.schemaVersion)}' ` +
            `for profile '${String(request.exportProfile)}'.`
        );
    }

    if (!Array.isArray(request.requestedDataTiers) || request.requestedDataTiers.length === 0) {
        throw new Error('ML1 Export Request Error: At least one data tier must be requested.');
    }
    const tiers = request.requestedDataTiers;
    for (const tier of tiers) {
        if (typeof tier !== 'string' || !VALID_TIERS.has(tier as ML1DataTier)) {
            throw new Error(`ML1 Export Request Error: Unknown data tier '${tier}'.`);
        }
    }
    if (new Set(tiers).size !== tiers.length) {
        throw new Error('ML1 Export Request Error: Duplicate data tiers are not permitted.');
    }

    switch (request.exportProfile as ML1ExportProfile) {
        case 'MODEL_INPUTS':
            if (!tiers.includes('A') || tiers.includes('C')) {
                throw new Error('ML1 Export Request Error: MODEL_INPUTS requires Tier A and forbids Tier C.');
            }
            break;
        case 'STRUCTURAL_TEACHER':
            if (tiers.length !== 1 || tiers[0] !== 'B') {
                throw new Error("ML1 Export Request Error: STRUCTURAL_TEACHER permits only Tier B.");
            }
            break;
        case 'FORWARD_OUTCOMES':
            if (tiers.length !== 1 || tiers[0] !== 'C') {
                throw new Error("ML1 Export Request Error: FORWARD_OUTCOMES permits only Tier C.");
            }
            break;
    }

    if (request.exportConfig.includeHeaders !== undefined &&
        typeof request.exportConfig.includeHeaders !== 'boolean') {
        throw new Error('ML1 Export Request Error: exportConfig.includeHeaders must be a boolean.');
    }
    if (request.exportConfig.compressionLevel !== undefined) {
        const lvl = request.exportConfig.compressionLevel;
        if (typeof lvl !== 'number' || !Number.isSafeInteger(lvl) || lvl < 0 || lvl > 9) {
            throw new Error('ML1 Export Request Error: exportConfig.compressionLevel must be an integer between 0 and 9.');
        }
    }

    if (request.destinationConfig.targetDirectory !== undefined &&
        typeof request.destinationConfig.targetDirectory !== 'string') {
        throw new Error('ML1 Export Request Error: destinationConfig.targetDirectory must be a string.');
    }
    if (request.destinationConfig.overwriteExisting !== undefined &&
        typeof request.destinationConfig.overwriteExisting !== 'boolean') {
        throw new Error('ML1 Export Request Error: destinationConfig.overwriteExisting must be a boolean.');
    }
}

export function createML1ZipExportRequest(manifest: DatasetManifest): ML1ExportRequest {
    if (!manifest.auditResults.passed ||
        !manifest.auditResults.chronologyValid ||
        !manifest.auditResults.identityUnique ||
        !manifest.auditResults.inputOutcomeSeparationValid) {
        throw new Error('ML1 Export Request Error: Cannot reference a dataset that has not passed its integrity audit.');
    }
    if (manifest.datasetVersion !== manifest.buildConfig.datasetVersion ||
        manifest.representationSchemaVersion !== manifest.buildConfig.representationSchemaVersion ||
        manifest.modelInputSchemaVersion !== manifest.buildConfig.modelInputSchemaVersion ||
        manifest.symbol !== manifest.buildConfig.symbol ||
        manifest.timeframe !== manifest.buildConfig.baseTimeframe ||
        manifest.startTimestamp !== manifest.buildConfig.dateRange.startTimestamp ||
        manifest.endTimestamp !== manifest.buildConfig.dateRange.endTimestamp) {
        throw new Error('ML1 Export Request Error: Dataset manifest metadata does not match its build configuration.');
    }

    return {
        requestId: `${manifest.datasetId}:MODEL_INPUTS:ZIP`,
        datasetRef: {
            datasetId: manifest.datasetId,
            symbol: manifest.symbol,
            baseTimeframe: manifest.timeframe,
            datasetVersion: manifest.datasetVersion,
            sourceIdentity: manifest.sourceIdentity,
            buildConfigVersion: manifest.buildConfig.featureConfigVersion,
            featureSchemaVersion: manifest.modelInputSchemaVersion,
            teacherVersion: manifest.teacherVersion,
            outcomeVersion: manifest.outcomeVersion,
            dateRange: {
                startTimestamp: manifest.startTimestamp,
                endTimestamp: manifest.endTimestamp
            },
            integrityStatus: 'VALIDATED'
        },
        requestedOutputType: 'ZIP',
        requestedDataTiers: ['A', 'B'],
        exportProfile: 'MODEL_INPUTS',
        exportConfig: {},
        schemaVersion: manifest.modelInputSchemaVersion,
        destinationConfig: {}
    };
}

export function validateML1ExportRequestAgainstManifest(
    request: unknown,
    manifest: DatasetManifest
): asserts request is ML1ExportRequest {
    validateML1ExportRequest(request);
    if (!manifest.auditResults.passed ||
        !manifest.auditResults.chronologyValid ||
        !manifest.auditResults.identityUnique ||
        !manifest.auditResults.inputOutcomeSeparationValid) {
        throw new Error('ML1 Export Request Error: Dataset manifest has not passed its integrity audit.');
    }
    if (request.datasetRef.datasetId !== manifest.datasetId ||
        request.datasetRef.symbol !== manifest.symbol ||
        request.datasetRef.baseTimeframe !== manifest.timeframe ||
        request.datasetRef.datasetVersion !== manifest.datasetVersion ||
        request.datasetRef.sourceIdentity !== manifest.sourceIdentity ||
        request.datasetRef.buildConfigVersion !== manifest.buildConfig.featureConfigVersion ||
        request.datasetRef.featureSchemaVersion !== manifest.modelInputSchemaVersion ||
        request.datasetRef.teacherVersion !== manifest.teacherVersion ||
        request.datasetRef.outcomeVersion !== manifest.outcomeVersion ||
        request.datasetRef.dateRange.startTimestamp !== manifest.startTimestamp ||
        request.datasetRef.dateRange.endTimestamp !== manifest.endTimestamp) {
        throw new Error('ML1 Export Request Error: Dataset reference does not match the audited export manifest.');
    }
    if (request.exportProfile === 'MODEL_INPUTS' &&
        request.schemaVersion !== manifest.modelInputSchemaVersion) {
        throw new Error('ML1 Export Request Error: MODEL_INPUTS schema does not match the dataset manifest.');
    }
    if (request.exportProfile !== 'MODEL_INPUTS' &&
        request.schemaVersion !== manifest.representationSchemaVersion) {
        throw new Error('ML1 Export Request Error: Tier B/C schema does not match the dataset manifest.');
    }
}

export interface ML1SourceCoverage {
    readonly expectedCandles: number;
    readonly actualCandles: number;
    readonly missingCandles: number;
    readonly isComplete: boolean;
}

export interface ML1ProcessingJob {
    readonly jobId: string;
    readonly datasetId: string;
    readonly processingType: 'ACQUIRE_SOURCE' | 'BUILD_DATASET' | 'EXPORT';
    readonly configVersion: string;
    
    readonly idempotencyKey: string;
    readonly attempt: number;
    
    readonly status: ML1ProcessingStatus;
    readonly startTimeMs: number;
    readonly completionTimeMs: number | null;
    readonly progressInfo: {
        readonly percent: number;
        readonly statusText: string;
    };
    readonly errorInfo: string | null;
    readonly coverageInfo?: ML1SourceCoverage; // 🔒 Structured coverage report (Set on completion)
}

export interface ML1IntegrationResult {
    readonly datasetId: string;
    readonly jobId: string;
    readonly exportId: string | null;
    
    readonly processingStatus: ML1ProcessingStatus;
    readonly exportStatus: ML1ExportStatus;
    readonly outputReferences: readonly string[];
    
    readonly integrityVerificationStatus: 'VALIDATED' | 'FAILED' | 'PENDING';
    readonly details: string | null;
}
