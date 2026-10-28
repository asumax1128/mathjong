import { parentPort } from 'node:worker_threads';
import { simulate } from './sim-new-trio.mjs';
parentPort.on('message', job => {
  if (!job) { parentPort.close(); return; }
  try { parentPort.postMessage({ result: simulate(job) }); }
  catch (e) { parentPort.postMessage({ error: e.stack, sample: job.sample }); }
});
