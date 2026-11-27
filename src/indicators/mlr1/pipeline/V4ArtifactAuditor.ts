import type { IntegrityAuditResults } from '../dataset/DatasetManifest';
import { extractDataQuality } from '../dataset/ObservationBackbone';
import {
    HTF_DIAGNOSTIC_ALLOWLIST,
    MTF_COMPLETED_CANDLE_ALLOWLIST,
    MTF_CONTEXT_ALLOWLIST,
    TIER_C_V4_QUARANTINE_LIST
} from '../dataset/DatasetSchema';
import { ML1_CONFIG_D, ML1_CONFIG_D_3M, ML1_CONFIG_D_5M } from '../ML1FeatureConfigs';
import { createInitialML1FeatureStateV6, stepML1FeaturesV6, validateML1ConfigV6 } from '../ML1FeatureEngine';
import type { ML1Candle, ML1FeatureStateV6, ValidatedML1FeatureConfigV6 } from '../ML1FeatureTypes';
import { validateV4MTFConfig, type ValidatedV4MTFGlobalConfig } from '../mtf/MTFConfig';
import { createInitialV4MTFState } from '../mtf/MTFState';
import { stepV4MTFCombined } from '../mtf/MTFFeatureEngine';
import { alignV4MTFContext } from '../mtf/MTFAligner';
import type { V4HTFIncompleteDiagnostic, V4MTFState, V4MTFTimeframeContext } from '../mtf/MTFTypes';
import {
    assertV4RepresentationZeroTierCLeakage,
    serializeAndValidateV4StructuralContext,
    V4_HORIZONS,
    V4_MAX_HORIZON_BARS,
    V4_REPRESENTATION_COLUMNS,
    V4_STOP_ATR_MULT,
    V4_STRATEGY_EVENT_COLUMNS,
    V4_STRUCTURAL_CONTEXT_ALLOWLIST,
    V4_TARGET_R_MULT,
    V4_TRADE_COST_R,
    type V4PipelineStrategyId,
    type V4StrategyEventRow
} from './V4OutcomeContracts';
import type { V3HorizonOutcomeClass } from './MultiHorizonOutcomeEngine';
import { parseCsvDocumentCRLF, parseSingleCsvRecord, type RawReplayBar } from './V3ArtifactAuditor';

export const V4_REPLAY_TOLERANCE = 1e-12;

const V4_1M_CANONICAL_FEATURES: readonly string[] = (() => {
    const res = stepML1FeaturesV6(
        { time: 0, open: 100, high: 101, low: 99, close: 100, volume: 100, isSynthetic: false },
        0,
        createInitialML1FeatureStateV6(ML1_CONFIG_D),
        ML1_CONFIG_D
    );
    const keys = Object.keys(res.observation.features).sort();
    if (keys.length !== 150) throw new Error(`V4ArtifactAuditor Schema Error: expected 150 1m features, got ${keys.length}.`);
    return Object.freeze(keys);
})();

const V4_HTF_CANONICAL_FEATURES: ReadonlySet<string> = (() => {
    const res = stepML1FeaturesV6(
        { time: 0, open: 100, high: 101, low: 99, close: 100, volume: 100, isSynthetic: false },
        0,
        createInitialML1FeatureStateV6(ML1_CONFIG_D_3M),
        ML1_CONFIG_D_3M
    );
    const keys = Object.keys(res.observation.features);
    if (keys.length !== 147) throw new Error(`V4ArtifactAuditor Schema Error: expected 147 HTF features, got ${keys.length}.`);
    return new Set(keys);
})();

const CONTINUOUS_FIXED_HEADERS = [
    'observation_id', 'source_timestamp', 'observation_timestamp',
    'open', 'high', 'low', 'close', 'volume', 'symbol', 'timeframe', 'data_quality'
] as const;

const DATA_QUALITY_KEYS = [
    'isSourceValid', 'hasDataGap', 'isDiscontinuity', 'isDuplicate', 'isOutOfOrder', 'isUnexpectedInterval'
] as const;

const QUARANTINED_LOWER = new Set(TIER_C_V4_QUARANTINE_LIST.map(k => k.toLowerCase()));
const VALID_HORIZON_OUTCOMES = new Set<string>(['full_target', 'hard_stop', 'timeout_net_gain', 'timeout_net_loss']);
const VALID_AVAILABILITY = new Set<string>(['UNAVAILABLE', 'WARMING_UP', 'AVAILABLE_VALID', 'STALE']);
const VALID_STRATEGY_IDS = new Set<string>(['STRICT_CBC', 'PHL_BOS_MSS', 'DTFX_STRICTCBC', 'VAM_REVERSAL']);
const VALID_EVENT_TYPES_BY_STRATEGY: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
    STRICT_CBC: new Set(['CBC_HIGH_HH', 'CBC_HIGH_LH', 'CBC_LOW_HL', 'CBC_LOW_LL']),
    PHL_BOS_MSS: new Set(['PHL_BOS_BULL', 'PHL_BOS_BEAR', 'PHL_MSS_BULL', 'PHL_MSS_BEAR']),
    DTFX_STRICTCBC: new Set(['DTFX_CBC_DEMAND_CREATED', 'DTFX_CBC_SUPPLY_CREATED', 'DTFX_CBC_DEMAND_RETEST', 'DTFX_CBC_SUPPLY_RETEST']),
    VAM_REVERSAL: new Set(['VAM_BUY', 'VAM_SELL'])
});

type ColType = 'nonempty_string' | 'strategy_id' | 'direction' | 'availability' | 'outcome' | 'int_nonneg' | 'flag_01' | 'regime_012' | 'finite_float' | 'positive_float' | 'json_context';

const V4_EVENT_SCHEMA: Readonly<Record<keyof V4StrategyEventRow, ColType>> = Object.freeze({
    event_id: 'nonempty_string',
    event_discriminator: 'nonempty_string',
    strategy_id: 'strategy_id',
    strategy_version: 'nonempty_string',
    symbol: 'nonempty_string',
    timeframe: 'nonempty_string',
    event_type: 'nonempty_string',
    event_direction: 'direction',
    source_bar_index: 'int_nonneg',
    source_timestamp: 'int_nonneg',
    confirmation_bar_index: 'int_nonneg',
    confirmation_timestamp: 'int_nonneg',
    confirmation_lag_bars: 'int_nonneg',
    observation_bar_index: 'int_nonneg',
    observation_timestamp: 'int_nonneg',
    tierA_observation_id: 'nonempty_string',
    structural_context_json: 'json_context',
    tierA_atr_14: 'positive_float',
    tierA_exhaustion_14: 'finite_float',
    tierA_exhaustion_14_valid: 'flag_01',
    tierA_exhaustion_20: 'finite_float',
    tierA_exhaustion_20_valid: 'flag_01',
    tierA_vcs_ratio_360: 'finite_float',
    tierA_vcs_zscore_360: 'finite_float',
    tierA_vcs_regime_360: 'regime_012',
    tierA_vcs_valid: 'flag_01',
    tierA_vam_center_dist_atr: 'finite_float',
    tierA_vam_slope_3_atr: 'finite_float',
    tierA_vam_efficiency: 'finite_float',
    tierA_vam_adx_14: 'finite_float',
    tierA_vam_di_spread_14: 'finite_float',
    tierA_vam_rsi_14: 'finite_float',
    tierA_vam_trend: 'finite_float',
    tierA_vam_valid: 'flag_01',
    tierA_sma_20_dist_atr: 'finite_float',
    tierA_sma_50_dist_atr: 'finite_float',
    tierA_sma_200_dist_atr: 'finite_float',
    tierA_sma_20_above_50: 'finite_float',
    tierA_sma_50_above_200: 'finite_float',
    tierA_sma_valid: 'flag_01',
    tierA_macd_line_atr: 'finite_float',
    tierA_macd_signal_atr: 'finite_float',
    tierA_macd_hist_atr: 'finite_float',
    tierA_macd_valid: 'flag_01',
    tierA_bb_width_20: 'finite_float',
    tierA_bb_pctb_20: 'finite_float',
    tierA_bb_valid: 'flag_01',
    tierA_context_3m_available: 'flag_01',
    tierA_context_3m_status: 'availability',
    tierA_context_5m_available: 'flag_01',
    tierA_context_5m_status: 'availability',
    entry_bar_index: 'int_nonneg',
    entry_time: 'int_nonneg',
    entry_price: 'positive_float',
    atr_at_confirmation: 'positive_float',
    long_stop_price: 'finite_float',
    long_target_price: 'finite_float',
    short_stop_price: 'finite_float',
    short_target_price: 'finite_float',
    long_exit_price_60: 'finite_float',
    long_net_r_60: 'finite_float',
    long_outcome_60: 'outcome',
    short_exit_price_60: 'finite_float',
    short_net_r_60: 'finite_float',
    short_outcome_60: 'outcome',
    long_exit_price_120: 'finite_float',
    long_net_r_120: 'finite_float',
    long_outcome_120: 'outcome',
    short_exit_price_120: 'finite_float',
    short_net_r_120: 'finite_float',
    short_outcome_120: 'outcome',
    long_exit_price_180: 'finite_float',
    long_net_r_180: 'finite_float',
    long_outcome_180: 'outcome',
    short_exit_price_180: 'finite_float',
    short_net_r_180: 'finite_float',
    short_outcome_180: 'outcome'
});

function assertExactPlainObject(obj: unknown, label: string, expectedKeys: readonly string[]): Record<string, unknown> {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj) || Object.getPrototypeOf(obj) !== Object.prototype) {
        throw new Error(`${label} must be a plain object.`);
    }
    const keys = Object.keys(obj);
    if (keys.length !== expectedKeys.length || expectedKeys.some(k => !Object.prototype.hasOwnProperty.call(obj, k))) {
        throw new Error(`${label} keys mismatch.`);
    }
    return obj as Record<string, unknown>;
}

function assertRecursiveNoQuarantinedKeys(val: unknown, depth = 0): void {
    if (depth > 4) throw new Error('Nested JSON exceeds max depth.');
    if (val === null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') return;
    if (Array.isArray(val)) {
        for (const item of val) assertRecursiveNoQuarantinedKeys(item, depth + 1);
        return;
    }
    if (typeof val === 'object') {
        for (const k of Object.keys(val)) {
            const lower = k.toLowerCase();
            if (QUARANTINED_LOWER.has(lower) || /(^|_)(entry|exit|stop|target|net_r|outcome|forward|future|horizon|mfe|mae)(_|$)/.test(lower)) {
                throw new Error(`Recursive leakage guard rejected '${k}'.`);
            }
            assertRecursiveNoQuarantinedKeys((val as Record<string, unknown>)[k], depth + 1);
        }
        return;
    }
    throw new Error('Unsupported value in nested JSON.');
}

function parseNum(raw: string, label: string): number {
    if (raw === '') throw new Error(`Empty numeric '${label}'.`);
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`Non-finite '${label}' (${raw}).`);
    return n;
}

function parseIntNonNeg(raw: string, label: string): number {
    const n = parseNum(raw, label);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid integer '${label}' (${raw}).`);
    return n;
}

function compareAscii(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

export class V4ArtifactAuditor {
    private readonly expectedSymbol: string;
    private readonly expectedTimeframe: string;
    private readonly intervalMs: number;
    private readonly include3m5mMtf: boolean;
    private readonly batchRawBuffer: Float64Array | null;
    private readonly batchRawLength: number;

    private readonly replayFeatureConfig: ValidatedML1FeatureConfigV6;
    private replayFeatureState: ML1FeatureStateV6;
    private readonly replayMtfConfig: ValidatedV4MTFGlobalConfig | null;
    private replayMtfState: V4MTFState | null;

    private contHeaders: string[] | null = null;
    private contFeatureCount = 0;
    private contRowCount = 0;
    private repRowCount = 0;
    private evRowCount = 0;

    private readonly rawWindow = new Map<number, RawReplayBar>();
    private readonly obsIdWindow = new Map<number, string>();
    private readonly batchObsIds: string[] = [];
    private readonly seenObsIds = new Set<string>();
    private readonly clockCheckpoints: Array<{ readonly barIndex: number; readonly time: number }> = [];
    private prevContSrcTs = -1;
    private latestRawBarIndex = -1;
    private prevRawTime = -1;

    private prevEventOrder: { confirmationBarIndex: number; strategyId: string; eventType: string; eventId: string } | null = null;
    private readonly seenEventIds = new Set<string>();

    private hasContinuousFailure = false;
    private hasChronologyFailure = false;
    private hasIdentityFailure = false;
    private hasSeparationFailure = false;
    private hasReplayFailure = false;
    private readonly errors: string[] = [];

    public constructor(params: {
        readonly expectedSymbol: string;
        readonly expectedTimeframe: string;
        readonly intervalMs: number;
        readonly include3m5mMtf: boolean;
        readonly batchRawBuffer?: Float64Array;
    }) {
        if (typeof params.expectedSymbol !== 'string' || params.expectedSymbol.trim() === '') {
            throw new Error(`V4ArtifactAuditor Error: invalid expectedSymbol '${String(params.expectedSymbol)}'.`);
        }
        if (params.expectedTimeframe !== '1m' || params.intervalMs !== 60_000) {
            throw new Error(
                `V4ArtifactAuditor Error: V4 requires expectedTimeframe='1m' and intervalMs=60000, got '${params.expectedTimeframe}' / ${params.intervalMs}.`
            );
        }
        this.expectedSymbol = params.expectedSymbol;
        this.expectedTimeframe = params.expectedTimeframe;
        this.intervalMs = params.intervalMs;
        this.include3m5mMtf = params.include3m5mMtf;

        this.replayFeatureConfig = validateML1ConfigV6({
            ...ML1_CONFIG_D,
            symbol: this.expectedSymbol,
            timeframe: this.expectedTimeframe,
            expectedIntervalMs: this.intervalMs,
            gapDiscontinuityThresholdMs: Math.max(ML1_CONFIG_D.gapDiscontinuityThresholdMs, this.intervalMs * 5),
            emaPeriods: [...ML1_CONFIG_D.emaPeriods],
            atrPeriods: [...ML1_CONFIG_D.atrPeriods],
            rollingRangePeriods: [...ML1_CONFIG_D.rollingRangePeriods],
            momentumPeriods: [...ML1_CONFIG_D.momentumPeriods],
            volumeSmaPeriods: [...ML1_CONFIG_D.volumeSmaPeriods],
            cciPeriods: [...ML1_CONFIG_D.cciPeriods],
            volumeCandleSizePeriods: [...ML1_CONFIG_D.volumeCandleSizePeriods],
            enableVAM: ML1_CONFIG_D.enableVAM,
            smaPeriods: [...ML1_CONFIG_D.smaPeriods],
            enableMACD: ML1_CONFIG_D.enableMACD,
            bbPeriod: ML1_CONFIG_D.bbPeriod,
            bbStdMult: ML1_CONFIG_D.bbStdMult
        });
        this.replayFeatureState = createInitialML1FeatureStateV6(this.replayFeatureConfig);

        if (this.include3m5mMtf) {
            this.replayMtfConfig = validateV4MTFConfig({
                symbol: this.expectedSymbol,
                baseTimeframe: '1m',
                config3m: {
                    timeframe: '3m',
                    durationMs: 180_000,
                    alignment: 'UTC_HALF_OPEN',
                    expectedSourceIntervalMs: 60_000,
                    gapPolicy: 'REJECT_AND_RESET',
                    featureConfig: validateML1ConfigV6({
                        ...ML1_CONFIG_D_3M,
                        symbol: this.expectedSymbol,
                        emaPeriods: [...ML1_CONFIG_D_3M.emaPeriods],
                        atrPeriods: [...ML1_CONFIG_D_3M.atrPeriods],
                        rollingRangePeriods: [...ML1_CONFIG_D_3M.rollingRangePeriods],
                        momentumPeriods: [...ML1_CONFIG_D_3M.momentumPeriods],
                        volumeSmaPeriods: [...ML1_CONFIG_D_3M.volumeSmaPeriods],
                        cciPeriods: [...ML1_CONFIG_D_3M.cciPeriods],
                        volumeCandleSizePeriods: [],
                        smaPeriods: [...ML1_CONFIG_D_3M.smaPeriods]
                    })
                },
                config5m: {
                    timeframe: '5m',
                    durationMs: 300_000,
                    alignment: 'UTC_HALF_OPEN',
                    expectedSourceIntervalMs: 60_000,
                    gapPolicy: 'REJECT_AND_RESET',
                    featureConfig: validateML1ConfigV6({
                        ...ML1_CONFIG_D_5M,
                        symbol: this.expectedSymbol,
                        emaPeriods: [...ML1_CONFIG_D_5M.emaPeriods],
                        atrPeriods: [...ML1_CONFIG_D_5M.atrPeriods],
                        rollingRangePeriods: [...ML1_CONFIG_D_5M.rollingRangePeriods],
                        momentumPeriods: [...ML1_CONFIG_D_5M.momentumPeriods],
                        volumeSmaPeriods: [...ML1_CONFIG_D_5M.volumeSmaPeriods],
                        cciPeriods: [...ML1_CONFIG_D_5M.cciPeriods],
                        volumeCandleSizePeriods: [],
                        smaPeriods: [...ML1_CONFIG_D_5M.smaPeriods]
                    })
                }
            });
            this.replayMtfState = createInitialV4MTFState(this.replayMtfConfig);
        } else {
            this.replayMtfConfig = null;
            this.replayMtfState = null;
        }

        if (params.batchRawBuffer !== undefined) {
            if (!(params.batchRawBuffer instanceof Float64Array) || params.batchRawBuffer.length % 6 !== 0) {
                throw new Error('V4ArtifactAuditor Error: invalid batchRawBuffer.');
            }
            this.batchRawBuffer = params.batchRawBuffer;
            this.batchRawLength = params.batchRawBuffer.length / 6;
            let prevT = -1;
            const gridAnchor = this.batchRawLength > 0 ? params.batchRawBuffer[0] : 0;
            for (let i = 0; i < this.batchRawLength; i++) {
                const off = i * 6;
                const t = params.batchRawBuffer[off], o = params.batchRawBuffer[off + 1], h = params.batchRawBuffer[off + 2];
                const l = params.batchRawBuffer[off + 3], c = params.batchRawBuffer[off + 4], v = params.batchRawBuffer[off + 5];
                if (!Number.isSafeInteger(t) || t < 1e12 || (t - gridAnchor) % this.intervalMs !== 0 ||
                    !Number.isFinite(o) || o <= 0 || !Number.isFinite(h) || h <= 0 ||
                    !Number.isFinite(l) || l <= 0 || !Number.isFinite(c) || c <= 0 ||
                    !Number.isFinite(v) || v < 0 || h < l || h < Math.max(o, c) || l > Math.min(o, c)) {
                    this.fail('replay', `Invalid raw candle at bar ${i}.`);
                    break;
                }
                if (prevT !== -1 && t <= prevT) {
                    this.fail('chrono', `Non-monotonic raw candle at bar ${i}.`);
                    break;
                }
                if (this.clockCheckpoints.length === 0) this.clockCheckpoints.push({ barIndex: i, time: t });
                else {
                    const last = this.clockCheckpoints[this.clockCheckpoints.length - 1];
                    if (t !== last.time + (i - last.barIndex) * this.intervalMs) this.clockCheckpoints.push({ barIndex: i, time: t });
                }
                prevT = t;
            }
        } else {
            this.batchRawBuffer = null;
            this.batchRawLength = 0;
        }
    }

    private fail(category: 'cont' | 'chrono' | 'id' | 'sep' | 'replay', msg: string): void {
        if (category === 'cont') this.hasContinuousFailure = true;
        if (category === 'chrono') this.hasChronologyFailure = true;
        if (category === 'id') this.hasIdentityFailure = true;
        if (category === 'sep') this.hasSeparationFailure = true;
        if (category === 'replay') this.hasReplayFailure = true;
        if (this.errors.length < 25) this.errors.push(msg);
    }

    private getRawBar(barIndex: number): RawReplayBar | undefined {
        if (this.batchRawBuffer !== null) {
            if (barIndex < 0 || barIndex >= this.batchRawLength) return undefined;
            const off = barIndex * 6;
            return {
                time: this.batchRawBuffer[off], open: this.batchRawBuffer[off + 1], high: this.batchRawBuffer[off + 2],
                low: this.batchRawBuffer[off + 3], close: this.batchRawBuffer[off + 4], volume: this.batchRawBuffer[off + 5]
            };
        }
        return this.rawWindow.get(barIndex);
    }

    private resolveClockTime(barIndex: number): number | undefined {
        const direct = this.getRawBar(barIndex);
        if (direct) return direct.time;
        if (this.clockCheckpoints.length === 0 || barIndex < this.clockCheckpoints[0].barIndex) return undefined;
        let cp = this.clockCheckpoints[0];
        for (let i = 1; i < this.clockCheckpoints.length; i++) {
            if (this.clockCheckpoints[i].barIndex <= barIndex) cp = this.clockCheckpoints[i];
            else break;
        }
        return cp.time + (barIndex - cp.barIndex) * this.intervalMs;
    }

    private getObservedIdAt(barIndex: number): string | undefined {
        return this.batchRawBuffer !== null ? this.batchObsIds[barIndex] : this.obsIdWindow.get(barIndex);
    }

    public pushRawCandle(barIndex: number, c: RawReplayBar): void {
        if (this.batchRawBuffer !== null) throw new Error('V4ArtifactAuditor: streaming only.');
        if (barIndex !== this.latestRawBarIndex + 1 || (this.prevRawTime !== -1 && c.time <= this.prevRawTime)) {
            this.fail('chrono', `Non-monotonic raw candle at bar ${barIndex}.`);
            return;
        }
        this.rawWindow.set(barIndex, c);
        this.latestRawBarIndex = barIndex;
        this.prevRawTime = c.time;
        if (this.clockCheckpoints.length === 0) this.clockCheckpoints.push({ barIndex, time: c.time });
        else {
            const last = this.clockCheckpoints[this.clockCheckpoints.length - 1];
            if (c.time !== last.time + (barIndex - last.barIndex) * this.intervalMs) this.clockCheckpoints.push({ barIndex, time: c.time });
        }
        const pruneBefore = barIndex - (V4_MAX_HORIZON_BARS + 2);
        if (pruneBefore >= 0) {
            this.rawWindow.delete(pruneBefore);
            this.obsIdWindow.delete(pruneBefore);
        }
    }

    public validateContinuousHeader(headerCells: readonly string[]): void {
        const expectedHeaders = [
            ...CONTINUOUS_FIXED_HEADERS,
            ...V4_1M_CANONICAL_FEATURES,
            ...V4_1M_CANONICAL_FEATURES.map(f => `valid_${f}`),
            ...(this.include3m5mMtf ? ['context3m', 'htf3mDiagnostic', 'context5m', 'htf5mDiagnostic'] : [])
        ];
        if (headerCells.some(c => QUARANTINED_LOWER.has(c.toLowerCase())) ||
            headerCells.includes('context15m') || headerCells.includes('htf15mDiagnostic') ||
            headerCells.includes('context1h') || headerCells.includes('htf1hDiagnostic')) {
            this.fail('sep', 'V4 Continuous header contains forbidden 15m/1h or Tier C columns.');
            return;
        }
        if (headerCells.length !== expectedHeaders.length || headerCells.some((c, i) => c !== expectedHeaders[i])) {
            this.fail('sep', 'V4 Continuous header does not match exact ordered 150-feature V4 schema.');
            return;
        }
        this.contHeaders = [...headerCells];
        this.contFeatureCount = V4_1M_CANONICAL_FEATURES.length;
    }

    private validateHtfJsonPair(
        ctxStr: string,
        diagStr: string,
        expectedTf: '3m' | '5m',
        obsTs: number,
        expectedCtx: V4MTFTimeframeContext,
        expectedDiag: V4HTFIncompleteDiagnostic | null
    ): void {
        const durationMs = expectedTf === '3m' ? 180_000 : 300_000;
        const expectedSrcCount = expectedTf === '3m' ? 3 : 5;

        const ctxRaw = JSON.parse(ctxStr);
        assertRecursiveNoQuarantinedKeys(ctxRaw);
        const ctx = assertExactPlainObject(ctxRaw, `context${expectedTf}`, MTF_CONTEXT_ALLOWLIST);
        if (ctx['timeframe'] !== expectedTf ||
            typeof ctx['isAvailable'] !== 'boolean' ||
            typeof ctx['isWarmupComplete'] !== 'boolean' ||
            !VALID_AVAILABILITY.has(String(ctx['availabilityStatus']))) {
            throw new Error(`invalid context${expectedTf} status`);
        }
        const featObj = ctx['features'] as Record<string, unknown>;
        const valObj = ctx['validity'] as Record<string, unknown>;
        if (!featObj || typeof featObj !== 'object' || Array.isArray(featObj) ||
            !valObj || typeof valObj !== 'object' || Array.isArray(valObj)) {
            throw new Error(`context${expectedTf} features/validity must be plain objects`);
        }
        let lastCompletedOpen: number | null = null;
        if (ctx['lastCompletedCandle'] === null) {
            if (ctx['lastCompletedOpenTimestamp'] !== null || ctx['lastCompletedCloseTimestamp'] !== null ||
                ctx['contextAgeMs'] !== null || ctx['isAvailable'] !== false ||
                ctx['availabilityStatus'] !== 'UNAVAILABLE' || ctx['isWarmupComplete'] !== false ||
                Object.keys(featObj).length !== 0 || Object.keys(valObj).length !== 0) {
                throw new Error(`null context${expectedTf}.lastCompletedCandle must have empty metadata`);
            }
        } else {
            const mc = assertExactPlainObject(ctx['lastCompletedCandle'], `context${expectedTf}.lastCompletedCandle`, MTF_COMPLETED_CANDLE_ALLOWLIST);
            const mcOpen = mc['openTimestamp'] as number, mcClose = mc['closeTimestamp'] as number;
            const mcO = mc['open'] as number, mcH = mc['high'] as number, mcL = mc['low'] as number, mcC = mc['close'] as number, mcV = mc['volume'] as number;
            if (mc['timeframe'] !== expectedTf || mc['completeness'] !== 'COMPLETE' ||
                !Number.isSafeInteger(mcOpen) || mcOpen < 0 || mcOpen % durationMs !== 0 ||
                mcClose !== mcOpen + durationMs || mcClose > obsTs ||
                ctx['lastCompletedOpenTimestamp'] !== mcOpen || ctx['lastCompletedCloseTimestamp'] !== mcClose ||
                ctx['contextAgeMs'] !== obsTs - mcClose || mc['sourceObservationCount'] !== expectedSrcCount ||
                typeof mcO !== 'number' || !Number.isFinite(mcO) || mcO <= 0 ||
                typeof mcH !== 'number' || !Number.isFinite(mcH) || mcH <= 0 ||
                typeof mcL !== 'number' || !Number.isFinite(mcL) || mcL <= 0 ||
                typeof mcC !== 'number' || !Number.isFinite(mcC) || mcC <= 0 ||
                typeof mcV !== 'number' || !Number.isFinite(mcV) || mcV < 0 ||
                mcH < mcL || mcH < Math.max(mcO, mcC) || mcL > Math.min(mcO, mcC)) {
                throw new Error(`invalid/non-causal context${expectedTf}.lastCompletedCandle`);
            }
            const expectedAvail = ctx['availabilityStatus'] === 'WARMING_UP' || ctx['availabilityStatus'] === 'AVAILABLE_VALID';
            if (ctx['isAvailable'] !== expectedAvail ||
                ctx['isWarmupComplete'] !== (ctx['availabilityStatus'] === 'AVAILABLE_VALID')) {
                throw new Error(`inconsistent context${expectedTf} availability/warmup status`);
            }
            lastCompletedOpen = mcOpen;
            if (Object.keys(featObj).length !== V4_HTF_CANONICAL_FEATURES.size ||
                Object.keys(valObj).length !== V4_HTF_CANONICAL_FEATURES.size) {
                throw new Error(`context${expectedTf} must have exactly 147 features`);
            }
            for (const fk of V4_HTF_CANONICAL_FEATURES) {
                if (!Object.prototype.hasOwnProperty.call(featObj, fk) || !Object.prototype.hasOwnProperty.call(valObj, fk) ||
                    typeof featObj[fk] !== 'number' || !Number.isFinite(featObj[fk] as number) || typeof valObj[fk] !== 'boolean') {
                    throw new Error(`context${expectedTf} invalid/missing '${fk}'`);
                }
            }
        }

        // Compare context against independent MTF replay
        if (ctx['isAvailable'] !== expectedCtx.isAvailable ||
            ctx['availabilityStatus'] !== expectedCtx.availabilityStatus ||
            ctx['isWarmupComplete'] !== expectedCtx.isWarmupComplete ||
            ctx['lastCompletedOpenTimestamp'] !== expectedCtx.lastCompletedOpenTimestamp ||
            ctx['lastCompletedCloseTimestamp'] !== expectedCtx.lastCompletedCloseTimestamp ||
            ctx['contextAgeMs'] !== expectedCtx.contextAgeMs) {
            throw new Error(`REPLAY_MISMATCH: context${expectedTf} metadata diverges from independent MTF replay`);
        }
        if (expectedCtx.lastCompletedCandle === null) {
            if (ctx['lastCompletedCandle'] !== null) {
                throw new Error(`REPLAY_MISMATCH: context${expectedTf}.lastCompletedCandle expected null`);
            }
        } else {
            const mc = ctx['lastCompletedCandle'] as Record<string, unknown>;
            const ec = expectedCtx.lastCompletedCandle;
            if (!mc || mc['openTimestamp'] !== ec.openTimestamp || mc['closeTimestamp'] !== ec.closeTimestamp ||
                mc['sourceObservationCount'] !== ec.sourceObservationCount ||
                Math.abs((mc['open'] as number) - ec.open) > V4_REPLAY_TOLERANCE ||
                Math.abs((mc['high'] as number) - ec.high) > V4_REPLAY_TOLERANCE ||
                Math.abs((mc['low'] as number) - ec.low) > V4_REPLAY_TOLERANCE ||
                Math.abs((mc['close'] as number) - ec.close) > V4_REPLAY_TOLERANCE ||
                Math.abs((mc['volume'] as number) - ec.volume) > V4_REPLAY_TOLERANCE) {
                throw new Error(`REPLAY_MISMATCH: context${expectedTf}.lastCompletedCandle diverges from independent MTF replay`);
            }
            for (const fk of V4_HTF_CANONICAL_FEATURES) {
                if (Math.abs((featObj[fk] as number) - expectedCtx.features[fk]) > V4_REPLAY_TOLERANCE ||
                    valObj[fk] !== expectedCtx.validity[fk]) {
                    throw new Error(`REPLAY_MISMATCH: context${expectedTf} feature '${fk}' diverges from independent MTF replay`);
                }
            }
        }

        const diagRaw = JSON.parse(diagStr);
        if (diagRaw !== null) {
            assertRecursiveNoQuarantinedKeys(diagRaw);
            const diag = assertExactPlainObject(diagRaw, `htf${expectedTf}Diagnostic`, HTF_DIAGNOSTIC_ALLOWLIST);
            const dOpen = diag['openTimestamp'] as number, dClose = diag['closeTimestamp'] as number;
            const actualSrc = diag['actualSourceCount'] as number, dup = diag['duplicateCount'] as number;
            const inv = diag['invalidSourceCount'] as number, missing = diag['missingTimestamps'] as unknown[];
            const comp = String(diag['completeness']);
            if (diag['timeframe'] !== expectedTf ||
                typeof dOpen !== 'number' || !Number.isSafeInteger(dOpen) || dOpen < 0 || dOpen % durationMs !== 0 ||
                typeof dClose !== 'number' || !Number.isSafeInteger(dClose) || dClose !== dOpen + durationMs || dClose > obsTs ||
                diag['expectedSourceCount'] !== expectedSrcCount ||
                typeof actualSrc !== 'number' || !Number.isSafeInteger(actualSrc) || actualSrc < 0 || actualSrc > expectedSrcCount ||
                typeof dup !== 'number' || !Number.isSafeInteger(dup) || dup < 0 ||
                typeof inv !== 'number' || !Number.isSafeInteger(inv) || inv < 0 ||
                !Array.isArray(missing) || actualSrc + missing.length !== expectedSrcCount) {
                throw new Error(`invalid htf${expectedTf}Diagnostic`);
            }
            if (comp !== 'INCOMPLETE_MISSING' && comp !== 'INCOMPLETE_DUPLICATE' && comp !== 'INCOMPLETE_INVALID') {
                throw new Error(`htf${expectedTf}Diagnostic invalid completeness '${comp}'`);
            }
            if (inv > 0 && comp !== 'INCOMPLETE_INVALID') throw new Error('diag precedence');
            if (inv === 0 && dup > 0 && comp !== 'INCOMPLETE_DUPLICATE') throw new Error('diag precedence');
            if (comp === 'INCOMPLETE_INVALID' && inv <= 0) throw new Error('INCOMPLETE_INVALID requires invalidSourceCount > 0');
            if (comp === 'INCOMPLETE_DUPLICATE' && (inv !== 0 || dup <= 0)) throw new Error('INCOMPLETE_DUPLICATE requires dup > 0 and inv === 0');
            if (comp === 'INCOMPLETE_MISSING' && (inv !== 0 || dup !== 0 || missing.length === 0 || actualSrc >= expectedSrcCount)) {
                throw new Error('INCOMPLETE_MISSING requires missing timestamps with zero dup/inv');
            }
            let prevMt = -1;
            for (const mt of missing) {
                if (typeof mt !== 'number' || !Number.isSafeInteger(mt) ||
                    mt < dOpen || mt >= dClose || (mt - dOpen) % 60_000 !== 0 ||
                    (prevMt !== -1 && mt <= prevMt)) {
                    throw new Error(`invalid/unsorted/duplicate missingTimestamp inside htf${expectedTf}Diagnostic`);
                }
                prevMt = mt;
            }
            if (lastCompletedOpen !== null && dClose > lastCompletedOpen) {
                throw new Error(`htf${expectedTf}Diagnostic post-dates active candle`);
            }
        }

        // Compare diagnostic against independent MTF replay
        if (expectedDiag === null) {
            if (diagRaw !== null) {
                throw new Error(`REPLAY_MISMATCH: htf${expectedTf}Diagnostic expected null`);
            }
        } else {
            if (diagRaw === null) {
                throw new Error(`REPLAY_MISMATCH: htf${expectedTf}Diagnostic expected non-null`);
            }
            const diag = diagRaw as Record<string, unknown>;
            const missing = diag['missingTimestamps'] as number[];
            if (diag['timeframe'] !== expectedDiag.timeframe ||
                diag['openTimestamp'] !== expectedDiag.openTimestamp ||
                diag['closeTimestamp'] !== expectedDiag.closeTimestamp ||
                diag['expectedSourceCount'] !== expectedDiag.expectedSourceCount ||
                diag['actualSourceCount'] !== expectedDiag.actualSourceCount ||
                diag['duplicateCount'] !== expectedDiag.duplicateCount ||
                diag['invalidSourceCount'] !== expectedDiag.invalidSourceCount ||
                diag['completeness'] !== expectedDiag.completeness ||
                missing.length !== expectedDiag.missingTimestamps.length ||
                missing.some((mt, i) => mt !== expectedDiag.missingTimestamps[i])) {
                throw new Error(`REPLAY_MISMATCH: htf${expectedTf}Diagnostic diverges from independent MTF replay`);
            }
        }
    }

    public validateContinuousCells(cells: readonly string[]): void {
        const rowIdx = this.contRowCount;
        this.contRowCount++;
        if (!this.contHeaders || cells.length !== this.contHeaders.length) {
            this.fail('cont', `V4 Continuous column count mismatch at row ${rowIdx}.`);
            return;
        }
        try {
            const obsId = cells[0];
            if (!obsId || obsId.trim() === '' || this.seenObsIds.has(obsId)) {
                this.fail('id', `V4 Continuous row ${rowIdx} failed: invalid/dup obsId '${obsId}'`);
                return;
            }
            this.seenObsIds.add(obsId);

            const srcTs = parseIntNonNeg(cells[1], 'source_timestamp');
            const obsTs = parseIntNonNeg(cells[2], 'observation_timestamp');
            if (obsTs !== srcTs + this.intervalMs || (this.prevContSrcTs !== -1 && srcTs <= this.prevContSrcTs)) {
                this.fail('chrono', `V4 Continuous row ${rowIdx} failed: timestamp chronology failure`);
                return;
            }
            this.prevContSrcTs = srcTs;

            const o = parseNum(cells[3], 'open'), h = parseNum(cells[4], 'high'), l = parseNum(cells[5], 'low');
            const c = parseNum(cells[6], 'close'), v = parseNum(cells[7], 'volume');
            const expectedRaw = this.getRawBar(rowIdx);
            if (!expectedRaw || srcTs !== expectedRaw.time || Math.abs(o - expectedRaw.open) > V4_REPLAY_TOLERANCE ||
                Math.abs(h - expectedRaw.high) > V4_REPLAY_TOLERANCE || Math.abs(l - expectedRaw.low) > V4_REPLAY_TOLERANCE ||
                Math.abs(c - expectedRaw.close) > V4_REPLAY_TOLERANCE || Math.abs(v - expectedRaw.volume) > V4_REPLAY_TOLERANCE) {
                this.fail('replay', `V4 Continuous row ${rowIdx} diverges from raw candle`);
                return;
            }
            if (this.batchRawBuffer !== null) this.batchObsIds[rowIdx] = obsId;
            else this.obsIdWindow.set(rowIdx, obsId);

            const sym = cells[8], tf = cells[9];
            if (!sym || !tf || sym !== this.expectedSymbol || tf !== this.expectedTimeframe) {
                this.fail('sep', `V4 Continuous row ${rowIdx} failed: symbol/timeframe mismatch (${sym}/${tf} vs ${this.expectedSymbol}/${this.expectedTimeframe})`);
                return;
            }

            const dq = assertExactPlainObject(JSON.parse(cells[10]), 'data_quality', DATA_QUALITY_KEYS);
            for (const dk of DATA_QUALITY_KEYS) {
                if (typeof dq[dk] !== 'boolean') throw new Error(`data_quality.${dk} must be boolean`);
            }
            if (dq['isSourceValid'] !== true) throw new Error('isSourceValid !== true');

            const fStart = CONTINUOUS_FIXED_HEADERS.length;
            const vStart = fStart + this.contFeatureCount;
            const parsedFeatures = new Array<number>(this.contFeatureCount);
            const parsedValidity = new Array<string>(this.contFeatureCount);
            for (let i = 0; i < this.contFeatureCount; i++) {
                parsedFeatures[i] = parseNum(cells[fStart + i], this.contHeaders[fStart + i]);
                const valStr = cells[vStart + i];
                if (valStr !== 'true' && valStr !== 'false') throw new Error('non-boolean validity');
                parsedValidity[i] = valStr;
            }

            // Independent 1m V6 Tier A replay
            const replayCandle: ML1Candle = Object.freeze({
                time: expectedRaw.time,
                open: expectedRaw.open,
                high: expectedRaw.high,
                low: expectedRaw.low,
                close: expectedRaw.close,
                volume: expectedRaw.volume,
                isSynthetic: false as const
            });
            const featStep = stepML1FeaturesV6(replayCandle, rowIdx, this.replayFeatureState, this.replayFeatureConfig);
            this.replayFeatureState = featStep.nextState;
            const expectedDq = extractDataQuality(featStep.observation);
            for (const dk of DATA_QUALITY_KEYS) {
                if (dq[dk] !== expectedDq[dk]) {
                    this.fail('replay', `V4 Continuous row ${rowIdx} data_quality.${dk} diverges from independent replay.`);
                    return;
                }
            }
            for (let i = 0; i < this.contFeatureCount; i++) {
                const fk = V4_1M_CANONICAL_FEATURES[i];
                const expVal = featStep.observation.features[fk];
                const expValid = featStep.observation.validity[fk];
                if (!Number.isFinite(expVal) || Math.abs(parsedFeatures[i] - expVal) > V4_REPLAY_TOLERANCE) {
                    this.fail('replay', `V4 Continuous row ${rowIdx} feature '${fk}' diverges from independent 1m replay (${parsedFeatures[i]} vs ${expVal}).`);
                    return;
                }
                if (parsedValidity[i] !== String(expValid)) {
                    this.fail('replay', `V4 Continuous row ${rowIdx} validity 'valid_${fk}' diverges from independent 1m replay (${parsedValidity[i]} vs ${expValid}).`);
                    return;
                }
            }

            if (this.include3m5mMtf && this.replayMtfState !== null && this.replayMtfConfig !== null) {
                const combined = stepV4MTFCombined(replayCandle, true, this.replayMtfState, this.replayMtfConfig, rowIdx);
                this.replayMtfState = combined.nextState;
                const expectedAligned = alignV4MTFContext(obsTs, this.expectedSymbol, this.replayMtfState, this.replayMtfConfig);
                const expectedDiag3m = this.replayMtfState.state3m.aggregation.lastDiagnostic;
                const expectedDiag5m = this.replayMtfState.state5m.aggregation.lastDiagnostic;

                this.validateHtfJsonPair(cells[cells.length - 4], cells[cells.length - 3], '3m', obsTs, expectedAligned.context3m, expectedDiag3m);
                this.validateHtfJsonPair(cells[cells.length - 2], cells[cells.length - 1], '5m', obsTs, expectedAligned.context5m, expectedDiag5m);
            }
        } catch (e: any) {
            const msg = String(e?.message ?? e);
            this.fail(msg.startsWith('REPLAY_MISMATCH:') ? 'replay' : 'sep', `V4 Continuous row ${rowIdx} failed: ${msg}`);
        }
    }

    public validateContinuousLine(line: string): void {
        try {
            this.validateContinuousCells(parseSingleCsvRecord(line));
        } catch (e: any) {
            this.contRowCount++;
            this.fail('cont', `V4 Continuous parse error: ${e?.message}`);
        }
    }

    public validateRepresentationHeader(headerCells: readonly string[]): void {
        if (headerCells.length !== V4_REPRESENTATION_COLUMNS.length ||
            headerCells.some((c, i) => c !== V4_REPRESENTATION_COLUMNS[i])) {
            this.fail('sep', 'V4 Representation header mismatch.');
            return;
        }
        try { assertV4RepresentationZeroTierCLeakage(headerCells); }
        catch (e: any) { this.fail('sep', `V4 Representation header error: ${e?.message}`); }
    }

    public validateStrategyEventsHeader(headerCells: readonly string[]): void {
        if (headerCells.length !== V4_STRATEGY_EVENT_COLUMNS.length ||
            headerCells.some((c, i) => c !== V4_STRATEGY_EVENT_COLUMNS[i])) {
            this.fail('chrono', 'V4 StrategyEvents header mismatch.');
        }
    }

    public validateSerializedEventCells(repCells: readonly string[], evCells: readonly string[]): void {
        this.repRowCount++;
        this.evRowCount++;
        if (repCells.length !== V4_REPRESENTATION_COLUMNS.length) { this.fail('sep', 'Rep col count mismatch'); return; }
        if (evCells.length !== V4_STRATEGY_EVENT_COLUMNS.length) { this.fail('replay', 'Ev col count mismatch'); return; }

        const evMap = new Map<string, string>();
        for (let i = 0; i < V4_STRATEGY_EVENT_COLUMNS.length; i++) {
            const colName = V4_STRATEGY_EVENT_COLUMNS[i];
            const cell = evCells[i];
            const colType = V4_EVENT_SCHEMA[colName];
            try {
                if (colType === 'nonempty_string') { if (!cell || cell.trim() === '') throw new Error('blank'); }
                else if (colType === 'strategy_id') { if (!VALID_STRATEGY_IDS.has(cell)) throw new Error(`bad strategy_id '${cell}'`); }
                else if (colType === 'direction') { if (cell !== 'bull' && cell !== 'bear') throw new Error('bad direction'); }
                else if (colType === 'availability') { if (!VALID_AVAILABILITY.has(cell)) throw new Error('bad availability'); }
                else if (colType === 'outcome') { if (!VALID_HORIZON_OUTCOMES.has(cell)) throw new Error('bad outcome'); }
                else if (colType === 'int_nonneg') parseIntNonNeg(cell, String(colName));
                else if (colType === 'flag_01') { if (cell !== '0' && cell !== '1') throw new Error('bad flag'); }
                else if (colType === 'regime_012') { if (cell !== '0' && cell !== '1' && cell !== '2') throw new Error('bad regime'); }
                else if (colType === 'finite_float') parseNum(cell, String(colName));
                else if (colType === 'positive_float') { if (parseNum(cell, String(colName)) <= 0) throw new Error('non-positive'); }
                else if (colType === 'json_context') JSON.parse(cell);
            } catch (e: any) {
                this.fail('replay', `V4 StrategyEvents schema error on '${String(colName)}': ${e?.message}`);
                return;
            }
            evMap.set(String(colName), cell);
        }

        const repMap = new Map<string, string>();
        for (let i = 0; i < V4_REPRESENTATION_COLUMNS.length; i++) repMap.set(V4_REPRESENTATION_COLUMNS[i], repCells[i]);

        try {
            const stratId = repMap.get('tierB_strategy_id')! as V4PipelineStrategyId;
            const evType = evMap.get('event_type')!;
            if (!VALID_EVENT_TYPES_BY_STRATEGY[stratId]?.has(evType)) {
                this.fail('replay', `Invalid event_type '${evType}' for '${stratId}'.`);
                return;
            }
            const parsedCtx = JSON.parse(repMap.get('tierB_structural_context_json')!);
            assertRecursiveNoQuarantinedKeys(parsedCtx);
            const canonicalCtx = serializeAndValidateV4StructuralContext(stratId, parsedCtx);
            if (canonicalCtx !== repMap.get('tierB_structural_context_json')) {
                this.fail('sep', 'Non-canonical structural_context_json.');
            }
            if (stratId === 'DTFX_STRICTCBC' || stratId === 'PHL_BOS_MSS') {
                for (const reqKey of V4_STRUCTURAL_CONTEXT_ALLOWLIST[stratId]) {
                    if (!Object.prototype.hasOwnProperty.call(parsedCtx, reqKey)) {
                        this.fail('sep', `${stratId} missing required context key '${reqKey}'.`);
                        return;
                    }
                }
            }

            const pairs: Array<[string, string]> = [
                ['tierA_observation_id', 'tierA_observation_id'],
                ['tierA_atr_14', 'tierA_atr_14'],
                ['tierA_exhaustion_14', 'tierA_exhaustion_14'],
                ['tierA_exhaustion_14_valid', 'tierA_exhaustion_14_valid'],
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
                ['tierA_sma_20_dist_atr', 'tierA_sma_20_dist_atr'],
                ['tierA_sma_50_dist_atr', 'tierA_sma_50_dist_atr'],
                ['tierA_sma_200_dist_atr', 'tierA_sma_200_dist_atr'],
                ['tierA_sma_20_above_50', 'tierA_sma_20_above_50'],
                ['tierA_sma_50_above_200', 'tierA_sma_50_above_200'],
                ['tierA_sma_valid', 'tierA_sma_valid'],
                ['tierA_macd_line_atr', 'tierA_macd_line_atr'],
                ['tierA_macd_signal_atr', 'tierA_macd_signal_atr'],
                ['tierA_macd_hist_atr', 'tierA_macd_hist_atr'],
                ['tierA_macd_valid', 'tierA_macd_valid'],
                ['tierA_bb_width_20', 'tierA_bb_width_20'],
                ['tierA_bb_pctb_20', 'tierA_bb_pctb_20'],
                ['tierA_bb_valid', 'tierA_bb_valid'],
                ['tierA_context_3m_available', 'tierA_context_3m_available'],
                ['tierA_context_3m_status', 'tierA_context_3m_status'],
                ['tierA_context_5m_available', 'tierA_context_5m_available'],
                ['tierA_context_5m_status', 'tierA_context_5m_status'],
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
                    this.fail('sep', `Representation '${rk}' diverges from StrategyEvents '${ek}'.`);
                    return;
                }
            }
        } catch (e: any) {
            this.fail('sep', `Representation error: ${e?.message}`);
            return;
        }

        try {
            const eventId = evMap.get('event_id')!;
            const strategyId = evMap.get('strategy_id')!;
            const eventType = evMap.get('event_type')!;
            const evSymbol = evMap.get('symbol')!;
            const evTimeframe = evMap.get('timeframe')!;
            if (evSymbol !== this.expectedSymbol || evTimeframe !== this.expectedTimeframe) {
                this.fail('sep', `Event symbol/timeframe mismatch on '${eventId}' (${evSymbol}/${evTimeframe} vs ${this.expectedSymbol}/${this.expectedTimeframe}).`);
                return;
            }
            const srcBar = Number(evMap.get('source_bar_index')!);
            const srcTs = Number(evMap.get('source_timestamp')!);
            const confBar = Number(evMap.get('confirmation_bar_index')!);
            const confTs = Number(evMap.get('confirmation_timestamp')!);
            const lag = Number(evMap.get('confirmation_lag_bars')!);
            const obsBar = Number(evMap.get('observation_bar_index')!);
            const obsTs = Number(evMap.get('observation_timestamp')!);
            const entryBar = Number(evMap.get('entry_bar_index')!);
            const entryTime = Number(evMap.get('entry_time')!);
            const entryPrice = Number(evMap.get('entry_price')!);
            const atr = Number(evMap.get('atr_at_confirmation')!);

            if (Math.abs(Number(evMap.get('tierA_atr_14')!) - atr) > V4_REPLAY_TOLERANCE ||
                lag !== confBar - srcBar || obsBar !== confBar || srcTs > confTs) {
                throw new Error('chronology/atr mismatch');
            }
            if (this.seenEventIds.has(eventId)) this.fail('id', `Duplicate event_id '${eventId}'.`);
            this.seenEventIds.add(eventId);

            if (this.prevEventOrder !== null) {
                const cmp = (this.prevEventOrder.confirmationBarIndex - confBar) ||
                    compareAscii(this.prevEventOrder.strategyId, strategyId) ||
                    compareAscii(this.prevEventOrder.eventType, eventType) ||
                    compareAscii(this.prevEventOrder.eventId, eventId);
                if (cmp >= 0) this.fail('chrono', `Events out of canonical order at '${eventId}'.`);
            }
            this.prevEventOrder = { confirmationBarIndex: confBar, strategyId, eventType, eventId };

            const expectedSrcTs = this.resolveClockTime(srcBar);
            if (expectedSrcTs === undefined || srcTs !== expectedSrcTs) this.fail('chrono', `Bad source_timestamp on '${eventId}'.`);
            const expectedObsId = this.getObservedIdAt(obsBar);
            if (expectedObsId === undefined || evMap.get('tierA_observation_id') !== expectedObsId) {
                this.fail('id', `Bad tierA_observation_id on '${eventId}'.`);
            }
            const confCandle = this.getRawBar(confBar), entryCandle = this.getRawBar(entryBar);
            if (!confCandle || !entryCandle || entryBar !== confBar + 1 ||
                confTs !== confCandle.time || obsTs !== confTs + this.intervalMs ||
                entryTime !== entryCandle.time || entryTime <= confTs ||
                Math.abs(entryPrice - entryCandle.open) > V4_REPLAY_TOLERANCE) {
                this.fail('chrono', `Entry/confirmation mismatch on '${eventId}'.`);
                return;
            }

            const expLStop = entryPrice - atr * V4_STOP_ATR_MULT;
            const expLTarget = entryPrice + atr * V4_STOP_ATR_MULT * V4_TARGET_R_MULT;
            const expSStop = entryPrice + atr * V4_STOP_ATR_MULT;
            const expSTarget = entryPrice - atr * V4_STOP_ATR_MULT * V4_TARGET_R_MULT;
            if (Math.abs(expLStop - Number(evMap.get('long_stop_price'))) > V4_REPLAY_TOLERANCE ||
                Math.abs(expLTarget - Number(evMap.get('long_target_price'))) > V4_REPLAY_TOLERANCE ||
                Math.abs(expSStop - Number(evMap.get('short_stop_price'))) > V4_REPLAY_TOLERANCE ||
                Math.abs(expSTarget - Number(evMap.get('short_target_price'))) > V4_REPLAY_TOLERANCE) {
                this.fail('replay', `Barrier price mismatch on '${eventId}'.`);
                return;
            }
            const lRisk = entryPrice - expLStop, sRisk = expSStop - entryPrice;

            const replayH = (isLong: boolean, h: number) => {
                const hEnd = entryBar + h - 1;
                let resolved = false, exitP = entryPrice, kind: 'hard_stop' | 'full_target' = 'hard_stop';
                for (let f = entryBar; f <= hEnd; f++) {
                    const b = this.getRawBar(f);
                    if (!b) throw new Error(`missing bar ${f}`);
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
                const netR = grossR - V4_TRADE_COST_R;
                const outcome: V3HorizonOutcomeClass = resolved ? kind : netR > 0 ? 'timeout_net_gain' : 'timeout_net_loss';
                return { exitP, netR, outcome };
            };

            for (const h of V4_HORIZONS) {
                const repL = replayH(true, h), repS = replayH(false, h);
                if (Math.abs(repL.exitP - Number(evMap.get(`long_exit_price_${h}`))) > V4_REPLAY_TOLERANCE ||
                    Math.abs(repL.netR - Number(evMap.get(`long_net_r_${h}`))) > V4_REPLAY_TOLERANCE ||
                    repL.outcome !== evMap.get(`long_outcome_${h}`) ||
                    Math.abs(repS.exitP - Number(evMap.get(`short_exit_price_${h}`))) > V4_REPLAY_TOLERANCE ||
                    Math.abs(repS.netR - Number(evMap.get(`short_net_r_${h}`))) > V4_REPLAY_TOLERANCE ||
                    repS.outcome !== evMap.get(`short_outcome_${h}`)) {
                    this.fail('replay', `Replay mismatch H=${h} on '${eventId}'.`);
                    return;
                }
            }
        } catch (e: any) {
            this.fail('replay', `V4 Replay validation failed: ${e?.message}`);
        }
    }

    public validateSerializedEventPairLines(repLine: string, evLine: string): void {
        try {
            this.validateSerializedEventCells(parseSingleCsvRecord(repLine), parseSingleCsvRecord(evLine));
        } catch (e: any) {
            this.repRowCount++;
            this.evRowCount++;
            this.fail('sep', `CSV row parse error: ${e?.message}`);
        }
    }

    public finalizeAudit(expectedContinuousRows: number, expectedEventRows: number): IntegrityAuditResults {
        const batchMismatch = this.batchRawBuffer !== null && this.batchRawLength !== expectedContinuousRows;
        const countMismatch =
            batchMismatch ||
            this.contRowCount !== expectedContinuousRows ||
            this.repRowCount !== expectedEventRows ||
            this.evRowCount !== expectedEventRows;
        if (countMismatch) this.fail('cont', `Row count mismatch (cont=${this.contRowCount}/${expectedContinuousRows}, ev=${this.evRowCount}/${expectedEventRows}).`);

        const chronologyValid = !this.hasChronologyFailure;
        const identityUnique = !this.hasIdentityFailure;
        const inputOutcomeSeparationValid = !this.hasSeparationFailure;
        const passed = !this.hasContinuousFailure && !this.hasReplayFailure && chronologyValid && identityUnique && inputOutcomeSeparationValid && !countMismatch;

        return Object.freeze({
            passed,
            chronologyValid,
            identityUnique,
            inputOutcomeSeparationValid,
            remarks: Object.freeze([...this.errors])
        });
    }

    public static runBatchAudit(params: {
        readonly rawCandleBuffer: Float64Array;
        readonly expectedSymbol: string;
        readonly expectedTimeframe: string;
        readonly intervalMs: number;
        readonly expectedContinuousRows: number;
        readonly expectedEventRows: number;
        readonly continuousCsv: string;
        readonly representationCsv: string;
        readonly strategyEventsCsv: string;
        readonly include3m5mMtf: boolean;
    }): IntegrityAuditResults {
        const auditor = new V4ArtifactAuditor({
            expectedSymbol: params.expectedSymbol,
            expectedTimeframe: params.expectedTimeframe,
            intervalMs: params.intervalMs,
            include3m5mMtf: params.include3m5mMtf,
            batchRawBuffer: params.rawCandleBuffer
        });

        let contRecords: string[][], repRecords: string[][], evRecords: string[][];
        try {
            contRecords = parseCsvDocumentCRLF(params.continuousCsv);
            repRecords = parseCsvDocumentCRLF(params.representationCsv);
            evRecords = parseCsvDocumentCRLF(params.strategyEventsCsv);
        } catch (e: any) {
            return Object.freeze({
                passed: false, chronologyValid: false, identityUnique: false, inputOutcomeSeparationValid: false,
                remarks: Object.freeze([`V4 CSV Parse Error: ${e?.message}`])
            });
        }

        auditor.validateContinuousHeader(contRecords[0] ?? []);
        for (let i = 1; i < contRecords.length; i++) auditor.validateContinuousCells(contRecords[i]);

        auditor.validateRepresentationHeader(repRecords[0] ?? []);
        auditor.validateStrategyEventsHeader(evRecords[0] ?? []);
        const evCount = Math.max(repRecords.length, evRecords.length) - 1;
        for (let i = 1; i <= evCount; i++) {
            auditor.validateSerializedEventCells(repRecords[i] ?? [], evRecords[i] ?? []);
        }
        return auditor.finalizeAudit(params.expectedContinuousRows, params.expectedEventRows);
    }
}
