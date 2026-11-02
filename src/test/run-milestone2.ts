import { runPhase2ATests } from './milestone2a-acceptance';
import { runPhase2JTests } from './milestone2j-acceptance';
import { generatePhase2JReports } from '../analysis/ML1FeatureAuditGenerator';

const resA = runPhase2ATests();
const resJ = runPhase2JTests();

// Execute the Phase 2J audit report generator after all acceptance tests pass
// This will print the reports directly to the console
let auditPassed = false;
if (resA && resJ) {
    const auditRes = generatePhase2JReports();
    auditPassed = auditRes.passed;
}

process.exit(resA && resJ && auditPassed ? 0 : 1);
