// Guards: APP_VERSION (js/app.js) must match sw.js VERSION.
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8').match(/APP_VERSION = '([^']+)'/)[1];
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8').match(/VERSION = 'tl-v([^']+)'/)[1];
if (app !== sw) { console.log(`FAIL version mismatch: app ${app} vs sw ${sw}`); process.exit(1); }
console.log(`PASS version in sync (${app})`);
