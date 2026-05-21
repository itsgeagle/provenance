/**
 * CLI entry point.
 *
 * Usage:
 *   node dist/index.js [--mode=<api|worker|all>]
 *
 * Modes:
 *   api    — start the HTTP API server (default)
 *   worker — start the background job worker (stub until Phase 12)
 *   all    — boot api only for now (worker added in Phase 12)
 */
import { startApi } from './api/start.js';
import { startWorker } from './jobs/worker.js';

const args = process.argv.slice(2);
const modeArg = args.find((a) => a.startsWith('--mode='));
const mode = modeArg ? modeArg.split('=')[1] : 'api';

switch (mode) {
  case 'api':
  case 'all':
    startApi();
    break;
  case 'worker':
    startWorker();
    break;
  default:
    console.error(`Unknown --mode="${mode}". Expected: api | worker | all`);
    process.exit(1);
}
