#!/usr/bin/env node
// 薄入口：把 CLI 交给 src/cli/atlas.mjs，保持 npm bin 稳定。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'src', 'cli', 'atlas.mjs');
const r = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
