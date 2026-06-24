'use strict';
// Shared driver for the bulk enrollment tools (enroll/spot.js, enroll/perp.js).
// Generates N wallets, runs a concurrency-bounded worker pool that auths -> enrolls ->
// (optionally) generates volume per account, prints progress, and writes the result + JWT files.
//
// The spot/perp difference lives entirely in the `hooks` passed by each tool:
//   { mode?, filePrefix, jwtPrefix, printConfig(opts), runVolume(rl,opts,addr,jwt),
//     volumeLine(volume,opts)->string, printVolumeSummary(results,opts), outDir? }

const fs = require('fs');
const path = require('path');
const { Wallet } = require('ethers');
const { sleep, createRateLimiter } = require('./http');
const { authenticate, enroll } = require('./accounts');

async function worker(queue, results, jwts, opts, rl, onResult, runVolume) {
  while (queue.length > 0) {
    const job = queue.shift();
    if (!job) break;

    const auth = await authenticate(rl, opts.authBase, job.wallet, opts.maxRetries);
    if (!auth.ok) {
      const result = { address: job.wallet.address, status: 'failed', httpStatus: auth.httpStatus, body: { error: { code: `AUTH_${auth.stage.toUpperCase()}_FAILED`, ...auth.body } } };
      results.push(result); onResult(result);
      if (opts.delay > 0) await sleep(opts.delay);
      continue;
    }
    jwts.push({ address: job.wallet.address, jwt: auth.accessToken });

    const result = await enroll(rl, opts.base, opts.competition, job.wallet.address, auth.accessToken, opts.maxRetries, opts.terms);

    // Generate volume regardless of enroll outcome (we have a valid JWT + fundable accounts).
    if (runVolume) {
      try { result.volume = await runVolume(rl, opts, job.wallet.address, auth.accessToken); }
      catch (err) { result.volume = { error: String(err) }; }
    }
    results.push(result); onResult(result);
    if (opts.delay > 0) await sleep(opts.delay);
  }
}

async function runEnrollment(opts, hooks) {
  if (!Number.isFinite(opts.count) || opts.count <= 0) { console.error('--count must be a positive integer'); process.exit(2); }

  console.log(`Generating ${opts.count} wallets...`);
  const queue = [];
  for (let i = 0; i < opts.count; i++) queue.push({ wallet: Wallet.createRandom() });

  console.log(`Auth via ${opts.authBase}`);
  console.log(`Enroll into "${opts.competition}" on ${opts.base}`);
  console.log(`Concurrency: ${opts.concurrency}, rps: ${opts.rps}, max-retries: ${opts.maxRetries}, delay: ${opts.delay}ms, terms_accepted: ${opts.terms}`);
  if (opts.volume) hooks.printConfig(opts); else console.log('Volume: OFF (--volume false)');
  console.log('');

  const rl = createRateLimiter(opts.rps);
  const total = queue.length;
  const results = [];
  const jwts = [];
  let done = 0;
  const onResult = (r) => {
    done++;
    const marker = r.status === 'enrolled' ? 'OK' : r.status === 'already_enrolled' ? 'DUP' : 'ERR';
    const note = r.status === 'failed' ? ` (${r.httpStatus} ${r.body?.error?.code || 'unknown'})` : '';
    let vol = '';
    if (r.volume) vol = r.volume.error ? ` | vol ERR: ${r.volume.error}` : hooks.volumeLine(r.volume, opts);
    console.log(`[${done}/${total}] ${marker} ${r.address}${note}${vol}`);
  };

  const startedAt = Date.now();
  const runVolume = opts.volume ? hooks.runVolume : null;
  const workers = [];
  for (let i = 0; i < opts.concurrency; i++) workers.push(worker(queue, results, jwts, opts, rl, onResult, runVolume));
  await Promise.all(workers);
  const elapsedMs = Date.now() - startedAt;

  const summary = {
    enrolled:         results.filter((r) => r.status === 'enrolled').length,
    already_enrolled: results.filter((r) => r.status === 'already_enrolled').length,
    failed:           results.filter((r) => r.status === 'failed').length,
  };
  console.log('');
  console.log(`Done in ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`  enrolled:         ${summary.enrolled}`);
  console.log(`  already_enrolled: ${summary.already_enrolled}`);
  console.log(`  failed:           ${summary.failed}`);
  if (summary.failed > 0) {
    const codes = {};
    for (const r of results) { if (r.status !== 'failed') continue; const c = r.body?.error?.code || `HTTP_${r.httpStatus}`; codes[c] = (codes[c] || 0) + 1; }
    console.log('  failure breakdown:', codes);
  }
  if (opts.volume) hooks.printVolumeSummary(results, opts);

  // Output lands in the competition/ root by default so the parent .gitignore (which ignores
  // competition/enrollments-*.json and competition/wallet-jwts-*.json — they hold live JWTs) applies.
  const outDir = hooks.outDir || path.resolve(__dirname, '..');
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${hooks.filePrefix}-${opts.competition}-${ts}.json`);
  const doc = {
    base: opts.base, competition: opts.competition,
    ...(hooks.mode ? { mode: hooks.mode } : {}),
    started_at: new Date(startedAt).toISOString(), elapsed_ms: elapsedMs, summary, results,
  };
  fs.writeFileSync(outFile, JSON.stringify(doc, null, 2));
  console.log(`\nResults written to ${outFile}`);

  const jwtFile = path.join(outDir, `${hooks.jwtPrefix}-${opts.competition}-${ts}.json`);
  fs.writeFileSync(jwtFile, JSON.stringify(jwts, null, 2));
  console.log(`JWTs written to  ${jwtFile} (${jwts.length} entries)`);

  process.exit(summary.failed > 0 ? 1 : 0);
}

module.exports = { runEnrollment };
