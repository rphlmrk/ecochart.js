import JSZip from 'jszip';
import { AIExporter } from '../data/AIExporter';
import {
    createML1ZipExportRequest,
    validateML1ExportRequest,
    validateML1ExportRequestAgainstManifest,
    type ML1DataTier,
    type ML1ExportProfile,
    type ML1ExportRequest
} from '../indicators/mlr1/integration/ML1IntegrationTypes';
import {
    MLR1_V3_MODEL_INPUT_SCHEMA_VERSION,
    MLR1_V3_REPRESENTATION_SCHEMA_VERSION,
    TIER_C_V3_QUARANTINE_LIST
} from '../indicators/mlr1/dataset/DatasetSchema';
import {
    V3_DATASET_VERSION,
    V3_REPRESENTATION_COLUMNS
} from '../indicators/mlr1/pipeline/MultiHorizonOutcomeEngine';

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(`[Phase5BAssertionFailed] ${message}`);
}

function makeRequest(
    profile: ML1ExportProfile = 'MODEL_INPUTS',
    tiers: readonly ML1DataTier[] = ['A', 'B']
): ML1ExportRequest {
    const schemaVersion = profile === 'MODEL_INPUTS'
        ? MLR1_V3_MODEL_INPUT_SCHEMA_VERSION
        : MLR1_V3_REPRESENTATION_SCHEMA_VERSION;
    return {
        requestId: 'REQUEST_SOLUSDT_1m_V3',
        datasetRef: {
            datasetId: 'DS_SOLUSDT_1m_V3',
            symbol: 'SOLUSDT',
            baseTimeframe: '1m',
            datasetVersion: V3_DATASET_VERSION,
            sourceIdentity: 'BINANCE_SPOT',
            buildConfigVersion: 'ML1_CONFIG_C_v1',
            featureSchemaVersion: schemaVersion,
            teacherVersion: 'MULTI_TEACHER_CBC_PHL_DTFX_VAM_v1',
            outcomeVersion: 'MLR1_V3_H60_120_180',
            dateRange: { startTimestamp: 1_800_000_000_000, endTimestamp: 1_800_000_060_000 },
            integrityStatus: 'VALIDATED'
        },
        requestedOutputType: 'ZIP',
        requestedDataTiers: tiers,
        exportProfile: profile,
        exportConfig: {},
        schemaVersion,
        destinationConfig: {}
    };
}

function createCandles(count: number): Float64Array {
    const intervalMs = 60_000;
    const start = 1_700_000_040_000;
    const buffer = new Float64Array(count * 6);
    for (let index = 0; index < count; index++) {
        const close = index % 8 < 4
            ? 100 + (index % 4)
            : 104 - (index % 4);
        const open = index % 2 === 1 ? close - 0.5 : close + 0.5;
        buffer.set(
            [start + index * intervalMs, open, Math.max(open, close) + 1,
                Math.min(open, close) - 1, close, 100 + index % 7],
            index * 6
        );
    }
    return buffer;
}

export async function runPhase5BAcceptanceSuite(): Promise<boolean> {
    console.log('\n======================================================');
    console.log('🧪 Starting Milestone 5 Phase 5B V3 Acceptance Suite');
    console.log('======================================================\n');
    let passed = 0;
    let failed = 0;

    const runTest = async (name: string, testFn: () => void | Promise<void>) => {
        try {
            await testFn();
            passed++;
            console.log(`  ✅ Passed: ${name}`);
        } catch (error: unknown) {
            failed++;
            console.error(`  ❌ Failed: ${name} - ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const expectRejected = (
        request: unknown,
        expectedMessage: string
    ): void => {
        let errorMessage = '';
        try {
            validateML1ExportRequest(request);
        } catch (error: unknown) {
            errorMessage = error instanceof Error ? error.message : String(error);
        }
        assert(errorMessage.includes(expectedMessage), `Expected rejection containing '${expectedMessage}', got '${errorMessage}'.`);
    };

    await runTest('Valid V3 MODEL_INPUTS request accepts the approved Tier A/B projection', () => {
        validateML1ExportRequest(makeRequest());
    });

    await runTest('MODEL_INPUTS rejects Tier C', () => {
        expectRejected(makeRequest('MODEL_INPUTS', ['A', 'B', 'C']), 'forbids Tier C');
    });

    await runTest('MODEL_INPUTS rejects Tier B without Tier A', () => {
        expectRejected(makeRequest('MODEL_INPUTS', ['B']), 'requires Tier A');
    });

    await runTest('Valid V3 STRUCTURAL_TEACHER request accepts Tier B only', () => {
        validateML1ExportRequest(makeRequest('STRUCTURAL_TEACHER', ['B']));
    });

    await runTest('STRUCTURAL_TEACHER rejects Tier A and Tier C', () => {
        expectRejected(makeRequest('STRUCTURAL_TEACHER', ['A', 'B']), 'permits only Tier B');
        expectRejected(makeRequest('STRUCTURAL_TEACHER', ['C']), 'permits only Tier B');
    });

    await runTest('Valid V3 FORWARD_OUTCOMES request accepts Tier C only', () => {
        validateML1ExportRequest(makeRequest('FORWARD_OUTCOMES', ['C']));
    });

    await runTest('FORWARD_OUTCOMES rejects Tier A and Tier B', () => {
        expectRejected(makeRequest('FORWARD_OUTCOMES', ['A', 'C']), 'permits only Tier C');
        expectRejected(makeRequest('FORWARD_OUTCOMES', ['B', 'C']), 'permits only Tier C');
    });

    await runTest('Validator rejects retired V2 dataset/schema versions and invalid output types', () => {
        expectRejected({ ...makeRequest(), requestedOutputType: 'TAR' }, 'Unknown output type');
        expectRejected({ ...makeRequest(), schemaVersion: 'MLR1_MODEL_INPUT_V2' }, 'Unsupported schema version');
        expectRejected({ ...makeRequest(), schemaVersion: 'MLR1_MODEL_INPUT_V99' }, 'Unsupported schema version');
        expectRejected({
            ...makeRequest(),
            datasetRef: { ...makeRequest().datasetRef, datasetVersion: 2 }
        }, 'datasetVersion must be 3');
    });

    await runTest('Validator rejects missing required fields and unknown top-level properties', () => {
        const { requestId: _requestId, ...missingRequestId } = makeRequest();
        expectRejected(missingRequestId, 'Missing request.requestId');
        expectRejected({ ...makeRequest(), unexpected: true }, 'Invalid request property');
    });

    await runTest('Validator rejects invalid destination and export configuration values', () => {
        expectRejected({ ...makeRequest(), destinationConfig: { targetDirectory: 42 } }, 'targetDirectory must be a string');
        expectRejected({ ...makeRequest(), exportConfig: { compressionLevel: 10 } }, 'compressionLevel must be an integer');
    });

    await runTest('Validator rejects unknown config keys, accessors, and duplicate tiers', () => {
        expectRejected({ ...makeRequest(), exportConfig: { extra: true } }, 'Invalid exportConfig property');
        expectRejected({ ...makeRequest(), requestedDataTiers: ['A', 'A'] }, 'Duplicate data tiers');
        const accessorRequest = makeRequest();
        Object.defineProperty(accessorRequest, 'requestId', { get: () => 'REQUEST' });
        expectRejected(accessorRequest, 'Invalid request property');
    });

    await runTest('Validator rejects malformed dataset identity and date range', () => {
        expectRejected({
            ...makeRequest(),
            datasetRef: { ...makeRequest().datasetRef, integrityStatus: 'PENDING' }
        }, 'integrityStatus must be');
        expectRejected({
            ...makeRequest(),
            datasetRef: {
                ...makeRequest().datasetRef,
                dateRange: { startTimestamp: 2, endTimestamp: 1 }
            }
        }, 'ordered safe integer timestamps');
    });

    const rawBuffer = createCandles(650);
    let artifacts: Awaited<ReturnType<typeof AIExporter.buildV3ExportArtifacts>>;
    try {
        artifacts = await AIExporter.buildV3ExportArtifacts({
            rawCandleBuffer: rawBuffer,
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: 60_000,
            buildTimestamp: 1_700_000_000_000
        });
    } catch (error: unknown) {
        await runTest('Validated V3 build fixture supplies the production packaging boundary', () => {
            throw error;
        });
        console.log(`\nPhase 5B Acceptance: ${passed} passed, ${failed} failed.`);
        return false;
    }

    await runTest('Validated V3 build fixture supplies the production packaging boundary', () => {
        assert(artifacts.strategyEventRows.length > 0, 'V3 fixture must contain confirmed events with 180-bar horizons.');
        assert(artifacts.manifest.auditResults.passed, 'V3 fixture must have passed its audits.');
        assert(artifacts.manifest.datasetVersion === V3_DATASET_VERSION, 'V3 fixture must emit dataset version 3.');
    });

    const validRequest = createML1ZipExportRequest(artifacts.manifest);

    await runTest('V3 request bound to manifest passes validation and rejects version or manifest mismatches', () => {
        validateML1ExportRequestAgainstManifest(validRequest, artifacts.manifest);

        let errorMessage = '';
        try {
            validateML1ExportRequestAgainstManifest(
                { ...validRequest, requestedOutputType: 'TAR' },
                artifacts.manifest
            );
        } catch (error: unknown) {
            errorMessage = error instanceof Error ? error.message : String(error);
        }
        assert(errorMessage.includes('Unknown output type'), `Unexpected validation result: ${errorMessage}`);

        errorMessage = '';
        try {
            validateML1ExportRequestAgainstManifest(
                {
                    ...validRequest,
                    datasetRef: { ...validRequest.datasetRef, datasetVersion: 2 }
                },
                artifacts.manifest
            );
        } catch (error: unknown) {
            errorMessage = error instanceof Error ? error.message : String(error);
        }
        assert(errorMessage.includes('datasetVersion must be 3'), `Expected V2 rejection, got: ${errorMessage}`);
    });

    await runTest('V3 archive boundary rejects tampered representation CSV and Tier C contamination', async () => {
        let errorMessage = '';
        try {
            await AIExporter.createVerifiedV3DatasetArchive({
                ...artifacts,
                representationCsv: artifacts.representationCsv.replace(
                    '\r\n',
                    ',tierB_unapproved_feature\r\n'
                )
            }, rawBuffer);
        } catch (error: unknown) {
            errorMessage = error instanceof Error ? error.message : String(error);
        }
        assert(errorMessage.includes('checksums') || errorMessage.includes('V3 Archive Error'),
            `Unexpected projection tamper result: ${errorMessage}`);
    });

    await runTest('V3 ZIP production path produces verified four-member archive without Tier C leakage', async () => {
        const bytes = await AIExporter.createVerifiedV3DatasetArchive(artifacts, rawBuffer);
        const reopened = await JSZip.loadAsync(bytes);
        const names = Object.keys(reopened.files).filter(name => !reopened.files[name].dir).sort();
        const expected = [
            artifacts.continuousFileName,
            artifacts.strategyEventsFileName,
            artifacts.representationFileName,
            artifacts.manifestFileName
        ].sort();
        assert(JSON.stringify(names) === JSON.stringify(expected), `Unexpected archive members: ${names.join(', ')}`);

        const representation = await reopened.file(artifacts.representationFileName)!.async('string');
        const headers = representation.split(/\r?\n/, 1)[0].split(',');
        assert(JSON.stringify(headers) === JSON.stringify(V3_REPRESENTATION_COLUMNS),
            'V3 model-input CSV must retain the exact approved V3 representation column ordering.');
        assert(!headers.some(header => TIER_C_V3_QUARANTINE_LIST.some(field =>
            header.toLowerCase() === field.toLowerCase() ||
            header.toLowerCase() === `tiera_${field.toLowerCase()}` ||
            header.toLowerCase() === `tierb_${field.toLowerCase()}`
        )), 'Tier C fields must not be present in the V3 model-input representation.');
    });

    console.log(`\nPhase 5B Acceptance: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}
