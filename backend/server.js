// Real boot entrypoint (Phase 5A). Loads/validates env, connects to
// MongoDB, builds the Express app, and starts listening. This is the ONLY
// module that performs these three side effects together -- app.js stays
// importable by tests without any of them.

import 'dotenv/config';
import { loadConfig } from './src/config/env.js';
import { connectDb } from './src/config/db.js';
import { createApp } from './src/app.js';

const config = loadConfig(); // exits the process on missing required vars

async function start() {
  try {
    await connectDb(config.mongodbUri);
    console.log('[ShopStock backend] MongoDB connected.');
  } catch (err) {
    console.error('[ShopStock backend] Failed to connect to MongoDB:', err.message);
    process.exit(1);
  }

  const app = createApp({ corsOrigin: config.corsOrigin });

  app.listen(config.port, () => {
    console.log(`[ShopStock backend] Listening on port ${config.port} (${config.nodeEnv}).`);
  });
}

start();

