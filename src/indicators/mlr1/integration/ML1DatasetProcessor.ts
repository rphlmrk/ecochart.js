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
 * safe idempotency (via canonical request fingerprinting), and independent
 * timestamp-level coverage verification.
 * 
 * Retains acquired source artifacts for the M1-M4 pipeline without bypassing it.
 */
export class ML1DatasetProcessor {
    // In-memory registries (In-process job tracking only, not durable restart recovery)
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

    /**
     * Retrieves a defensive copy of the acquired source artifact (Float64Array).
     */
    public static getSourceArtifact(jobId: string): Float64Array | undefined {
        const artifact = this.artifacts.get(jobId);
        return artifact ? artifact.slice() : undefined;
    }

    /**
     * 🔒 ARTIFACT LIFECYCLE RELEASE
     * Explicitly releases the heavy Float64Array artifact from memory
     * once the downstream pipeline (M1-M4) has finished consuming it.
     */
    public static releaseSourceArtifact(jobId: string): boolean {
        return this.artifacts.delete(jobId);
    }

    /**
     * Cancels an active job via its specific AbortController.
     */
    public static cancelJob(jobId: string): void {
        const controller = this.controllers.get(jobId);
        if (controller) {
            controller.abort();
        }
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
        if (!dateRange || typeof dateRange !== 'object') {
            throw new Error('ML1 Dataset Processor Error: Invalid dateRange object.');
        }
        const { startTimestamp, endTimestamp } = dateRange;
        if (!Number.isSafeInteger(startTimestamp) || startTimestamp < 0) {
            throw new Error(`ML1 Dataset Processor Error: Invalid dateRange.startTimestamp: must be a non-negative safe integer, got ${startTimestamp}`);
        }
        if (!Number.isSafeInteger(endTimestamp) || endTimestamp <= startTimestamp) {
            throw new Error(`ML1 Dataset Processor Error: Invalid dateRange.endTimestamp: must be greater than startTimestamp, got ${endTimestamp}`);
        }
        const durationMs = endTimestamp - startTimestamp;
        if (!Number.isSafeInteger(durationMs)) {
            throw new Error('ML1 Dataset Processor Error: Duration exceeds safe integer range.');
        }
        if (durationMs % intervalMs !== 0) {
            throw new Error(`ML1 Dataset Processor Error: Invalid dateRange: duration (${durationMs}ms) must be an exact multiple of timeframe interval (${intervalMs}ms).`);
        }
        if (startTimestamp % intervalMs !== 0 || endTimestamp % intervalMs !== 0) {
            throw new Error('ML1 Dataset Processor Error: Date range boundaries must align with the timeframe interval.');
        }

        return JSON.stringify({
            datasetId,
            symbol,
            timeframe,
            rangeStart: startTimestamp,
            rangeEnd: endTimestamp,
            configVersion
        });
    }

    /**
     * 🔒 DEFENSIVE INDEPENDENT TIMESTAMP-LEVEL COVERAGE AUDIT
     * Validates flat buffer structure, safe duration bounds, individual timestamps,
     * rejects duplicates/out-of-order data, and accounts for leading/trailing gaps.
     */
    public static evaluateCoverage(
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

        // 🔒 Defensive validation of requested boundaries
        if (
            !Number.isSafeInteger(startTimestamp) ||
            !Number.isSafeInteger(endTimestamp) ||
            startTimestamp < 0 ||
            endTimestamp <= startTimestamp ||
            startTimestamp % intervalMs !== 0 ||
            endTimestamp % intervalMs !== 0 ||
            (endTimestamp - startTimestamp) % intervalMs !== 0
        ) {
            throw new Error('Invalid coverage evaluation boundaries.');
        }

        const durationMs = endTimestamp - startTimestamp;
        if (!Number.isSafeInteger(durationMs)) {
            throw new Error('Invalid coverage duration: duration exceeds safe integer range.');
        }

        const expectedCandles = durationMs / intervalMs;
        if (!Number.isSafeInteger(expectedCandles) || expectedCandles <= 0) {
            throw new Error('Invalid expected candle count.');
        }

        const actualCandles = buffer.length / 6;
        if (actualCandles === 0) {
            return { expectedCandles, actualCandles: 0, missingCandles: expectedCandles, isComplete: false };
        }

        const lastExpectedTs = endTimestamp - intervalMs;
        const firstTs = buffer[0];
        const lastActualTs = buffer[(actualCandles - 1) * 6];

        let isContiguous = true;
        let missingCandles = 0;
        let prevTs = -1;

        for (let i = 0; i < actualCandles; i++) {
            const currentTs = buffer[i * 6];

            // 🔒 Validate every individual timestamp record against boundaries and interval grid
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

                // 🔒 Explicitly fail closed on duplicate or descending timestamps
                if (delta <= 0) {
                    throw new Error('Invalid source artifact: duplicate or out-of-order timestamps.');
                }
                if (delta % intervalMs !== 0) {
                    throw new Error('Invalid source artifact: timestamp gap is not interval-aligned.');
                }
                if (delta > intervalMs) {
                    isContiguous = false;
                    missingCandles += (delta / intervalMs) - 1;
                }
            }
            prevTs = currentTs;
        }

        // 🔒 Accurate missing-candle accounting for leading and trailing gaps
        if (firstTs > startTimestamp) {
            isContiguous = false;
            missingCandles += (firstTs - startTimestamp) / intervalMs;
        }
        if (lastActualTs < lastExpectedTs) {
            isContiguous = false;
            missingCandles += (lastExpectedTs - lastActualTs) / intervalMs;
        }

        // 🔒 Defensive arithmetic guard on missing candles
        if (!Number.isSafeInteger(missingCandles) || missingCandles < 0) {
            throw new Error('Invalid source artifact: missing candle count is unsafe.');
        }

        const isComplete = isContiguous && actualCandles === expectedCandles && missingCandles === 0;

        return { expectedCandles, actualCandles, missingCandles, isComplete };
    }

    /**
     * Initializes and starts a background dataset acquisition job.
     */
    public static async startDatasetBuild(
        jobId: string,
        datasetId: string,
        symbol: string,
        timeframe: string,
        dateRange: DatasetDateRange,
        configVersion: string,
        idempotencyKey: string
    ): Promise<ML1ProcessingJob> {
        // 🔒 Controlled pre-trimming type guards
        const stringInputs: Array<[string, unknown]> = [
            ['jobId', jobId],
            ['idempotencyKey', idempotencyKey],
            ['datasetId', datasetId],
            ['symbol', symbol],
            ['timeframe', timeframe],
            ['configVersion', configVersion]
        ];

        for (const [name, value] of stringInputs) {
            if (typeof value !== 'string' || !value.trim()) {
                throw new Error(
                    `ML1 Dataset Processor Error: ${name} must be a non-empty string.`
                );
            }
        }

        const cleanJobId = jobId.trim();
        const cleanIdempotencyKey = idempotencyKey.trim();
        const cleanDatasetId = datasetId.trim();
        const cleanSymbol = symbol.trim().toUpperCase();
        const cleanTimeframe = timeframe.trim();
        const cleanConfigVersion = configVersion.trim();

        if (this.jobs.has(cleanJobId)) {
            throw new Error(`ML1 Dataset Processor Error: Job ID '${cleanJobId}' already exists.`);
        }

        const intervalMs = BackgroundDataMiner.intervalToMs(cleanTimeframe);

        // 🔒 Canonical fingerprinting using the exact trimmed values
        const requestFingerprint = this.validateAndFingerprint(
            cleanDatasetId,
            cleanSymbol,
            cleanTimeframe,
            dateRange,
            cleanConfigVersion,
            intervalMs
        );

        // 🔒 Idempotency lookup: Search in REVERSE order to always find the most recent attempt
        const existingRecord = Array.from(this.jobs.values())
            .reverse()
            .find(r => r.job.idempotencyKey === cleanIdempotencyKey);

        if (existingRecord) {
            if (existingRecord.requestFingerprint !== requestFingerprint) {
                throw new Error(`ML1 Dataset Processor Error: Idempotency key '${cleanIdempotencyKey}' reused with conflicting request parameters.`);
            }
            if (existingRecord.job.status === 'COMPLETED' || existingRecord.job.status === 'IN_PROGRESS') {
                return this.getJob(existingRecord.job.jobId)!;
            }
        }

        const attempt = existingRecord ? existingRecord.job.attempt + 1 : 1;
        const abortController = new AbortController();

        const job: ML1ProcessingJob = {
            jobId: cleanJobId,
            datasetId: cleanDatasetId,
            processingType: 'ACQUIRE_SOURCE',
            configVersion: cleanConfigVersion,
            idempotencyKey: cleanIdempotencyKey,
            attempt,
            status: 'PENDING',
            startTimeMs: Date.now(),
            completionTimeMs: null,
            progressInfo: { percent: 0, statusText: 'Initializing background processing...' },
            errorInfo: null
        };

        this.jobs.set(cleanJobId, { job, requestFingerprint });
        this.controllers.set(cleanJobId, abortController);

        this.executeBuild(job, cleanSymbol, cleanTimeframe, dateRange, abortController).catch(err => {
            console.error(`[ML1DatasetProcessor] Unhandled exception in job ${cleanJobId}`, err);
        });

        return this.getJob(cleanJobId)!;
    }

    private static async executeBuild(
        job: ML1ProcessingJob,
        symbol: string,
        timeframe: string,
        dateRange: DatasetDateRange,
        abortController: AbortController
    ): Promise<void> {
        const signal = abortController.signal;
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

            // 🔒 Guard: verify cancellation before storing the artifact
            if (signal.aborted) {
                throw new Error('Mining cancelled by user.');
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
            // 🔒 Use the signal as primary authority for interruption classification
            const isInterrupted = signal.aborted || /cancel|abort/i.test(errorMessage);

            updateStatus(
                isInterrupted ? 'INTERRUPTED' : 'FAILED',
                0,
                'Processing stopped.',
                errorMessage
            );
        } finally {
            // 🔒 Controlled cleanup: only delete controller if it matches this specific attempt
            if (this.controllers.get(job.jobId) === abortController) {
                this.controllers.delete(job.jobId);
            }
        }
    }
}
