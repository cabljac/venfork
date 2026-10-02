import { mkdirSync } from 'node:fs';
import path from 'node:path';

const suite = process.argv[2];
if (suite !== 'unit' && suite !== 'integration') {
  console.error('usage: bun scripts/run-suite.ts <unit|integration>');
  process.exit(2);
}

const root = path.resolve(import.meta.dir, '..');
const reports = path.join(root, '.test-reports');
mkdirSync(reports, { recursive: true });
const report = path.join(reports, `${suite}.xml`);
const startedAt = Date.now();

const run = (args: string[]) =>
  Bun.spawnSync([process.execPath, ...args], {
    cwd: root,
    stdio: ['inherit', 'inherit', 'inherit'],
  }).exitCode;

const tests = run([
  'run',
  `test:${suite}`,
  '--reporter=junit',
  `--reporter-outfile=${report}`,
]);
const gate = run([
  path.join(root, 'scripts', 'test-count.ts'),
  suite,
  report,
  '--since',
  String(startedAt),
]);
process.exit(tests !== 0 ? tests : gate);
