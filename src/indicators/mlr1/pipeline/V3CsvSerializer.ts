import type { DatasetManifest, ExportAccounting, IntegrityAuditResults } from '../dataset/DatasetManifest';
import { createDatasetManifest, evaluateDatasetUptime } from '../dataset/ObservationBackbone';
import type { HTFIncompleteDiagnostic, MTFTimeframeContext } from '../mtf/MTFTypes';
import {
    assertV3RepresentationRowZeroLeakage,
    assertV3RepresentationZeroTierCLeakage,
    buildV3RepresentationRow,
    V3_DATASET_VERSION,
    V3_MODEL_INPUT_SCHEMA_VERSION,
    V3_OUTCOME_CONFIG_VERSION,
    V3_REPRESENTATION_COLUMNS,
    V3_REPRESENTATION_SCHEMA_VERSION,
    V3_STRATEGY_EVENT_COLUMNS,
    type V3OutcomeAccounting,
    type V3RepresentationRow,
    type V3StrategyEventRow
} from './MultiHorizonOutcomeEngine';
import {
    getV3FeatureConfigVersion,
    type V3PipelineBarStepOutput,
    type V3PipelineConfig,
    type V3PipelineRunner
} from './V3PipelineEngine';

export const V3_TEACHER_VERSION = 'MULTI_TEACHER_CBC_PHL_DTFX_VAM_v1';

export function v3CsvEscape(value: unknown): string {
    if (value == null) return '';
    const raw = String(value);
    return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

export class MTF15mSerializerCache {
    private lastCandleRef: unknown = Symbol();
    private lastFeaturesRef: unknown = Symbol();
    private lastValidityRef: unknown = Symbol();
    private lastDiagRef: unknown = Symbol();
    private candleJson = 'null';
    private featuresJson = '{}';
    private validityJson = '{}';
    private diagJson = 'null';

    public serializeContext(ctx: MTFTimeframeContext): string {
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

    public serializeDiagnostic(diag: HTFIncompleteDiagnostic | null): string {
        if (diag !== this.lastDiagRef) {
            this.lastDiagRef = diag;
            this.diagJson = JSON.stringify(diag);
        }
        return this.diagJson;
    }
}

export function getV3FileNames(symbol: string, interval: string) {
    return Object.freeze({
        continuousFileName: `MLR1_${symbol}_${interval}_Continuous_Observations.csv`,
        representationFileName: `MLR1_${symbol}_${interval}_Representation_Features.csv`,
        strategyEventsFileName: `MLR1_${symbol}_${interval}_StrategyEvents.csv`,
        manifestFileName: `MLR1_${symbol}_${interval}_Manifest.json`
    });
}

export function buildV3ContinuousHeader(
    featureKeys: readonly string[],
    include15mMtf: boolean
): string {
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
        ...(include15mMtf ? ['context15m', 'htf15mDiagnostic'] : [])
    ];
    return names.map(v3CsvEscape).join(',');
}

export function formatV3ContinuousRow(
    stepOut: V3PipelineBarStepOutput,
    featureKeys: readonly string[],
    mtfCache: MTF15mSerializerCache,
    include15mMtf: boolean
): string {
    const { observation, candle, dataQuality } = stepOut;
    const vals: string[] = [
        v3CsvEscape(stepOut.observationId),
        String(stepOut.sourceTimestamp),
        String(stepOut.observationTimestamp),
        String(candle.open),
        String(candle.high),
        String(candle.low),
        String(candle.close),
        String(candle.volume),
        v3CsvEscape(observation.symbol),
        v3CsvEscape(observation.timeframe),
        v3CsvEscape(JSON.stringify(dataQuality)),
        ...featureKeys.map(k => {
            const v = observation.features[k];
            if (!Number.isFinite(v)) {
                throw new Error(`V3 Serialization Error: non-finite feature '${k}' at bar ${stepOut.acceptedBarIndex}.`);
            }
            return String(v);
        }),
        ...featureKeys.map(k => {
            const valid = observation.validity[k];
            if (typeof valid !== 'boolean') {
                throw new Error(`V3 Serialization Error: non-boolean validity '${k}' at bar ${stepOut.acceptedBarIndex}.`);
            }
            return String(valid);
        })
    ];

    if (include15mMtf) {
        if (!stepOut.context15m) {
            throw new Error(`V3 Serialization Error: missing context15m at bar ${stepOut.acceptedBarIndex}.`);
        }
        vals.push(v3CsvEscape(mtfCache.serializeContext(stepOut.context15m)));
        vals.push(v3CsvEscape(mtfCache.serializeDiagnostic(stepOut.htf15mDiagnostic)));
    }

    return vals.join(',');
}

export function buildV3StrategyEventHeader(): string {
    return V3_STRATEGY_EVENT_COLUMNS.map(v3CsvEscape).join(',');
}

export function formatV3StrategyEventRow(row: V3StrategyEventRow): string {
    return V3_STRATEGY_EVENT_COLUMNS.map(key => {
        const val = row[key];
        if (typeof val === 'number') {
            if (!Number.isFinite(val)) {
                throw new Error(`V3 Serialization Error: non-finite numeric field '${String(key)}' on event '${row.event_id}'.`);
            }
            return String(val);
        }
        return v3CsvEscape(val);
    }).join(',');
}

export function buildV3RepresentationHeader(): string {
    assertV3RepresentationZeroTierCLeakage(V3_REPRESENTATION_COLUMNS);
    return V3_REPRESENTATION_COLUMNS.map(v3CsvEscape).join(',');
}

export function formatV3RepresentationRow(
    row: V3StrategyEventRow
): { readonly repRow: V3RepresentationRow; readonly csvLine: string } {
    const repRow = buildV3RepresentationRow(row);
    assertV3RepresentationRowZeroLeakage(repRow);
    const csvLine = V3_REPRESENTATION_COLUMNS.map(key => {
        const val = repRow[key];
        if (typeof val === 'number') {
            if (!Number.isFinite(val)) {
                throw new Error(`V3 Representation Serialization Error: non-finite '${String(key)}' on '${repRow.tierB_event_id}'.`);
            }
            return String(val);
        }
        return v3CsvEscape(val);
    }).join(',');
    return { repRow, csvLine };
}

export function buildV3DatasetManifest(params: {
    readonly runner: V3PipelineRunner;
    readonly config: V3PipelineConfig;
    readonly totalRawCandles: number;
    readonly startTimestamp: number;
    readonly endTimestamp: number;
    readonly outcomeAccounting: V3OutcomeAccounting;
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
        throw new Error(
            `V3 Manifest Error: cannot publish manifest for unvalidated export (${auditResults?.remarks?.join('; ') || 'audit failed'}).`
        );
    }

    const stats = runner.getStats();
    const uptime = evaluateDatasetUptime(
        stats,
        config.integrityPolicy,
        config.intervalMs,
        config.sourceTimestampBounds ?? { startTimestamp, endTimestamp }
    );
    const fileNames = getV3FileNames(config.symbol, config.interval);
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
        tierBConfirmedTeacherEventCount: params.strategyEventRowCount,
        tierCOutcomeRowCount: params.strategyEventRowCount,
        actualFileRowCounts
    };
    const htf15m = runner.getHtf15mStats();
    const manifest = createDatasetManifest(
        `DS_${config.symbol}_${config.interval}_V${V3_DATASET_VERSION}`,
        'BINANCE_SPOT',
        {
            symbol: config.symbol,
            baseTimeframe: config.interval,
            datasetVersion: V3_DATASET_VERSION,
            representationSchemaVersion: V3_REPRESENTATION_SCHEMA_VERSION,
            modelInputSchemaVersion: V3_MODEL_INPUT_SCHEMA_VERSION,
            sourceIntervalMs: config.intervalMs,
            featureConfigVersion: getV3FeatureConfigVersion(config),
            teacherVersion: V3_TEACHER_VERSION,
            outcomeConfigVersion: V3_OUTCOME_CONFIG_VERSION,
            dateRange: { startTimestamp, endTimestamp },
            integrityPolicy: config.integrityPolicy,
            exportConfig: {
                exportTierA: true,
                exportTierB: true,
                exportTierC: true,
                // Per DatasetConfig contract: false because StrategyEvents.csv co-locates Tier B teacher rows with Tier C outcomes;
                // Continuous_Observations.csv and Representation_Features.csv remain separate zero-leakage files.
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
                `V3 Multi-Teacher Pipeline (15m-only MTF, 60/120/180 independent horizons): ` +
                    `${outcomeAccounting.totalCandidateEvents} candidates, ${outcomeAccounting.eligibleEvents} eligible, ` +
                    `excluded(missingOpen=${outcomeAccounting.excludedMissingNextOpen}, unwarmedAtr=${outcomeAccounting.excludedUnwarmedAtr}, incompleteHz180=${outcomeAccounting.excludedIncompleteHorizon}).`,
                `Strategy Counts: ${JSON.stringify(outcomeAccounting.countsByStrategy)}`,
                `Event Type Counts: ${JSON.stringify(outcomeAccounting.countsByEventType)}`,
                `Tier B + Tier C co-located in ${fileNames.strategyEventsFileName} (separateFiles=false); model-input projection in ${fileNames.representationFileName}.`,
                `SHA-256 ${fileNames.continuousFileName}: ${params.fileChecksums.continuousSha256}`,
                `SHA-256 ${fileNames.representationFileName}: ${params.fileChecksums.representationSha256}`,
                `SHA-256 ${fileNames.strategyEventsFileName}: ${params.fileChecksums.strategyEventsSha256}`,
                ...auditResults.remarks
            ]
        },
        exportAccounting,
        {
            htf15mGapCount: htf15m.htf15mGapCount,
            htf15mResetCount: htf15m.htf15mResetCount,
            htf15mIncompleteWindowCount: htf15m.htf15mIncompleteWindowCount,
            htf1hGapCount: 0,
            htf1hResetCount: 0,
            htf1hIncompleteWindowCount: 0
        }
    );

    return params.buildTimestamp === undefined
        ? manifest
        : { ...manifest, buildTimestamp: params.buildTimestamp };
}
