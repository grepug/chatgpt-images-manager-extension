import { readdir, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const file of await readdir('extension')) {
  if (!file.endsWith('.js')) continue;
  const result = spawnSync(process.execPath, ['--check', `extension/${file}`], { encoding: 'utf8' });
  if (result.status) { process.stderr.write(result.stderr); process.exit(result.status); }
}
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
for (const path of [manifest.background.service_worker, ...manifest.content_scripts.flatMap(script => script.js), ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]) await access(`extension/${path}`);
if (manifest.host_permissions.join(',') !== 'https://chatgpt.com/*') throw new Error('Unexpected website permission');
console.log('JavaScript syntax, manifest resources and website permissions verified.');
