import { runPhase2ATests } from './milestone2a-acceptance';
import { runPhase2JTests } from './milestone2j-acceptance';
import { generatePhase2JReports } from '../analysis/ML1FeatureAuditGenerator';
import type { ML1Candle } from '../indicators/mlr1/ML1FeatureTypes';

/**
 * Complete Milestone 2 Acceptance Orchestrator.
 * Gating: Phase 2A-2H Core Engine + Phase 2J Schema + Phase 2J-B Quantitative Invariants.
 */
export function runMilestone2AcceptanceSuite(
    sourceCandles?: ML1Candle[],
    symbol?: string,
    timeframe?: string
): boolean {
    console.log('\n🚀 Starting Complete Milestone 2 Acceptance Orchestrator (Phases 2A-2J)...');

    const passedCore = runPhase2ATests();
    if (!passedCore) {
        console.error('❌ Milestone 2 Gate 1 Failed: Phase 2A-2H suite failed.');
        return false;
    }

    const passedSchema = runPhase2JTests();
    if (!passedSchema) {
        console.error('❌ Milestone 2 Gate 2 Failed: Phase 2J schema test failed.');
        return false;
    }

    const auditResult = generatePhase2JReports(sourceCandles, symbol, timeframe);
    if (!auditResult.passed) {
        console.error('❌ Milestone 2 Gate 3 Failed: Quantitative invariant audit failed.');
        return false;
    }

    console.log('\n======================================================');
    console.log('🏆 ALL MILESTONE 2 ACCEPTANCE GATES & AUDIT CRITERIA PASSED.');
    console.log('======================================================\n');
    return true;
}

const isDirectRun = typeof process !== 'undefined' && process.argv && process.argv[1]?.includes('run-milestone2');
if (isDirectRun) {
    const success = runMilestone2AcceptanceSuite();
    process.exit(success ? 0 : 1);
}
