// =========================================================================
// 🔒 V3 RESEARCH CONTRACT: EXPLICIT FEATURE / OUTCOME SEPARATION
// =========================================================================
import JSZip from 'jszip';
import type { DatasetManifest, IntegrityAuditResults } from '../indicators/mlr1/dataset/DatasetManifest';
import type { RawSourceAccountingReport, RawSourceTimestampBounds } from '../indicators/mlr1/dataset/ObservationBackbone';
import {
    V3_DATASET_VERSION,
    type V3StrategyEventRow
} from '../indicators/mlr1/pipeline/MultiHorizonOutcomeEngine';
import {
    createV3PipelineConfig,
    V3_15M_ONLY_MTF_VERSION,
    V3PipelineRunner
} from '../indicators/mlr1/pipeline/V3PipelineEngine';
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
import { parseCsvDocumentCRLF, V3ArtifactAuditor } from '../indicators/mlr1/pipeline/V3ArtifactAuditor';

export class SourceIntegrityError extends Error {
    public readonly sourceReport: RawSourceAccountingReport;

    public constructor(sourceReport: RawSourceAccountingReport) {
        const { stats, rejectedRows, uptime } = sourceReport;
        super(
            `Source integrity rejected ${rejectedRows.length} of ${stats.sourceRowCount} raw candles; ` +
            `uptime=${uptime.usableObservationFraction}, missingIntervals=${stats.missingIntervalCount}, ` +
            `duplicates=${stats.duplicateTimestampCount}, outOfOrder=${stats.outOfOrderCount}, ` +
            `invalidOhlcv=${stats.invalidOhlcvCount}, offGrid=${stats.offGridTimestampCount}, ` +
            `outOfRange=${stats.outOfRangeTimestampCount}.`
        );
        this.sourceReport = sourceReport;
        this.name = 'SourceIntegrityError';
    }
}

export class AIExporter {
    public static countCsvDataRows(csv: string): number {
        if (typeof csv !== 'string' || csv.length === 0) {
            throw new Error('CSV Row Count Error: CSV content must be a non-empty string.');
        }
        let inQuotedField = false;
        let recordCount = 1;
        for (let i = 0; i < csv.length; i++) {
            const character = csv[i];
            if (character === '"') {
                if (inQuotedField && csv[i + 1] === '"') {
                    i++;
                } else {
                    inQuotedField = !inQuotedField;
                }
            } else if (!inQuotedField && character === '\r') {
                if (csv[i + 1] !== '\n') {
                    throw new Error('CSV Row Count Error: CSV must use CRLF record separators.');
                }
                recordCount++;
                i++;
            } else if (!inQuotedField && character === '\n') {
                throw new Error('CSV Row Count Error: CSV contains an unpaired line feed.');
            }
        }
        if (inQuotedField) {
            throw new Error('CSV Row Count Error: CSV contains an unterminated quoted field.');
        }
        return recordCount - 1;
    }

    public static assertCandleBufferWithinBounds(
        candleBuffer: Float64Array,
        bounds: RawSourceTimestampBounds
    ): void {
        if (!(candleBuffer instanceof Float64Array) || candleBuffer.length % 6 !== 0 ||
            !Number.isSafeInteger(bounds.startTimestamp) ||
            !Number.isSafeInteger(bounds.endTimestamp) ||
            bounds.startTimestamp < 0 ||
            bounds.endTimestamp < bounds.startTimestamp) {
            throw new Error('Custom date validation requires a valid candle buffer and ordered timestamp bounds.');
        }
        for (let offset = 0; offset < candleBuffer.length; offset += 6) {
            const timestamp = candleBuffer[offset];
            if (!Number.isSafeInteger(timestamp) ||
                timestamp < bounds.startTimestamp || timestamp > bounds.endTimestamp) {
                throw new Error(
                    `Fetched candle timestamp ${timestamp} falls outside custom date bounds ` +
                    `[${bounds.startTimestamp}, ${bounds.endTimestamp}].`
                );
            }
        }
    }

    public static assertCandleBufferMatchesExactRange(
        candleBuffer: Float64Array,
        intervalMs: number,
        expectedStartTimestamp: number,
        expectedEndTimestamp: number,
        expectedCandleCount: number
    ): void {
        if (!(candleBuffer instanceof Float64Array) ||
            !Number.isSafeInteger(intervalMs) || intervalMs <= 0 ||
            !Number.isSafeInteger(expectedStartTimestamp) || expectedStartTimestamp < 0 ||
            !Number.isSafeInteger(expectedEndTimestamp) || expectedEndTimestamp < expectedStartTimestamp ||
            !Number.isSafeInteger(expectedCandleCount) || expectedCandleCount <= 0 ||
            expectedEndTimestamp - expectedStartTimestamp !== (expectedCandleCount - 1) * intervalMs ||
            candleBuffer.length !== expectedCandleCount * 6) {
            throw new Error(
                `Historical range integrity error: expected ${expectedCandleCount} candles from ` +
                `${expectedStartTimestamp} to ${expectedEndTimestamp} at ${intervalMs}ms intervals.`
            );
        }
        for (let index = 0; index < expectedCandleCount; index++) {
            const timestamp = candleBuffer[index * 6];
            const expectedTimestamp = expectedStartTimestamp + index * intervalMs;
            if (timestamp !== expectedTimestamp) {
                throw new Error(
                    `Historical range integrity error at candle ${index}: expected ${expectedTimestamp}, got ${timestamp}.`
                );
            }
        }
    }

    // =========================================================================
    // V3 Multi-Teacher Batch Export & Archive Verification (Shared V3Pipeline)
    // =========================================================================

    private static async sha256Utf8(text: string): Promise<string> {
        const bytes = new TextEncoder().encode(text);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /** rawCandleBuffer must contain strictly accepted, validated candles (0..N-1 = acceptedBarIndex). Use accountRawSourceRows() upstream when filtering dirty raw feeds. */
    public static async buildV3ExportArtifacts(params: {
        rawCandleBuffer: Float64Array;
        symbol: string;
        interval: string;
        intervalMs: number;
        include15mMtf?: boolean;
        buildTimestamp?: number;
        requireContiguous?: boolean;
        sourceTimestampBounds?: RawSourceTimestampBounds;
        onProgress?: (detail: string) => void;
    }) {
        const { rawCandleBuffer, symbol, interval, intervalMs } = params;
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
            throw new Error(`Unsupported chart interval for V3 export: ${interval}`);
        }
        if (!(rawCandleBuffer instanceof Float64Array) || rawCandleBuffer.length === 0 || rawCandleBuffer.length % 6 !== 0) {
            throw new Error('Historical fetch returned empty or malformed data buffer (length not divisible by 6).');
        }

        const rawCandleCount = rawCandleBuffer.length / 6;
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
        const mtfCache = new MTF15mSerializerCache();

        let featureKeys: string[] | null = null;
        const continuousLines: string[] = [];
        const representationLines: string[] = [buildV3RepresentationHeader()];
        const strategyEventLines: string[] = [buildV3StrategyEventHeader()];
        const strategyEventRows: V3StrategyEventRow[] = [];

        params.onProgress?.(`Running shared V3 pipeline on ${rawCandleCount.toLocaleString()} candles...`);
        for (let i = 0; i < rawCandleCount; i++) {
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

            if (featureKeys === null) {
                featureKeys = Object.keys(stepOut.observation.features).sort();
                continuousLines.push(buildV3ContinuousHeader(featureKeys, include15mMtf));
            }
            continuousLines.push(formatV3ContinuousRow(stepOut, featureKeys, mtfCache, include15mMtf));

            for (const row of stepOut.completedOutcomeRows) {
                strategyEventRows.push(row);
                strategyEventLines.push(formatV3StrategyEventRow(row));
                representationLines.push(formatV3RepresentationRow(row).csvLine);
            }
        }

        const fin = runner.finalize();
        if (runner.getAcceptedCount() !== rawCandleCount || runner.getStats().rejectedObservationCount !== 0) {
            throw new Error(
                `V3 Batch Contract Error: rawCandleBuffer must contain strictly accepted candles (accepted=${runner.getAcceptedCount()}, raw=${rawCandleCount}).`
            );
        }
        if (strategyEventRows.length === 0) {
            throw new Error('V3 Export Error: no eligible confirmed events with complete 180-bar horizons.');
        }

        const continuousCsv = continuousLines.join('\r\n');
        const representationCsv = representationLines.join('\r\n');
        const strategyEventsCsv = strategyEventLines.join('\r\n');

        params.onProgress?.('Running V3 serialized CSV, zero-leakage & 180-bar replay audits...');
        const auditResult = DatasetAuditor.runV3CausalityAudit({
            rawCandleBuffer,
            intervalMs,
            expectedContinuousRows: rawCandleCount,
            expectedEventRows: strategyEventRows.length,
            continuousCsv,
            representationCsv,
            strategyEventsCsv,
            include15mMtf,
            is1mBase: interval === '1m'
        });
        if (!auditResult.passed) {
            throw new Error(`V3 Pre-flight audit failed: ${auditResult.remarks.join('; ')}`);
        }

        const verifiedFileChecksums = Object.freeze({
            continuousSha256: await this.sha256Utf8(continuousCsv),
            representationSha256: await this.sha256Utf8(representationCsv),
            strategyEventsSha256: await this.sha256Utf8(strategyEventsCsv)
        });

        const fileNames = getV3FileNames(symbol, interval);
        const manifest = buildV3DatasetManifest({
            runner,
            config,
            totalRawCandles: rawCandleCount,
            startTimestamp: rawCandleBuffer[0],
            endTimestamp: rawCandleBuffer[(rawCandleCount - 1) * 6],
            outcomeAccounting: fin.outcomeAccounting,
            continuousRowCount: rawCandleCount,
            representationRowCount: strategyEventRows.length,
            strategyEventRowCount: strategyEventRows.length,
            auditResults: auditResult,
            fileChecksums: verifiedFileChecksums,
            buildTimestamp: params.buildTimestamp
        });

        return {
            manifest,
            continuousCsv,
            representationCsv,
            strategyEventsCsv,
            continuousFileName: fileNames.continuousFileName,
            representationFileName: fileNames.representationFileName,
            strategyEventsFileName: fileNames.strategyEventsFileName,
            manifestFileName: fileNames.manifestFileName,
            strategyEventRows,
            outcomeAccounting: fin.outcomeAccounting,
            auditResult,
            verifiedFileChecksums
        };
    }

    public static async createVerifiedV3DatasetArchive(
        artifacts: {
            manifest: DatasetManifest;
            continuousCsv: string;
            representationCsv: string;
            strategyEventsCsv: string;
            continuousFileName: string;
            representationFileName: string;
            strategyEventsFileName: string;
            manifestFileName: string;
            verifiedFileChecksums: {
                readonly continuousSha256: string;
                readonly representationSha256: string;
                readonly strategyEventsSha256: string;
            };
        },
        rawCandleBuffer: Float64Array
    ): Promise<Uint8Array> {
        if (artifacts.manifest.datasetVersion !== V3_DATASET_VERSION ||
            !artifacts.manifest.auditResults.passed) {
            throw new Error('V3 Archive Error: manifest must be a validated V3 dataset.');
        }
        const expectedNames = getV3FileNames(artifacts.manifest.symbol, artifacts.manifest.timeframe);
        if (artifacts.continuousFileName !== expectedNames.continuousFileName ||
            artifacts.representationFileName !== expectedNames.representationFileName ||
            artifacts.strategyEventsFileName !== expectedNames.strategyEventsFileName ||
            artifacts.manifestFileName !== expectedNames.manifestFileName) {
            throw new Error('V3 Archive Error: file names do not match V3 contract.');
        }

        // Bind audit to exact current bytes before archive creation (defeats stale-audit tampering)
        const actualContHash = await this.sha256Utf8(artifacts.continuousCsv);
        const actualRepHash = await this.sha256Utf8(artifacts.representationCsv);
        const actualEvHash = await this.sha256Utf8(artifacts.strategyEventsCsv);
        if (actualContHash !== artifacts.verifiedFileChecksums.continuousSha256 ||
            actualRepHash !== artifacts.verifiedFileChecksums.representationSha256 ||
            actualEvHash !== artifacts.verifiedFileChecksums.strategyEventsSha256) {
            throw new Error('V3 Archive Error: CSV contents do not match audited SHA-256 checksums.');
        }

        const remarks = artifacts.manifest.auditResults.remarks;
        if (!remarks.includes(`SHA-256 ${artifacts.continuousFileName}: ${actualContHash}`) ||
            !remarks.includes(`SHA-256 ${artifacts.representationFileName}: ${actualRepHash}`) ||
            !remarks.includes(`SHA-256 ${artifacts.strategyEventsFileName}: ${actualEvHash}`)) {
            throw new Error('V3 Archive Error: manifest SHA-256 remarks do not match audited CSV bytes.');
        }

        // Independently verify exact CSV bytes entering ZIP against the raw source candles
        const manifestIncludes15m = artifacts.manifest.featureVersion.includes(V3_15M_ONLY_MTF_VERSION);
        const reAudit = DatasetAuditor.runV3CausalityAudit({
            rawCandleBuffer,
            intervalMs: artifacts.manifest.buildConfig.sourceIntervalMs,
            expectedContinuousRows: artifacts.manifest.acceptedObservationCount,
            expectedEventRows: artifacts.manifest.exportAccounting.tierBConfirmedTeacherEventCount,
            continuousCsv: artifacts.continuousCsv,
            representationCsv: artifacts.representationCsv,
            strategyEventsCsv: artifacts.strategyEventsCsv,
            include15mMtf: manifestIncludes15m,
            is1mBase: artifacts.manifest.timeframe === '1m'
        });
        if (!reAudit.passed) {
            throw new Error(`V3 Archive Error: CSV bytes failed pre-ZIP audit (${reAudit.remarks.join('; ')}).`);
        }

        const entries = [
            { name: artifacts.manifestFileName, content: JSON.stringify(artifacts.manifest, null, 2) },
            { name: artifacts.continuousFileName, content: artifacts.continuousCsv },
            { name: artifacts.representationFileName, content: artifacts.representationCsv },
            { name: artifacts.strategyEventsFileName, content: artifacts.strategyEventsCsv }
        ];
        const expectedCounts = artifacts.manifest.exportAccounting.actualFileRowCounts;
        for (const [name, csv] of [
            [artifacts.continuousFileName, artifacts.continuousCsv],
            [artifacts.representationFileName, artifacts.representationCsv],
            [artifacts.strategyEventsFileName, artifacts.strategyEventsCsv]
        ] as const) {
            if (this.countCsvDataRows(csv) !== expectedCounts[name]) {
                throw new Error(`V3 Archive Error: CSV row count mismatch on '${name}'.`);
            }
        }

        const fixedDate = new Date(artifacts.manifest.buildTimestamp);
        const zip = new JSZip();
        for (const entry of entries) {
            zip.file(entry.name, entry.content, { date: fixedDate });
        }
        const bytes = await zip.generateAsync({ type: 'uint8array' });

        const reopened = await JSZip.loadAsync(bytes);
        const actualNames = Object.keys(reopened.files).filter(n => !reopened.files[n].dir).sort();
        const wantNames = entries.map(e => e.name).sort();
        if (actualNames.length !== wantNames.length || actualNames.some((n, i) => n !== wantNames[i])) {
            throw new Error('V3 Archive Verification Error: archive entries mismatch.');
        }
        for (const entry of entries) {
            const content = await reopened.file(entry.name)!.async('string');
            if (content !== entry.content) {
                throw new Error(`V3 Archive Verification Error: byte mismatch on '${entry.name}'.`);
            }
        }
        return bytes;
    }
}

export class DatasetAuditor {
    public static runV3CausalityAudit(params: {
        readonly rawCandleBuffer: Float64Array;
        readonly intervalMs: number;
        readonly expectedContinuousRows: number;
        readonly expectedEventRows: number;
        readonly continuousCsv: string;
        readonly representationCsv: string;
        readonly strategyEventsCsv: string;
        readonly include15mMtf: boolean;
        readonly is1mBase: boolean;
    }): IntegrityAuditResults {
        const auditor = new V3ArtifactAuditor({
            intervalMs: params.intervalMs,
            include15mMtf: params.include15mMtf,
            is1mBase: params.is1mBase,
            batchRawBuffer: params.rawCandleBuffer
        });

        let contRecords: string[][];
        let repRecords: string[][];
        let evRecords: string[][];
        try {
            contRecords = parseCsvDocumentCRLF(params.continuousCsv);
            repRecords = parseCsvDocumentCRLF(params.representationCsv);
            evRecords = parseCsvDocumentCRLF(params.strategyEventsCsv);
        } catch (e: any) {
            return Object.freeze({
                passed: false,
                chronologyValid: false,
                identityUnique: false,
                inputOutcomeSeparationValid: false,
                remarks: Object.freeze([`CSV Document Parse Error: ${e?.message}`])
            });
        }

        auditor.validateContinuousHeader(contRecords[0] ?? []);
        for (let i = 1; i < contRecords.length; i++) {
            auditor.validateContinuousCells(contRecords[i]);
        }

        auditor.validateRepresentationHeader(repRecords[0] ?? []);
        auditor.validateStrategyEventsHeader(evRecords[0] ?? []);

        const eventCount = Math.max(repRecords.length, evRecords.length) - 1;
        for (let i = 1; i <= eventCount; i++) {
            auditor.validateSerializedEventCells(
                repRecords[i] ?? [],
                evRecords[i] ?? []
            );
        }

        return auditor.finalizeAudit(params.expectedContinuousRows, params.expectedEventRows);
    }
}
