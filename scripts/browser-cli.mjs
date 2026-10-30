import {fileURLToPath} from 'node:url';

// Use the version in package-lock.json even when a different CLI is on PATH.
export const agentBrowser = fileURLToPath(new URL('../node_modules/.bin/agent-browser', import.meta.url));
