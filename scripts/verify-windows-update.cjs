'use strict';
const path = require('node:path');
const { verifyDirectory } = require('./lib/windows-update.cjs');

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: npm run update:verify:win -- <version-output-directory>');
  const directory = path.resolve(process.argv[2]);
  const { summary } = await verifyDirectory(directory);
  console.log(JSON.stringify(summary, null, 2));
}
main().catch(error => { console.error('[FAILED] ' + error.message); process.exitCode = 1; });
