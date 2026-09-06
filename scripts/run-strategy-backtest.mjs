import { readFile, writeFile } from 'node:fs/promises';
import { runComparison } from '../lib/backtest/engine.mjs';

const [input, config, output] = process.argv.slice(2);
if (!input) throw Error('Usage: node scripts/run-strategy-backtest.mjs PIT_DATA.json [PARAMETERS.json|-] [NEW_REPORT.json]');
const data = JSON.parse(await readFile(input, 'utf8'));
const parameters = config && config !== '-' ? JSON.parse(await readFile(config, 'utf8')) : {};
const report = JSON.stringify(runComparison(data, parameters), null, 2) + '\n';
if (output) await writeFile(output, report, { flag: 'wx' });
else process.stdout.write(report);
