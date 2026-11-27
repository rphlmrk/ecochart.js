import type { DatasetManifest } from '../indicators/mlr1/dataset/DatasetManifest';
import type { RawSourceTimestampBounds } from '../indicators/mlr1/dataset/ObservationBackbone';
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
import type { DTFXStrictCBCTimeframe, V4DTFXStrictCBCTimeframe } from '../indicators/mlr1/teachers/DTFXStrictCBCTeacher';
import type { PHLTimeframe } from '../indicators/mlr1/teachers/ProtectedHighsLowsTeacher';
import { V4_DATASET_VERSION } from '../indicators/mlr1/pipeline/V4OutcomeContracts';
import { createV4PipelineConfig, V4PipelineRunner } from '../indicators/mlr1/pipeline/V4PipelineEngine';
import {
    buildV4ContinuousHeader,
    buildV4DatasetManifest,
    buildV4RepresentationHeader,
    buildV4StrategyEventHeader,
    formatV4ContinuousRow,
    formatV4RepresentationRow,
    formatV4StrategyEventRow,
    getV4FileNames,
    MTFV4SerializerCache
} from '../indicators/mlr1/pipeline/V4CsvSerializer';
import { V4ArtifactAuditor } from '../indicators/mlr1/pipeline/V4ArtifactAuditor';
import { AIExporter, buildV4ExportArtifacts } from './AIExporter';

const STREAMING_BATCH_ROWS = 500;

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

function getHeapUsedMB(): number | null {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return mem ? Math.round((mem.usedJSHeapSize / (1024 * 1024)) * 100) / 100 : null;
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

// =========================================================================
// Main Streaming 4-File V3 Exporter
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

    /**
     * Streams V3 dataset artifacts into a unique destination directory by default
     * (exposed via `result.folderName` only after finalization succeeds).
     *
     * Platform limitation: The browser File System Access API has no atomic `O_EXCL`
     * exclusive create-if-absent primitive. The primary `crypto.randomUUID()` folder
     * suffix minimizes accidental collisions (with a `Date.now() + Math.random()`
     * collision-reduction fallback when `randomUUID` is unavailable, which is not a
     * guaranteed unique ID). Shared `destinationFolderName` usage is best-effort for
     * same-runtime concurrency only (via `activeV3DirReservations`); external
     * cross-tab/cross-process empty-directory or zero-byte-file races remain an
     * unresolved platform limitation, so exclusive ownership is never claimed. Rollback
     * never deletes `finalDirHandle`.
     */
    public static async exportV3ToFolderOrOpfs(params: {
        rawCandleBuffer: Float64Array;
        symbol: string;
        interval: string;
        intervalMs: number;
        include15mMtf?: boolean;
        experimentalDtfxCbcTimeframes?: readonly DTFXStrictCBCTimeframe[];
        rootDirHandle?: any;
        destinationFolderName?: string;
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
        const executionId =
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        const folderName =
            params.destinationFolderName ??
            `MLR1_${symbol}_${interval}_V${V3_DATASET_VERSION}_Dataset_${executionId}`;
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
                experimentalDtfxCbcTimeframes: params.experimentalDtfxCbcTimeframes,
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
        experimentalDtfxCbcTimeframes?: readonly DTFXStrictCBCTimeframe[];
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
            experimentalDtfxCbcTimeframes: params.experimentalDtfxCbcTimeframes,
            requireContiguous: params.requireContiguous ?? true,
            sourceTimestampBounds: params.sourceTimestampBounds
        });
        const runner = new V3PipelineRunner(config);
        const include15mMtf = config.mtf15mConfig !== null;
        const includeExperimentalDtfxCbc = config.experimentalDtfxCbcTimeframes.length > 0;
        const auditor = new V3ArtifactAuditor({
            intervalMs,
            include15mMtf,
            is1mBase: interval === '1m',
            includeExperimentalDtfxCbc
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
                const rawTime = rawCandleBuffer[off];
                const rawOpen = rawCandleBuffer[off + 1];
                const rawHigh = rawCandleBuffer[off + 2];
                const rawLow = rawCandleBuffer[off + 3];
                const rawClose = rawCandleBuffer[off + 4];
                const rawVolume = rawCandleBuffer[off + 5];
                const stepOut = runner.stepCandle({
                    time: rawTime,
                    open: rawOpen,
                    high: rawHigh,
                    low: rawLow,
                    close: rawClose,
                    volume: rawVolume,
                    isSynthetic: false as const
                });
                const isValidRaw =
                    Number.isSafeInteger(rawTime) && rawTime >= 1e12 &&
                    Number.isFinite(rawOpen) && rawOpen > 0 &&
                    Number.isFinite(rawHigh) && rawHigh > 0 &&
                    Number.isFinite(rawLow) && rawLow > 0 &&
                    Number.isFinite(rawClose) && rawClose > 0 &&
                    Number.isFinite(rawVolume) && rawVolume >= 0 &&
                    rawHigh >= rawLow &&
                    rawHigh >= Math.max(rawOpen, rawClose) &&
                    rawLow <= Math.min(rawOpen, rawClose);
                const isValidAccepted =
                    Number.isSafeInteger(stepOut.candle.time) && stepOut.candle.time >= 1e12 &&
                    Number.isFinite(stepOut.candle.open) && stepOut.candle.open > 0 &&
                    Number.isFinite(stepOut.candle.high) && stepOut.candle.high > 0 &&
                    Number.isFinite(stepOut.candle.low) && stepOut.candle.low > 0 &&
                    Number.isFinite(stepOut.candle.close) && stepOut.candle.close > 0 &&
                    Number.isFinite(stepOut.candle.volume) && stepOut.candle.volume >= 0 &&
                    stepOut.candle.high >= stepOut.candle.low &&
                    stepOut.candle.high >= Math.max(stepOut.candle.open, stepOut.candle.close) &&
                    stepOut.candle.low <= Math.min(stepOut.candle.open, stepOut.candle.close);
                if (!isValidRaw ||
                    !isValidAccepted ||
                    !stepOut.dataQuality.isSourceValid ||
                    stepOut.acceptedBarIndex !== expectedAcceptedIdx ||
                    stepOut.sourceTimestamp !== rawTime ||
                    stepOut.candle.time !== rawTime ||
                    stepOut.candle.open !== rawOpen ||
                    stepOut.candle.high !== rawHigh ||
                    stepOut.candle.low !== rawLow ||
                    stepOut.candle.close !== rawClose ||
                    stepOut.candle.volume !== rawVolume) {
                    throw new Error(
                        `V3 Streaming Chronology Error: unexpected or modified accepted candle at index ${expectedAcceptedIdx} (got ${stepOut.acceptedBarIndex}).`
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

    public static async exportV4ToFolderOrOpfs(params: {
        rawCandleBuffer: Float64Array;
        symbol: string;
        interval: string;
        intervalMs: number;
        include3m5mMtf?: boolean;
        phlTimeframes?: readonly PHLTimeframe[];
        dtfxStrictCbcTimeframes?: readonly V4DTFXStrictCBCTimeframe[];
        rootDirHandle?: any;
        destinationFolderName?: string;
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
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error(`Unsupported interval: ${interval}`);
        if (!(rawCandleBuffer instanceof Float64Array) || rawCandleBuffer.length === 0 || rawCandleBuffer.length % 6 !== 0) {
            throw new Error('V4 Export Error: malformed or empty candle buffer.');
        }

        const totalCandles = rawCandleBuffer.length / 6;
        const executionId =
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        const folderName =
            params.destinationFolderName ??
            `MLR1_${symbol}_${interval}_V${V4_DATASET_VERSION}_Dataset_${executionId}`;
        const fileNames = getV4FileNames(symbol, interval);

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
                throw new Error(`V4 Export Error: destination '${name}' already exists.`);
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
                throw new Error('Neither File System Access API nor OPFS supported.');
            }
            if (params.signal?.aborted) throw new Error('V4 Export cancelled by user.');

            continuousSink = await createSink(fileNames.continuousFileName);
            representationSink = await createSink(fileNames.representationFileName);
            strategyEventSink = await createSink(fileNames.strategyEventsFileName);

            const coreResult = await this.runV4StreamingCore({
                rawCandleBuffer,
                symbol,
                interval,
                intervalMs,
                include3m5mMtf: params.include3m5mMtf,
                phlTimeframes: params.phlTimeframes,
                dtfxStrictCbcTimeframes: params.dtfxStrictCbcTimeframes,
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

            if (params.signal?.aborted) throw new Error('V4 Export cancelled before manifest.');

            const manifestBytes = new TextEncoder().encode(JSON.stringify(coreResult.manifest, null, 2));
            const manifestHasher = new IncrementalSha256();
            manifestHasher.update(manifestBytes);
            const manifestHandle = await targetDirHandle.getFileHandle(fileNames.manifestFileName, { create: true });
            const manifestWritable = await manifestHandle.createWritable();
            try {
                await manifestWritable.write(manifestBytes);
                await manifestWritable.close();
            } catch (err) {
                await manifestWritable.abort().catch(() => {});
                throw err;
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
                    const srcHandle = await targetDirHandle.getFileHandle(name);
                    const srcFile: File = await srcHandle.getFile();
                    const dstHandle = await finalDirHandle.getFileHandle(name, { create: true });
                    publishedDestinationFiles.push(name);
                    const dstWritable = await dstHandle.createWritable();
                    try {
                        await dstWritable.write(await srcFile.arrayBuffer());
                        await dstWritable.close();
                    } catch (pubErr) {
                        await dstWritable.abort().catch(() => {});
                        throw pubErr;
                    }
                }
                if (typeof params.rootDirHandle.removeEntry === 'function') {
                    await params.rootDirHandle.removeEntry(stagingDirName, { recursive: true }).catch(() => {});
                }
            } else if (opfsRoot) {
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
                fileChecksums: {
                    ...coreResult.fileChecksums,
                    [fileNames.manifestFileName]: { sha256: manifestHasher.digestHex(), bytesWritten: manifestBytes.length }
                },
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
                if (finalDirHandle && typeof finalDirHandle.removeEntry === 'function') {
                    for (const fName of publishedDestinationFiles) await finalDirHandle.removeEntry(fName).catch(() => {});
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
            if (hasReservation && params.rootDirHandle) this.releaseV3FolderReservation(params.rootDirHandle, folderName);
        }
    }

    public static async runV4StreamingCore(params: {
        rawCandleBuffer: Float64Array;
        symbol: string;
        interval: string;
        intervalMs: number;
        include3m5mMtf?: boolean;
        phlTimeframes?: readonly PHLTimeframe[];
        dtfxStrictCbcTimeframes?: readonly V4DTFXStrictCBCTimeframe[];
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

        const config = createV4PipelineConfig({
            symbol,
            interval,
            intervalMs,
            include3m5mMtf: params.include3m5mMtf,
            phlTimeframes: params.phlTimeframes,
            dtfxStrictCbcTimeframes: params.dtfxStrictCbcTimeframes,
            requireContiguous: params.requireContiguous ?? true,
            sourceTimestampBounds: params.sourceTimestampBounds
        });
        const runner = new V4PipelineRunner(config);
        const include3m5mMtf = config.mtfConfig !== null;
        const auditor = new V4ArtifactAuditor({
            expectedSymbol: symbol,
            expectedTimeframe: interval,
            intervalMs,
            include3m5mMtf
        });
        const mtfCache = new MTFV4SerializerCache();
        let featureKeys: string[] | null = null;
        let headersWritten = false;
        let emittedEvents = 0;

        try {
            for (let i = 0; i < totalCandles; i++) {
                if (params.signal?.aborted) throw new Error('V4 Export cancelled by user.');
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
                    const contHdr = buildV4ContinuousHeader(featureKeys, include3m5mMtf);
                    const repHdr = buildV4RepresentationHeader();
                    const evHdr = buildV4StrategyEventHeader();
                    auditor.validateContinuousHeader(parseSingleCsvRecord(contHdr));
                    auditor.validateRepresentationHeader(parseSingleCsvRecord(repHdr));
                    auditor.validateStrategyEventsHeader(parseSingleCsvRecord(evHdr));
                    await continuousSink.writeHeader(contHdr);
                    await representationSink.writeHeader(repHdr);
                    await strategyEventSink.writeHeader(evHdr);
                    headersWritten = true;
                }

                const contLine = formatV4ContinuousRow(stepOut, featureKeys!, mtfCache, include3m5mMtf);
                auditor.validateContinuousLine(contLine);
                await continuousSink.appendRow(contLine);

                for (const row of stepOut.completedOutcomeRows) {
                    const evLine = formatV4StrategyEventRow(row);
                    const repLine = formatV4RepresentationRow(row).csvLine;
                    auditor.validateSerializedEventPairLines(repLine, evLine);
                    await strategyEventSink.appendRow(evLine);
                    await representationSink.appendRow(repLine);
                    emittedEvents++;
                }

                if (i % STREAMING_BATCH_ROWS === 0 || i === totalCandles - 1) {
                    params.onProgress?.(Math.round(((i + 1) / totalCandles) * 100), `Streaming V4 ${i + 1} / ${totalCandles} candles (${emittedEvents} events)...`);
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            if (params.signal?.aborted) throw new Error('V4 Export cancelled.');
            const fin = runner.finalize();
            if (emittedEvents === 0) throw new Error('V4 Streaming Export Error: no eligible events.');

            const auditResult = auditor.finalizeAudit(totalCandles, emittedEvents);
            if (!auditResult.passed) throw new Error(`V4 Streaming Audit Failed: ${auditResult.remarks.join('; ')}`);

            const contStats = await continuousSink.finalize();
            const repStats = await representationSink.finalize();
            const evStats = await strategyEventSink.finalize();

            const fileNames = getV4FileNames(symbol, interval);
            const manifest = buildV4DatasetManifest({
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
            await Promise.allSettled([continuousSink.abort(), representationSink.abort(), strategyEventSink.abort()]);
            throw coreErr;
        }
    }
}

// =========================================================================
// V3 Streaming Parity Verification
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

export async function runV4StreamingExportParityTest(candleCount = 900): Promise<boolean> {
    const intervalMs = 60_000;
    const start = 1_700_000_040_000;
    const buf = new Float64Array(candleCount * 6);
    let price = 100;
    for (let i = 0; i < candleCount; i++) {
        const major = Math.floor(i / 180) % 2 === 0 ? 1 : -1;
        const swing = (i % 60) < 35 ? major : -0.65 * major;
        const micro = (i % 5 === 0) ? -0.4 * swing : 0.65 * swing;
        const open = price;
        const close = Math.max(20, open + micro);
        buf.set([start + i * intervalMs, open, Math.max(open, close) + 0.5, Math.min(open, close) - 0.5, close, 100 + (i % 7) * 15], i * 6);
        price = close;
    }

    const fixedTs = 1_700_000_000_000;
    const batch = await buildV4ExportArtifacts({
        rawCandleBuffer: buf,
        symbol: 'SOLUSDT',
        interval: '1m',
        intervalMs,
        buildTimestamp: fixedTs
    });

    const memCont = new MemoryCaptureStream();
    const memRep = new MemoryCaptureStream();
    const memEv = new MemoryCaptureStream();
    const streamed = await StreamingDatasetExporter.runV4StreamingCore({
        rawCandleBuffer: buf,
        symbol: 'SOLUSDT',
        interval: '1m',
        intervalMs,
        buildTimestamp: fixedTs,
        continuousSink: new BufferedTextSink(memCont, 128),
        representationSink: new BufferedTextSink(memRep, 128),
        strategyEventSink: new BufferedTextSink(memEv, 128)
    });

    if (memCont.toStringUtf8() !== batch.continuousCsv) throw new Error('V4 Parity FAIL: Continuous CSV differs.');
    if (memRep.toStringUtf8() !== batch.representationCsv) throw new Error('V4 Parity FAIL: Representation CSV differs.');
    if (memEv.toStringUtf8() !== batch.strategyEventsCsv) throw new Error('V4 Parity FAIL: StrategyEvents CSV differs.');
    if (streamed.fileChecksums[batch.continuousFileName].sha256 !== await sha256Utf8(batch.continuousCsv)) throw new Error('V4 Continuous SHA-256 mismatch.');
    if (streamed.fileChecksums[batch.representationFileName].sha256 !== await sha256Utf8(batch.representationCsv)) throw new Error('V4 Representation SHA-256 mismatch.');
    if (streamed.fileChecksums[batch.strategyEventsFileName].sha256 !== await sha256Utf8(batch.strategyEventsCsv)) throw new Error('V4 StrategyEvents SHA-256 mismatch.');
    if (JSON.stringify(streamed.manifest) !== JSON.stringify(batch.manifest)) throw new Error('V4 Parity FAIL: manifest mismatch.');

    console.log(`✅ Streaming V4 Parity PASSED (${candleCount} candles): 100% byte-for-byte CSV + SHA-256 + manifest parity!`);
    return true;
}
