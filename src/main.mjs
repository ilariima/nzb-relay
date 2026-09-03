import os from 'node:os';
import path from 'node:path';

import { createRelayApp } from './relay-server.mjs';

const dataDirectory = process.env.NZB_RELAY_DATA_DIR || path.join(os.homedir(), '.nzb-relay');
const app = await createRelayApp({ dataDirectory });
const address = await app.start();

console.log(`NZB Relay is running at http://${address.address}:${address.port}`);
console.log(`Configuration is stored in ${dataDirectory}`);

async function shutdown() {
  await app.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
