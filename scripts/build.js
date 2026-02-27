#!/usr/bin/env node
// SPDX-License-Identifier: MIT

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const rawArgs = process.argv.slice(2);
const disableCleanup = rawArgs.includes('--no-cleanup');
const wantsHelp = rawArgs.includes('--help') || rawArgs.includes('-h');
const platformArg = (rawArgs.find(arg => !arg.startsWith('--')) || 'current').toLowerCase();
const passthroughFlags = rawArgs
  .filter(arg => arg.startsWith('--'))
  .filter(arg => arg !== '--no-cleanup');

const platformFlagsByTarget = {
  current: [],
  all: [],
  mac: ['--mac'],
  win: ['--win'],
  windows: ['--win'],
  linux: ['--linux'],
};

if (platformArg === 'help' || platformArg === '--help' || platformArg === '-h' || wantsHelp) {
  printUsage();
  process.exit(0);
}

const platformFlags = platformFlagsByTarget[platformArg];
if (!platformFlags) {
  console.error(`[build] Unknown target '${platformArg}'.`);
  printUsage();
  process.exit(1);
}

const electronBuilderBin = process.platform === 'win32'
  ? path.join('node_modules', '.bin', 'electron-builder.cmd')
  : path.join('node_modules', '.bin', 'electron-builder');

if (!existsSync(electronBuilderBin)) {
  console.error('[build] Local electron-builder not found in node_modules. Run: npm install');
  process.exit(1);
}

const args = [...platformFlags, ...passthroughFlags];

console.log(`[build] Running: ${electronBuilderBin} ${args.join(' ')}`);

const result = spawnSync(electronBuilderBin, args, {
  stdio: 'inherit',
  shell: false,
});

if (typeof result.status === 'number') {
  if (result.status === 0 && !disableCleanup && !passthroughFlags.includes('--dir') && !passthroughFlags.includes('--help')) {
    const cleanupResult = spawnSync('node', ['scripts/cleanup-dist.js'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    if (typeof cleanupResult.status === 'number' && cleanupResult.status !== 0) {
      process.exit(cleanupResult.status);
    }
  }

  process.exit(result.status);
}

process.exit(1);

function printUsage() {
  console.log('Usage: npm run build -- [current|all|mac|win|linux] [--dir] [--no-cleanup] [extra electron-builder flags]');
  console.log('Examples:');
  console.log('  npm run build');
  console.log('  npm run build -- mac');
  console.log('  npm run build -- win');
  console.log('  npm run build -- linux --dir');
  console.log('  npm run build -- mac --no-cleanup');
}
