import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const directory = mkdtempSync(join('/tmp', 'images-safari-build-'));
const path = join(directory, 'build.json');
const legacy = process.argv.includes('--legacy-export');
const signing = legacy ? { identity:'-', team:'' } : JSON.parse(readFileSync(resolve('.local-signing.json'),'utf8'));
writeFileSync(path, JSON.stringify({
  projectPath: resolve(legacy ? 'build/legacy-safari/ChatGPT Images Manager/ChatGPT Images Manager.xcodeproj' : 'build/safari/ChatGPT Images Manager/ChatGPT Images Manager.xcodeproj'),
  scheme: 'ChatGPT Images Manager', configuration: 'Debug', derivedDataPath: resolve(legacy ? 'build/LegacyDerivedData' : 'build/NativeDerivedData'),
  extraArgs: ['CODE_SIGN_STYLE=Manual', `CODE_SIGN_IDENTITY=${signing.identity}`, `DEVELOPMENT_TEAM=${signing.team}`, 'CODE_SIGNING_ALLOWED=YES', 'REGISTER_APP_GROUPS=NO', 'SWIFT_OPTIMIZATION_LEVEL=-O']
}, null, 2));
console.log(`Build parameters: ${path}`);
const result = spawnSync('xcodebuildmcp', ['macos', process.argv.includes('--build-only') ? 'build' : 'build-and-run', '--json', readFileSync(path, 'utf8')], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
