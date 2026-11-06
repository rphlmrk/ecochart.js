import type { DatasetDateRange } from '../dataset/DatasetConfig';

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

function assertPlainObject(
    value: unknown,
    fieldName: string
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
}

/**
 * 🔒 RUNTIME CONTRACT VALIDATION
 * Enforces strict isolation rules between Export Profiles and Data Tiers,
 * and rigorously checks configuration objects for pure data (no getters/setters/unknown keys).
 * Must be called by the implementation before processing any export.
 */
export function validateML1ExportRequest(request: ML1ExportRequest): void {
    if (
        request === null ||
        typeof request !== 'object' ||
        Array.isArray(request)
    ) {
        throw new Error('ML1 Export Request Error: Invalid request object.');
    }

    assertPlainObject(request.exportConfig, 'exportConfig');
    assertPlainObject(request.destinationConfig, 'destinationConfig');

    if (!Array.isArray(request.requestedDataTiers)) {
        throw new Error('ML1 Export Request Error: Data tiers must be an array.');
    }

    const tiers = request.requestedDataTiers;

    if (tiers.length === 0) {
        throw new Error('ML1 Export Request Error: At least one data tier must be requested.');
    }

    if (!VALID_PROFILES.has(request.exportProfile)) {
        throw new Error(`ML1 Export Request Error: Unknown export profile '${request.exportProfile}'.`);
    }

    for (const tier of tiers) {
        if (!VALID_TIERS.has(tier)) {
            throw new Error(`ML1 Export Request Error: Unknown data tier '${tier}'.`);
        }
    }

    if (new Set(tiers).size !== tiers.length) {
        throw new Error('ML1 Export Request Error: Duplicate data tiers are not permitted.');
    }

    // 🔒 Profile-to-Tier Isolation Rules
    switch (request.exportProfile) {
        case 'MODEL_INPUTS':
            if (tiers.includes('C')) {
                throw new Error("ML1 Export Request Error: MODEL_INPUTS cannot contain Tier C.");
            }
            break;

        case 'STRUCTURAL_TEACHER':
            if (tiers.some(tier => tier !== 'B')) {
                throw new Error("ML1 Export Request Error: STRUCTURAL_TEACHER permits only Tier B.");
            }
            break;

        case 'FORWARD_OUTCOMES':
            if (tiers.some(tier => tier !== 'C')) {
                throw new Error("ML1 Export Request Error: FORWARD_OUTCOMES permits only Tier C.");
            }
            break;
    }

    // 🔒 Runtime Configuration Hardening (Rejects unknown keys, symbols, accessors, and invalid types)
    const allowedExportKeys = new Set(['includeHeaders', 'compressionLevel']);
    for (const key of Reflect.ownKeys(request.exportConfig)) {
        const descriptor = Object.getOwnPropertyDescriptor(request.exportConfig, key);
        if (
            typeof key !== 'string' || 
            !allowedExportKeys.has(key) || 
            !descriptor || 
            !('value' in descriptor)
        ) {
            throw new Error(`ML1 Export Request Error: Invalid exportConfig property '${String(key)}'.`);
        }
    }
    if (request.exportConfig.includeHeaders !== undefined && typeof request.exportConfig.includeHeaders !== 'boolean') {
        throw new Error("ML1 Export Request Error: exportConfig.includeHeaders must be a boolean.");
    }
    if (request.exportConfig.compressionLevel !== undefined) {
        const lvl = request.exportConfig.compressionLevel as number;
        if (!Number.isSafeInteger(lvl) || lvl < 0 || lvl > 9) {
            throw new Error("ML1 Export Request Error: exportConfig.compressionLevel must be an integer between 0 and 9.");
        }
    }

    const allowedDestKeys = new Set(['targetDirectory', 'overwriteExisting']);
    for (const key of Reflect.ownKeys(request.destinationConfig)) {
        const descriptor = Object.getOwnPropertyDescriptor(request.destinationConfig, key);
        if (
            typeof key !== 'string' || 
            !allowedDestKeys.has(key) || 
            !descriptor || 
            !('value' in descriptor)
        ) {
            throw new Error(`ML1 Export Request Error: Invalid destinationConfig property '${String(key)}'.`);
        }
    }
    if (request.destinationConfig.targetDirectory !== undefined && typeof request.destinationConfig.targetDirectory !== 'string') {
        throw new Error("ML1 Export Request Error: destinationConfig.targetDirectory must be a string.");
    }
    if (request.destinationConfig.overwriteExisting !== undefined && typeof request.destinationConfig.overwriteExisting !== 'boolean') {
        throw new Error("ML1 Export Request Error: destinationConfig.overwriteExisting must be a boolean.");
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
