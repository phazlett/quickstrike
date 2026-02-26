#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const distDir = path.resolve(process.cwd(), 'dist');

const removableFiles = new Set([
  'builder-effective-config.yaml',
  'builder-debug.yml',
]);

const removableDirectories = new Set([
  'mac',
  'mac-arm64',
  'mac-x64',
  'mac-universal',
  'win-unpacked',
  'linux-unpacked',
]);

function cleanupDist() {
  if (!fs.existsSync(distDir)) {
    console.log('[build] Skipped cleanup: dist/ does not exist.');
    return;
  }

  const entries = fs.readdirSync(distDir, { withFileTypes: true });
  let removedCount = 0;

  entries.forEach(entry => {
    const fullPath = path.join(distDir, entry.name);

    if (entry.isFile() && removableFiles.has(entry.name)) {
      fs.rmSync(fullPath, { force: true });
      removedCount += 1;
      return;
    }

    if (entry.isDirectory() && removableDirectories.has(entry.name)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removedCount += 1;
    }
  });

  if (removedCount > 0) {
    console.log(`[build] Cleanup complete: removed ${removedCount} item${removedCount === 1 ? '' : 's'} from dist/.`);
    return;
  }

  console.log('[build] Cleanup complete: no removable temporary build artifacts found.');
}

cleanupDist();
