import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const directory = mkdtempSync(join('/tmp', 'images-safari-build-'));
const path = join(directory, 'build.json');
writeFileSync(path, JSON.stringify({
  projectPath: resolve('build/safari/ChatGPT Images Manager/ChatGPT Images Manager.xcodeproj'),
  scheme: 'ChatGPT Images Manager', configuration: 'Debug', derivedDataPath: resolve('build/DerivedData'),
  extraArgs: ['CODE_SIGN_STYLE=Manual', 'CODE_SIGN_IDENTITY=-', 'CODE_SIGNING_ALLOWED=YES']
}, null, 2));
console.log(`Build parameters: ${path}`);
const result = spawnSync('xcodebuildmcp', ['macos', 'build-and-run', '--json', readFileSync(path, 'utf8')], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
