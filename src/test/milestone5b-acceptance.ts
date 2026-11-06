import JSZip from 'jszip';
import {
    AIExporter,
    MLR1_REPRESENTATION_COLUMNS
} from '../data/AIExporter';
import {
    createML1ZipExportRequest,
    validateML1ExportRequest,
    type ML1DataTier,
    type ML1ExportProfile,
    type ML1ExportRequest
} from '../indicators/mlr1/integration/ML1IntegrationTypes';
import {
    MLR1_MODEL_INPUT_SCHEMA_VERSION,
    MLR1_REPRESENTATION_SCHEMA_VERSION,
    TIER_C_QUARANTINE_LIST
} from '../indicators/mlr1/dataset/DatasetSchema';

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(`[Phase5BAssertionFailed] ${message}`);
}

function makeRequest(
    profile: ML1ExportProfile = 'MODEL_INPUTS',
    tiers: readonly ML1DataTier[] = ['A', 'B']
): ML1ExportRequest {
    const schemaVersion = profile === 'MODEL_INPUTS'
        ? MLR1_MODEL_INPUT_SCHEMA_VERSION
        : MLR1_REPRESENTATION_SCHEMA_VERSION;
    return {
        requestId: 'REQUEST_SOLUSDT_1m_V2',
        datasetRef: {
            datasetId: 'DS_SOLUSDT_1m_V2',
            symbol: 'SOLUSDT',
            baseTimeframe: '1m',
            datasetVersion: 2,
            sourceIdentity: 'BINANCE_SPOT',
            buildConfigVersion: 'ML1_CONFIG_B_TEST',
            featureSchemaVersion: schemaVersion,
            teacherVersion: 'STRICT_CBC_TEST',
            outcomeVersion: 'MLR1_TEST',
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
    console.log('🧪 Starting Milestone 5 Phase 5B Acceptance Suite');
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

    await runTest('Valid MODEL_INPUTS request accepts the approved Tier A/B projection', () => {
        validateML1ExportRequest(makeRequest());
    });

    await runTest('MODEL_INPUTS rejects Tier C', () => {
        expectRejected(makeRequest('MODEL_INPUTS', ['A', 'B', 'C']), 'forbids Tier C');
    });

    await runTest('MODEL_INPUTS rejects Tier B without Tier A', () => {
        expectRejected(makeRequest('MODEL_INPUTS', ['B']), 'requires Tier A');
    });

    await runTest('Valid STRUCTURAL_TEACHER request accepts Tier B only', () => {
        validateML1ExportRequest(makeRequest('STRUCTURAL_TEACHER', ['B']));
    });

    await runTest('STRUCTURAL_TEACHER rejects Tier A and Tier C', () => {
        expectRejected(makeRequest('STRUCTURAL_TEACHER', ['A', 'B']), 'permits only Tier B');
        expectRejected(makeRequest('STRUCTURAL_TEACHER', ['C']), 'permits only Tier B');
    });

    await runTest('Valid FORWARD_OUTCOMES request accepts Tier C only', () => {
        validateML1ExportRequest(makeRequest('FORWARD_OUTCOMES', ['C']));
    });

    await runTest('FORWARD_OUTCOMES rejects Tier A and Tier B', () => {
        expectRejected(makeRequest('FORWARD_OUTCOMES', ['A', 'C']), 'permits only Tier C');
        expectRejected(makeRequest('FORWARD_OUTCOMES', ['B', 'C']), 'permits only Tier C');
    });

    await runTest('Validator rejects invalid output type and unsupported schema version', () => {
        expectRejected({ ...makeRequest(), requestedOutputType: 'TAR' }, 'Unknown output type');
        expectRejected({ ...makeRequest(), schemaVersion: 'MLR1_MODEL_INPUT_V99' }, 'Unsupported schema version');
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

    let artifacts: Awaited<ReturnType<typeof AIExporter.buildExportArtifacts>>;
    try {
        artifacts = await AIExporter.buildExportArtifacts({
            rawCandleBuffer: createCandles(500),
            symbol: 'SOLUSDT',
            interval: '1m',
            intervalMs: 60_000,
            buildTimestamp: 1_700_000_000_000
        });
    } catch (error: unknown) {
        await runTest('Validated M4 build fixture supplies the production packaging boundary', () => {
            throw error;
        });
        console.log(`\nPhase 5B Acceptance: ${passed} passed, ${failed} failed.`);
        return false;
    }

    await runTest('Validated M4 build fixture supplies the production packaging boundary', () => {
        assert(artifacts.events.length > 0, 'M4 fixture must contain confirmed events.');
        assert(artifacts.manifest.auditResults.passed, 'M4 fixture must have passed its audits.');
    });

    const validRequest = createML1ZipExportRequest(artifacts.manifest);

    await runTest('Production boundary rejects an invalid request before ZIP creation', async () => {
        let errorMessage = '';
        try {
            await AIExporter.createVerifiedDatasetArchive(
                artifacts,
                { ...validRequest, requestedOutputType: 'TAR' }
            );
        } catch (error: unknown) {
            errorMessage = error instanceof Error ? error.message : String(error);
        }
        assert(errorMessage.includes('Unknown output type'), `Unexpected production boundary result: ${errorMessage}`);
    });

    await runTest('Production boundary rejects Tier B fields outside the frozen allowlist', async () => {
        let errorMessage = '';
        try {
            await AIExporter.createVerifiedDatasetArchive({
                ...artifacts,
                representationCsv: artifacts.representationCsv.replace(
                    '\r\n',
                    ',tierB_unapproved_feature\r\n'
                )
            }, validRequest);
        } catch (error: unknown) {
            errorMessage = error instanceof Error ? error.message : String(error);
        }
        assert(errorMessage.includes('approved Tier A/B allowlists'), `Unexpected projection result: ${errorMessage}`);
    });

    await runTest('Existing M4 ZIP request reaches the unchanged four-member archive path', async () => {
        const bytes = await AIExporter.createVerifiedDatasetArchive(artifacts, validRequest);
        const reopened = await JSZip.loadAsync(bytes);
        const names = Object.keys(reopened.files).filter(name => !reopened.files[name].dir).sort();
        const expected = [
            artifacts.continuousFileName,
            artifacts.eventFileName,
            artifacts.representationFileName,
            `MLR1_${artifacts.manifest.symbol}_${artifacts.manifest.timeframe}_Manifest.json`
        ].sort();
        assert(JSON.stringify(names) === JSON.stringify(expected), `Unexpected archive members: ${names.join(', ')}`);

        const representation = await reopened.file(artifacts.representationFileName)!.async('string');
        const headers = representation.split(/\r?\n/, 1)[0].split(',');
        assert(JSON.stringify(headers) === JSON.stringify(MLR1_REPRESENTATION_COLUMNS),
            'Model-input CSV must retain the exact approved Tier A/B column ordering.');
        assert(!headers.some(header => TIER_C_QUARANTINE_LIST.some(field =>
            header.toLowerCase() === field.toLowerCase() ||
            header.toLowerCase() === `tiera_${field}` ||
            header.toLowerCase() === `tierb_${field}`
        )), 'Tier C fields must not be present in the model-input representation.');
    });

    await runTest('ZIP production boundary rejects valid but unsupported CSV output requests', async () => {
        let errorMessage = '';
        try {
            await AIExporter.createVerifiedDatasetArchive(
                artifacts,
                { ...validRequest, requestedOutputType: 'CSV' }
            );
        } catch (error: unknown) {
            errorMessage = error instanceof Error ? error.message : String(error);
        }
        assert(errorMessage.includes('supports the canonical ZIP'), `Unexpected output type result: ${errorMessage}`);
    });

    console.log(`\nPhase 5B Acceptance: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}
