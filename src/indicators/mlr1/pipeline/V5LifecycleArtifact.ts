import type { DatasetManifest, ExportAccounting } from '../dataset/DatasetManifest';
import {
    createDatasetManifest,
    createInitialBackboneStats,
    evaluateDatasetUptime,
    extractDataQuality,
    processSourceObservation,
    validateCandleOhlcv
} from '../dataset/ObservationBackbone';
import type { ML1Candle, ML1Observation } from '../ML1FeatureTypes';
import {
    assertV5ZoneLifecycleManifestReconciliation,
    summarizeV5ZoneLifecycleAccounting,
    V5_DATASET_VERSION,
    V5_MODEL_INPUT_SCHEMA_VERSION,
    V5_OUTCOME_CONFIG_VERSION,
    V5_REPRESENTATION_SCHEMA_VERSION,
    V5_TEACHER_VERSION,
    validateV5ZoneLifecycleRecord,
    type V5Direction,
    type V5ZoneActivityState,
    type V5ZoneLifecycleEvent,
    type V5ZoneLifecycleRecord,
    type V5ZoneSide,
    type V5ZoneSource,
    type V5ZoneTimeframe
} from './V5OutcomeContracts';
import { parseCsvDocumentCRLF, serializeCsvRecord } from './V3ArtifactAuditor';

export const V5_ZONE_LIFECYCLE_COLUMNS: readonly (keyof V5ZoneLifecycleRecord)[] = Object.freeze([
    'lifecycleId',
    'zoneId',
    'symbol',
    'source',
    'zoneTimeframe',
    'zoneSide',
    'zoneDirection',
    'eventType',
    'eventDirection',
    'zoneActivity',
    'eventRole',
    'outcomeEligible',
    'retestCount',
    'retestEpisodeId',
    'zoneTop',
    'zoneBot',
    'createdSourceTimestamp',
    'createdConfirmationTimestamp',
    'confirmationTimestamp',
    'createdBaseBarIndex',
    'confirmationBaseBarIndex',
    'createdNativeBarIndex',
    'confirmationNativeBarIndex',
    'zoneAgeBaseBars',
    'zoneAgeNativeBars',
    'touchDepthNormRaw',
    'touchDepthNormClamped',
    'closeDepthNormRaw',
    'closeDepthNormClamped',
    'atr14Valid',
    'zoneWidthAtr',
    'supersededByZoneId'
]);

export function getV5LifecycleFileNames(symbol: string, interval: string) {
    return Object.freeze({
        lifecycleFileName: `MLR1_${symbol}_${interval}_V5_ZoneLifecycle.csv`,
        manifestFileName: `MLR1_${symbol}_${interval}_V5_Manifest.json`
    });
}

async function computeUtf8Sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function formatCell(val: unknown): string {
    if (val === null || val === undefined) return '';
    return String(val);
}

export function serializeV5ZoneLifecycleCsv(records: readonly V5ZoneLifecycleRecord[]): string {
    const header = serializeCsvRecord(V5_ZONE_LIFECYCLE_COLUMNS as readonly string[]);
    const lines: string[] = [header];
    for (const r of records) {
        validateV5ZoneLifecycleRecord(r);
        lines.push(serializeCsvRecord(V5_ZONE_LIFECYCLE_COLUMNS.map(col => formatCell(r[col]))));
    }
    return lines.join('\r\n');
}

export function buildV5LifecycleDatasetManifest(params: {
    readonly symbol: string;
    readonly timeframe: string;
    readonly intervalMs: number;
    readonly candles: readonly ML1Candle[];
    readonly observations: readonly ML1Observation[];
    readonly lifecycleRecords: readonly V5ZoneLifecycleRecord[];
    readonly lifecycleSha256: string;
    readonly allowGaps?: boolean;
    readonly buildTimestamp?: number;
}): DatasetManifest {
    const { symbol, timeframe, intervalMs, candles, observations, lifecycleRecords } = params;
    const allowGaps = params.allowGaps ?? false;
    if (!/^[0-9a-f]{64}$/.test(params.lifecycleSha256)) {
        throw new Error(`V5 Manifest Error: invalid lifecycleSha256 '${params.lifecycleSha256}'.`);
    }

    const policy = Object.freeze({
        rejectInvalidSource: true,
        rejectInvalidOhlcv: true,
        rejectDuplicateTimestamp: true,
        rejectOutOfOrder: true,
        requireMinimumUptimeFraction: allowGaps ? undefined : 1.0
    });

    let stats = createInitialBackboneStats();
    const gridAnchor = candles[0]?.time ?? 0;
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const dq = extractDataQuality(observations[i]);
        const isValid = validateCandleOhlcv(c);
        const step = processSourceObservation(
            stats,
            c.time,
            dq,
            isValid,
            policy,
            intervalMs,
            { isUniqueSource: true, isCandidateUniqueAccepted: true },
            { gridAnchor, isOnGrid: (c.time - gridAnchor) % intervalMs === 0, isWithinRange: true }
        );
        stats = step.nextStats;
    }

    const startTimestamp = candles[0].time;
    const endTimestamp = candles[candles.length - 1].time;
    const uptime = evaluateDatasetUptime(stats, policy, intervalMs, { startTimestamp, endTimestamp });
    if (!allowGaps && (!uptime.isUptimeValid || stats.missingIntervalCount > 0)) {
        throw new Error(
            `V5 Manifest Error: continuous lifecycle export rejected gapped stream (uptime=${uptime.usableObservationFraction}, missingIntervals=${stats.missingIntervalCount}).`
        );
    }
    const fileNames = getV5LifecycleFileNames(symbol, timeframe);
    const zoneLifecycleAccounting = summarizeV5ZoneLifecycleAccounting(lifecycleRecords);

    const exportAccounting: ExportAccounting = {
        rawSourceCandleCount: candles.length,
        acceptedSourceObservationCount: stats.acceptedObservationCount,
        rejectedSourceObservationCount: stats.rejectedObservationCount,
        tierAContinuousObservationCount: stats.acceptedObservationCount,
        tierAEventRepresentationRowCount: 0,
        tierBConfirmedTeacherEventCount: 0,
        tierCOutcomeRowCount: 0,
        actualFileRowCounts: {
            [fileNames.lifecycleFileName]: lifecycleRecords.length
        }
    };

    const baseManifest = createDatasetManifest(
        `DS_${symbol}_${timeframe}_V${V5_DATASET_VERSION}`,
        'BINANCE_SPOT',
        {
            symbol,
            baseTimeframe: timeframe,
            datasetVersion: V5_DATASET_VERSION,
            representationSchemaVersion: V5_REPRESENTATION_SCHEMA_VERSION,
            modelInputSchemaVersion: V5_MODEL_INPUT_SCHEMA_VERSION,
            sourceIntervalMs: intervalMs,
            featureConfigVersion: 'ML1_CONFIG_D_v1',
            teacherVersion: V5_TEACHER_VERSION,
            outcomeConfigVersion: V5_OUTCOME_CONFIG_VERSION,
            dateRange: { startTimestamp, endTimestamp },
            integrityPolicy: policy,
            exportConfig: {
                exportTierA: false,
                exportTierB: true,
                exportTierC: false,
                separateFiles: true
            }
        },
        stats,
        uptime,
        {
            passed: true,
            chronologyValid: true,
            identityUnique: true,
            inputOutcomeSeparationValid: true,
            remarks: [
                `SHA-256 ${fileNames.lifecycleFileName}: ${params.lifecycleSha256}`
            ]
        },
        exportAccounting
    );

    const withTs = params.buildTimestamp === undefined
        ? baseManifest
        : { ...baseManifest, buildTimestamp: params.buildTimestamp };

    return Object.freeze({
        ...withTs,
        teacherTimeframes: Object.freeze({
            phl: Object.freeze(['1m', '3m', '5m'] as const),
            dtfxStrictCbc: Object.freeze(['1m', '3m', '5m'] as const)
        }),
        fileChecksums: Object.freeze({
            [fileNames.lifecycleFileName]: params.lifecycleSha256
        }),
        zoneLifecycleAccounting
    });
}

function parseBoolStrict(raw: string | undefined, field: string): boolean {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`V5 Lifecycle Audit Error: invalid boolean '${field}'='${String(raw)}'.`);
}

function parseIntDecimalStrict(raw: string | undefined, field: string): number {
    if (raw === undefined || !/^(?:0|-?[1-9]\d*)$/.test(raw)) {
        throw new Error(`V5 Lifecycle Audit Error: invalid decimal integer '${field}'='${String(raw)}'.`);
    }
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) {
        throw new Error(`V5 Lifecycle Audit Error: unsafe integer '${field}'='${raw}'.`);
    }
    return n;
}

function parseFloatDecimalStrict(raw: string | undefined, field: string): number {
    if (raw === undefined || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
        throw new Error(`V5 Lifecycle Audit Error: invalid decimal float '${field}'='${String(raw)}'.`);
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
        throw new Error(`V5 Lifecycle Audit Error: non-finite float '${field}'='${raw}'.`);
    }
    return n;
}

function parseNullableFloatDecimalStrict(raw: string | undefined, field: string): number | null {
    if (raw === undefined || raw === '') return null;
    return parseFloatDecimalStrict(raw, field);
}

export function validateBaseTimeline(
    continuousBaseTimestamps: readonly number[],
    baseIntervalMs = 60_000,
    allowGaps = false
): void {
    if (typeof allowGaps !== 'boolean') {
        throw new Error(`V5 Timeline Error: allowGaps must be a boolean, got ${typeof allowGaps}.`);
    }
    if (!Number.isSafeInteger(baseIntervalMs) || baseIntervalMs <= 0) {
        throw new Error(`V5 Timeline Error: baseIntervalMs must be a positive safe integer, got ${String(baseIntervalMs)}.`);
    }
    if (!Array.isArray(continuousBaseTimestamps as unknown) || continuousBaseTimestamps.length === 0) {
        throw new Error('V5 Timeline Error: continuousBaseTimestamps must be a non-empty array.');
    }
    let prevTs = -1;
    for (let i = 0; i < continuousBaseTimestamps.length; i++) {
        const ts = continuousBaseTimestamps[i];
        if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts <= 0) {
            throw new Error(`V5 Timeline Error: non-safe-integer or non-positive timestamp at index ${i}: ${String(ts)}.`);
        }
        if (ts % baseIntervalMs !== 0) {
            throw new Error(`V5 Timeline Error: off-grid timestamp at index ${i}: ${ts} (% ${baseIntervalMs} !== 0).`);
        }
        if (prevTs !== -1) {
            if (ts <= prevTs) {
                throw new Error(`V5 Timeline Error: duplicate or non-increasing timestamp at index ${i}: ${ts} <= ${prevTs}.`);
            }
            if (!allowGaps && ts - prevTs !== baseIntervalMs) {
                throw new Error(`V5 Timeline Error: non-contiguous spacing at index ${i}: ${ts - prevTs}ms !== ${baseIntervalMs}ms.`);
            }
        }
        prevTs = ts;
    }
}

/**
 * Independently reconstructs completed native-bar indices from validated base timestamps.
 * Matches DTFXStrictCBCTeacher.ts semantics: canonical htfBarIndex restarts at 0 on GAP_RESET.
 */
export function buildCompletedNativeIndexTimeline(
    continuousBaseTimestamps: readonly number[],
    tfMs: number,
    baseIntervalMs = 60_000,
    allowGaps = false
): number[] {
    if (!Number.isSafeInteger(baseIntervalMs) || baseIntervalMs <= 0) {
        throw new Error(`V5 Timeline Error: baseIntervalMs must be a positive safe integer, got ${String(baseIntervalMs)}.`);
    }
    if (!Number.isSafeInteger(tfMs) || tfMs <= 0 || tfMs % baseIntervalMs !== 0) {
        throw new Error(`V5 Timeline Error: tfMs (${String(tfMs)}) must be a positive integer multiple of baseIntervalMs (${baseIntervalMs}).`);
    }
    validateBaseTimeline(continuousBaseTimestamps, baseIntervalMs, allowGaps);
    const barsPerBucket = tfMs / baseIntervalMs;
    const out = new Array<number>(continuousBaseTimestamps.length).fill(-1);
    let completedCount = 0;
    let activeBucketStart = -1;
    let bucketBarCount = 0;
    let prevTs = -1;

    for (let i = 0; i < continuousBaseTimestamps.length; i++) {
        const ts = continuousBaseTimestamps[i];
        const hasGap = prevTs !== -1 && ts !== prevTs + baseIntervalMs;
        prevTs = ts;

        const bucketStart = Math.floor(ts / tfMs) * tfMs;
        if (hasGap) {
            // Canonical DTFXStrictCBCTeacher resets htfBarIndex to 0 on discontinuity
            completedCount = 0;
            if (ts === bucketStart) {
                activeBucketStart = bucketStart;
                bucketBarCount = 1;
            } else {
                activeBucketStart = -1;
                bucketBarCount = 0;
            }
        } else if (activeBucketStart === -1) {
            if (ts === bucketStart) {
                activeBucketStart = bucketStart;
                bucketBarCount = 1;
            }
        } else if (bucketStart === activeBucketStart) {
            bucketBarCount++;
        } else {
            activeBucketStart = ts === bucketStart ? bucketStart : -1;
            bucketBarCount = ts === bucketStart ? 1 : 0;
        }

        if (activeBucketStart !== -1 &&
            bucketBarCount === barsPerBucket &&
            ts === activeBucketStart + tfMs - baseIntervalMs) {
            completedCount++;
            activeBucketStart = -1;
            bucketBarCount = 0;
        }
        out[i] = completedCount - 1;
    }
    return out;
}

export async function auditV5LifecycleArtifacts(params: {
    readonly lifecycleCsv: string;
    readonly manifestJson: string;
    readonly continuousBaseTimestamps: readonly number[];
    readonly allowGaps?: boolean;
}): Promise<{ readonly passed: boolean; readonly parsedCount: number; readonly remarks: readonly string[] }> {
    const remarks: string[] = [];
    const allowGaps = params.allowGaps ?? false;
    try {
        validateBaseTimeline(params.continuousBaseTimestamps, 60_000, allowGaps);

        const parsedManifest = JSON.parse(params.manifestJson) as DatasetManifest;
        if (parsedManifest.datasetVersion !== V5_DATASET_VERSION ||
            parsedManifest.representationSchemaVersion !== V5_REPRESENTATION_SCHEMA_VERSION ||
            parsedManifest.modelInputSchemaVersion !== V5_MODEL_INPUT_SCHEMA_VERSION ||
            parsedManifest.teacherVersion !== V5_TEACHER_VERSION) {
            throw new Error('V5 Manifest version/schema mismatch.');
        }
        if (!parsedManifest.zoneLifecycleAccounting) {
            throw new Error('V5 Manifest missing zoneLifecycleAccounting.');
        }

        const fileNames = getV5LifecycleFileNames(parsedManifest.symbol, parsedManifest.timeframe);
        const expectedSha256 = parsedManifest.fileChecksums?.[fileNames.lifecycleFileName];
        if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
            throw new Error(`V5 Manifest missing valid structured fileChecksums['${fileNames.lifecycleFileName}'].`);
        }
        const actualSha256 = await computeUtf8Sha256Hex(params.lifecycleCsv);
        if (actualSha256 !== expectedSha256) {
            throw new Error(
                `V5 Lifecycle SHA-256 mismatch on '${fileNames.lifecycleFileName}': actual ${actualSha256} !== manifest ${expectedSha256}.`
            );
        }

        const rows = parseCsvDocumentCRLF(params.lifecycleCsv);
        const header = rows[0] ?? [];
        if (header.length !== V5_ZONE_LIFECYCLE_COLUMNS.length ||
            header.some((c, i) => c !== V5_ZONE_LIFECYCLE_COLUMNS[i])) {
            throw new Error('V5_ZoneLifecycle.csv header mismatch.');
        }

        const nativeTimelineByTf: Record<V5ZoneTimeframe, number[]> = {
            '1m': buildCompletedNativeIndexTimeline(params.continuousBaseTimestamps, 60_000, 60_000, allowGaps),
            '3m': buildCompletedNativeIndexTimeline(params.continuousBaseTimestamps, 180_000, 60_000, allowGaps),
            '5m': buildCompletedNativeIndexTimeline(params.continuousBaseTimestamps, 300_000, 60_000, allowGaps)
        };

        const parsedRecords: V5ZoneLifecycleRecord[] = [];
        const seenLifecycleIds = new Set<string>();

        for (let rIdx = 1; rIdx < rows.length; rIdx++) {
            const cells = rows[rIdx];
            if (cells.length !== V5_ZONE_LIFECYCLE_COLUMNS.length) {
                throw new Error(`Row ${rIdx} column count mismatch.`);
            }
            const m = new Map<string, string>();
            for (let c = 0; c < V5_ZONE_LIFECYCLE_COLUMNS.length; c++) {
                m.set(V5_ZONE_LIFECYCLE_COLUMNS[c], cells[c]);
            }

            const eventRoleRaw = m.get('eventRole');
            if (eventRoleRaw !== 'ZONE_LIFECYCLE') {
                throw new Error(`V5 Lifecycle Audit Error: invalid eventRole '${String(eventRoleRaw)}' on row ${rIdx}.`);
            }
            const outcomeEligibleRaw = parseBoolStrict(m.get('outcomeEligible'), 'outcomeEligible');
            if (outcomeEligibleRaw !== false) {
                throw new Error(`V5 Lifecycle Audit Error: lifecycle row ${rIdx} cannot have outcomeEligible=true.`);
            }

            const rec: V5ZoneLifecycleRecord = {
                lifecycleId: m.get('lifecycleId')!,
                zoneId: m.get('zoneId')!,
                symbol: m.get('symbol')!,
                source: m.get('source')! as V5ZoneSource,
                zoneTimeframe: m.get('zoneTimeframe')! as V5ZoneTimeframe,
                zoneSide: m.get('zoneSide')! as V5ZoneSide,
                zoneDirection: m.get('zoneDirection')! as V5Direction,
                eventType: m.get('eventType')! as V5ZoneLifecycleEvent,
                eventDirection: m.get('eventDirection') === '' ? null : (m.get('eventDirection')! as V5Direction),
                zoneActivity: m.get('zoneActivity')! as V5ZoneActivityState,
                eventRole: 'ZONE_LIFECYCLE',
                outcomeEligible: false,
                retestCount: parseIntDecimalStrict(m.get('retestCount'), 'retestCount'),
                retestEpisodeId: m.get('retestEpisodeId') === '' ? null : m.get('retestEpisodeId')!,
                zoneTop: parseFloatDecimalStrict(m.get('zoneTop'), 'zoneTop'),
                zoneBot: parseFloatDecimalStrict(m.get('zoneBot'), 'zoneBot'),
                createdSourceTimestamp: parseIntDecimalStrict(m.get('createdSourceTimestamp'), 'createdSourceTimestamp'),
                createdConfirmationTimestamp: parseIntDecimalStrict(m.get('createdConfirmationTimestamp'), 'createdConfirmationTimestamp'),
                confirmationTimestamp: parseIntDecimalStrict(m.get('confirmationTimestamp'), 'confirmationTimestamp'),
                createdBaseBarIndex: parseIntDecimalStrict(m.get('createdBaseBarIndex'), 'createdBaseBarIndex'),
                confirmationBaseBarIndex: parseIntDecimalStrict(m.get('confirmationBaseBarIndex'), 'confirmationBaseBarIndex'),
                createdNativeBarIndex: parseIntDecimalStrict(m.get('createdNativeBarIndex'), 'createdNativeBarIndex'),
                confirmationNativeBarIndex: parseIntDecimalStrict(m.get('confirmationNativeBarIndex'), 'confirmationNativeBarIndex'),
                zoneAgeBaseBars: parseIntDecimalStrict(m.get('zoneAgeBaseBars'), 'zoneAgeBaseBars'),
                zoneAgeNativeBars: parseIntDecimalStrict(m.get('zoneAgeNativeBars'), 'zoneAgeNativeBars'),
                touchDepthNormRaw: parseNullableFloatDecimalStrict(m.get('touchDepthNormRaw'), 'touchDepthNormRaw'),
                touchDepthNormClamped: parseNullableFloatDecimalStrict(m.get('touchDepthNormClamped'), 'touchDepthNormClamped'),
                closeDepthNormRaw: parseNullableFloatDecimalStrict(m.get('closeDepthNormRaw'), 'closeDepthNormRaw'),
                closeDepthNormClamped: parseNullableFloatDecimalStrict(m.get('closeDepthNormClamped'), 'closeDepthNormClamped'),
                atr14Valid: parseBoolStrict(m.get('atr14Valid'), 'atr14Valid'),
                zoneWidthAtr: parseNullableFloatDecimalStrict(m.get('zoneWidthAtr'), 'zoneWidthAtr'),
                supersededByZoneId: m.get('supersededByZoneId') === '' ? null : m.get('supersededByZoneId')!
            };

            validateV5ZoneLifecycleRecord(rec);
            if (seenLifecycleIds.has(rec.lifecycleId)) {
                throw new Error(`Duplicate lifecycleId '${rec.lifecycleId}'.`);
            }
            seenLifecycleIds.add(rec.lifecycleId);

            // Base timestamp/index verification against continuous timeline
            const expectedCreatedTs = params.continuousBaseTimestamps[rec.createdBaseBarIndex];
            const expectedConfTs = params.continuousBaseTimestamps[rec.confirmationBaseBarIndex];
            if (expectedCreatedTs === undefined || rec.createdConfirmationTimestamp !== expectedCreatedTs) {
                throw new Error(
                    `Timestamp/index mismatch on '${rec.lifecycleId}': createdConfirmationTimestamp (${rec.createdConfirmationTimestamp}) !== timeline[${rec.createdBaseBarIndex}] (${expectedCreatedTs}).`
                );
            }
            if (expectedConfTs === undefined || rec.confirmationTimestamp !== expectedConfTs) {
                throw new Error(
                    `Timestamp/index mismatch on '${rec.lifecycleId}': confirmationTimestamp (${rec.confirmationTimestamp}) !== timeline[${rec.confirmationBaseBarIndex}] (${expectedConfTs}).`
                );
            }

            // Independent timestamp-derived native-bar index & age verification
            // On GAP_RESET, the event closes a pre-gap zone using the last pre-gap completed native bar (confirmationBaseBarIndex - 1).
            const tfTimeline = nativeTimelineByTf[rec.zoneTimeframe];
            const expectedCreatedNative = tfTimeline[rec.createdBaseBarIndex];
            const confLookupIdx = rec.eventType === 'GAP_RESET'
                ? rec.confirmationBaseBarIndex - 1
                : rec.confirmationBaseBarIndex;
            const expectedConfNative = tfTimeline[confLookupIdx];

            if (expectedCreatedNative === undefined || expectedCreatedNative < 0 || rec.createdNativeBarIndex !== expectedCreatedNative) {
                throw new Error(
                    `Native creation index mismatch on '${rec.lifecycleId}': got ${rec.createdNativeBarIndex}, expected ${expectedCreatedNative}.`
                );
            }
            if (expectedConfNative === undefined || expectedConfNative < 0 || rec.confirmationNativeBarIndex !== expectedConfNative) {
                throw new Error(
                    `Native confirmation index mismatch on '${rec.lifecycleId}': got ${rec.confirmationNativeBarIndex}, expected ${expectedConfNative}.`
                );
            }
            if (rec.zoneAgeNativeBars !== expectedConfNative - expectedCreatedNative) {
                throw new Error(
                    `Native age mismatch on '${rec.lifecycleId}': got ${rec.zoneAgeNativeBars}, expected ${expectedConfNative - expectedCreatedNative}.`
                );
            }

            parsedRecords.push(rec);
        }

        const manifestRowCount = parsedManifest.exportAccounting.actualFileRowCounts[fileNames.lifecycleFileName];
        if (manifestRowCount !== parsedRecords.length) {
            throw new Error(
                `Manifest actualFileRowCounts['${fileNames.lifecycleFileName}'] (${manifestRowCount}) !== CSV rows (${parsedRecords.length}).`
            );
        }

        assertV5ZoneLifecycleManifestReconciliation(parsedRecords, parsedManifest.zoneLifecycleAccounting);
        return { passed: true, parsedCount: parsedRecords.length, remarks: [] };
    } catch (e: any) {
        remarks.push(e?.message || String(e));
        return { passed: false, parsedCount: 0, remarks };
    }
}
