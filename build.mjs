import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { makeBookmarklet } from './make-bookmarklet.mjs';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/plugin.js'], bundle: true, platform: 'browser', format: 'iife', globalName: 'PiConsolePlugin', target: ['chrome110', 'firefox115', 'safari17'], minify: true, legalComments: 'eof', outfile: 'dist/pi-console.js', logLevel: 'info' });
await makeBookmarklet();
