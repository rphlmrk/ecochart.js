import type { DatasetManifest, ExportAccounting, IntegrityAuditResults } from '../dataset/DatasetManifest';
import { createDatasetManifest, evaluateDatasetUptime } from '../dataset/ObservationBackbone';
import type { V4HTFIncompleteDiagnostic, V4MTFTimeframeContext } from '../mtf/MTFTypes';
import {
    assertV4RepresentationRowZeroLeakage,
    assertV4RepresentationZeroTierCLeakage,
    buildV4RepresentationRow,
    V4_DATASET_VERSION,
    V4_MODEL_INPUT_SCHEMA_VERSION,
    V4_OUTCOME_CONFIG_VERSION,
    V4_REPRESENTATION_COLUMNS,
    V4_REPRESENTATION_SCHEMA_VERSION,
    V4_STRATEGY_EVENT_COLUMNS,
    V4_TEACHER_VERSION,
    type V4OutcomeAccounting,
    type V4RepresentationRow,
    type V4StrategyEventRow
} from './V4OutcomeContracts';
import {
    getV4FeatureConfigVersion,
    type V4PipelineBarStepOutput,
    type V4PipelineConfig,
    type V4PipelineRunner
} from './V4PipelineEngine';

export function v4CsvEscape(value: unknown): string {
    if (value == null) return '';
    const raw = String(value);
    return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

class SingleMtfV4SerializerCache {
    private lastCandleRef: unknown = Symbol();
    private lastFeaturesRef: unknown = Symbol();
    private lastValidityRef: unknown = Symbol();
    private lastDiagRef: unknown = Symbol();
    private candleJson = 'null';
    private featuresJson = '{}';
    private validityJson = '{}';
    private diagJson = 'null';

    public serializeContext(ctx: V4MTFTimeframeContext): string {
        if (ctx.lastCompletedCandle === null) {
            return `{"timeframe":"${ctx.timeframe}","lastCompletedCandle":null,"lastCompletedOpenTimestamp":null,"lastCompletedCloseTimestamp":null,"contextAgeMs":null,"isAvailable":false,"availabilityStatus":"UNAVAILABLE","isWarmupComplete":false,"features":{},"validity":{}}`;
        }
        if (ctx.lastCompletedCandle !== this.lastCandleRef) {
            this.lastCandleRef = ctx.lastCompletedCandle;
            this.candleJson = JSON.stringify(ctx.lastCompletedCandle);
        }
        if (ctx.features !== this.lastFeaturesRef) {
            this.lastFeaturesRef = ctx.features;
            this.featuresJson = JSON.stringify(ctx.features);
        }
        if (ctx.validity !== this.lastValidityRef) {
            this.lastValidityRef = ctx.validity;
            this.validityJson = JSON.stringify(ctx.validity);
        }
        return `{"timeframe":"${ctx.timeframe}","lastCompletedCandle":${this.candleJson},"lastCompletedOpenTimestamp":${ctx.lastCompletedOpenTimestamp},"lastCompletedCloseTimestamp":${ctx.lastCompletedCloseTimestamp},"contextAgeMs":${ctx.contextAgeMs},"isAvailable":${ctx.isAvailable},"availabilityStatus":"${ctx.availabilityStatus}","isWarmupComplete":${ctx.isWarmupComplete},"features":${this.featuresJson},"validity":${this.validityJson}}`;
    }

    public serializeDiagnostic(diag: V4HTFIncompleteDiagnostic | null): string {
        if (diag !== this.lastDiagRef) {
            this.lastDiagRef = diag;
            this.diagJson = JSON.stringify(diag);
        }
        return this.diagJson;
    }
}

export class MTFV4SerializerCache {
    public readonly cache3m = new SingleMtfV4SerializerCache();
    public readonly cache5m = new SingleMtfV4SerializerCache();
}

export function getV4FileNames(symbol: string, interval: string) {
    return Object.freeze({
        continuousFileName: `MLR1_${symbol}_${interval}_V4_Continuous_Observations.csv`,
        representationFileName: `MLR1_${symbol}_${interval}_V4_Representation_Features.csv`,
        strategyEventsFileName: `MLR1_${symbol}_${interval}_V4_StrategyEvents.csv`,
        manifestFileName: `MLR1_${symbol}_${interval}_V4_Manifest.json`
    });
}

export function buildV4ContinuousHeader(featureKeys: readonly string[], include3m5mMtf: boolean): string {
    const names = [
        'observation_id',
        'source_timestamp',
        'observation_timestamp',
        'open',
        'high',
        'low',
        'close',
        'volume',
        'symbol',
        'timeframe',
        'data_quality',
        ...featureKeys,
        ...featureKeys.map(k => `valid_${k}`),
        ...(include3m5mMtf ? ['context3m', 'htf3mDiagnostic', 'context5m', 'htf5mDiagnostic'] : [])
    ];
    return names.map(v4CsvEscape).join(',');
}

export function formatV4ContinuousRow(
    stepOut: V4PipelineBarStepOutput,
    featureKeys: readonly string[],
    mtfCache: MTFV4SerializerCache,
    include3m5mMtf: boolean
): string {
    const { observation, candle, dataQuality } = stepOut;
    const vals: string[] = [
        v4CsvEscape(stepOut.observationId),
        String(stepOut.sourceTimestamp),
        String(stepOut.observationTimestamp),
        String(candle.open),
        String(candle.high),
        String(candle.low),
        String(candle.close),
        String(candle.volume),
        v4CsvEscape(observation.symbol),
        v4CsvEscape(observation.timeframe),
        v4CsvEscape(JSON.stringify(dataQuality)),
        ...featureKeys.map(k => {
            const v = observation.features[k];
            if (!Number.isFinite(v)) {
                throw new Error(`V4 Serialization Error: non-finite feature '${k}' at bar ${stepOut.acceptedBarIndex}.`);
            }
            return String(v);
        }),
        ...featureKeys.map(k => {
            const valid = observation.validity[k];
            if (typeof valid !== 'boolean') {
                throw new Error(`V4 Serialization Error: non-boolean validity '${k}' at bar ${stepOut.acceptedBarIndex}.`);
            }
            return String(valid);
        })
    ];

    if (include3m5mMtf) {
        if (!stepOut.context3m || !stepOut.context5m) {
            throw new Error(`V4 Serialization Error: missing context3m/context5m at bar ${stepOut.acceptedBarIndex}.`);
        }
        vals.push(v4CsvEscape(mtfCache.cache3m.serializeContext(stepOut.context3m)));
        vals.push(v4CsvEscape(mtfCache.cache3m.serializeDiagnostic(stepOut.htf3mDiagnostic)));
        vals.push(v4CsvEscape(mtfCache.cache5m.serializeContext(stepOut.context5m)));
        vals.push(v4CsvEscape(mtfCache.cache5m.serializeDiagnostic(stepOut.htf5mDiagnostic)));
    }

    return vals.join(',');
}

export function buildV4StrategyEventHeader(): string {
    return V4_STRATEGY_EVENT_COLUMNS.map(v4CsvEscape).join(',');
}

export function formatV4StrategyEventRow(row: V4StrategyEventRow): string {
    return V4_STRATEGY_EVENT_COLUMNS.map(key => {
        const val = row[key];
        if (typeof val === 'number') {
            if (!Number.isFinite(val)) {
                throw new Error(`V4 Serialization Error: non-finite numeric '${String(key)}' on '${row.event_id}'.`);
            }
            return String(val);
        }
        return v4CsvEscape(val);
    }).join(',');
}

export function buildV4RepresentationHeader(): string {
    assertV4RepresentationZeroTierCLeakage(V4_REPRESENTATION_COLUMNS);
    return V4_REPRESENTATION_COLUMNS.map(v4CsvEscape).join(',');
}

export function formatV4RepresentationRow(
    row: V4StrategyEventRow
): { readonly repRow: V4RepresentationRow; readonly csvLine: string } {
    const repRow = buildV4RepresentationRow(row);
    assertV4RepresentationRowZeroLeakage(repRow);
    const csvLine = V4_REPRESENTATION_COLUMNS.map(key => {
        const val = repRow[key];
        if (typeof val === 'number') {
            if (!Number.isFinite(val)) {
                throw new Error(`V4 Representation Error: non-finite '${String(key)}' on '${repRow.tierB_event_id}'.`);
            }
            return String(val);
        }
        return v4CsvEscape(val);
    }).join(',');
    return { repRow, csvLine };
}

export function buildV4DatasetManifest(params: {
    readonly runner: V4PipelineRunner;
    readonly config: V4PipelineConfig;
    readonly totalRawCandles: number;
    readonly startTimestamp: number;
    readonly endTimestamp: number;
    readonly outcomeAccounting: V4OutcomeAccounting;
    readonly continuousRowCount: number;
    readonly representationRowCount: number;
    readonly strategyEventRowCount: number;
    readonly auditResults: IntegrityAuditResults;
    readonly fileChecksums: {
        readonly continuousSha256: string;
        readonly representationSha256: string;
        readonly strategyEventsSha256: string;
    };
    readonly buildTimestamp?: number;
}): DatasetManifest {
    const { runner, config, totalRawCandles, startTimestamp, endTimestamp, outcomeAccounting, auditResults } = params;
    if (!auditResults || !auditResults.passed || !auditResults.chronologyValid ||
        !auditResults.identityUnique || !auditResults.inputOutcomeSeparationValid) {
        throw new Error(`V4 Manifest Error: audit failed (${auditResults?.remarks?.join('; ') || 'unknown'}).`);
    }

    const stats = runner.getStats();
    const uptime = evaluateDatasetUptime(
        stats,
        config.integrityPolicy,
        config.intervalMs,
        config.sourceTimestampBounds ?? { startTimestamp, endTimestamp }
    );
    const fileNames = getV4FileNames(config.symbol, config.interval);
    const actualFileRowCounts = {
        [fileNames.continuousFileName]: params.continuousRowCount,
        [fileNames.representationFileName]: params.representationRowCount,
        [fileNames.strategyEventsFileName]: params.strategyEventRowCount
    };
    const exportAccounting: ExportAccounting = {
        rawSourceCandleCount: totalRawCandles,
        acceptedSourceObservationCount: stats.acceptedObservationCount,
        rejectedSourceObservationCount: stats.rejectedObservationCount,
        tierAContinuousObservationCount: stats.acceptedObservationCount,
        tierAEventRepresentationRowCount: params.representationRowCount,
        tierBConfirmedTeacherEventCount: outcomeAccounting.totalCandidateEvents,
        tierCOutcomeRowCount: params.strategyEventRowCount,
        actualFileRowCounts
    };
    const htf = runner.getHtfStats();
    const manifest = createDatasetManifest(
        `DS_${config.symbol}_${config.interval}_V${V4_DATASET_VERSION}`,
        'BINANCE_SPOT',
        {
            symbol: config.symbol,
            baseTimeframe: config.interval,
            datasetVersion: V4_DATASET_VERSION,
            representationSchemaVersion: V4_REPRESENTATION_SCHEMA_VERSION,
            modelInputSchemaVersion: V4_MODEL_INPUT_SCHEMA_VERSION,
            sourceIntervalMs: config.intervalMs,
            featureConfigVersion: getV4FeatureConfigVersion(config),
            teacherVersion: V4_TEACHER_VERSION,
            outcomeConfigVersion: V4_OUTCOME_CONFIG_VERSION,
            dateRange: { startTimestamp, endTimestamp },
            integrityPolicy: config.integrityPolicy,
            exportConfig: {
                exportTierA: true,
                exportTierB: true,
                exportTierC: true,
                separateFiles: false
            }
        },
        stats,
        uptime,
        {
            passed: auditResults.passed,
            chronologyValid: auditResults.chronologyValid,
            identityUnique: auditResults.identityUnique,
            inputOutcomeSeparationValid: auditResults.inputOutcomeSeparationValid,
            remarks: [
                `V4 Multi-Teacher Pipeline (3m & 5m MTF, PHL 1m/3m/5m ps=8, DTFX_STRICTCBC 1m/3m/5m, 60/120/180 horizons): ` +
                    `${outcomeAccounting.totalCandidateEvents} candidates, ${outcomeAccounting.eligibleEvents} eligible, ` +
                    `excluded(missingOpen=${outcomeAccounting.excludedMissingNextOpen}, unwarmedAtr=${outcomeAccounting.excludedUnwarmedAtr}, incompleteHz180=${outcomeAccounting.excludedIncompleteHorizon}).`,
                `Strategy Counts: ${JSON.stringify(outcomeAccounting.countsByStrategy)}`,
                `Event Type Counts: ${JSON.stringify(outcomeAccounting.countsByEventType)}`,
                `PHL Timeframes: ${config.phlTimeframes.join(',')}`,
                `DTFX_STRICTCBC Timeframes: ${config.dtfxStrictCbcTimeframes.join(',')}`,
                `SHA-256 ${fileNames.continuousFileName}: ${params.fileChecksums.continuousSha256}`,
                `SHA-256 ${fileNames.representationFileName}: ${params.fileChecksums.representationSha256}`,
                `SHA-256 ${fileNames.strategyEventsFileName}: ${params.fileChecksums.strategyEventsSha256}`,
                ...auditResults.remarks
            ]
        },
        exportAccounting,
        {
            htf15mGapCount: 0,
            htf15mResetCount: 0,
            htf15mIncompleteWindowCount: 0,
            htf1hGapCount: 0,
            htf1hResetCount: 0,
            htf1hIncompleteWindowCount: 0,
            htf3mGapCount: htf.htf3mGapCount,
            htf5mGapCount: htf.htf5mGapCount,
            htf3mResetCount: htf.htf3mResetCount,
            htf5mResetCount: htf.htf5mResetCount,
            htf3mIncompleteWindowCount: htf.htf3mIncompleteWindowCount,
            htf5mIncompleteWindowCount: htf.htf5mIncompleteWindowCount
        }
    );

    const withTs = params.buildTimestamp === undefined ? manifest : { ...manifest, buildTimestamp: params.buildTimestamp };
    const finalizedManifest: DatasetManifest = Object.freeze({
        ...withTs,
        teacherTimeframes: Object.freeze({
            phl: Object.freeze([...config.phlTimeframes]),
            dtfxStrictCbc: Object.freeze([...config.dtfxStrictCbcTimeframes])
        }),
        outcomeAccounting: Object.freeze({
            totalCandidateEvents: outcomeAccounting.totalCandidateEvents,
            eligibleEvents: outcomeAccounting.eligibleEvents,
            excludedMissingNextOpen: outcomeAccounting.excludedMissingNextOpen,
            excludedUnwarmedAtr: outcomeAccounting.excludedUnwarmedAtr,
            excludedIncompleteHorizon: outcomeAccounting.excludedIncompleteHorizon
        })
    });
    validateV4DatasetManifest(finalizedManifest);
    return finalizedManifest;
}

function assertStrictPlainObjectDescriptorValues(
    obj: unknown,
    label: string,
    expectedKeys: readonly string[]
): Record<string, unknown> {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error(`V4 Manifest Error: ${label} must be a non-null plain object.`);
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
        throw new Error(`V4 Manifest Error: ${label} has an unexpected prototype.`);
    }
    const ownKeys = Reflect.ownKeys(obj);
    if (ownKeys.length !== expectedKeys.length || ownKeys.some(k => typeof k !== 'string')) {
        throw new Error(`V4 Manifest Error: ${label} keys do not match exact expected string keys.`);
    }
    const out: Record<string, unknown> = {};
    for (const key of expectedKeys) {
        const desc = Object.getOwnPropertyDescriptor(obj, key);
        if (!desc || !('value' in desc) || !desc.enumerable) {
            throw new Error(`V4 Manifest Error: ${label}.${key} must be an own enumerable data property.`);
        }
        out[key] = desc.value;
    }
    return out;
}

export function validateV4DatasetManifest(manifest: DatasetManifest): void {
    if (!manifest || typeof manifest !== 'object') {
        throw new Error('V4 Manifest Error: manifest must be an object.');
    }
    if (manifest.datasetVersion !== V4_DATASET_VERSION ||
        manifest.representationSchemaVersion !== V4_REPRESENTATION_SCHEMA_VERSION ||
        manifest.modelInputSchemaVersion !== V4_MODEL_INPUT_SCHEMA_VERSION ||
        manifest.outcomeVersion !== V4_OUTCOME_CONFIG_VERSION ||
        manifest.teacherVersion !== V4_TEACHER_VERSION) {
        throw new Error('V4 Manifest Error: V4 dataset/schema/outcome/teacher version mismatch.');
    }
    if (!manifest.auditResults || !manifest.auditResults.passed) {
        throw new Error('V4 Manifest Error: manifest auditResults must have passed.');
    }
    if (manifest.experimentalTeachers !== undefined) {
        throw new Error('V4 Manifest Error: V4 manifest must not contain legacy experimentalTeachers.');
    }
    const validTfs = new Set(['1m', '3m', '5m']);
    if (!manifest.teacherTimeframes ||
        !Array.isArray(manifest.teacherTimeframes.phl) || manifest.teacherTimeframes.phl.length === 0 ||
        manifest.teacherTimeframes.phl.some(tf => !validTfs.has(tf)) ||
        !Array.isArray(manifest.teacherTimeframes.dtfxStrictCbc) || manifest.teacherTimeframes.dtfxStrictCbc.length === 0 ||
        manifest.teacherTimeframes.dtfxStrictCbc.some(tf => !validTfs.has(tf))) {
        throw new Error('V4 Manifest Error: invalid teacherTimeframes.');
    }

    const oaKeys = [
        'totalCandidateEvents',
        'eligibleEvents',
        'excludedMissingNextOpen',
        'excludedUnwarmedAtr',
        'excludedIncompleteHorizon'
    ] as const;
    const oaVals = assertStrictPlainObjectDescriptorValues(manifest.outcomeAccounting, 'outcomeAccounting', oaKeys);
    for (const k of oaKeys) {
        const v = oaVals[k];
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
            throw new Error(`V4 Manifest Error: outcomeAccounting.${k} must be a nonnegative safe integer.`);
        }
    }
    const totalCandidates = oaVals['totalCandidateEvents'] as number;
    const eligibleEvents = oaVals['eligibleEvents'] as number;
    const exclMissing = oaVals['excludedMissingNextOpen'] as number;
    const exclAtr = oaVals['excludedUnwarmedAtr'] as number;
    const exclHorizon = oaVals['excludedIncompleteHorizon'] as number;

    const s1 = eligibleEvents + exclMissing;
    const s2 = s1 + exclAtr;
    const expectedTotal = s2 + exclHorizon;
    if (!Number.isSafeInteger(s1) || !Number.isSafeInteger(s2) || !Number.isSafeInteger(expectedTotal) ||
        totalCandidates !== expectedTotal) {
        throw new Error(
            `V4 Manifest Error: totalCandidateEvents (${totalCandidates}) != safe sum (${expectedTotal}).`
        );
    }

    const eaCounterKeys = [
        'rawSourceCandleCount',
        'acceptedSourceObservationCount',
        'rejectedSourceObservationCount',
        'tierAContinuousObservationCount',
        'tierAEventRepresentationRowCount',
        'tierBConfirmedTeacherEventCount',
        'tierCOutcomeRowCount'
    ] as const;
    const eaVals = assertStrictPlainObjectDescriptorValues(
        manifest.exportAccounting,
        'exportAccounting',
        [...eaCounterKeys, 'actualFileRowCounts']
    );
    for (const k of eaCounterKeys) {
        const v = eaVals[k];
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
            throw new Error(`V4 Manifest Error: exportAccounting.${k} must be a nonnegative safe integer.`);
        }
    }
    const rawCount = eaVals['rawSourceCandleCount'] as number;
    const accCount = eaVals['acceptedSourceObservationCount'] as number;
    const rejCount = eaVals['rejectedSourceObservationCount'] as number;
    const tierAContCount = eaVals['tierAContinuousObservationCount'] as number;
    const tierARepCount = eaVals['tierAEventRepresentationRowCount'] as number;
    const tierBCount = eaVals['tierBConfirmedTeacherEventCount'] as number;
    const tierCCount = eaVals['tierCOutcomeRowCount'] as number;

    const rawSum = accCount + rejCount;
    if (!Number.isSafeInteger(rawSum) || rawCount !== rawSum) {
        throw new Error('V4 Manifest Error: rawSourceCandleCount !== accepted + rejected.');
    }

    const fileNames = getV4FileNames(manifest.symbol, manifest.timeframe);
    const expectedFileKeys = [
        fileNames.continuousFileName,
        fileNames.representationFileName,
        fileNames.strategyEventsFileName
    ] as const;
    const countVals = assertStrictPlainObjectDescriptorValues(
        eaVals['actualFileRowCounts'],
        'actualFileRowCounts',
        expectedFileKeys
    );
    for (const fk of expectedFileKeys) {
        const v = countVals[fk];
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
            throw new Error(`V4 Manifest Error: invalid row count on '${fk}'.`);
        }
    }

    if (accCount !== manifest.acceptedObservationCount ||
        tierAContCount !== manifest.acceptedObservationCount ||
        countVals[fileNames.continuousFileName] !== manifest.acceptedObservationCount ||
        tierBCount !== totalCandidates ||
        tierCCount !== eligibleEvents ||
        tierARepCount !== eligibleEvents ||
        countVals[fileNames.representationFileName] !== eligibleEvents ||
        countVals[fileNames.strategyEventsFileName] !== eligibleEvents) {
        throw new Error('V4 Manifest Error: exportAccounting disagrees with accepted/candidate/eligible file row populations.');
    }
}
