// @ts-check
// Entry point: always starts the server, so it also works when a host or process manager loads it through its own
// wrapper instead of running it directly. No top-level await, because some wrappers load it with require(), which
// cannot load modules that use it. The app itself is in create-app.js.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createModels } from './ai.js';
import { createApp } from './create-app.js';

const env = process.env;
const { version } = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8'));
const models = createModels(env);
createApp({ models, limit: Number(env.RATE_LIMIT_PER_HOUR) || undefined, trustProxy: env.TRUST_PROXY === '1' }).then((server) => {
  server.listen(Number(env.PORT) || 3000, () => console.log(JSON.stringify({ event: 'listening', version, address: server.address(), models: models.map((m) => m.id) })));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
});
