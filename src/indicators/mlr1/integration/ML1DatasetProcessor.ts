import { BackgroundDataMiner } from '../../../data/BackgroundDataMiner';
import type { DatasetDateRange } from '../dataset/DatasetConfig';
import type { ML1ProcessingJob, ML1ProcessingStatus } from './ML1IntegrationTypes';

/**
 * 🔒 PHASE 5C: BACKGROUND DATA MINER INTEGRATION
 * Orchestrates background processing jobs, ensuring idempotency, 
 * safe recovery, and strict tracking of ML1ProcessingJob states.
 * 
 * Retains acquired source artifacts for the M1-M4 pipeline without bypassing it.
 */
export class ML1DatasetProcessor {
    // In-memory registries for processing jobs and acquired artifacts
    private static jobs: Map<string, ML1ProcessingJob> = new Map();
    private static artifacts: Map<string, Float64Array> = new Map();

    /**
     * Retrieves the current status of a processing job.
     */
    public static getJob(jobId: string): ML1ProcessingJob | undefined {
        return this.jobs.get(jobId);
    }

    /**
     * Retrieves the acquired source artifact (Float64Array) for a completed job.
     */
    public static getSourceArtifact(jobId: string): Float64Array | undefined {
        return this.artifacts.get(jobId);
    }

    /**
     * Initializes and starts a background dataset acquisition job.
     * Enforces idempotency and prevents Job ID collisions.
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
        // 🔒 1. Prevent Reused Job ID Overwrites
        if (this.jobs.has(jobId)) {
            throw new Error(`ML1 Dataset Processor Error: Job ID '${jobId}' already exists.`);
        }

        // 🔒 2. Idempotency Check: Prevent duplicate logical outputs
        const existingJob = Array.from(this.jobs.values()).find(
            j => j.idempotencyKey === idempotencyKey && j.datasetId === datasetId
        );

        if (existingJob && (existingJob.status === 'COMPLETED' || existingJob.status === 'IN_PROGRESS')) {
            return existingJob; // Return the existing active/completed job
        }

        const attempt = existingJob ? existingJob.attempt + 1 : 1;

        // 🔒 3. Initialize Job State
        const job: ML1ProcessingJob = {
            jobId,
            datasetId,
            processingType: 'ACQUIRE_SOURCE', // Explicitly restricted to source acquisition for now
            configVersion,
            idempotencyKey,
            attempt,
            status: 'PENDING',
            startTimeMs: Date.now(),
            completionTimeMs: null,
            progressInfo: { percent: 0, statusText: 'Initializing background processing...' },
            errorInfo: null
        };
        
        this.jobs.set(jobId, job);

        // 4. Fire-and-Forget Execution
        this.executeBuild(job, symbol, timeframe, dateRange).catch(err => {
            console.error(`[ML1DatasetProcessor] Unhandled exception in job ${jobId}`, err);
        });

        return job;
    }

    /**
     * Internal execution wrapper. 
     * Safely executes BackgroundDataMiner, retains the artifact, and updates status.
     */
    private static async executeBuild(
        job: ML1ProcessingJob,
        symbol: string,
        timeframe: string,
        dateRange: DatasetDateRange
    ): Promise<void> {
        const updateStatus = (status: ML1ProcessingStatus, percent: number, text: string, error: string | null = null) => {
            const currentJob = this.jobs.get(job.jobId);
            if (!currentJob) return;
            this.jobs.set(job.jobId, {
                ...currentJob,
                status,
                completionTimeMs: (status === 'COMPLETED' || status === 'FAILED' || status === 'INTERRUPTED') ? Date.now() : null,
                progressInfo: { percent, statusText: text },
                errorInfo: error
            });
        };

        updateStatus('IN_PROGRESS', 5, 'Acquiring source data...');

        try {
            const durationMs = dateRange.endTimestamp - dateRange.startTimestamp;
            
            // 🔒 5. Execute Source Acquisition via BackgroundDataMiner
            const rawCandles = await BackgroundDataMiner.mineHistoricalCandles(
                symbol,
                timeframe,
                durationMs,
                (progress) => {
                    const scaledPercent = 5 + Math.floor(progress.percent * 0.9);
                    updateStatus('IN_PROGRESS', scaledPercent, `Mining: ${progress.statusText}`);
                },
                dateRange.startTimestamp,
                dateRange.endTimestamp
            );

            if (!rawCandles || rawCandles.length === 0) {
                throw new Error('BackgroundDataMiner returned empty data for the requested range.');
            }

            // 🔒 6. Safely retain the artifact for the M1-M4 pipeline
            this.artifacts.set(job.jobId, rawCandles);

            // 🔒 7. Explicitly claim ONLY acquisition success (Dataset is NOT built yet)
            updateStatus('COMPLETED', 100, 'Source acquisition completed successfully.');

        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isInterrupted = /cancel|abort/i.test(errorMessage);

            updateStatus(
                isInterrupted ? 'INTERRUPTED' : 'FAILED',
                0,
                'Processing stopped.',
                errorMessage
            );
        }
    }
}
