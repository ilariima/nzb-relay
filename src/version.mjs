import { readFileSync } from 'node:fs';

// Read the shipped package.json so the health endpoint and outgoing User-Agent
// strings always match the released build. Electron's asar-aware fs makes this
// work identically in the packaged app and in headless Node mode.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const APP_VERSION = manifest.version;
export const USER_AGENT = `NZBRelay/${APP_VERSION}`;
export const FETCH_USER_AGENT = `${USER_AGENT} (+https://github.com/ilariima/nzb-relay)`;
