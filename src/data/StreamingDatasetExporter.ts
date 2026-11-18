import { AIExporter, MLR1_DATASET_VERSION, MLR1_OUTCOME_CONFIG_VERSION, MLR1_REPRESENTATION_COLUMNS, buildRepresentationInput, type MLR1EventRow } from './AIExporter';
import { ML1_CONFIG_B, ML1_CONFIG_B_VERSION } from '../indicators/mlr1/ML1FeatureConfigs';
import { createInitialML1FeatureState, stepML1Features, validateML1Config } from '../indicators/mlr1/ML1FeatureEngine';
import type { ML1Candle, ML1FeatureState, ML1Observation } from '../indicators/mlr1/ML1FeatureTypes';
import { alignMTFContext } from '../indicators/mlr1/mtf/MTFAligner';
import { MTF_CONFIG_B, validateMTFConfig } from '../indicators/mlr1/mtf/MTFConfig';
import { createInitialIntegratedMTFState, stepIntegratedMTFPipeline, type IntegratedMTFState } from '../indicators/mlr1/mtf/MTFEngine';
import type { HTFIncompleteDiagnostic, MTFTimeframeContext } from '../indicators/mlr1/mtf/MTFTypes';
import { MLR1_MODEL_INPUT_SCHEMA_VERSION, MLR1_REPRESENTATION_SCHEMA_VERSION, TIER_A_MODEL_INPUT_ALLOWLIST, TIER_B_MODEL_INPUT_ALLOWLIST } from '../indicators/mlr1/dataset/DatasetSchema';
import type { DatasetManifest, ExportAccounting } from '../indicators/mlr1/dataset/DatasetManifest';
import { createDatasetManifest, createInitialBackboneStats, evaluateDatasetUptime, extractDataQuality, generateObservationId, processSourceObservation, validateCandleOhlcv, type BackboneStats, type RawSourceTimestampBounds } from '../indicators/mlr1/dataset/ObservationBackbone';
import { createML1ZipExportRequest } from '../indicators/mlr1/integration/ML1IntegrationTypes';
import { STRICT_CBC_ZIGZAG_TEACHER_VERSION, createInitialStrictCBCState, stepStrictCBC, type StrictCBCState, type StrictZigZagPivot } from '../indicators/plugins/StrictCBCZigZagIndicator';
import { createV3PipelineConfig, V3PipelineRunner } from '../indicators/mlr1/pipeline/V3PipelineEngine';
import {
    buildV3ContinuousHeader,
    buildV3DatasetManifest,
    buildV3RepresentationHeader,
    buildV3StrategyEventHeader,
    formatV3ContinuousRow,
    formatV3RepresentationRow,
    formatV3StrategyEventRow,
    getV3FileNames,
    MTF15mSerializerCache
} from '../indicators/mlr1/pipeline/V3CsvSerializer';
import { V3_DATASET_VERSION } from '../indicators/mlr1/pipeline/MultiHorizonOutcomeEngine';
import { parseSingleCsvRecord, V3ArtifactAuditor } from '../indicators/mlr1/pipeline/V3ArtifactAuditor';

const MLR1_EVENT_ID_VERSION = 'v2_ATR14_SL1.5_TP2_HZ60';
const MLR1_MTF_CONTEXT_VERSION = 'M3A_3E_MTFv1';
const STREAMING_BATCH_ROWS = 500;

const MLR1_EVENT_COLUMNS: readonly (keyof MLR1EventRow)[] = [
    'event_id', 'symbol', 'timeframe', 'pivot_type', 'pivot_label',
    'pivot_price', 'previous_pivot_price', 'previous_pivot_bar_index',
    'previous_pivot_confirmed_bar_index', 'previous_pivot_confirmation_time_ms',
    'previous_pivot_type', 'pivot_bar_index', 'pivot_time_ms',
    'confirmed_bar_index', 'confirmation_time_ms',
    'completed_leg_direction', 'zigzag_next_leg_orientation',
    'bars_since_last_pivot', 'leg_distance_atr',
    'context_net_return_atr', 'context_max_favorable_atr',
    'context_max_adverse_atr', 'context_candle_count',
    'context_relative_volume', 'context_relative_volume_valid_fraction',
    'entry_bar_index', 'entry_time', 'entry_price', 'atr_at_confirmation',
    'long_stop_price', 'long_target_price', 'long_exit_price', 'long_net_r', 'long_outcome',
    'short_stop_price', 'short_target_price', 'short_exit_price', 'short_net_r', 'short_outcome'
];

// =========================================================================
// True Incremental SHA-256 (FIPS 180-4, zero full-buffer accumulation)
// =========================================================================
const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export class IncrementalSha256 {
    private readonly h = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    private readonly block = new Uint8Array(64);
    private readonly w = new Int32Array(64);
    private blockLen = 0;
    private totalBytes = 0;
    private finalized = false;

    public update(chunk: Uint8Array): void {
        if (this.finalized) throw new Error('IncrementalSha256 already finalized.');
        this.totalBytes += chunk.length;
        let offset = 0;
        while (offset < chunk.length) {
            const take = Math.min(64 - this.blockLen, chunk.length - offset);
            this.block.set(chunk.subarray(offset, offset + take), this.blockLen);
            this.blockLen += take;
            offset += take;
            if (this.blockLen === 64) {
                this.compress(this.block);
                this.blockLen = 0;
            }
        }
    }

    public digestHex(): string {
        if (!this.finalized) {
            this.finalized = true;
            const hi = Math.floor(this.totalBytes / 0x20000000) >>> 0;
            const lo = ((this.totalBytes & 0x1fffffff) * 8) >>> 0;

            this.block[this.blockLen++] = 0x80;
            if (this.blockLen > 56) {
                this.block.fill(0, this.blockLen, 64);
                this.compress(this.block);
                this.blockLen = 0;
            }
            this.block.fill(0, this.blockLen, 56);
            this.block[56] = (hi >>> 24) & 0xff;
            this.block[57] = (hi >>> 16) & 0xff;
            this.block[58] = (hi >>> 8) & 0xff;
            this.block[59] = hi & 0xff;
            this.block[60] = (lo >>> 24) & 0xff;
            this.block[61] = (lo >>> 16) & 0xff;
            this.block[62] = (lo >>> 8) & 0xff;
            this.block[63] = lo & 0xff;
            this.compress(this.block);
        }
        let hex = '';
        for (let i = 0; i < 8; i++) {
            hex += (this.h[i] >>> 0).toString(16).padStart(8, '0');
        }
        return hex;
    }

    private compress(buf: Uint8Array): void {
        const w = this.w;
        for (let i = 0; i < 16; i++) {
            const j = i * 4;
            w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
        }
        for (let i = 16; i < 64; i++) {
            const w15 = w[i - 15];
            const w2 = w[i - 2];
            const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
            const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let a = this.h[0] | 0, b = this.h[1] | 0, c = this.h[2] | 0, d = this.h[3] | 0;
        let e = this.h[4] | 0, f = this.h[5] | 0, g = this.h[6] | 0, h = this.h[7] | 0;
        for (let i = 0; i < 64; i++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ ((~e) & g);
            const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;
        }
        this.h[0] = (this.h[0] + a) | 0; this.h[1] = (this.h[1] + b) | 0;
        this.h[2] = (this.h[2] + c) | 0; this.h[3] = (this.h[3] + d) | 0;
        this.h[4] = (this.h[4] + e) | 0; this.h[5] = (this.h[5] + f) | 0;
        this.h[6] = (this.h[6] + g) | 0; this.h[7] = (this.h[7] + h) | 0;
    }
}

// =========================================================================
// Helpers: CSV escaping, MTF JSON cache (Amendment E), Memory measurement
// =========================================================================
function csvEscape(value: unknown): string {
    if (value == null) return '';
    const raw = String(value);
    return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function getHeapUsedMB(): number | null {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return mem ? Math.round((mem.usedJSHeapSize / (1024 * 1024)) * 100) / 100 : null;
}

class MTFContextSerializerCache {
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

// =========================================================================
// Incremental Stream Sinks (Desktop Directory Picker & OPFS Fallback)
// =========================================================================
export class BufferedTextSink {
    private readonly encoder = new TextEncoder();
    private readonly hasher = new IncrementalSha256();
    private readonly stream: { write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> };
    private readonly batchSize: number;
    private readonly lines: string[] = [];
    private rowCount = 0;
    private hasHeader = false;
    private closed = false;
    private aborted = false;
    public bytesWritten = 0;

    public constructor(
        stream: { write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> },
        batchSize: number = STREAMING_BATCH_ROWS
    ) {
        this.stream = stream;
        this.batchSize = batchSize;
    }

    public async writeHeader(headerLine: string): Promise<void> {
        if (this.hasHeader) throw new Error('Header already written.');
        this.hasHeader = true;
        const bytes = this.encoder.encode(headerLine);
        this.hasher.update(bytes);
        this.bytesWritten += bytes.length;
        await this.stream.write(bytes);
    }

    public async appendRow(rowLine: string): Promise<void> {
        if (!this.hasHeader) throw new Error('Header must be written before rows.');
        this.lines.push('\r\n' + rowLine);
        this.rowCount++;
        if (this.lines.length >= this.batchSize) {
            await this.flush();
        }
    }

    public async flush(): Promise<void> {
        if (this.lines.length === 0) return;
        const text = this.lines.join('');
        this.lines.length = 0;
        const bytes = this.encoder.encode(text);
        this.hasher.update(bytes);
        this.bytesWritten += bytes.length;
        await this.stream.write(bytes);
    }

    public async finalize(): Promise<{ rowCount: number; bytesWritten: number; sha256: string }> {
        if (this.aborted) throw new Error('Sink already aborted.');
        if (this.closed) throw new Error('Sink already finalized.');
        await this.flush();
        await this.stream.close();
        this.closed = true;
        return {
            rowCount: this.rowCount,
            bytesWritten: this.bytesWritten,
            sha256: this.hasher.digestHex()
        };
    }

    public async abort(): Promise<void> {
        this.lines.length = 0;
        if (!this.aborted) {
            this.aborted = true;
            this.closed = true;
            try { await this.stream.abort(); } catch { /* ignore cleanup error */ }
        }
    }
}

export interface StreamingExportResult {
    readonly destinationType: 'directory_picker' | 'opfs' | 'memory_test';
    readonly folderName: string;
    readonly manifest: DatasetManifest;
    readonly fileChecksums: Readonly<Record<string, { sha256: string; bytesWritten: number }>>;
    readonly telemetry: {
        readonly durationMs: number;
        readonly peakHeapMB: number | null;
        readonly postExportHeapMB: number | null;
        readonly batchSizeRows: number;
        readonly totalCandles: number;
        readonly totalEvents: number;
    };
}

interface PendingOutcomeEvent {
    readonly pivot: StrictZigZagPivot;
    readonly prevPivot: StrictZigZagPivot;
    readonly confBar: number;
    readonly entryBar: number;
    readonly horizonEnd: number;
    readonly currentAtr: number;
    readonly atrValid: boolean;
    readonly tokenFeatures: ReturnType<typeof buildTokenFromScalarContext> | null;
    initialized: boolean;
    entryTime: number;
    entryPrice: number;
    lStop: number; lTarget: number; lRisk: number;
    sStop: number; sTarget: number; sRisk: number;
    lResolved: boolean; lExitPrice: number; lOutcomeType: 'barrier' | 'timeout'; lBarrier: 'hard_stop' | 'full_target';
    sResolved: boolean; sExitPrice: number; sOutcomeType: 'barrier' | 'timeout'; sBarrier: 'hard_stop' | 'full_target';
}

function buildTokenFromScalarContext(
    event: StrictZigZagPivot,
    prevEvent: StrictZigZagPivot,
    startOpen: number,
    endClose: number,
    maxH: number,
    minL: number,
    count: number,
    matureCount: number,
    sumRelativeVolume: number,
    currentAtr: number
) {
    const barsSinceLast = event.confirmedBarIndex - prevEvent.confirmedBarIndex;
    const legDistAtr = (event.price - prevEvent.price) / currentAtr;
    const completed_leg_direction: 'up' | 'down' | 'flat' =
        event.price > prevEvent.price ? 'up' :
        event.price < prevEvent.price ? 'down' : 'flat';
    const zigzag_next_leg_orientation: 'up' | 'down' = event.type === 'high' ? 'down' : 'up';

    const netReturnAtr = (endClose - startOpen) / currentAtr;
    const maxFavorableAtr = (maxH - startOpen) / currentAtr;
    const maxAdverseAtr = (startOpen - minL) / currentAtr;
    const validFraction = count > 0 ? (matureCount / count) : 0.0;
    const relativeVolume = matureCount > 0 ? sumRelativeVolume / matureCount : -1.0;

    return {
        completed_leg_direction,
        zigzag_next_leg_orientation,
        bars_since_last_pivot: barsSinceLast,
        leg_distance_atr: legDistAtr,
        context_net_return_atr: netReturnAtr,
        context_max_favorable_atr: maxFavorableAtr,
        context_max_adverse_atr: maxAdverseAtr,
        context_candle_count: count,
        context_relative_volume: relativeVolume,
        context_relative_volume_valid_fraction: validFraction
    };
}

// =========================================================================
// Main Streaming 4-File Exporter (Preserves Frozen M4 Contract)
// =========================================================================
export class StreamingDatasetExporter {
    public static async promptDirectoryHandle(): Promise<any | null> {
        const picker = (window as unknown as { showDirectoryPicker?: (opts: { mode: string }) => Promise<any> }).showDirectoryPicker;
        if (typeof picker !== 'function') return null;
        return await picker({ mode: 'readwrite' });
    }

    public static isOpfsSupported(): boolean {
        return typeof navigator !== 'undefined' &&
            typeof navigator.storage?.getDirectory === 'function';
    }

    public static async exportToFolderOrOpfs(params: {
        rawCandleBuffer: Float64Array;
        symbol: string;
        interval: string;
        intervalMs: number;
        rootDirHandle?: any; // Acquired under user gesture via promptDirectoryHandle()
        buildTimestamp?: number;
        sourceTimestampBounds?: RawSourceTimestampBounds;
        signal?: AbortSignal;
        onProgress?: (pct: number, detail: string) => void;
    }): Promise<StreamingExportResult> {
        const startPerf = performance.now();
        let peakHeapMB = getHeapUsedMB();
        const updatePeakHeap = () => {
            const h = getHeapUsedMB();
            if (h !== null && (peakHeapMB === null || h > peakHeapMB)) peakHeapMB = h;
        };

        const { rawCandleBuffer, symbol, interval, intervalMs } = params;
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
            throw new Error(`Unsupported chart interval for export: ${interval}`);
        }
        if (!(rawCandleBuffer instanceof Float64Array) || rawCandleBuffer.length === 0 || rawCandleBuffer.length % 6 !== 0) {
            throw new Error('Historical fetch returned empty or malformed data buffer (length not divisible by 6).');
        }

        const totalCandles = rawCandleBuffer.length / 6;
        const folderName = `MLR1_${symbol}_${interval}_Dataset`;
        const continuousFileName = `MLR1_${symbol}_${interval}_Continuous_Observations.csv`;
        const representationFileName = `MLR1_${symbol}_${interval}_Representation_Features.csv`;
        const eventFileName = `MLR1_${symbol}_${interval}_Events.csv`;
        const manifestFileName = `MLR1_${symbol}_${interval}_Manifest.json`;

        let destinationType: 'directory_picker' | 'opfs' = 'opfs';
        let targetDirHandle: any;
        let opfsStagingDirName: string | null = null;
        let opfsRoot: any = null;

        if (params.rootDirHandle) {
            destinationType = 'directory_picker';
            targetDirHandle = await params.rootDirHandle.getDirectoryHandle(folderName, { create: true });
        } else if (this.isOpfsSupported()) {
            destinationType = 'opfs';
            opfsRoot = await navigator.storage.getDirectory();
            opfsStagingDirName = `.tmp_${folderName}_${Date.now()}`;
            targetDirHandle = await opfsRoot.getDirectoryHandle(opfsStagingDirName, { create: true });
        } else {
            throw new Error(
                'This browser supports neither File System Access API (showDirectoryPicker) nor OPFS incremental writing. Use Desktop Chrome/Edge or a modern browser for large exports.'
            );
        }

        const createSink = async (fileName: string): Promise<BufferedTextSink> => {
            const fileHandle = await targetDirHandle.getFileHandle(fileName, { create: true });
            if (typeof fileHandle.createWritable !== 'function') {
                throw new Error(`FileSystemWritableFileStream is unavailable for '${fileName}' in this browser.`);
            }
            const writable = await fileHandle.createWritable();
            return new BufferedTextSink({
                write: (bytes: Uint8Array) => writable.write(bytes),
                close: () => writable.close(),
                abort: () => writable.abort()
            }, STREAMING_BATCH_ROWS);
        };

        let continuousSink: BufferedTextSink | null = null;
        let representationSink: BufferedTextSink | null = null;
        let eventSink: BufferedTextSink | null = null;
        const writtenFiles: Array<{ name: string; handle: any }> = [];

        try {
            continuousSink = await createSink(continuousFileName);
            representationSink = await createSink(representationFileName);
            eventSink = await createSink(eventFileName);

            const coreResult = await this.runStreamingCore({
                rawCandleBuffer,
                symbol,
                interval,
                intervalMs,
                buildTimestamp: params.buildTimestamp,
                sourceTimestampBounds: params.sourceTimestampBounds,
                signal: params.signal,
                continuousSink,
                representationSink,
                eventSink,
                onProgress: (pct, detail) => {
                    updatePeakHeap();
                    params.onProgress?.(pct, detail);
                }
            });

            // Write Manifest JSON last, only after all 3 CSV streams finalized & audited
            const encoder = new TextEncoder();
            const manifestBytes = encoder.encode(JSON.stringify(coreResult.manifest, null, 2));
            const manifestHasher = new IncrementalSha256();
            manifestHasher.update(manifestBytes);
            const manifestHandle = await targetDirHandle.getFileHandle(manifestFileName, { create: true });
            const manifestWritable = await manifestHandle.createWritable();
            await manifestWritable.write(manifestBytes);
            await manifestWritable.close();

            const fileChecksums: Record<string, { sha256: string; bytesWritten: number }> = {
                ...coreResult.fileChecksums,
                [manifestFileName]: {
                    sha256: manifestHasher.digestHex(),
                    bytesWritten: manifestBytes.length
                }
            };

            if (destinationType === 'opfs' && opfsRoot) {
                // Write atomic completion marker inside staging dir, then trigger disk-backed file downloads
                const markerHandle = await targetDirHandle.getFileHandle('.complete.json', { create: true });
                const markerW = await markerHandle.createWritable();
                await markerW.write(encoder.encode(JSON.stringify({
                    completedAt: Date.now(),
                    datasetId: coreResult.manifest.datasetId,
                    fileChecksums
                }, null, 2)));
                await markerW.close();

                for (const name of [manifestFileName, continuousFileName, representationFileName, eventFileName]) {
                    const h = await targetDirHandle.getFileHandle(name);
                    writtenFiles.push({ name, handle: h });
                }
                for (const item of writtenFiles) {
                    const diskFile: File = await item.handle.getFile();
                    const url = URL.createObjectURL(diskFile);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = item.name;
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => {
                        if (a.parentNode) document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                    }, 1500);
                    await new Promise(r => setTimeout(r, 250));
                }
                // Clean up OPFS staging directory after browser initiates downloads
                setTimeout(() => {
                    opfsRoot.removeEntry(opfsStagingDirName!, { recursive: true }).catch(() => {});
                }, 10_000);
            }

            updatePeakHeap();
            return {
                destinationType,
                folderName,
                manifest: coreResult.manifest,
                fileChecksums,
                telemetry: {
                    durationMs: Math.round(performance.now() - startPerf),
                    peakHeapMB,
                    postExportHeapMB: getHeapUsedMB(),
                    batchSizeRows: STREAMING_BATCH_ROWS,
                    totalCandles,
                    totalEvents: coreResult.manifest.exportAccounting.tierBConfirmedTeacherEventCount
                }
            };
        } catch (err) {
            if (continuousSink) await continuousSink.abort();
            if (representationSink) await representationSink.abort();
            if (eventSink) await eventSink.abort();
            if (destinationType === 'opfs' && opfsRoot && opfsStagingDirName) {
                await opfsRoot.removeEntry(opfsStagingDirName, { recursive: true }).catch(() => {});
            }
            throw err;
        }
    }

    public static async runStreamingCore(params: {
        rawCandleBuffer: Float64Array;
        symbol: string;
        interval: string;
        intervalMs: number;
        buildTimestamp?: number;
        sourceTimestampBounds?: RawSourceTimestampBounds;
        signal?: AbortSignal;
        continuousSink: BufferedTextSink;
        representationSink: BufferedTextSink;
        eventSink: BufferedTextSink;
        onProgress?: (pct: number, detail: string) => void;
    }): Promise<{
        manifest: DatasetManifest;
        fileChecksums: Record<string, { sha256: string; bytesWritten: number }>;
    }> {
        const { rawCandleBuffer, symbol, interval, intervalMs, continuousSink, representationSink, eventSink } = params;
        const totalCandles = rawCandleBuffer.length / 6;

        const strictPolicy = {
            rejectInvalidSource: true,
            rejectInvalidOhlcv: true,
            rejectDuplicateTimestamp: true,
            rejectOutOfOrder: true,
            requireMinimumUptimeFraction: 1.0
        };
        const featureConfig = validateML1Config({
            ...ML1_CONFIG_B,
            symbol,
            timeframe: interval,
            expectedIntervalMs: intervalMs,
            gapDiscontinuityThresholdMs: Math.max(ML1_CONFIG_B.gapDiscontinuityThresholdMs, intervalMs),
            emaPeriods: [...ML1_CONFIG_B.emaPeriods],
            atrPeriods: [...ML1_CONFIG_B.atrPeriods],
            rollingRangePeriods: [...ML1_CONFIG_B.rollingRangePeriods],
            momentumPeriods: [...ML1_CONFIG_B.momentumPeriods],
            volumeSmaPeriods: [...ML1_CONFIG_B.volumeSmaPeriods]
        });
        const mtfConfig = interval === '1m'
            ? validateMTFConfig({
                ...MTF_CONFIG_B,
                symbol,
                config15m: {
                    ...MTF_CONFIG_B.config15m,
                    featureConfig: validateML1Config({
                        ...ML1_CONFIG_B, symbol, timeframe: '15m', expectedIntervalMs: 900_000,
                        gapDiscontinuityThresholdMs: Math.max(ML1_CONFIG_B.gapDiscontinuityThresholdMs, 900_000)
                    })
                },
                config1h: {
                    ...MTF_CONFIG_B.config1h,
                    featureConfig: validateML1Config({
                        ...ML1_CONFIG_B, symbol, timeframe: '1h', expectedIntervalMs: 3_600_000,
                        gapDiscontinuityThresholdMs: Math.max(ML1_CONFIG_B.gapDiscontinuityThresholdMs, 3_600_000)
                    })
                }
            })
            : null;

        let stats: BackboneStats = createInitialBackboneStats();
        let featureState: ML1FeatureState = createInitialML1FeatureState();
        let integratedState: IntegratedMTFState | null = interval === '1m' ? createInitialIntegratedMTFState() : null;
        let cbcState: StrictCBCState | null = null;
        let gridAnchor: number | null = params.sourceTimestampBounds?.startTimestamp ?? null;
        let prevAcceptedTs = -1;

        const cache15m = new MTFContextSerializerCache();
        const cache1h = new MTFContextSerializerCache();
        let featureKeys: string[] | null = null;
        let headersWritten = false;

        // O(1) Scalar Accumulators for CandleContextAggregator
        let prevPivot: StrictZigZagPivot | null = null;
        let excludedIndexZero = 0;
        let excludedUnwarmedAtr = 0;
        let excludedMissingNextOpen = 0;
        let excludedIncompleteHorizon = 0;
        let ctxNeedsStartOpen = false;
        let ctxStartOpen = 0, ctxMaxH = -Infinity, ctxMinL = Infinity, ctxMatureCount = 0, ctxSumRelVol = 0, ctxCount = 0;

        const STOP_ATR_MULT = 1.5;
        const TARGET_R_MULT = 2.0;
        const MAX_HORIZON_BARS = 60;
        const TRADE_COST_R = 0.05;
        const pendingEvents: PendingOutcomeEvent[] = [];
        const emittedEventIds = new Set<string>(); // only ~10% of bars are events; or check monotonicity
        let emittedEventCount = 0;
        let lastEmittedConfBar = -1;

        for (let i = 0; i < totalCandles; i++) {
            if (params.signal?.aborted) {
                throw new Error('Export cancelled by user.');
            }
            const off = i * 6;
            const candle: ML1Candle = {
                time: rawCandleBuffer[off],
                open: rawCandleBuffer[off + 1],
                high: rawCandleBuffer[off + 2],
                low: rawCandleBuffer[off + 3],
                close: rawCandleBuffer[off + 4],
                volume: rawCandleBuffer[off + 5],
                isSynthetic: false as const
            };

            // 1. Source Integrity Gate (matches accountRawSourceRows + buildSourceBackbone)
            const timestampIsValid = Number.isSafeInteger(candle.time) && candle.time >= 0 && candle.time >= 1e12;
            const isValidOhlcv = validateCandleOhlcv(candle);
            if (!timestampIsValid || !isValidOhlcv) {
                throw new Error(`Source integrity rejected candle at index ${i} (time=${candle.time}).`);
            }
            const anchor = gridAnchor ?? candle.time;
            gridAnchor = anchor;
            const isOnGrid = (candle.time - anchor) % intervalMs === 0;
            const isWithinRange = params.sourceTimestampBounds === undefined ||
                (candle.time >= params.sourceTimestampBounds.startTimestamp && candle.time <= params.sourceTimestampBounds.endTimestamp);
            if (!isOnGrid || !isWithinRange) {
                throw new Error(`Source integrity rejected off-grid or out-of-range candle at index ${i} (time=${candle.time}).`);
            }
            if (prevAcceptedTs !== -1 && candle.time !== prevAcceptedTs + intervalMs) {
                throw new Error(`Source integrity rejected non-contiguous candle at index ${i}: expected ${prevAcceptedTs + intervalMs}, got ${candle.time}.`);
            }
            prevAcceptedTs = candle.time;

            // 2. Step Feature + MTF Engine
            let observation: ML1Observation;
            let mtfContextJson15m = '';
            let mtfContextJson1h = '';
            let diagJson15m = 'null';
            let diagJson1h = 'null';

            if (integratedState && mtfConfig) {
                const res = stepIntegratedMTFPipeline(candle, i, integratedState, { m1Config: featureConfig, mtfConfig });
                integratedState = res.nextState;
                observation = res.observation.observation1m;
                const aligned = alignMTFContext(candle.time + intervalMs, symbol, res.nextState.mtfState, mtfConfig);
                mtfContextJson15m = cache15m.serializeContext(aligned.context15m);
                mtfContextJson1h = cache1h.serializeContext(aligned.context1h);
                diagJson15m = cache15m.serializeDiagnostic(res.nextState.mtfState.state15m.aggregation.lastDiagnostic);
                diagJson1h = cache1h.serializeDiagnostic(res.nextState.mtfState.state1h.aggregation.lastDiagnostic);
            } else {
                const res = stepML1Features(candle, i, featureState, featureConfig);
                featureState = res.nextState;
                observation = res.observation;
            }

            const dataQuality = extractDataQuality(observation);
            const backboneStep = processSourceObservation(
                stats, candle.time, dataQuality, true, strictPolicy, intervalMs,
                { isUniqueSource: true, isCandidateUniqueAccepted: true },
                { gridAnchor: anchor, isOnGrid, isWithinRange }
            );
            stats = backboneStep.nextStats;
            if (!backboneStep.acceptance.isAccepted) {
                throw new Error(`Backbone rejected candle at index ${i}: ${backboneStep.acceptance.rejectionReasons.join(', ')}`);
            }

            const observationId = generateObservationId(symbol, interval, candle.time, MLR1_DATASET_VERSION);

            // 3. Write headers on first row & stream Continuous_Observations.csv row
            if (!headersWritten) {
                featureKeys = Object.keys(observation.features).sort();
                const contHeaderNames = [
                    'observation_id', 'source_timestamp', 'observation_timestamp',
                    'open', 'high', 'low', 'close', 'volume', 'symbol', 'timeframe', 'data_quality',
                    ...featureKeys,
                    ...featureKeys.map(k => `valid_${k}`),
                    ...(mtfConfig === null ? [] : ['context15m', 'context1h', 'htf15mDiagnostic', 'htf1hDiagnostic'])
                ];
                await continuousSink.writeHeader(contHeaderNames.map(csvEscape).join(','));
                await representationSink.writeHeader(MLR1_REPRESENTATION_COLUMNS.map(csvEscape).join(','));
                await eventSink.writeHeader(MLR1_EVENT_COLUMNS.map(csvEscape).join(','));
                headersWritten = true;
            }

            const contRowVals = [
                csvEscape(observationId),
                String(candle.time),
                String(backboneStep.observationTimestamp),
                String(candle.open), String(candle.high), String(candle.low), String(candle.close), String(candle.volume),
                csvEscape(symbol), csvEscape(interval),
                csvEscape(JSON.stringify(dataQuality)),
                ...featureKeys!.map(k => String(observation.features[k])),
                ...featureKeys!.map(k => String(observation.validity[k])),
                ...(mtfConfig === null ? [] : [
                    csvEscape(mtfContextJson15m),
                    csvEscape(mtfContextJson1h),
                    csvEscape(diagJson15m),
                    csvEscape(diagJson1h)
                ])
            ];
            await continuousSink.appendRow(contRowVals.join(','));

            // 4. Update O(1) CandleContextAggregator scalar accumulators
            const relVolVal = observation.features['RelativeVolume_20'];
            const relVolValid = observation.validity['RelativeVolume_20'] === true;
            if (ctxNeedsStartOpen) {
                ctxStartOpen = candle.open;
                ctxMaxH = candle.high;
                ctxMinL = candle.low;
                ctxMatureCount = relVolValid ? 1 : 0;
                ctxSumRelVol = relVolValid ? relVolVal : 0;
                ctxCount = 1;
                ctxNeedsStartOpen = false;
            } else if (prevPivot !== null) {
                if (candle.high > ctxMaxH) ctxMaxH = candle.high;
                if (candle.low < ctxMinL) ctxMinL = candle.low;
                if (relVolValid) {
                    ctxMatureCount++;
                    ctxSumRelVol += relVolVal;
                }
                ctxCount++;
            }

            // 5. Initialize & step pending 60-bar counterfactual events
            for (let p = 0; p < pendingEvents.length; p++) {
                const ev = pendingEvents[p];
                if (ev.entryBar === i) {
                    if (!ev.atrValid) {
                        excludedUnwarmedAtr++;
                        pendingEvents.splice(p, 1);
                        p--;
                        continue;
                    }
                    ev.initialized = true;
                    ev.entryTime = candle.time;
                    ev.entryPrice = candle.open;
                    ev.lStop = ev.entryPrice - (ev.currentAtr * STOP_ATR_MULT);
                    ev.lTarget = ev.entryPrice + (ev.currentAtr * STOP_ATR_MULT * TARGET_R_MULT);
                    ev.lRisk = ev.entryPrice - ev.lStop;
                    ev.sStop = ev.entryPrice + (ev.currentAtr * STOP_ATR_MULT);
                    ev.sTarget = ev.entryPrice - (ev.currentAtr * STOP_ATR_MULT * TARGET_R_MULT);
                    ev.sRisk = ev.sStop - ev.entryPrice;
                }
                if (ev.initialized) {
                    if (!ev.lResolved) {
                        if (candle.open <= ev.lStop) { ev.lExitPrice = candle.open; ev.lBarrier = 'hard_stop'; ev.lOutcomeType = 'barrier'; ev.lResolved = true; }
                        else if (candle.open >= ev.lTarget) { ev.lExitPrice = candle.open; ev.lBarrier = 'full_target'; ev.lOutcomeType = 'barrier'; ev.lResolved = true; }
                        else {
                            const hitSL = candle.low <= ev.lStop;
                            const hitTP = candle.high >= ev.lTarget;
                            if (hitSL) { ev.lExitPrice = ev.lStop; ev.lBarrier = 'hard_stop'; ev.lOutcomeType = 'barrier'; ev.lResolved = true; }
                            else if (hitTP) { ev.lExitPrice = ev.lTarget; ev.lBarrier = 'full_target'; ev.lOutcomeType = 'barrier'; ev.lResolved = true; }
                        }
                        if (!ev.lResolved && i === ev.horizonEnd) {
                            ev.lExitPrice = candle.close;
                            ev.lOutcomeType = 'timeout';
                            ev.lResolved = true;
                        }
                    }
                    if (!ev.sResolved) {
                        if (candle.open >= ev.sStop) { ev.sExitPrice = candle.open; ev.sBarrier = 'hard_stop'; ev.sOutcomeType = 'barrier'; ev.sResolved = true; }
                        else if (candle.open <= ev.sTarget) { ev.sExitPrice = candle.open; ev.sBarrier = 'full_target'; ev.sOutcomeType = 'barrier'; ev.sResolved = true; }
                        else {
                            const hitSL = candle.high >= ev.sStop;
                            const hitTP = candle.low <= ev.sTarget;
                            if (hitSL) { ev.sExitPrice = ev.sStop; ev.sBarrier = 'hard_stop'; ev.sOutcomeType = 'barrier'; ev.sResolved = true; }
                            else if (hitTP) { ev.sExitPrice = ev.sTarget; ev.sBarrier = 'full_target'; ev.sOutcomeType = 'barrier'; ev.sResolved = true; }
                        }
                        if (!ev.sResolved && i === ev.horizonEnd) {
                            ev.sExitPrice = candle.close;
                            ev.sOutcomeType = 'timeout';
                            ev.sResolved = true;
                        }
                    }
                }
            }

            // Flush resolved events in strict confirmation order when horizonEnd == i
            while (pendingEvents.length > 0 && pendingEvents[0].horizonEnd === i) {
                const done = pendingEvents.shift()!;
                const tf = done.tokenFeatures!;
                const lNetR = Math.min(TARGET_R_MULT, (done.lExitPrice - done.entryPrice) / done.lRisk) - TRADE_COST_R;
                const sNetR = Math.min(TARGET_R_MULT, (done.entryPrice - done.sExitPrice) / done.sRisk) - TRADE_COST_R;
                const long_outcome: MLR1EventRow['long_outcome'] = done.lOutcomeType === 'barrier' ? done.lBarrier : (lNetR > 0 ? 'timeout_net_gain' : 'timeout_net_loss');
                const short_outcome: MLR1EventRow['short_outcome'] = done.sOutcomeType === 'barrier' ? done.sBarrier : (sNetR > 0 ? 'timeout_net_gain' : 'timeout_net_loss');

                const confTs = done.pivot.confirmedBarIndex === i
                    ? candle.time
                    : rawCandleBuffer[done.pivot.confirmedBarIndex * 6];
                const prevConfTs = rawCandleBuffer[done.prevPivot.confirmedBarIndex * 6];
                const eventId = `MLR1_${symbol}_${interval}_${MLR1_EVENT_ID_VERSION}_${confTs}_${done.pivot.time}_${done.pivot.type}`;

                if (done.pivot.confirmedBarIndex <= lastEmittedConfBar || emittedEventIds.has(eventId)) {
                    throw new Error(`Streaming audit failure: non-monotonic or duplicate event ${eventId}`);
                }
                lastEmittedConfBar = done.pivot.confirmedBarIndex;
                emittedEventIds.add(eventId);

                const rowObj: MLR1EventRow = {
                    event_id: eventId,
                    symbol, timeframe: interval,
                    pivot_type: done.pivot.type,
                    pivot_label: done.pivot.label,
                    pivot_price: done.pivot.price,
                    previous_pivot_price: done.prevPivot.price,
                    previous_pivot_bar_index: done.prevPivot.barIndex,
                    previous_pivot_confirmed_bar_index: done.prevPivot.confirmedBarIndex,
                    previous_pivot_confirmation_time_ms: prevConfTs,
                    previous_pivot_type: done.prevPivot.type,
                    pivot_bar_index: done.pivot.barIndex,
                    pivot_time_ms: done.pivot.time,
                    confirmed_bar_index: done.pivot.confirmedBarIndex,
                    confirmation_time_ms: confTs,
                    completed_leg_direction: tf.completed_leg_direction,
                    zigzag_next_leg_orientation: tf.zigzag_next_leg_orientation,
                    bars_since_last_pivot: tf.bars_since_last_pivot,
                    leg_distance_atr: tf.leg_distance_atr,
                    context_net_return_atr: tf.context_net_return_atr,
                    context_max_favorable_atr: tf.context_max_favorable_atr,
                    context_max_adverse_atr: tf.context_max_adverse_atr,
                    context_candle_count: tf.context_candle_count,
                    context_relative_volume: tf.context_relative_volume,
                    context_relative_volume_valid_fraction: tf.context_relative_volume_valid_fraction,
                    entry_bar_index: done.entryBar,
                    entry_time: done.entryTime,
                    entry_price: done.entryPrice,
                    atr_at_confirmation: done.currentAtr,
                    long_stop_price: done.lStop, long_target_price: done.lTarget, long_exit_price: done.lExitPrice, long_net_r: lNetR, long_outcome,
                    short_stop_price: done.sStop, short_target_price: done.sTarget, short_exit_price: done.sExitPrice, short_net_r: sNetR, short_outcome
                };

                const confObsId = generateObservationId(symbol, interval, confTs, MLR1_DATASET_VERSION);
                const repInput = buildRepresentationInput(rowObj, confObsId);
                const repVals = [
                    repInput.tierAObservationId,
                    ...TIER_A_MODEL_INPUT_ALLOWLIST.map(k => repInput.tierA[k]),
                    ...TIER_B_MODEL_INPUT_ALLOWLIST.map(k => repInput.tierB[k])
                ];
                await representationSink.appendRow(repVals.map(csvEscape).join(','));
                await eventSink.appendRow(MLR1_EVENT_COLUMNS.map(k => csvEscape(rowObj[k])).join(','));
                emittedEventCount++;
            }

            // 6. Step Causal StrictCBC Teacher
            if (i === 0) cbcState = createInitialStrictCBCState(candle);
            const cbcRes = stepStrictCBC(candle, i, cbcState!);
            cbcState = cbcRes.nextState;

            if (cbcRes.confirmedPivot) {
                const confirmed = cbcRes.confirmedPivot;
                if (prevPivot === null) {
                    prevPivot = confirmed;
                    excludedIndexZero = 1;
                    ctxNeedsStartOpen = true;
                } else {
                    const currentAtr = observation.features['ATR_14'];
                    const isAtrValid = observation.validity['ATR_14'] === true && Number.isFinite(currentAtr) && currentAtr > 0;
                    const tokenFeatures = isAtrValid
                        ? buildTokenFromScalarContext(
                            confirmed, prevPivot,
                            ctxStartOpen, candle.close, ctxMaxH, ctxMinL,
                            ctxCount, ctxMatureCount, ctxSumRelVol, currentAtr
                        )
                        : null;

                    pendingEvents.push({
                        pivot: confirmed,
                        prevPivot,
                        confBar: i,
                        entryBar: i + 1,
                        horizonEnd: i + MAX_HORIZON_BARS,
                        currentAtr,
                        atrValid: isAtrValid,
                        tokenFeatures,
                        initialized: false,
                        entryTime: 0, entryPrice: 0,
                        lStop: 0, lTarget: 0, lRisk: 0,
                        sStop: 0, sTarget: 0, sRisk: 0,
                        lResolved: false, lExitPrice: 0, lOutcomeType: 'timeout', lBarrier: 'hard_stop',
                        sResolved: false, sExitPrice: 0, sOutcomeType: 'timeout', sBarrier: 'hard_stop'
                    });
                    prevPivot = confirmed;
                    ctxNeedsStartOpen = true;
                }
            }

            if (i % STREAMING_BATCH_ROWS === 0 || i === totalCandles - 1) {
                const pct = Math.round(((i + 1) / totalCandles) * 100);
                params.onProgress?.(pct, `Streaming ${i + 1} / ${totalCandles} candles (${emittedEventCount} events)...`);
                await new Promise(r => setTimeout(r, 0)); // Yield to keep UI responsive
            }
        }

        // Account for end-of-dataset censored events (exact M4 precedence)
        for (const leftover of pendingEvents) {
            if (leftover.entryBar >= totalCandles) excludedMissingNextOpen++;
            else if (!leftover.atrValid) excludedUnwarmedAtr++;
            else excludedIncompleteHorizon++;
        }
        pendingEvents.length = 0;

        const dateRange = {
            startTimestamp: rawCandleBuffer[0],
            endTimestamp: rawCandleBuffer[(totalCandles - 1) * 6]
        };
        const uptime = evaluateDatasetUptime(stats, strictPolicy, intervalMs, dateRange);
        if (!uptime.isUptimeValid) {
            throw new Error(`Streaming export uptime failed: ${uptime.usableObservationFraction}`);
        }
        if (emittedEventCount === 0) {
            throw new Error('No valid confirmed structural events with complete horizons were detected.');
        }

        const totalPivots = excludedIndexZero + excludedUnwarmedAtr + excludedMissingNextOpen + excludedIncompleteHorizon + emittedEventCount;
        const contStats = await continuousSink.finalize();
        const repStats = await representationSink.finalize();
        const evStats = await eventSink.finalize();

        const continuousFileName = `MLR1_${symbol}_${interval}_Continuous_Observations.csv`;
        const representationFileName = `MLR1_${symbol}_${interval}_Representation_Features.csv`;
        const eventFileName = `MLR1_${symbol}_${interval}_Events.csv`;

        const actualFileRowCounts = {
            [continuousFileName]: contStats.rowCount,
            [representationFileName]: repStats.rowCount,
            [eventFileName]: evStats.rowCount
        };
        const exportAccounting: ExportAccounting = {
            rawSourceCandleCount: totalCandles,
            acceptedSourceObservationCount: stats.acceptedObservationCount,
            rejectedSourceObservationCount: stats.rejectedObservationCount,
            tierAContinuousObservationCount: stats.acceptedObservationCount,
            tierAEventRepresentationRowCount: repStats.rowCount,
            tierBConfirmedTeacherEventCount: evStats.rowCount,
            tierCOutcomeRowCount: evStats.rowCount,
            actualFileRowCounts
        };

        const rawManifest = createDatasetManifest(
            `DS_${symbol}_${interval}_V${MLR1_DATASET_VERSION}`,
            'BINANCE_SPOT',
            {
                symbol,
                baseTimeframe: interval,
                datasetVersion: MLR1_DATASET_VERSION,
                representationSchemaVersion: MLR1_REPRESENTATION_SCHEMA_VERSION,
                modelInputSchemaVersion: MLR1_MODEL_INPUT_SCHEMA_VERSION,
                sourceIntervalMs: intervalMs,
                featureConfigVersion: interval === '1m' ? `${ML1_CONFIG_B_VERSION}+${MLR1_MTF_CONTEXT_VERSION}` : ML1_CONFIG_B_VERSION,
                teacherVersion: STRICT_CBC_ZIGZAG_TEACHER_VERSION,
                outcomeConfigVersion: MLR1_OUTCOME_CONFIG_VERSION,
                dateRange,
                integrityPolicy: strictPolicy,
                exportConfig: { exportTierA: true, exportTierB: true, exportTierC: true, separateFiles: false }
            },
            stats,
            uptime,
            {
                passed: true,
                chronologyValid: true,
                identityUnique: true,
                inputOutcomeSeparationValid: true,
                remarks: [
                    `Streamed 4-file M4 dataset (${totalPivots} teacher pivots accounted, ${emittedEventCount} eligible events).`,
                    `SHA-256 ${continuousFileName}: ${contStats.sha256}`,
                    `SHA-256 ${representationFileName}: ${repStats.sha256}`,
                    `SHA-256 ${eventFileName}: ${evStats.sha256}`
                ]
            },
            exportAccounting
        );

        const manifest: DatasetManifest = params.buildTimestamp === undefined
            ? rawManifest
            : { ...rawManifest, buildTimestamp: params.buildTimestamp };

        return {
            manifest,
            fileChecksums: {
                [continuousFileName]: { sha256: contStats.sha256, bytesWritten: contStats.bytesWritten },
                [representationFileName]: { sha256: repStats.sha256, bytesWritten: repStats.bytesWritten },
                [eventFileName]: { sha256: evStats.sha256, bytesWritten: evStats.bytesWritten }
            }
        };
    }

    private static readonly activeV3DirReservations = new WeakMap<object, Set<string>>();

    private static acquireV3FolderReservation(rootDirHandle: object, folderName: string): void {
        let active = this.activeV3DirReservations.get(rootDirHandle);
        if (!active) {
            active = new Set<string>();
            this.activeV3DirReservations.set(rootDirHandle, active);
        }
        if (active.has(folderName)) {
            throw new Error(`V3 Export Error: concurrent export already active for '${folderName}'.`);
        }
        active.add(folderName);
    }

    private static releaseV3FolderReservation(rootDirHandle: object, folderName: string): void {
        this.activeV3DirReservations.get(rootDirHandle)?.delete(folderName);
    }

    public static async exportV3ToFolderOrOpfs(params: {
        rawCandleBuffer: Float64Array;
        symbol: string;
        interval: string;
        intervalMs: number;
        include15mMtf?: boolean;
        rootDirHandle?: any;
        buildTimestamp?: number;
        requireContiguous?: boolean;
        sourceTimestampBounds?: RawSourceTimestampBounds;
        signal?: AbortSignal;
        onProgress?: (pct: number, detail: string) => void;
    }): Promise<StreamingExportResult> {
        const startPerf = performance.now();
        let peakHeapMB = getHeapUsedMB();
        const updatePeakHeap = () => {
            const h = getHeapUsedMB();
            if (h !== null && (peakHeapMB === null || h > peakHeapMB)) peakHeapMB = h;
        };

        const { rawCandleBuffer, symbol, interval, intervalMs } = params;
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
            throw new Error(`Unsupported chart interval for V3 export: ${interval}`);
        }
        if (!(rawCandleBuffer instanceof Float64Array) || rawCandleBuffer.length === 0 || rawCandleBuffer.length % 6 !== 0) {
            throw new Error('Historical fetch returned empty or malformed data buffer (length not divisible by 6).');
        }

        const totalCandles = rawCandleBuffer.length / 6;
        const folderName = `MLR1_${symbol}_${interval}_V${V3_DATASET_VERSION}_Dataset`;
        const fileNames = getV3FileNames(symbol, interval);

        let destinationType: 'directory_picker' | 'opfs' = 'opfs';
        let targetDirHandle: any;
        let opfsStagingDirName: string | null = null;
        let opfsRoot: any = null;
        const stagingDirName = `.tmp_${folderName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        let hasReservation = false;
        if (params.rootDirHandle) {
            destinationType = 'directory_picker';
            this.acquireV3FolderReservation(params.rootDirHandle, folderName);
            hasReservation = true;
        }

        const assertDirAbsent = async (parent: any, name: string) => {
            try {
                await parent.getDirectoryHandle(name, { create: false });
                throw new Error(`V3 Export Error: destination directory '${name}' already exists; refusing to overwrite.`);
            } catch (e: any) {
                if (e?.name !== 'NotFoundError') throw e;
            }
        };

        let finalDirHandle: any = null;
        const publishedDestinationFiles: string[] = [];

        const createSink = async (fileName: string): Promise<BufferedTextSink> => {
            const fileHandle = await targetDirHandle.getFileHandle(fileName, { create: true });
            const writable = await fileHandle.createWritable();
            return new BufferedTextSink({
                write: (bytes: Uint8Array) => writable.write(bytes),
                close: () => writable.close(),
                abort: () => writable.abort()
            }, STREAMING_BATCH_ROWS);
        };

        let continuousSink: BufferedTextSink | null = null;
        let representationSink: BufferedTextSink | null = null;
        let strategyEventSink: BufferedTextSink | null = null;

        try {
            if (params.rootDirHandle) {
                await assertDirAbsent(params.rootDirHandle, folderName);
                targetDirHandle = await params.rootDirHandle.getDirectoryHandle(stagingDirName, { create: true });
            } else if (this.isOpfsSupported()) {
                destinationType = 'opfs';
                opfsRoot = await navigator.storage.getDirectory();
                opfsStagingDirName = stagingDirName;
                targetDirHandle = await opfsRoot.getDirectoryHandle(opfsStagingDirName, { create: true });
            } else {
                throw new Error('Neither File System Access API nor OPFS incremental writing is supported in this browser.');
            }
            if (params.signal?.aborted) {
                throw new Error('V3 Export cancelled by user.');
            }
            continuousSink = await createSink(fileNames.continuousFileName);
            representationSink = await createSink(fileNames.representationFileName);
            strategyEventSink = await createSink(fileNames.strategyEventsFileName);

            const coreResult = await this.runV3StreamingCore({
                rawCandleBuffer,
                symbol,
                interval,
                intervalMs,
                include15mMtf: params.include15mMtf,
                buildTimestamp: params.buildTimestamp,
                requireContiguous: params.requireContiguous,
                sourceTimestampBounds: params.sourceTimestampBounds,
                signal: params.signal,
                continuousSink,
                representationSink,
                strategyEventSink,
                onProgress: (pct, detail) => {
                    updatePeakHeap();
                    params.onProgress?.(pct, detail);
                }
            });

            if (params.signal?.aborted) {
                throw new Error('V3 Export cancelled by user before publishing manifest.');
            }

            const encoder = new TextEncoder();
            const manifestBytes = encoder.encode(JSON.stringify(coreResult.manifest, null, 2));
            const manifestHasher = new IncrementalSha256();
            manifestHasher.update(manifestBytes);
            const manifestHandle = await targetDirHandle.getFileHandle(fileNames.manifestFileName, { create: true });
            const manifestWritable = await manifestHandle.createWritable();
            try {
                await manifestWritable.write(manifestBytes);
                if (params.signal?.aborted) {
                    throw new Error('V3 Export cancelled by user during manifest write.');
                }
                await manifestWritable.close();
            } catch (manifestErr) {
                await manifestWritable.abort().catch(() => {});
                throw manifestErr;
            }

            if (params.signal?.aborted) {
                throw new Error('V3 Export cancelled by user before publication.');
            }

            if (destinationType === 'directory_picker') {
                await assertDirAbsent(params.rootDirHandle, folderName);
                finalDirHandle = await params.rootDirHandle.getDirectoryHandle(folderName, { create: true });

                for (const name of [
                    fileNames.continuousFileName,
                    fileNames.representationFileName,
                    fileNames.strategyEventsFileName,
                    fileNames.manifestFileName
                ]) {
                    if (params.signal?.aborted) {
                        throw new Error('V3 Export cancelled during directory publication.');
                    }
                    try {
                        await finalDirHandle.getFileHandle(name, { create: false });
                        throw new Error(`V3 Export Error: destination file '${name}' already exists; refusing overwrite.`);
                    } catch (fe: any) {
                        if (fe?.name !== 'NotFoundError') throw fe;
                    }

                    const srcHandle = await targetDirHandle.getFileHandle(name);
                    const srcFile: File = await srcHandle.getFile();
                    const dstHandle = await finalDirHandle.getFileHandle(name, { create: true });
                    publishedDestinationFiles.push(name);
                    const dstWritable = await dstHandle.createWritable();
                    try {
                        await dstWritable.write(await srcFile.arrayBuffer());
                        if (params.signal?.aborted) {
                            throw new Error('V3 Export cancelled during directory file write.');
                        }
                        await dstWritable.close();
                    } catch (pubErr) {
                        await dstWritable.abort().catch(() => {});
                        throw pubErr;
                    }
                }
                if (typeof params.rootDirHandle.removeEntry === 'function') {
                    await params.rootDirHandle.removeEntry(stagingDirName, { recursive: true }).catch(() => {});
                }
            }

            const fileChecksums: Record<string, { sha256: string; bytesWritten: number }> = {
                ...coreResult.fileChecksums,
                [fileNames.manifestFileName]: {
                    sha256: manifestHasher.digestHex(),
                    bytesWritten: manifestBytes.length
                }
            };

            if (destinationType === 'opfs' && opfsRoot) {
                for (const name of [
                    fileNames.manifestFileName,
                    fileNames.continuousFileName,
                    fileNames.representationFileName,
                    fileNames.strategyEventsFileName
                ]) {
                    const h = await targetDirHandle.getFileHandle(name);
                    const diskFile: File = await h.getFile();
                    const url = URL.createObjectURL(diskFile);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = name;
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => {
                        if (a.parentNode) document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                    }, 1500);
                    await new Promise(r => setTimeout(r, 250));
                }
                setTimeout(() => {
                    opfsRoot.removeEntry(opfsStagingDirName!, { recursive: true }).catch(() => {});
                }, 10_000);
            }

            updatePeakHeap();
            return {
                destinationType,
                folderName,
                manifest: coreResult.manifest,
                fileChecksums,
                telemetry: {
                    durationMs: Math.round(performance.now() - startPerf),
                    peakHeapMB,
                    postExportHeapMB: getHeapUsedMB(),
                    batchSizeRows: STREAMING_BATCH_ROWS,
                    totalCandles,
                    totalEvents: coreResult.manifest.exportAccounting.tierBConfirmedTeacherEventCount
                }
            };
        } catch (err) {
            await Promise.allSettled([
                continuousSink ? continuousSink.abort() : Promise.resolve(),
                representationSink ? representationSink.abort() : Promise.resolve(),
                strategyEventSink ? strategyEventSink.abort() : Promise.resolve()
            ]);
            if (destinationType === 'directory_picker') {
                // Only remove individual files written by THIS execution; never delete an unowned directory recursively
                if (finalDirHandle && typeof finalDirHandle.removeEntry === 'function') {
                    for (const fName of publishedDestinationFiles) {
                        await finalDirHandle.removeEntry(fName).catch(() => {});
                    }
                }
                if (params.rootDirHandle && typeof params.rootDirHandle.removeEntry === 'function') {
                    await params.rootDirHandle.removeEntry(stagingDirName, { recursive: true }).catch(() => {});
                }
            }
            if (destinationType === 'opfs' && opfsRoot && opfsStagingDirName) {
                await opfsRoot.removeEntry(opfsStagingDirName, { recursive: true }).catch(() => {});
            }
            throw err;
        } finally {
            if (hasReservation && params.rootDirHandle) {
                this.releaseV3FolderReservation(params.rootDirHandle, folderName);
            }
        }
    }

    public static async runV3StreamingCore(params: {
        rawCandleBuffer: Float64Array;
        symbol: string;
        interval: string;
        intervalMs: number;
        include15mMtf?: boolean;
        buildTimestamp?: number;
        requireContiguous?: boolean;
        sourceTimestampBounds?: RawSourceTimestampBounds;
        signal?: AbortSignal;
        continuousSink: BufferedTextSink;
        representationSink: BufferedTextSink;
        strategyEventSink: BufferedTextSink;
        onProgress?: (pct: number, detail: string) => void;
    }): Promise<{
        manifest: DatasetManifest;
        fileChecksums: Record<string, { sha256: string; bytesWritten: number }>;
    }> {
        const { rawCandleBuffer, symbol, interval, intervalMs, continuousSink, representationSink, strategyEventSink } = params;
        const totalCandles = rawCandleBuffer.length / 6;

        const config = createV3PipelineConfig({
            symbol,
            interval,
            intervalMs,
            include15mMtf: params.include15mMtf,
            requireContiguous: params.requireContiguous ?? true,
            sourceTimestampBounds: params.sourceTimestampBounds
        });
        const runner = new V3PipelineRunner(config);
        const include15mMtf = config.mtf15mConfig !== null;
        const auditor = new V3ArtifactAuditor({
            intervalMs,
            include15mMtf,
            is1mBase: interval === '1m'
        });
        const mtfCache = new MTF15mSerializerCache();
        let featureKeys: string[] | null = null;
        let headersWritten = false;
        let emittedEvents = 0;
        let expectedAcceptedIdx = 0;

        let contStats: { rowCount: number; bytesWritten: number; sha256: string };
        let repStats: { rowCount: number; bytesWritten: number; sha256: string };
        let evStats: { rowCount: number; bytesWritten: number; sha256: string };
        let fin: ReturnType<V3PipelineRunner['finalize']>;

        try {
            for (let i = 0; i < totalCandles; i++) {
                if (params.signal?.aborted) {
                    throw new Error('V3 Export cancelled by user.');
                }
                const off = i * 6;
                const stepOut = runner.stepCandle({
                    time: rawCandleBuffer[off],
                    open: rawCandleBuffer[off + 1],
                    high: rawCandleBuffer[off + 2],
                    low: rawCandleBuffer[off + 3],
                    close: rawCandleBuffer[off + 4],
                    volume: rawCandleBuffer[off + 5],
                    isSynthetic: false as const
                });
                if (!stepOut.dataQuality.isSourceValid ||
                    stepOut.acceptedBarIndex !== expectedAcceptedIdx ||
                    stepOut.sourceTimestamp !== stepOut.candle.time) {
                    throw new Error(
                        `V3 Streaming Chronology Error: unexpected runner acceptance state at index ${expectedAcceptedIdx} (got ${stepOut.acceptedBarIndex}).`
                    );
                }
                expectedAcceptedIdx++;
                auditor.pushRawCandle(stepOut.acceptedBarIndex, {
                    time: stepOut.sourceTimestamp,
                    open: stepOut.candle.open,
                    high: stepOut.candle.high,
                    low: stepOut.candle.low,
                    close: stepOut.candle.close,
                    volume: stepOut.candle.volume
                });

                if (!headersWritten) {
                    featureKeys = Object.keys(stepOut.observation.features).sort();
                    const contHdr = buildV3ContinuousHeader(featureKeys, include15mMtf);
                    const repHdr = buildV3RepresentationHeader();
                    const evHdr = buildV3StrategyEventHeader();
                    auditor.validateContinuousHeader(parseSingleCsvRecord(contHdr));
                    auditor.validateRepresentationHeader(parseSingleCsvRecord(repHdr));
                    auditor.validateStrategyEventsHeader(parseSingleCsvRecord(evHdr));
                    await continuousSink.writeHeader(contHdr);
                    await representationSink.writeHeader(repHdr);
                    await strategyEventSink.writeHeader(evHdr);
                    headersWritten = true;
                }

                const contLine = formatV3ContinuousRow(stepOut, featureKeys!, mtfCache, include15mMtf);
                auditor.validateContinuousLine(contLine);
                await continuousSink.appendRow(contLine);

                for (const row of stepOut.completedOutcomeRows) {
                    const evLine = formatV3StrategyEventRow(row);
                    const repLine = formatV3RepresentationRow(row).csvLine;
                    auditor.validateSerializedEventPairLines(repLine, evLine);
                    await strategyEventSink.appendRow(evLine);
                    await representationSink.appendRow(repLine);
                    emittedEvents++;
                }

                if (i % STREAMING_BATCH_ROWS === 0 || i === totalCandles - 1) {
                    const pct = Math.round(((i + 1) / totalCandles) * 100);
                    params.onProgress?.(pct, `Streaming V3 ${i + 1} / ${totalCandles} candles (${emittedEvents} events)...`);
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            if (params.signal?.aborted) {
                throw new Error('V3 Export cancelled by user before finalization.');
            }

            fin = runner.finalize();
            if (emittedEvents === 0) {
                throw new Error('V3 Streaming Export Error: no eligible confirmed events with complete 180-bar horizons.');
            }

            const auditResult = auditor.finalizeAudit(totalCandles, emittedEvents);
            if (!auditResult.passed) {
                throw new Error(`V3 Streaming Audit Failed: ${auditResult.remarks.join('; ')}`);
            }

            if (params.signal?.aborted) {
                throw new Error('V3 Export cancelled by user before sink finalization.');
            }

            contStats = await continuousSink.finalize();
            if (params.signal?.aborted) throw new Error('V3 Export cancelled during finalization.');
            repStats = await representationSink.finalize();
            if (params.signal?.aborted) throw new Error('V3 Export cancelled during finalization.');
            evStats = await strategyEventSink.finalize();

            const fileNames = getV3FileNames(symbol, interval);
            const manifest = buildV3DatasetManifest({
                runner,
                config,
                totalRawCandles: totalCandles,
                startTimestamp: rawCandleBuffer[0],
                endTimestamp: rawCandleBuffer[(totalCandles - 1) * 6],
                outcomeAccounting: fin.outcomeAccounting,
                continuousRowCount: contStats.rowCount,
                representationRowCount: repStats.rowCount,
                strategyEventRowCount: evStats.rowCount,
                auditResults: auditResult,
                fileChecksums: {
                    continuousSha256: contStats.sha256,
                    representationSha256: repStats.sha256,
                    strategyEventsSha256: evStats.sha256
                },
                buildTimestamp: params.buildTimestamp
            });

            return {
                manifest,
                fileChecksums: {
                    [fileNames.continuousFileName]: { sha256: contStats.sha256, bytesWritten: contStats.bytesWritten },
                    [fileNames.representationFileName]: { sha256: repStats.sha256, bytesWritten: repStats.bytesWritten },
                    [fileNames.strategyEventsFileName]: { sha256: evStats.sha256, bytesWritten: evStats.bytesWritten }
                }
            };
        } catch (coreErr) {
            await Promise.allSettled([
                continuousSink.abort(),
                representationSink.abort(),
                strategyEventSink.abort()
            ]);
            throw coreErr;
        }
    }
}

// =========================================================================
// Phase 0 (Baseline + Parity Oracle) & Phase 3 (Streaming Parity Test)
// =========================================================================
function makeDeterministicTestCandles(count: number): Float64Array {
    const intervalMs = 60_000;
    const start = 1_700_000_040_000;
    const buf = new Float64Array(count * 6);
    for (let i = 0; i < count; i++) {
        const close = i % 8 < 4 ? 100 + (i % 4) : 104 - (i % 4);
        const open = i % 2 === 1 ? close - 0.5 : close + 0.5;
        buf.set([start + i * intervalMs, open, Math.max(open, close) + 1, Math.min(open, close) - 1, close, 100 + (i % 7)], i * 6);
    }
    return buf;
}

class MemoryCaptureStream {
    private readonly chunks: Uint8Array[] = [];
    public write = async (data: Uint8Array) => { this.chunks.push(data.slice()); };
    public close = async () => {};
    public abort = async () => { this.chunks.length = 0; };
    public toStringUtf8(): string {
        const total = this.chunks.reduce((s, c) => s + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of this.chunks) { merged.set(c, off); off += c.length; }
        return new TextDecoder().decode(merged);
    }
}

async function sha256Utf8(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const hasher = new IncrementalSha256();
    hasher.update(bytes);
    const incHex = hasher.digestHex();
    if (typeof crypto !== 'undefined' && crypto.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', bytes);
        const nativeHex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        if (nativeHex !== incHex) throw new Error(`IncrementalSha256 mismatch vs WebCrypto: ${incHex} != ${nativeHex}`);
    }
    return incHex;
}

export async function runPhase0ExportBaseline(candleCount = 1440) {
    const t0 = performance.now();
    const heapBefore = getHeapUsedMB();
    const rawCandleBuffer = makeDeterministicTestCandles(candleCount);
    const fixedTs = 1_700_000_000_000;

    const artifacts = await AIExporter.buildExportArtifacts({
        rawCandleBuffer,
        symbol: 'SOLUSDT',
        interval: '1m',
        intervalMs: 60_000,
        buildTimestamp: fixedTs
    });
    const tBuild = performance.now();
    const zipBytes = await AIExporter.createVerifiedDatasetArchive(artifacts, createML1ZipExportRequest(artifacts.manifest));
    const tEnd = performance.now();

    const oracle = {
        candleCount,
        heapBeforeMB: heapBefore,
        heapAfterMB: getHeapUsedMB(),
        buildMs: Math.round(tBuild - t0),
        zipVerifyMs: Math.round(tEnd - tBuild),
        totalMs: Math.round(tEnd - t0),
        zipSizeBytes: zipBytes.length,
        continuousSha256: await sha256Utf8(artifacts.continuousCsv),
        representationSha256: await sha256Utf8(artifacts.representationCsv),
        eventSha256: await sha256Utf8(artifacts.eventCsv),
        rowCounts: artifacts.manifest.exportAccounting.actualFileRowCounts
    };
    console.log('📊 Phase 0 Baseline & Parity Oracle:', oracle);
    return oracle;
}

export async function runStreamingExportParityTest(candleCount = 1440): Promise<boolean> {
    const rawCandleBuffer = makeDeterministicTestCandles(candleCount);
    const fixedTs = 1_700_000_000_000;

    const legacy = await AIExporter.buildExportArtifacts({
        rawCandleBuffer,
        symbol: 'SOLUSDT',
        interval: '1m',
        intervalMs: 60_000,
        buildTimestamp: fixedTs
    });

    const memCont = new MemoryCaptureStream();
    const memRep = new MemoryCaptureStream();
    const memEv = new MemoryCaptureStream();

    const streamed = await StreamingDatasetExporter.runStreamingCore({
        rawCandleBuffer,
        symbol: 'SOLUSDT',
        interval: '1m',
        intervalMs: 60_000,
        buildTimestamp: fixedTs,
        continuousSink: new BufferedTextSink(memCont, 128),
        representationSink: new BufferedTextSink(memRep, 128),
        eventSink: new BufferedTextSink(memEv, 128)
    });

    const sCont = memCont.toStringUtf8();
    const sRep = memRep.toStringUtf8();
    const sEv = memEv.toStringUtf8();

    if (sCont !== legacy.continuousCsv) throw new Error('Parity FAIL: Continuous_Observations.csv differs from legacy M4 output.');
    if (sRep !== legacy.representationCsv) throw new Error('Parity FAIL: Representation_Features.csv differs from legacy M4 output.');
    if (sEv !== legacy.eventCsv) throw new Error('Parity FAIL: Events.csv differs from legacy M4 output.');

    const legacyContHash = await sha256Utf8(legacy.continuousCsv);
    const legacyRepHash = await sha256Utf8(legacy.representationCsv);
    const legacyEvHash = await sha256Utf8(legacy.eventCsv);

    if (streamed.fileChecksums[legacy.continuousFileName].sha256 !== legacyContHash) throw new Error('Continuous SHA-256 mismatch.');
    if (streamed.fileChecksums[legacy.representationFileName].sha256 !== legacyRepHash) throw new Error('Representation SHA-256 mismatch.');
    if (streamed.fileChecksums[legacy.eventFileName].sha256 !== legacyEvHash) throw new Error('Events SHA-256 mismatch.');

    if (JSON.stringify(streamed.manifest.exportAccounting) !== JSON.stringify(legacy.manifest.exportAccounting)) {
        throw new Error('Parity FAIL: manifest exportAccounting mismatch.');
    }
    if (JSON.stringify(streamed.manifest.missingDataStats) !== JSON.stringify(legacy.manifest.missingDataStats)) {
        throw new Error('Parity FAIL: manifest missingDataStats mismatch.');
    }

    console.log(`✅ Streaming M4 Parity PASSED (${candleCount} candles): 100% byte-for-byte CSV + SHA-256 + manifest parity!`);
    return true;
}

export async function runV3StreamingExportParityTest(candleCount = 650): Promise<boolean> {
    const rawCandleBuffer = makeDeterministicTestCandles(candleCount);
    const fixedTs = 1_700_000_000_000;

    const batch = await AIExporter.buildV3ExportArtifacts({
        rawCandleBuffer,
        symbol: 'SOLUSDT',
        interval: '1m',
        intervalMs: 60_000,
        buildTimestamp: fixedTs
    });

    const memCont = new MemoryCaptureStream();
    const memRep = new MemoryCaptureStream();
    const memEv = new MemoryCaptureStream();

    const streamed = await StreamingDatasetExporter.runV3StreamingCore({
        rawCandleBuffer,
        symbol: 'SOLUSDT',
        interval: '1m',
        intervalMs: 60_000,
        buildTimestamp: fixedTs,
        continuousSink: new BufferedTextSink(memCont, 128),
        representationSink: new BufferedTextSink(memRep, 128),
        strategyEventSink: new BufferedTextSink(memEv, 128)
    });

    const sCont = memCont.toStringUtf8();
    const sRep = memRep.toStringUtf8();
    const sEv = memEv.toStringUtf8();

    if (sCont !== batch.continuousCsv) throw new Error('V3 Parity FAIL: Continuous_Observations.csv differs.');
    if (sRep !== batch.representationCsv) throw new Error('V3 Parity FAIL: Representation_Features.csv differs.');
    if (sEv !== batch.strategyEventsCsv) throw new Error('V3 Parity FAIL: StrategyEvents.csv differs.');

    const bContHash = await sha256Utf8(batch.continuousCsv);
    const bRepHash = await sha256Utf8(batch.representationCsv);
    const bEvHash = await sha256Utf8(batch.strategyEventsCsv);

    if (streamed.fileChecksums[batch.continuousFileName].sha256 !== bContHash) throw new Error('V3 Continuous SHA-256 mismatch.');
    if (streamed.fileChecksums[batch.representationFileName].sha256 !== bRepHash) throw new Error('V3 Representation SHA-256 mismatch.');
    if (streamed.fileChecksums[batch.strategyEventsFileName].sha256 !== bEvHash) throw new Error('V3 StrategyEvents SHA-256 mismatch.');

    if (JSON.stringify(streamed.manifest) !== JSON.stringify(batch.manifest)) {
        throw new Error('V3 Parity FAIL: full manifest mismatch between batch and streaming exports.');
    }

    console.log(`✅ Streaming V3 Parity PASSED (${candleCount} candles): 100% byte-for-byte CSV + SHA-256 + manifest parity!`);
    return true;
}

