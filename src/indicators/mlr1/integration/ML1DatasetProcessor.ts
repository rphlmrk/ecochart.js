import { BackgroundDataMiner } from '../../../data/BackgroundDataMiner';
import type { DatasetDateRange } from '../dataset/DatasetConfig';
import type { ML1ProcessingJob, ML1ProcessingStatus, ML1SourceCoverage } from './ML1IntegrationTypes';

interface InternalJobRecord {
    readonly job: ML1ProcessingJob;
    readonly requestFingerprint: string;
}

/**
 * 🔒 PHASE 5C: BACKGROUND DATA MINER INTEGRATION
 * Orchestrates background processing jobs, ensuring in-process job tracking,
 * safe idempotency (via request fingerprinting), and coverage calculations.
 * 
 * Retains acquired source artifacts for the M1-M4 pipeline without bypassing it.
 */
export class ML1DatasetProcessor {
    // In-memory registries (Note: In-process tracking only, not durable recovery)
    private static jobs: Map<string, InternalJobRecord> = new Map();
    private static artifacts: Map<string, Float64Array> = new Map();
    private static controllers: Map<string, AbortController> = new Map();

    /**
     * Retrieves a defensive copy of the current status of a processing job.
     */
    public static getJob(jobId: string): ML1ProcessingJob | undefined {
        const record = this.jobs.get(jobId);
        if (!record) return undefined;
        const { job } = record;
        return {
            ...job,
            progressInfo: { ...job.progressInfo },
            coverageInfo: job.coverageInfo ? { ...job.coverageInfo } : undefined
        };
    }

    public static getSourceArtifact(jobId: string): Float64Array | undefined {
        const artifact = this.artifacts.get(jobId);
        return artifact ? artifact.slice() : undefined; // 🔒 Defensive copy
    }

    /**
     * 🔒 ARTIFACT LIFECYCLE RELEASE
     * Explicitly releases the heavy Float64Array artifact from memory
     * once downstream pipeline (M1-M4) has consumed it.
     */
    public static releaseSourceArtifact(jobId: string): boolean {
        return this.artifacts.delete(jobId);
    }

    /**
     * 🔒 REQUEST VALIDATION & CANONICAL FINGERPRINTING
     * Validates all inputs before allocation and builds an order-independent fingerprint.
     */
    private static validateAndFingerprint(
        datasetId: string,
        symbol: string,
        timeframe: string,
        dateRange: DatasetDateRange,
        configVersion: string,
        intervalMs: number
    ): string {
        if (typeof datasetId !== 'string' || !datasetId.trim()) throw new Error('Invalid datasetId.');
        if (typeof symbol !== 'string' || !symbol.trim()) throw new Error('Invalid symbol.');
        if (typeof timeframe !== 'string' || !timeframe.trim()) throw new Error('Invalid timeframe.');
        if (typeof configVersion !== 'string' || !configVersion.trim()) throw new Error('Invalid configVersion.');

        if (!dateRange || typeof dateRange !== 'object') throw new Error('Invalid dateRange object.');
        const { startTimestamp, endTimestamp } = dateRange;
        if (!Number.isSafeInteger(startTimestamp) || startTimestamp < 0) {
            throw new Error(`Invalid dateRange.startTimestamp: must be a non-negative safe integer, got ${startTimestamp}`);
        }
        if (!Number.isSafeInteger(endTimestamp) || endTimestamp <= startTimestamp) {
            throw new Error(`Invalid dateRange.endTimestamp: must be greater than startTimestamp, got ${endTimestamp}`);
        }
        const durationMs = endTimestamp - startTimestamp;
        if (durationMs % intervalMs !== 0) {
            throw new Error(`Invalid dateRange: duration (${durationMs}ms) must be an exact multiple of timeframe interval (${intervalMs}ms).`);
        }

        return JSON.stringify({
            datasetId: datasetId.trim(),
            symbol: symbol.trim().toUpperCase(),
            timeframe: timeframe.trim(),
            rangeStart: startTimestamp,
            rangeEnd: endTimestamp,
            configVersion: configVersion.trim()
        });
    }

    /**
     * 🔒 DEFENSIVE INDEPENDENT TIMESTAMP-LEVEL COVERAGE AUDIT
     * Validates flat buffer structure and verifies every individual record timestamp.
     */
    private static evaluateCoverage(
        buffer: Float64Array,
        startTimestamp: number,
        endTimestamp: number,
        intervalMs: number
    ): ML1SourceCoverage {
        if (buffer.length % 6 !== 0) {
            throw new Error('Invalid source artifact: buffer length is not divisible by six.');
        }
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
            throw new Error('Invalid interval supplied to coverage evaluator.');
        }

        const expectedCandles = (endTimestamp - startTimestamp) / intervalMs;
        const actualCandles = buffer.length / 6;

        if (actualCandles === 0) {
            return { expectedCandles, actualCandles: 0, missingCandles: expectedCandles, isComplete: false };
        }

        const lastExpectedTs = endTimestamp - intervalMs;
        const firstTs = buffer[0];
        const lastActualTs = buffer[(actualCandles - 1) * 6];

        let isContiguous = true;
        let prevTs = -1;

        for (let i = 0; i < actualCandles; i++) {
            const currentTs = buffer[i * 6];

            // 🔒 Validate every individual timestamp record
            if (
                !Number.isSafeInteger(currentTs) ||
                currentTs < startTimestamp ||
                currentTs >= endTimestamp ||
                currentTs % intervalMs !== 0
            ) {
                throw new Error(`Invalid source timestamp ${currentTs} at record ${i}.`);
            }

            if (i > 0) {
                const delta = currentTs - prevTs;
                if (delta !== intervalMs) {
                    isContiguous = false;
                }
            }
            prevTs = currentTs;
        }

        if (firstTs !== startTimestamp || lastActualTs !== lastExpectedTs) {
            isContiguous = false;
        }

        const missingCandles = Math.max(0, expectedCandles - actualCandles);
        const isComplete = isContiguous && actualCandles === expectedCandles && missingCandles === 0;

        return { expectedCandles, actualCandles, missingCandles, isComplete };
    }
    
    public static cancelJob(jobId: string): void {
        const controller = this.controllers.get(jobId);
        if (controller) {
            controller.abort();
        }
    }

    public static async startDatasetBuild(
        jobId: string,
        datasetId: string,
        symbol: string,
        timeframe: string,
        dateRange: DatasetDateRange,
        configVersion: string,
        idempotencyKey: string
    ): Promise<ML1ProcessingJob> {
        // 🔒 Validate identifier strings before inspecting registries
        if (typeof jobId !== 'string' || !jobId.trim()) {
            throw new Error('ML1 Dataset Processor Error: jobId must be a non-empty string.');
        }
        if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
            throw new Error('ML1 Dataset Processor Error: idempotencyKey must be a non-empty string.');
        }

        if (this.jobs.has(jobId)) {
            throw new Error(`ML1 Dataset Processor Error: Job ID '${jobId}' already exists.`);
        }

        const intervalMs = BackgroundDataMiner.intervalToMs(timeframe);

        // 🔒 Pre-flight request validation and canonical fingerprinting
        const requestFingerprint = this.validateAndFingerprint(
            datasetId,
            symbol,
            timeframe,
            dateRange,
            configVersion,
            intervalMs
        );

        const existingRecord = Array.from(this.jobs.values()).find(
            r => r.job.idempotencyKey === idempotencyKey
        );

        if (existingRecord) {
            if (existingRecord.requestFingerprint !== requestFingerprint) {
                throw new Error(`ML1 Dataset Processor Error: Idempotency key '${idempotencyKey}' reused with conflicting request parameters.`);
            }
            if (existingRecord.job.status === 'COMPLETED' || existingRecord.job.status === 'IN_PROGRESS') {
                return this.getJob(existingRecord.job.jobId)!;
            }
        }

        const attempt = existingRecord ? existingRecord.job.attempt + 1 : 1;
        const abortController = new AbortController();

        const job: ML1ProcessingJob = {
            jobId,
            datasetId,
            processingType: 'ACQUIRE_SOURCE',
            configVersion,
            idempotencyKey,
            attempt,
            status: 'PENDING',
            startTimeMs: Date.now(),
            completionTimeMs: null,
            progressInfo: { percent: 0, statusText: 'Initializing background processing...' },
            errorInfo: null
        };
        
        this.jobs.set(jobId, { job, requestFingerprint });
        this.controllers.set(jobId, abortController);

        this.executeBuild(job, symbol, timeframe, dateRange, abortController.signal).catch(err => {
            console.error(`[ML1DatasetProcessor] Unhandled exception in job ${jobId}`, err);
        });

        return this.getJob(jobId)!;
    }

    private static async executeBuild(
        job: ML1ProcessingJob,
        symbol: string,
        timeframe: string,
        dateRange: DatasetDateRange,
        signal: AbortSignal
    ): Promise<void> {
        const updateStatus = (
            status: ML1ProcessingStatus, 
            percent: number, 
            text: string, 
            error: string | null = null,
            coverage?: ML1SourceCoverage
        ) => {
            const currentRecord = this.jobs.get(job.jobId);
            if (!currentRecord) return;
            this.jobs.set(job.jobId, {
                ...currentRecord,
                job: {
                    ...currentRecord.job,
                    status,
                    completionTimeMs: (status === 'COMPLETED' || status === 'FAILED' || status === 'INTERRUPTED') ? Date.now() : null,
                    progressInfo: { percent, statusText: text },
                    errorInfo: error,
                    ...(coverage ? { coverageInfo: coverage } : {})
                }
            });
        };

        updateStatus('IN_PROGRESS', 5, 'Acquiring source data...');

        try {
            if (signal.aborted) {
                throw new Error('Mining cancelled by user.');
            }

            const intervalMs = BackgroundDataMiner.intervalToMs(timeframe);
            const durationMs = dateRange.endTimestamp - dateRange.startTimestamp;
            
            const rawCandles = await BackgroundDataMiner.mineHistoricalCandles(
                symbol,
                timeframe,
                durationMs,
                (progress) => {
                    // 🔒 Clamped progress calculation: keeps within acquisition window [5%, 95%]
                    const sourcePercent = Number.isFinite(progress.percent)
                        ? Math.max(0, Math.min(100, progress.percent))
                        : 0;
                    const scaledPercent = 5 + Math.floor(sourcePercent * 0.9);
                    updateStatus('IN_PROGRESS', scaledPercent, `Mining: ${progress.statusText}`);
                },
                dateRange.startTimestamp,
                dateRange.endTimestamp,
                signal
            );

            if (!rawCandles || rawCandles.length === 0) {
                throw new Error('BackgroundDataMiner returned empty data for the requested range.');
            }

            // 🔒 True timestamp-level coverage evaluation (inspecting all 6-value records)
            const coverageInfo = this.evaluateCoverage(
                rawCandles,
                dateRange.startTimestamp,
                dateRange.endTimestamp,
                intervalMs
            );

            this.artifacts.set(job.jobId, rawCandles);

            // 🔒 Distinguish finished attempt vs true completeness for downstream M4 gating
            const completionText = coverageInfo.isComplete 
                ? 'Source acquisition completed with 100% full coverage.' 
                : `Source acquisition completed with incomplete coverage (Expected: ${coverageInfo.expectedCandles}, Actual: ${coverageInfo.actualCandles}, Missing: ${coverageInfo.missingCandles}). Downstream M4 pipeline requires complete coverage.`;

            updateStatus('COMPLETED', 100, completionText, null, coverageInfo);

        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isInterrupted = /cancel|abort/i.test(errorMessage);

            updateStatus(
                isInterrupted ? 'INTERRUPTED' : 'FAILED',
                0,
                'Processing stopped.',
                errorMessage
            );
        } finally {
            this.controllers.delete(job.jobId);
        }
    }
}
