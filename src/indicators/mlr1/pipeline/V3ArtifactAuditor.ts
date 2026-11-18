import type { IntegrityAuditResults } from '../dataset/DatasetManifest';
import {
    HTF_DIAGNOSTIC_ALLOWLIST,
    MTF_COMPLETED_CANDLE_ALLOWLIST,
    MTF_CONTEXT_ALLOWLIST,
    TIER_C_V3_QUARANTINE_LIST
} from '../dataset/DatasetSchema';
import {
    assertV3RepresentationZeroTierCLeakage,
    serializeAndValidateStructuralContext,
    V3_MAX_HORIZON_BARS,
    V3_REPRESENTATION_COLUMNS,
    V3_STOP_ATR_MULT,
    V3_STRATEGY_EVENT_COLUMNS,
    V3_TARGET_R_MULT,
    V3_TRADE_COST_R,
    type V3HorizonOutcomeClass
} from './MultiHorizonOutcomeEngine';
import { compareStrategyEvents, type StrategyId } from '../teachers/StrategyEventTypes';

const V3_MTF15M_ALLOWED_FEATURES: ReadonlySet<string> = new Set([
    'IsValidOHLCV', 'IsSynthetic', 'IsFlatCandle', 'IsZeroVolume', 'IsInvalidIndex',
    'HasDataGap', 'IsDiscontinuity', 'IsUnexpectedInterval', 'IsDuplicateTimestamp', 'IsOutOfOrder',
    'HasPreviousCandle', 'HasExpectedPreviousTimestamp', 'TimeDeltaSeconds', 'IsSourceValid', 'IsWarmupComplete',
    'CandleRange', 'BodySize', 'UpperWick', 'LowerWick', 'CandleDirection',
    'CloseLocation', 'BodyToRange', 'UpperWickRatio', 'LowerWickRatio',
    'MinuteOfHour', 'HourOfDay', 'DayOfWeek',
    'SinMinuteOfHour', 'CosMinuteOfHour', 'SinHourOfDay', 'CosHourOfDay', 'SinDayOfWeek', 'CosDayOfWeek',
    'ATR_14', 'ATR_14_Normalized', 'ATR_20', 'ATR_20_Normalized', 'ATR14_to_ATR20',
    ...[5, 10, 20, 50].flatMap(p => [
        `RollingHighestHigh_${p}`, `RollingLowestLow_${p}`, `RollingRangeWidth_${p}`,
        `PositionWithinRollingRange_${p}`, `RollingHighDistance_${p}`, `RollingLowDistance_${p}`
    ]),
    'RangeToATR14', 'BodyToATR14', 'RangeToATR20', 'BodyToATR20',
    ...[9, 20, 50, 100, 200].flatMap(p => [`EMA_${p}_Distance`, `EMA_${p}_Slope_3`, `EMA_${p}_Slope_10`]),
    ...[
        [9, 20], [20, 50], [50, 100], [100, 200]
    ].flatMap(([a, b]) => [`EMA_${a}_Above_EMA_${b}`, `EMA_${a}_${b}_Separation`, `EMA_SpreadChange_${a}_${b}`]),
    'Return_1', 'Return_3', 'Return_5', 'Return_10',
    'Momentum_3', 'Momentum_5', 'Momentum_10', 'Momentum_20',
    ...[5, 10, 20].flatMap(p => [`DirectionalEfficiency_${p}`, `PositiveReturnFraction_${p}`, `ReturnBalance_${p}`]),
    'Volume', 'LogVolume', 'VolumeChange_1', 'VolumeChange_3',
    'RelativeVolume_10', 'RelativeVolume_20', 'RelativeVolume_50',
    'VolumeZScore_20', 'VolumeZScore_50', 'SignedVolume_20'
]);

const V3_VAM_AND_EXHAUSTION_FEATURES: readonly string[] = [
    'Exhaustion_20',
    'VAM_Center_Dist_ATR',
    'VAM_Slope_3_ATR',
    'VAM_Efficiency',
    'VAM_ADX_14',
    'VAM_DI_Spread_14',
    'VAM_RSI_14',
    'VAM_Trend',
    'VAM_BuyStreak',
    'VAM_SellStreak',
    'VAM_Signal'
];

const V3_CONTINUOUS_NON1M_ALLOWED_FEATURES: ReadonlySet<string> = new Set([
    ...V3_MTF15M_ALLOWED_FEATURES,
    ...V3_VAM_AND_EXHAUSTION_FEATURES
]);

const V3_CONTINUOUS_1M_ALLOWED_FEATURES: ReadonlySet<string> = new Set([
    ...V3_CONTINUOUS_NON1M_ALLOWED_FEATURES,
    'VolumeCandleSize_Ratio_360',
    'VolumeCandleSize_ZScore_360',
    'VolumeCandleSize_Regime_360'
]);

const CONTINUOUS_FIXED_HEADERS = [
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
    'data_quality'
] as const;

const DATA_QUALITY_KEYS = [
    'isSourceValid',
    'hasDataGap',
    'isDiscontinuity',
    'isDuplicate',
    'isOutOfOrder',
    'isUnexpectedInterval'
] as const;

const QUARANTINED_LOWER = new Set(TIER_C_V3_QUARANTINE_LIST.map(k => k.toLowerCase()));
const VALID_HORIZON_OUTCOMES = new Set<string>([
    'full_target',
    'hard_stop',
    'timeout_net_gain',
    'timeout_net_loss'
]);
const VALID_AVAILABILITY = new Set<string>(['UNAVAILABLE', 'WARMING_UP', 'AVAILABLE_VALID', 'STALE']);
const VALID_HTF_COMPLETENESS = new Set<string>([
    'INCOMPLETE_MISSING',
    'INCOMPLETE_INVALID',
    'INCOMPLETE_DUPLICATE',
    'INCOMPLETE_UNFINISHED'
]);

type CsvParserState = 'FIELD_START' | 'IN_UNQUOTED' | 'IN_QUOTES' | 'AFTER_QUOTE';

/**
 * Single authoritative RFC-4180 CSV parser (CRLF record separator).
 * Rejects quotes inside unquoted fields, characters after closing quotes, unpaired LF, and unterminated quotes.
 */
export function parseCsvDocumentCRLF(csv: string): string[][] {
    if (typeof csv !== 'string' || csv.length === 0) {
        throw new Error('CSV Parse Error: CSV must be a non-empty string.');
    }
    const records: string[][] = [];
    let row: string[] = [];
    let field = '';
    let state: CsvParserState = 'FIELD_START';

    for (let i = 0; i < csv.length; i++) {
        const ch = csv[i];
        if (state === 'FIELD_START') {
            if (ch === '"') {
                state = 'IN_QUOTES';
            } else if (ch === ',') {
                row.push('');
            } else if (ch === '\r') {
                if (csv[i + 1] !== '\n') throw new Error('CSV Parse Error: CR without LF.');
                row.push('');
                records.push(row);
                row = [];
                i++;
            } else if (ch === '\n') {
                throw new Error('CSV Parse Error: unpaired LF outside quoted field.');
            } else {
                field += ch;
                state = 'IN_UNQUOTED';
            }
        } else if (state === 'IN_UNQUOTED') {
            if (ch === '"') {
                throw new Error('CSV Parse Error: quote inside unquoted field.');
            } else if (ch === ',') {
                row.push(field);
                field = '';
                state = 'FIELD_START';
            } else if (ch === '\r') {
                if (csv[i + 1] !== '\n') throw new Error('CSV Parse Error: CR without LF.');
                row.push(field);
                records.push(row);
                row = [];
                field = '';
                state = 'FIELD_START';
                i++;
            } else if (ch === '\n') {
                throw new Error('CSV Parse Error: unpaired LF outside quoted field.');
            } else {
                field += ch;
            }
        } else if (state === 'IN_QUOTES') {
            if (ch === '"') {
                if (csv[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    state = 'AFTER_QUOTE';
                }
            } else {
                field += ch;
            }
        } else {
            // AFTER_QUOTE
            if (ch === ',') {
                row.push(field);
                field = '';
                state = 'FIELD_START';
            } else if (ch === '\r') {
                if (csv[i + 1] !== '\n') throw new Error('CSV Parse Error: CR without LF after quote.');
                row.push(field);
                records.push(row);
                row = [];
                field = '';
                state = 'FIELD_START';
                i++;
            } else {
                throw new Error('CSV Parse Error: unexpected character after closing quote.');
            }
        }
    }

    if (state === 'IN_QUOTES') {
        throw new Error('CSV Parse Error: unterminated quoted field.');
    }
    row.push(field);
    records.push(row);
    return records;
}

export function parseSingleCsvRecord(line: string): string[] {
    const records = parseCsvDocumentCRLF(line);
    if (records.length !== 1) {
        throw new Error(`CSV Parse Error: expected single record, got ${records.length}.`);
    }
    return records[0];
}

export function serializeCsvRecord(cells: readonly string[]): string {
    return cells
        .map(raw => (/[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw))
        .join(',');
}

function assertExactPlainObject(obj: unknown, label: string, expectedKeys: readonly string[]): Record<string, unknown> {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error(`${label} must be a non-null plain object.`);
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
        throw new Error(`${label} must be a plain object.`);
    }
    const keys = Object.keys(obj);
    if (keys.length !== expectedKeys.length || expectedKeys.some(k => !Object.prototype.hasOwnProperty.call(obj, k))) {
        throw new Error(`${label} keys do not match allowlist.`);
    }
    return obj as Record<string, unknown>;
}

function assertRecursiveNoQuarantinedKeys(val: unknown, depth = 0): void {
    if (depth > 4) throw new Error('Nested JSON exceeds permitted depth.');
    if (val === null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') return;
    if (Array.isArray(val)) {
        for (const item of val) assertRecursiveNoQuarantinedKeys(item, depth + 1);
        return;
    }
    if (typeof val === 'object') {
        for (const k of Object.keys(val)) {
            const lower = k.toLowerCase();
            if (QUARANTINED_LOWER.has(lower) ||
                /(^|_)(entry|exit|stop|target|net_r|outcome|forward|future|horizon|mfe|mae)(_|$)/.test(lower)) {
                throw new Error(`Recursive leakage guard rejected quarantined key '${k}'.`);
            }
            assertRecursiveNoQuarantinedKeys((val as Record<string, unknown>)[k], depth + 1);
        }
        return;
    }
    throw new Error('Unsupported value type in nested JSON.');
}

function parseFiniteNumber(raw: string, label: string): number {
    if (raw === '') throw new Error(`V3 Audit Error: empty numeric cell '${label}'.`);
    const n = Number(raw);
    if (!Number.isFinite(n)) {
        throw new Error(`V3 Audit Error: non-finite numeric cell '${label}' (${raw}).`);
    }
    return n;
}

function parseSafeInt(raw: string, label: string): number {
    const n = parseFiniteNumber(raw, label);
    if (!Number.isSafeInteger(n) || n < 0) {
        throw new Error(`V3 Audit Error: invalid non-negative integer '${label}' (${raw}).`);
    }
    return n;
}

export interface RawReplayBar {
    readonly time: number;
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume: number;
}

export class V3ArtifactAuditor {
    private readonly intervalMs: number;
    private readonly is1mBase: boolean;
    private readonly include15mMtf: boolean;

    private contHeaders: string[] | null = null;
    private contFeatureCount = 0;
    private contRowCount = 0;
    private repRowCount = 0;
    private evRowCount = 0;

    private readonly rawWindow = new Map<number, RawReplayBar>();
    private latestRawBarIndex = -1;
    private prevRawTime = -1;

    private prevEventOrder: {
        confirmationBarIndex: number;
        strategyId: string;
        eventType: string;
        eventId: string;
    } | null = null;
    private readonly seenEventIds = new Set<string>();

    private hasContinuousFailure = false;
    private hasChronologyFailure = false;
    private hasIdentityFailure = false;
    private hasSeparationFailure = false;
    private hasReplayFailure = false;
    private readonly errors: string[] = [];

    public constructor(intervalMs: number, include15mMtf: boolean, is1mBase = true) {
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
            throw new Error(`V3ArtifactAuditor Error: invalid intervalMs ${intervalMs}.`);
        }
        this.intervalMs = intervalMs;
        this.include15mMtf = include15mMtf;
        this.is1mBase = is1mBase;
    }

    private fail(category: 'cont' | 'chrono' | 'id' | 'sep' | 'replay', msg: string): void {
        if (category === 'cont') this.hasContinuousFailure = true;
        if (category === 'chrono') this.hasChronologyFailure = true;
        if (category === 'id') this.hasIdentityFailure = true;
        if (category === 'sep') this.hasSeparationFailure = true;
        if (category === 'replay') this.hasReplayFailure = true;
        if (this.errors.length < 25) this.errors.push(msg);
    }

    public pushRawCandle(barIndex: number, c: RawReplayBar): void {
        if (!Number.isSafeInteger(barIndex) || barIndex < 0 ||
            !Number.isSafeInteger(c.time) || c.time < 0 ||
            !Number.isFinite(c.open) || c.open <= 0 ||
            !Number.isFinite(c.high) || c.high <= 0 ||
            !Number.isFinite(c.low) || c.low <= 0 ||
            !Number.isFinite(c.close) || c.close <= 0 ||
            !Number.isFinite(c.volume) || c.volume < 0 ||
            c.high < c.low || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) {
            this.fail('replay', `Invalid raw OHLCV candle at bar ${barIndex}.`);
            return;
        }
        if (barIndex !== this.latestRawBarIndex + 1 || (this.prevRawTime !== -1 && c.time <= this.prevRawTime)) {
            this.fail('chrono', `Non-monotonic raw candle at bar ${barIndex}.`);
            return;
        }
        this.rawWindow.set(barIndex, c);
        this.latestRawBarIndex = barIndex;
        this.prevRawTime = c.time;

        // Retain 182 bars (confirmation bar + 180-bar horizon + 1 safety margin)
        const pruneBefore = barIndex - (V3_MAX_HORIZON_BARS + 2);
        if (pruneBefore >= 0) {
            this.rawWindow.delete(pruneBefore);
        }
    }

    public validateContinuousHeader(headerLine: string): void {
        let cols: string[];
        try {
            cols = parseSingleCsvRecord(headerLine);
        } catch (e: any) {
            this.fail('cont', `Continuous header parse failed: ${e?.message}`);
            return;
        }

        const expectedFeatures = (this.is1mBase ? [...V3_CONTINUOUS_1M_ALLOWED_FEATURES] : [...V3_CONTINUOUS_NON1M_ALLOWED_FEATURES]).sort();
        const expectedHeaders = [
            ...CONTINUOUS_FIXED_HEADERS,
            ...expectedFeatures,
            ...expectedFeatures.map(f => `valid_${f}`),
            ...(this.include15mMtf ? ['context15m', 'htf15mDiagnostic'] : [])
        ];

        if (cols.some(c => QUARANTINED_LOWER.has(c.toLowerCase())) ||
            cols.includes('context1h') || cols.includes('htf1hDiagnostic')) {
            this.fail('sep', 'Continuous header contains forbidden 1h or Tier C columns.');
            return;
        }
        if (cols.length !== expectedHeaders.length || cols.some((c, i) => c !== expectedHeaders[i])) {
            this.fail('sep', 'Continuous header does not match exact ordered V3 Tier A schema.');
            return;
        }

        this.contHeaders = cols;
        this.contFeatureCount = expectedFeatures.length;
    }

    public validateContinuousLine(line: string): void {
        this.contRowCount++;
        if (!this.contHeaders) {
            this.fail('cont', 'Continuous row seen before valid header.');
            return;
        }
        let cells: string[];
        try {
            cells = parseSingleCsvRecord(line);
        } catch (e: any) {
            this.fail('cont', `Continuous row parse failed: ${e?.message}`);
            return;
        }
        if (cells.length !== this.contHeaders.length) {
            this.fail('cont', `Continuous row column count ${cells.length} !== ${this.contHeaders.length}.`);
            return;
        }
        try {
            if (!cells[0] || cells[0].trim() === '') throw new Error('empty observation_id');
            const srcTs = parseSafeInt(cells[1], 'source_timestamp');
            const obsTs = parseSafeInt(cells[2], 'observation_timestamp');
            if (obsTs !== srcTs + this.intervalMs) throw new Error('observation_timestamp !== source + intervalMs');
            const o = parseFiniteNumber(cells[3], 'open');
            const h = parseFiniteNumber(cells[4], 'high');
            const l = parseFiniteNumber(cells[5], 'low');
            const c = parseFiniteNumber(cells[6], 'close');
            const v = parseFiniteNumber(cells[7], 'volume');
            if (o <= 0 || h <= 0 || l <= 0 || c <= 0 || v < 0 || h < l || h < Math.max(o, c) || l > Math.min(o, c)) {
                throw new Error('invalid OHLCV');
            }
            const dqRaw = JSON.parse(cells[10]);
            const dq = assertExactPlainObject(dqRaw, 'data_quality', DATA_QUALITY_KEYS);
            for (const dk of DATA_QUALITY_KEYS) {
                if (typeof dq[dk] !== 'boolean') throw new Error(`data_quality.${dk} must be boolean`);
            }
            if (dq['isSourceValid'] !== true) throw new Error('data_quality.isSourceValid !== true');

            const fStart = CONTINUOUS_FIXED_HEADERS.length;
            const vStart = fStart + this.contFeatureCount;
            for (let i = 0; i < this.contFeatureCount; i++) {
                parseFiniteNumber(cells[fStart + i], this.contHeaders[fStart + i]);
                const vStr = cells[vStart + i];
                if (vStr !== 'true' && vStr !== 'false') {
                    throw new Error(`non-boolean validity '${vStr}'`);
                }
            }

            if (this.include15mMtf) {
                const ctxRaw = JSON.parse(cells[cells.length - 2]);
                assertRecursiveNoQuarantinedKeys(ctxRaw);
                const ctx = assertExactPlainObject(ctxRaw, 'context15m', MTF_CONTEXT_ALLOWLIST);
                if (ctx['timeframe'] !== '15m' ||
                    typeof ctx['isAvailable'] !== 'boolean' ||
                    typeof ctx['isWarmupComplete'] !== 'boolean' ||
                    !VALID_AVAILABILITY.has(String(ctx['availabilityStatus']))) {
                    throw new Error('invalid context15m flags/status');
                }
                const featObj = ctx['features'];
                const valObj = ctx['validity'];
                if (!featObj || typeof featObj !== 'object' || Array.isArray(featObj) ||
                    !valObj || typeof valObj !== 'object' || Array.isArray(valObj)) {
                    throw new Error('context15m features/validity must be plain objects');
                }
                const fKeys = Object.keys(featObj);
                const vKeys = Object.keys(valObj);

                if (ctx['lastCompletedCandle'] === null) {
                    if (ctx['lastCompletedOpenTimestamp'] !== null ||
                        ctx['lastCompletedCloseTimestamp'] !== null ||
                        ctx['contextAgeMs'] !== null ||
                        ctx['isAvailable'] !== false ||
                        ctx['availabilityStatus'] !== 'UNAVAILABLE' ||
                        ctx['isWarmupComplete'] !== false ||
                        fKeys.length !== 0 || vKeys.length !== 0) {
                        throw new Error('null context15m.lastCompletedCandle has non-empty metadata');
                    }
                } else {
                    const mc = assertExactPlainObject(ctx['lastCompletedCandle'], 'context15m.lastCompletedCandle', MTF_COMPLETED_CANDLE_ALLOWLIST);
                    const mcOpen = mc['openTimestamp'] as number;
                    const mcClose = mc['closeTimestamp'] as number;
                    const mcO = mc['open'] as number;
                    const mcH = mc['high'] as number;
                    const mcL = mc['low'] as number;
                    const mcC = mc['close'] as number;
                    const mcV = mc['volume'] as number;
                    if (mc['timeframe'] !== '15m' ||
                        mc['completeness'] !== 'COMPLETE' ||
                        !Number.isSafeInteger(mcOpen) || mcOpen < 0 || mcOpen % 900_000 !== 0 ||
                        mcClose !== mcOpen + 900_000 ||
                        mcClose > obsTs ||
                        ctx['lastCompletedOpenTimestamp'] !== mcOpen ||
                        ctx['lastCompletedCloseTimestamp'] !== mcClose ||
                        ctx['contextAgeMs'] !== obsTs - mcClose ||
                        mc['sourceObservationCount'] !== 15 ||
                        !Number.isFinite(mcO) || mcO <= 0 ||
                        !Number.isFinite(mcH) || mcH <= 0 ||
                        !Number.isFinite(mcL) || mcL <= 0 ||
                        !Number.isFinite(mcC) || mcC <= 0 ||
                        !Number.isFinite(mcV) || mcV < 0 ||
                        mcH < mcL || mcH < Math.max(mcO, mcC) || mcL > Math.min(mcO, mcC)) {
                        throw new Error('invalid or non-causal context15m.lastCompletedCandle');
                    }
                    const expectedAvail = ctx['availabilityStatus'] === 'WARMING_UP' || ctx['availabilityStatus'] === 'AVAILABLE_VALID';
                    if (ctx['isAvailable'] !== expectedAvail ||
                        ctx['isWarmupComplete'] !== (ctx['availabilityStatus'] === 'AVAILABLE_VALID')) {
                        throw new Error('inconsistent context15m availability/warmup status');
                    }
                    if (fKeys.length !== V3_MTF15M_ALLOWED_FEATURES.size || vKeys.length !== V3_MTF15M_ALLOWED_FEATURES.size) {
                        throw new Error('context15m.features must contain the complete 15m Tier A feature set');
                    }
                    for (const fk of V3_MTF15M_ALLOWED_FEATURES) {
                        if (!Object.prototype.hasOwnProperty.call(featObj, fk) ||
                            !Object.prototype.hasOwnProperty.call(valObj, fk)) {
                            throw new Error(`context15m missing expected feature '${fk}'`);
                        }
                        const fv = (featObj as Record<string, unknown>)[fk];
                        const vv = (valObj as Record<string, unknown>)[fk];
                        if (typeof fv !== 'number' || !Number.isFinite(fv) || typeof vv !== 'boolean') {
                            throw new Error(`context15m invalid feature/validity value on '${fk}'`);
                        }
                    }
                }

                const diagRaw = JSON.parse(cells[cells.length - 1]);
                if (diagRaw !== null) {
                    assertRecursiveNoQuarantinedKeys(diagRaw);
                    const diag = assertExactPlainObject(diagRaw, 'htf15mDiagnostic', HTF_DIAGNOSTIC_ALLOWLIST);
                    const dOpen = diag['openTimestamp'] as number;
                    const dClose = diag['closeTimestamp'] as number;
                    if (diag['timeframe'] !== '15m' ||
                        !Number.isSafeInteger(dOpen) || dOpen < 0 ||
                        dClose !== dOpen + 900_000 ||
                        diag['expectedSourceCount'] !== 15 ||
                        !Number.isSafeInteger(diag['actualSourceCount']) || (diag['actualSourceCount'] as number) < 0 ||
                        !Number.isSafeInteger(diag['duplicateCount']) || (diag['duplicateCount'] as number) < 0 ||
                        !Number.isSafeInteger(diag['invalidSourceCount']) || (diag['invalidSourceCount'] as number) < 0 ||
                        !Array.isArray(diag['missingTimestamps']) ||
                        !VALID_HTF_COMPLETENESS.has(String(diag['completeness']))) {
                        throw new Error('invalid htf15mDiagnostic values');
                    }
                    for (const mt of diag['missingTimestamps'] as unknown[]) {
                        if (typeof mt !== 'number' || !Number.isSafeInteger(mt) || mt < dOpen || mt >= dClose) {
                            throw new Error('invalid missingTimestamp inside htf15mDiagnostic');
                        }
                    }
                }
            }
        } catch (e: any) {
            this.fail('sep', `Continuous row ${this.contRowCount} failed validation: ${e?.message}`);
        }
    }

    public validateRepresentationHeader(headerLine: string): void {
        try {
            const cols = parseSingleCsvRecord(headerLine);
            if (cols.length !== V3_REPRESENTATION_COLUMNS.length ||
                cols.some((c, i) => c !== V3_REPRESENTATION_COLUMNS[i])) {
                this.fail('sep', 'Representation header does not match exact ordered V3_REPRESENTATION_COLUMNS.');
                return;
            }
            assertV3RepresentationZeroTierCLeakage(cols);
        } catch (e: any) {
            this.fail('sep', `Representation header failed: ${e?.message}`);
        }
    }

    public validateStrategyEventsHeader(headerLine: string): void {
        try {
            const cols = parseSingleCsvRecord(headerLine);
            if (cols.length !== V3_STRATEGY_EVENT_COLUMNS.length ||
                cols.some((c, i) => c !== V3_STRATEGY_EVENT_COLUMNS[i])) {
                this.fail('chrono', 'StrategyEvents header does not match exact ordered V3_STRATEGY_EVENT_COLUMNS.');
            }
        } catch (e: any) {
            this.fail('chrono', `StrategyEvents header parse failed: ${e?.message}`);
        }
    }

    public validateSerializedEventPair(repLine: string, evLine: string): void {
        this.repRowCount++;
        this.evRowCount++;

        let repCells: string[];
        let evCells: string[];
        try {
            repCells = parseSingleCsvRecord(repLine);
            evCells = parseSingleCsvRecord(evLine);
        } catch (e: any) {
            this.fail('sep', `CSV row parse error: ${e?.message}`);
            return;
        }
        if (repCells.length !== V3_REPRESENTATION_COLUMNS.length) {
            this.fail('sep', `Representation cell count mismatch (${repCells.length}).`);
            return;
        }
        if (evCells.length !== V3_STRATEGY_EVENT_COLUMNS.length) {
            this.fail('replay', `StrategyEvent cell count mismatch (${evCells.length}).`);
            return;
        }

        const evMap = new Map<string, string>();
        for (let i = 0; i < V3_STRATEGY_EVENT_COLUMNS.length; i++) {
            evMap.set(String(V3_STRATEGY_EVENT_COLUMNS[i]), evCells[i]);
        }
        const repMap = new Map<string, string>();
        for (let i = 0; i < V3_REPRESENTATION_COLUMNS.length; i++) {
            repMap.set(V3_REPRESENTATION_COLUMNS[i], repCells[i]);
        }

        try {
            const stratId = repMap.get('tierB_strategy_id')! as StrategyId;
            const parsedCtx = JSON.parse(repMap.get('tierB_structural_context_json')!);
            assertRecursiveNoQuarantinedKeys(parsedCtx);
            const canonicalCtx = serializeAndValidateStructuralContext(stratId, parsedCtx);
            if (canonicalCtx !== repMap.get('tierB_structural_context_json')) {
                this.fail('sep', 'Representation structural_context_json not canonical.');
            }

            const pairs: Array<[string, string]> = [
                ['tierA_observation_id', 'tierA_observation_id'],
                ['tierA_atr_14', 'tierA_atr_14'],
                ['tierA_exhaustion_20', 'tierA_exhaustion_20'],
                ['tierA_exhaustion_20_valid', 'tierA_exhaustion_20_valid'],
                ['tierA_vcs_ratio_360', 'tierA_vcs_ratio_360'],
                ['tierA_vcs_zscore_360', 'tierA_vcs_zscore_360'],
                ['tierA_vcs_regime_360', 'tierA_vcs_regime_360'],
                ['tierA_vcs_valid', 'tierA_vcs_valid'],
                ['tierA_vam_center_dist_atr', 'tierA_vam_center_dist_atr'],
                ['tierA_vam_slope_3_atr', 'tierA_vam_slope_3_atr'],
                ['tierA_vam_efficiency', 'tierA_vam_efficiency'],
                ['tierA_vam_adx_14', 'tierA_vam_adx_14'],
                ['tierA_vam_di_spread_14', 'tierA_vam_di_spread_14'],
                ['tierA_vam_rsi_14', 'tierA_vam_rsi_14'],
                ['tierA_vam_trend', 'tierA_vam_trend'],
                ['tierA_vam_valid', 'tierA_vam_valid'],
                ['tierA_context_15m_available', 'tierA_context_15m_available'],
                ['tierA_context_15m_status', 'tierA_context_15m_status'],
                ['tierB_event_id', 'event_id'],
                ['tierB_strategy_id', 'strategy_id'],
                ['tierB_strategy_version', 'strategy_version'],
                ['tierB_event_type', 'event_type'],
                ['tierB_event_direction', 'event_direction'],
                ['tierB_event_discriminator', 'event_discriminator'],
                ['tierB_source_bar_index', 'source_bar_index'],
                ['tierB_confirmation_bar_index', 'confirmation_bar_index'],
                ['tierB_confirmation_lag_bars', 'confirmation_lag_bars'],
                ['tierB_structural_context_json', 'structural_context_json']
            ];
            for (const [rk, ek] of pairs) {
                if (repMap.get(rk) !== evMap.get(ek)) {
                    this.fail('sep', `Representation '${rk}' cell diverges from StrategyEvents '${ek}'.`);
                    return;
                }
            }
        } catch (e: any) {
            this.fail('sep', `Representation JSON/cell check failed: ${e?.message}`);
            return;
        }

        // Schema-driven finite audit across ALL StrategyEvents numeric/integer/enum fields
        try {
            const eventId = evMap.get('event_id')!;
            const strategyId = evMap.get('strategy_id')!;
            const eventType = evMap.get('event_type')!;
            const dir = evMap.get('event_direction')!;
            if (dir !== 'bull' && dir !== 'bear') throw new Error(`invalid event_direction '${dir}'`);

            const srcBar = parseSafeInt(evMap.get('source_bar_index')!, 'source_bar_index');
            const srcTs = parseSafeInt(evMap.get('source_timestamp')!, 'source_timestamp');
            const confBar = parseSafeInt(evMap.get('confirmation_bar_index')!, 'confirmation_bar_index');
            const confTs = parseSafeInt(evMap.get('confirmation_timestamp')!, 'confirmation_timestamp');
            const lag = parseSafeInt(evMap.get('confirmation_lag_bars')!, 'confirmation_lag_bars');
            const obsBar = parseSafeInt(evMap.get('observation_bar_index')!, 'observation_bar_index');
            const obsTs = parseSafeInt(evMap.get('observation_timestamp')!, 'observation_timestamp');
            const entryBar = parseSafeInt(evMap.get('entry_bar_index')!, 'entry_bar_index');
            const entryTime = parseSafeInt(evMap.get('entry_time')!, 'entry_time');
            const entryPrice = parseFiniteNumber(evMap.get('entry_price')!, 'entry_price');
            const atr = parseFiniteNumber(evMap.get('atr_at_confirmation')!, 'atr_at_confirmation');

            // Validate every Tier A float/flag cell on StrategyEvents
            const tierAAtr = parseFiniteNumber(evMap.get('tierA_atr_14')!, 'tierA_atr_14');
            parseFiniteNumber(evMap.get('tierA_exhaustion_20')!, 'tierA_exhaustion_20');
            parseSafeInt(evMap.get('tierA_exhaustion_20_valid')!, 'tierA_exhaustion_20_valid');
            parseFiniteNumber(evMap.get('tierA_vcs_ratio_360')!, 'tierA_vcs_ratio_360');
            parseFiniteNumber(evMap.get('tierA_vcs_zscore_360')!, 'tierA_vcs_zscore_360');
            parseSafeInt(evMap.get('tierA_vcs_regime_360')!, 'tierA_vcs_regime_360');
            parseSafeInt(evMap.get('tierA_vcs_valid')!, 'tierA_vcs_valid');
            parseFiniteNumber(evMap.get('tierA_vam_center_dist_atr')!, 'tierA_vam_center_dist_atr');
            parseFiniteNumber(evMap.get('tierA_vam_slope_3_atr')!, 'tierA_vam_slope_3_atr');
            parseFiniteNumber(evMap.get('tierA_vam_efficiency')!, 'tierA_vam_efficiency');
            parseFiniteNumber(evMap.get('tierA_vam_adx_14')!, 'tierA_vam_adx_14');
            parseFiniteNumber(evMap.get('tierA_vam_di_spread_14')!, 'tierA_vam_di_spread_14');
            parseFiniteNumber(evMap.get('tierA_vam_rsi_14')!, 'tierA_vam_rsi_14');
            parseFiniteNumber(evMap.get('tierA_vam_trend')!, 'tierA_vam_trend');
            parseSafeInt(evMap.get('tierA_vam_valid')!, 'tierA_vam_valid');
            parseSafeInt(evMap.get('tierA_context_15m_available')!, 'tierA_context_15m_available');
            if (!VALID_AVAILABILITY.has(evMap.get('tierA_context_15m_status')!)) {
                throw new Error('invalid tierA_context_15m_status');
            }

            if (atr <= 0 || entryPrice <= 0 || Math.abs(tierAAtr - atr) > 1e-12) {
                throw new Error('non-positive ATR/entry_price or tierA_atr_14 mismatch');
            }
            if (lag !== confBar - srcBar || obsBar !== confBar || srcTs > confTs) {
                throw new Error('inconsistent source/confirmation/observation chronology');
            }

            // Global event_id uniqueness across entire export (not limited to one confirmation bar)
            if (this.seenEventIds.has(eventId)) {
                this.fail('id', `Duplicate global event_id '${eventId}'.`);
            }
            this.seenEventIds.add(eventId);

            if (this.prevEventOrder !== null) {
                const cmp = compareStrategyEvents(
                    this.prevEventOrder as any,
                    { confirmationBarIndex: confBar, strategyId, eventType, eventId } as any
                );
                if (cmp >= 0) {
                    this.fail('chrono', `Events out of canonical order at '${eventId}'.`);
                }
            }
            this.prevEventOrder = { confirmationBarIndex: confBar, strategyId, eventType, eventId };

            const confCandle = this.rawWindow.get(confBar);
            const entryCandle = this.rawWindow.get(entryBar);
            if (!confCandle || !entryCandle) {
                this.fail('replay', `Missing raw candles in sliding window for '${eventId}'.`);
                return;
            }
            if (entryBar !== confBar + 1 ||
                confTs !== confCandle.time ||
                obsTs !== confTs + this.intervalMs ||
                entryTime !== entryCandle.time ||
                entryTime <= confTs ||
                Math.abs(entryPrice - entryCandle.open) > 1e-9) {
                this.fail('chrono', `Accepted-candle chronology/entry mismatch for '${eventId}'.`);
                return;
            }

            const lStop = parseFiniteNumber(evMap.get('long_stop_price')!, 'long_stop_price');
            const lTarget = parseFiniteNumber(evMap.get('long_target_price')!, 'long_target_price');
            const sStop = parseFiniteNumber(evMap.get('short_stop_price')!, 'short_stop_price');
            const sTarget = parseFiniteNumber(evMap.get('short_target_price')!, 'short_target_price');
            const expLStop = entryPrice - atr * V3_STOP_ATR_MULT;
            const expLTarget = entryPrice + atr * V3_STOP_ATR_MULT * V3_TARGET_R_MULT;
            const expSStop = entryPrice + atr * V3_STOP_ATR_MULT;
            const expSTarget = entryPrice - atr * V3_STOP_ATR_MULT * V3_TARGET_R_MULT;
            const lRisk = entryPrice - expLStop;
            const sRisk = expSStop - entryPrice;

            if (lRisk <= 0 || sRisk <= 0 ||
                Math.abs(lStop - expLStop) > 1e-6 || Math.abs(lTarget - expLTarget) > 1e-6 ||
                Math.abs(sStop - expSStop) > 1e-6 || Math.abs(sTarget - expSTarget) > 1e-6) {
                this.fail('replay', `Barrier geometry mismatch for '${eventId}'.`);
                return;
            }

            const replayH = (isLong: boolean, h: number) => {
                const hEnd = entryBar + h - 1;
                let resolved = false;
                let exitP = entryPrice;
                let kind: 'hard_stop' | 'full_target' = 'hard_stop';
                for (let f = entryBar; f <= hEnd; f++) {
                    const b = this.rawWindow.get(f);
                    if (!b) throw new Error(`missing replay bar ${f}`);
                    if (isLong) {
                        if (b.open <= expLStop) { exitP = b.open; kind = 'hard_stop'; resolved = true; break; }
                        if (b.open >= expLTarget) { exitP = b.open; kind = 'full_target'; resolved = true; break; }
                        if (b.low <= expLStop) { exitP = expLStop; kind = 'hard_stop'; resolved = true; break; }
                        if (b.high >= expLTarget) { exitP = expLTarget; kind = 'full_target'; resolved = true; break; }
                    } else {
                        if (b.open >= expSStop) { exitP = b.open; kind = 'hard_stop'; resolved = true; break; }
                        if (b.open <= expSTarget) { exitP = b.open; kind = 'full_target'; resolved = true; break; }
                        if (b.high >= expSStop) { exitP = expSStop; kind = 'hard_stop'; resolved = true; break; }
                        if (b.low <= expSTarget) { exitP = expSTarget; kind = 'full_target'; resolved = true; break; }
                    }
                    if (f === hEnd) exitP = b.close;
                }
                const grossR = isLong ? (exitP - entryPrice) / lRisk : (entryPrice - exitP) / sRisk;
                const netR = grossR - V3_TRADE_COST_R;
                const outcome: V3HorizonOutcomeClass = resolved ? kind : netR > 0 ? 'timeout_net_gain' : 'timeout_net_loss';
                return { exitP, netR, outcome };
            };

            for (const h of [60, 120, 180] as const) {
                const cellLExit = parseFiniteNumber(evMap.get(`long_exit_price_${h}`)!, `long_exit_price_${h}`);
                const cellLNetR = parseFiniteNumber(evMap.get(`long_net_r_${h}`)!, `long_net_r_${h}`);
                const cellLOut = evMap.get(`long_outcome_${h}`)!;
                const cellSExit = parseFiniteNumber(evMap.get(`short_exit_price_${h}`)!, `short_exit_price_${h}`);
                const cellSNetR = parseFiniteNumber(evMap.get(`short_net_r_${h}`)!, `short_net_r_${h}`);
                const cellSOut = evMap.get(`short_outcome_${h}`)!;

                if (!VALID_HORIZON_OUTCOMES.has(cellLOut) || !VALID_HORIZON_OUTCOMES.has(cellSOut)) {
                    this.fail('replay', `Invalid horizon outcome class at H=${h} on '${eventId}'.`);
                    return;
                }
                const repL = replayH(true, h);
                const repS = replayH(false, h);
                if (Math.abs(repL.exitP - cellLExit) > 1e-6 || Math.abs(repL.netR - cellLNetR) > 1e-6 || repL.outcome !== cellLOut ||
                    Math.abs(repS.exitP - cellSExit) > 1e-6 || Math.abs(repS.netR - cellSNetR) > 1e-6 || repS.outcome !== cellSOut) {
                    this.fail('replay', `Replay mismatch at H=${h} on '${eventId}'.`);
                    return;
                }
            }
        } catch (e: any) {
            this.fail('replay', `StrategyEvents row ${this.evRowCount} failed validation: ${e?.message}`);
        }
    }

    public finalizeAudit(expectedContinuousRows: number, expectedEventRows: number): IntegrityAuditResults {
        const countMismatch =
            this.contRowCount !== expectedContinuousRows ||
            this.repRowCount !== expectedEventRows ||
            this.evRowCount !== expectedEventRows;
        if (countMismatch) {
            this.fail('cont', `Row count mismatch (cont=${this.contRowCount}/${expectedContinuousRows}, rep=${this.repRowCount}/${expectedEventRows}, ev=${this.evRowCount}/${expectedEventRows}).`);
        }
        const chronologyValid = !this.hasChronologyFailure;
        const identityUnique = !this.hasIdentityFailure;
        const inputOutcomeSeparationValid = !this.hasSeparationFailure;
        const passed =
            !this.hasContinuousFailure &&
            !this.hasReplayFailure &&
            chronologyValid &&
            identityUnique &&
            inputOutcomeSeparationValid &&
            !countMismatch;

        return Object.freeze({
            passed,
            chronologyValid,
            identityUnique,
            inputOutcomeSeparationValid,
            remarks: Object.freeze([...this.errors])
        });
    }
}
