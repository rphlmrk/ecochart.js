import { ML1DatasetProcessor } from '../indicators/mlr1/integration/ML1DatasetProcessor';
import { BackgroundDataMiner } from '../data/BackgroundDataMiner';

function assert(condition: boolean, msg: string): asserts condition {
    if (!condition) throw new Error(`[Phase5CAssertionFailed] ${msg}`);
}

function createSyntheticBuffer(timestamps: number[], price = 100): Float64Array {
    const buf = new Float64Array(timestamps.length * 6);
    for (let i = 0; i < timestamps.length; i++) {
        const base = i * 6;
        buf[base] = timestamps[i];
        buf[base + 1] = price;
        buf[base + 2] = price + 1;
        buf[base + 3] = price - 1;
        buf[base + 4] = price;
        buf[base + 5] = 10;
    }
    return buf;
}

async function waitForTerminalStatus(jobId: string, timeoutMs = 3000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const job = ML1DatasetProcessor.getJob(jobId);
        if (job?.status === 'COMPLETED' || job?.status === 'FAILED' || job?.status === 'INTERRUPTED') {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Job ${jobId} did not reach a terminal status within ${timeoutMs}ms.`);
}

export async function runPhase5CAcceptanceSuite(): Promise<boolean> {
    console.log('\n======================================================');
    console.log('🧪 Starting Milestone 5 Phase 5C Acceptance Suite');
    console.log('======================================================\n');
    let passed = 0;
    let failed = 0;

    const runTest = async (name: string, testFn: () => void | Promise<void>) => {
        try {
            await testFn();
            passed++;
            console.log(`  ✅ Passed: ${name}`);
        } catch (e: unknown) {
            failed++;
            console.error(`  ❌ Failed: ${name} - ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    const interval = 60_000;
    // 🔒 Minute-align the fixture so start and end boundaries cleanly pass interval-grid validation
    const start = Math.floor(1_700_000_000_000 / interval) * interval;
    const end60 = start + 60 * interval;

    // --- 1. COVERAGE EVALUATION TESTS ---

    await runTest('1. Complete 60-candle sequence', () => {
        const timestamps = Array.from({ length: 60 }, (_, i) => start + i * interval);
        const buf = createSyntheticBuffer(timestamps);
        const cov = ML1DatasetProcessor.evaluateCoverage(buf, start, end60, interval);
        assert(cov.isComplete === true, 'Should be marked complete');
        assert(cov.missingCandles === 0, 'Missing candles should be 0');
        assert(cov.actualCandles === 60, 'Actual candles should be 60');
        assert(cov.expectedCandles === 60, 'Expected candles should be 60');
    });

    await runTest('2. One missing middle candle', () => {
        const timestamps = Array.from({ length: 60 }, (_, i) => start + i * interval).filter((_, i) => i !== 30);
        const buf = createSyntheticBuffer(timestamps);
        const cov = ML1DatasetProcessor.evaluateCoverage(buf, start, end60, interval);
        assert(cov.isComplete === false, 'Should be incomplete');
        assert(cov.missingCandles === 1, 'Should report 1 missing candle');
        assert(cov.actualCandles === 59, 'Actual should be 59');
    });

    await runTest('3. Two missing leading candles', () => {
        const timestamps = Array.from({ length: 60 }, (_, i) => start + i * interval).slice(2);
        const buf = createSyntheticBuffer(timestamps);
        const cov = ML1DatasetProcessor.evaluateCoverage(buf, start, end60, interval);
        assert(cov.isComplete === false, 'Should be incomplete');
        assert(cov.missingCandles === 2, 'Should report 2 missing leading candles');
    });

    await runTest('4. Three missing trailing candles', () => {
        const timestamps = Array.from({ length: 57 }, (_, i) => start + i * interval);
        const buf = createSyntheticBuffer(timestamps);
        const cov = ML1DatasetProcessor.evaluateCoverage(buf, start, end60, interval);
        assert(cov.isComplete === false, 'Should be incomplete');
        assert(cov.missingCandles === 3, 'Should report 3 missing trailing candles');
    });

    await runTest('5. Duplicate timestamp throws', () => {
        const timestamps = [start, start + interval, start + interval, start + 3 * interval];
        const buf = createSyntheticBuffer(timestamps);
        let threw = false;
        try {
            ML1DatasetProcessor.evaluateCoverage(buf, start, start + 4 * interval, interval);
        } catch (e: unknown) {
            threw = e instanceof Error && e.message.includes('duplicate or out-of-order');
        }
        assert(threw, 'Should throw on duplicate timestamp');
    });

    await runTest('6. Descending timestamp throws', () => {
        const timestamps = [start, start + 2 * interval, start + interval];
        const buf = createSyntheticBuffer(timestamps);
        let threw = false;
        try {
            ML1DatasetProcessor.evaluateCoverage(buf, start, start + 3 * interval, interval);
        } catch (e: unknown) {
            threw = e instanceof Error && e.message.includes('duplicate or out-of-order');
        }
        assert(threw, 'Should throw on descending timestamp');
    });

    await runTest('7. Unaligned timestamp throws', () => {
        const timestamps = [start, start + interval + 15];
        const buf = createSyntheticBuffer(timestamps);
        let threw = false;
        try {
            ML1DatasetProcessor.evaluateCoverage(buf, start, start + 2 * interval, interval);
        } catch (e: unknown) {
            threw = e instanceof Error && e.message.includes('Invalid source timestamp');
        }
        assert(threw, 'Should throw on unaligned timestamp');
    });

    await runTest('8. Timestamp outside requested range throws', () => {
        const timestamps = [start - interval, start];
        const buf = createSyntheticBuffer(timestamps);
        let threw = false;
        try {
            ML1DatasetProcessor.evaluateCoverage(buf, start, start + 2 * interval, interval);
        } catch (e: unknown) {
            threw = e instanceof Error && e.message.includes('Invalid source timestamp');
        }
        assert(threw, 'Should throw on timestamp outside range');
    });

    await runTest('9. Empty buffer reports all missing', () => {
        const buf = new Float64Array(0);
        const cov = ML1DatasetProcessor.evaluateCoverage(buf, start, end60, interval);
        assert(cov.isComplete === false, 'Empty buffer is incomplete');
        assert(cov.actualCandles === 0, 'Actual candles 0');
        assert(cov.missingCandles === 60, 'All 60 candles missing');
    });

    await runTest('10. Buffer length not divisible by six throws', () => {
        const buf = new Float64Array(7);
        let threw = false;
        try {
            ML1DatasetProcessor.evaluateCoverage(buf, start, end60, interval);
        } catch (e: unknown) {
            threw = e instanceof Error && e.message.includes('not divisible by six');
        }
        assert(threw, 'Should throw on buffer length not divisible by 6');
    });

    // --- 2. IDEMPOTENCY, RETRY & INPUT VALIDATION TESTS ---

    await runTest('11. Non-string inputs fail with explicit error', async () => {
        let threw = false;
        try {
            await ML1DatasetProcessor.startDatasetBuild(
                '' as any, 'DS1', 'SOLUSDT', '1m', { startTimestamp: start, endTimestamp: end60 }, 'v1', 'key1'
            );
        } catch (e: unknown) {
            threw = e instanceof Error && e.message.includes('jobId must be a non-empty string');
        }
        assert(threw, 'Should throw on empty jobId string');
    });

    await runTest('12. Conflicting request with same idempotency key is rejected', async () => {
        const originalMine = BackgroundDataMiner.mineHistoricalCandles;
        BackgroundDataMiner.mineHistoricalCandles = async () => createSyntheticBuffer(
            Array.from({ length: 60 }, (_, i) => start + i * interval)
        );
        try {
            await ML1DatasetProcessor.startDatasetBuild(
                'job-c1', 'DS-C', 'SOLUSDT', '1m', { startTimestamp: start, endTimestamp: end60 }, 'v1', 'idem-key-1'
            );
            await waitForTerminalStatus('job-c1');

            let threw = false;
            try {
                // Same key, but different symbol
                await ML1DatasetProcessor.startDatasetBuild(
                    'job-c2', 'DS-C', 'BTCUSDT', '1m', { startTimestamp: start, endTimestamp: end60 }, 'v1', 'idem-key-1'
                );
            } catch (e: unknown) {
                threw = e instanceof Error && e.message.includes('reused with conflicting request parameters');
            }
            assert(threw, 'Should reject conflicting idempotency key usage');
        } finally {
            BackgroundDataMiner.mineHistoricalCandles = originalMine;
        }
    });

    await runTest('13. Repeated completed idempotency key returns latest completed job', async () => {
        const originalMine = BackgroundDataMiner.mineHistoricalCandles;
        BackgroundDataMiner.mineHistoricalCandles = async () => createSyntheticBuffer(
            Array.from({ length: 60 }, (_, i) => start + i * interval)
        );
        try {
            const job1 = await ML1DatasetProcessor.startDatasetBuild(
                'job-r1', 'DS-R', 'SOLUSDT', '1m', { startTimestamp: start, endTimestamp: end60 }, 'v1', 'idem-key-repeat'
            );
            assert(job1.jobId === 'job-r1', 'First job must start with requested id');
            await waitForTerminalStatus('job-r1');
            assert(ML1DatasetProcessor.getJob('job-r1')?.status === 'COMPLETED', 'First job must reach COMPLETED status');

            const job2 = await ML1DatasetProcessor.startDatasetBuild(
                'job-r2', 'DS-R', 'SOLUSDT', '1m', { startTimestamp: start, endTimestamp: end60 }, 'v1', 'idem-key-repeat'
            );
            assert(job2.jobId === 'job-r1', 'Should return the existing completed job without running a new one');
        } finally {
            BackgroundDataMiner.mineHistoricalCandles = originalMine;
        }
    });

    await runTest('14. Retry after failure increments attempt count', async () => {
        const originalMine = BackgroundDataMiner.mineHistoricalCandles;
        let fail = true;
        BackgroundDataMiner.mineHistoricalCandles = async () => {
            if (fail) throw new Error('Simulated Binance Network Drop');
            return createSyntheticBuffer(Array.from({ length: 60 }, (_, i) => start + i * interval));
        };
        try {
            await ML1DatasetProcessor.startDatasetBuild(
                'job-f1', 'DS-F', 'SOLUSDT', '1m', { startTimestamp: start, endTimestamp: end60 }, 'v1', 'idem-retry'
            );
            await waitForTerminalStatus('job-f1');
            assert(ML1DatasetProcessor.getJob('job-f1')?.status === 'FAILED', 'Attempt 1 must be FAILED');

            fail = false;
            const job2 = await ML1DatasetProcessor.startDatasetBuild(
                'job-f2', 'DS-F', 'SOLUSDT', '1m', { startTimestamp: start, endTimestamp: end60 }, 'v1', 'idem-retry'
            );
            assert(job2.attempt === 2, 'Attempt count must increment to 2');
            await waitForTerminalStatus('job-f2');
            assert(ML1DatasetProcessor.getJob('job-f2')?.status === 'COMPLETED', 'Retry attempt must complete successfully');
        } finally {
            BackgroundDataMiner.mineHistoricalCandles = originalMine;
        }
    });

    await runTest('15. Concurrent jobs with different IDs remain isolated', async () => {
        const originalMine = BackgroundDataMiner.mineHistoricalCandles;
        BackgroundDataMiner.mineHistoricalCandles = async (_s, _i, _d, _p, _st, _et, signal) => {
            await new Promise(resolve => setTimeout(resolve, 60));
            if (signal?.aborted) throw new Error('Mining cancelled by user.');
            return createSyntheticBuffer(Array.from({ length: 60 }, (_, i) => start + i * interval));
        };
        try {
            const p1 = ML1DatasetProcessor.startDatasetBuild(
                'job-iso-1', 'DS-1', 'SOLUSDT', '1m', { startTimestamp: start, endTimestamp: end60 }, 'v1', 'key-iso-1'
            );
            const p2 = ML1DatasetProcessor.startDatasetBuild(
                'job-iso-2', 'DS-2', 'SOLUSDT', '1m', { startTimestamp: start, endTimestamp: end60 }, 'v1', 'key-iso-2'
            );
            await Promise.all([p1, p2]);

            assert(ML1DatasetProcessor.getJob('job-iso-1')?.status === 'IN_PROGRESS', 'Job 1 must be active before cancellation');
            ML1DatasetProcessor.cancelJob('job-iso-1');

            await Promise.all([
                waitForTerminalStatus('job-iso-1'),
                waitForTerminalStatus('job-iso-2')
            ]);

            const j1 = ML1DatasetProcessor.getJob('job-iso-1');
            const j2 = ML1DatasetProcessor.getJob('job-iso-2');
            assert(j1?.status === 'INTERRUPTED', 'Job 1 should be cancelled');
            assert(j2?.status === 'COMPLETED', 'Job 2 should complete independently');
        } finally {
            BackgroundDataMiner.mineHistoricalCandles = originalMine;
        }
    });

    await runTest('16. Defensive copy of source artifact prevents mutation of internal storage', async () => {
        const originalMine = BackgroundDataMiner.mineHistoricalCandles;
        BackgroundDataMiner.mineHistoricalCandles = async () => createSyntheticBuffer(
            Array.from({ length: 60 }, (_, i) => start + i * interval)
        );
        try {
            await ML1DatasetProcessor.startDatasetBuild(
                'job-def', 'DS-DEF', 'SOLUSDT', '1m', { startTimestamp: start, endTimestamp: end60 }, 'v1', 'key-def'
            );
            await waitForTerminalStatus('job-def');

            const firstCopy = ML1DatasetProcessor.getSourceArtifact('job-def');
            assert(firstCopy !== undefined, 'Artifact must exist');
            firstCopy[1] = 999999; // Mutate caller copy

            const secondCopy = ML1DatasetProcessor.getSourceArtifact('job-def');
            assert(secondCopy !== undefined && secondCopy[1] !== 999999, 'Mutating returned artifact must not alter stored artifact');
        } finally {
            BackgroundDataMiner.mineHistoricalCandles = originalMine;
        }
    });

    await runTest('17. Releasing an artifact removes buffer without deleting job metadata', async () => {
        const originalMine = BackgroundDataMiner.mineHistoricalCandles;
        BackgroundDataMiner.mineHistoricalCandles = async () => createSyntheticBuffer(
            Array.from({ length: 60 }, (_, i) => start + i * interval)
        );
        try {
            await ML1DatasetProcessor.startDatasetBuild(
                'job-rel', 'DS-REL', 'SOLUSDT', '1m', { startTimestamp: start, endTimestamp: end60 }, 'v1', 'key-rel'
            );
            await waitForTerminalStatus('job-rel');

            assert(ML1DatasetProcessor.getSourceArtifact('job-rel') !== undefined, 'Artifact must exist initially');
            const released = ML1DatasetProcessor.releaseSourceArtifact('job-rel');
            assert(released === true, 'releaseSourceArtifact must return true on success');
            assert(ML1DatasetProcessor.getSourceArtifact('job-rel') === undefined, 'Artifact buffer must be cleaned up');
            assert(ML1DatasetProcessor.getJob('job-rel')?.status === 'COMPLETED', 'Job status must remain intact');
        } finally {
            BackgroundDataMiner.mineHistoricalCandles = originalMine;
        }
    });

    await runTest('18. Defensive copy of job objects prevents mutation of internal state', async () => {
        const job = ML1DatasetProcessor.getJob('job-rel');
        assert(job !== undefined, 'Job must exist');
        (job as any).status = 'FAILED'; // Deliberate runtime cast testing immutability
        const freshJob = ML1DatasetProcessor.getJob('job-rel');
        assert(freshJob?.status === 'COMPLETED', 'Internal registry job status was mutated');
    });

    console.log(`\nPhase 5C Acceptance: ${passed} passed, ${failed} failed.`);
    return failed === 0;
}

