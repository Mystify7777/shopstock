// Entry point for Vercel (see vercel.json and docs/DEPLOYMENT.md). Vercel runs the
// default export, an Express app, as a serverless function. For a host that runs one
// long-lived process, use server.js (`npm start`) instead.

import { createServerlessApp } from './src/serverless.js';

export default createServerlessApp();
