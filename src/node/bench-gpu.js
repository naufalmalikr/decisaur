/**
 * GPU throughput/latency benchmark harness for tev1:0.8b.
 *
 * WHAT IS MEASURED
 *
 *   1. A concurrency sweep over `POST /api/generate`. Each level fires N
 *      sustained requests with a fixed `num_predict`, all overlapping, while
 *      `nvidia-smi` samples VRAM and GPU utilisation in parallel. Decode and
 *      prefill tok/s come from Ollama's own counters (`eval_count` /
 *      `eval_duration`, `prompt_eval_count` / `prompt_eval_duration`), not
 *      wall-clock guesswork. Latency percentiles come from per-request wall
 *      clock.
 *
 *   2. The System One decision endpoint (`POST /v1/systemone`), using the real
 *      question set from `src/ollama/decider.js`. This is the one-query-per-
 *      obstacle load the game loop actually puts on the card.
 *
 * WHY
 *
 * The sweep's FIRST question is not about the GPU at all: does Ollama even run
 * overlapping requests concurrently? The runner is started with a fixed number
 * of parallel slots (`llama-server -np <n>`, set from OLLAMA_NUM_PARALLEL,
 * default 1). With one slot every request is queued and served alone, so flat
 * throughput under concurrency means the server serialised the work - the GPU
 * was never asked to do concurrent work, and NO saturation conclusion is
 * possible. The harness detects that from the data (level wall time failing to
 * drop as concurrency rises, VRAM flat across levels) and reports it as a
 * server property instead of blaming the card. Only when requests genuinely
 * overlapped do the throughput numbers describe the GPU, and then the question
 * is whether a memory-bandwidth-bound model (752M Q8_0 on a GTX 1050 Ti Max-Q,
 * ~51 tok/s decode measured) gains anything from batching or is already at its
 * ceiling.
 *
 * The second measurement makes the contrast concrete. The game loop asks the
 * model ONE question per obstacle with `LOOP.maxConcurrent: 1`. At top speed
 * (13px/frame @ 60fps = 780px/s) an obstacle is visible for ~590ms inside
 * `LOOP.perceptionRange` (460px), so the loop can consume roughly one query per
 * obstacle - a tiny fraction of what this card can serve, however the sweep
 * turns out.
 *
 * WHAT A GPU BENCHMARK DOES NOT TELL YOU
 *
 * It does not tell you the model is *correct*. tev1:0.8b is a classifier whose
 * one systematic error (reading a body-height bird as bird_high) is caught by
 * the policy gate, not by speed. It does not tell you the game gets faster or
 * better with more tok/s: the dino is driven by geometry at ~0 cost, and the
 * model's answer is checked against collision boxes before it may act. And raw
 * generation capacity - however high - says nothing about the 1-query-per-
 * obstacle regime the bot actually runs in: that is why the System One phase is
 * measured separately, not interpolated.
 *
 *   node src/node/bench-gpu.js
 *   node src/node/bench-gpu.js --concurrency 1,4 --requests 4 --num-predict 64 --warmup 1
 *   node src/node/bench-gpu.js --skip-systemone
 */

import * as childProcess from 'node:child_process';
import { DEFAULT_HOST, DEFAULT_MODEL, KEEP_ALIVE, LOOP } from '../config.js';
import { QUESTIONS } from '../ollama/decider.js';

/** Scene descriptions reused across both phases; only what is on screen, never the class. */
const SCENES = [
  'The T-Rex is running on the ground. A cactus stands on the ground ahead of it, blocking the way.',
  'The T-Rex is running on the ground. A pterodactyl flies high in the air above the T-Rex, clear underneath.',
  'The T-Rex is running on the ground. A pterodactyl flies low, at the height of the T-Rex.',
];

const GENERATE_PROMPT = SCENES[0];

function parseArgs(argv) {
  const args = {
    host: undefined,
    model: DEFAULT_MODEL,
    concurrency: '1,2,4,8',
    numPredict: 128,
    requests: 8,
    warmup: 2,
    sampleMs: 200,
    skipGenerate: false,
    skipSystemone: false,
  };
  const valueOf = (argv, i) => {
    const next = argv[i + 1];
    return next === undefined || next.startsWith('--') ? undefined : next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = valueOf(argv, i);
    if (flag === '--host') { if (value !== undefined) { args.host = value; i += 1; } }
    else if (flag === '--model') { if (value !== undefined) { args.model = value; i += 1; } }
    else if (flag === '--concurrency') { if (value !== undefined) { args.concurrency = value; i += 1; } }
    else if (flag === '--num-predict') { args.numPredict = Number.parseInt(value ?? '128', 10); i += 1; }
    else if (flag === '--requests') { args.requests = Number.parseInt(value ?? '8', 10); i += 1; }
    else if (flag === '--warmup') { args.warmup = Number.parseInt(value ?? '2', 10); i += 1; }
    else if (flag === '--sample-ms') { args.sampleMs = Number.parseInt(value ?? '200', 10); i += 1; }
    else if (flag === '--skip-generate') args.skipGenerate = true;
    else if (flag === '--skip-systemone') args.skipSystemone = true;
  }
  args.levels = args.concurrency.split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
  if (args.levels.length === 0) args.levels = [1, 2, 4, 8];
  return args;
}

/** Percentile of an unsorted array of samples: sort, then index. */
function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '-';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return '-';
  return n >= 1000 ? n.toFixed(0) : n >= 100 ? n.toFixed(1) : n.toFixed(2);
}

async function fetchJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return response.json();
}

/**
 * Sample `nvidia-smi` on an interval while a concurrency level runs.
 * Absent tool, absent GPU, or a non-zero exit are reported, never thrown.
 */
class GpuSampler {
  constructor(intervalMs) {
    this.intervalMs = intervalMs;
    this.vramUsed = [];
    this.utilisation = [];
    this.timer = null;
    this.child = null;
    this.available = null; // null unknown, true/false after first sample
    this.note = '';
  }

  start() {
    this.startedAt = Date.now();
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
  }

  sample() {
    const { spawn } = childProcess;
    this.child = spawn('nvidia-smi', ['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    this.child.stdout.on('data', (chunk) => { out += chunk; });
    this.child.on('error', () => {
      if (this.available === null) { this.available = false; this.note = 'nvidia-smi not found on PATH - no GPU telemetry'; }
    });
    this.child.on('close', (code) => {
      if (code !== 0) {
        if (this.available === null) { this.available = false; this.note = `nvidia-smi exited ${code} - no GPU telemetry`; }
        return;
      }
      for (const line of out.split('\n').filter((l) => l.trim() !== '')) {
        const [mem, util] = line.split(',').map((s) => Number.parseFloat(s.trim()));
        if (Number.isFinite(mem)) { this.available = true; this.vramUsed.push(mem); }
        if (Number.isFinite(util)) { this.available = true; this.utilisation.push(util); }
      }
    });
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    return {
      available: this.available === true,
      note: this.note,
      samples: Math.max(this.vramUsed.length, this.utilisation.length),
      peakVramMiB: this.vramUsed.length > 0 ? Math.max(...this.vramUsed) : NaN,
      meanUtil: this.utilisation.length > 0 ? this.utilisation.reduce((a, b) => a + b, 0) / this.utilisation.length : NaN,
      maxUtil: this.utilisation.length > 0 ? Math.max(...this.utilisation) : NaN,
    };
  }
}

/** One /api/generate request, non-streaming, with Ollama's own counters. */
async function generateOnce(host, model, numPredict) {
  const startedAt = Date.now();
  const data = await fetchJson(`${host}/api/generate`, {
    model,
    prompt: GENERATE_PROMPT,
    stream: false,
    keep_alive: KEEP_ALIVE,
    options: { num_predict: numPredict },
  });
  return {
    wallMs: Date.now() - startedAt,
    doneReason: data.done_reason ?? '-',
    evalCount: data.eval_count ?? 0,
    evalDurationNs: data.eval_duration ?? 0,
    promptEvalCount: data.prompt_eval_count ?? 0,
    promptEvalDurationNs: data.prompt_eval_duration ?? 0,
    loadDurationNs: data.load_duration ?? 0,
  };
}

/** One /v1/systemone decision, the shape the game loop actually sends. */
async function systemoneOnce(host, model, scene) {
  const startedAt = Date.now();
  await fetchJson(`${host}/v1/systemone`, {
    model,
    state: scene,
    questions: QUESTIONS,
    keep_alive: KEEP_ALIVE,
  });
  return Date.now() - startedAt;
}

const args = parseArgs(process.argv.slice(2));
const host = args.host ?? process.env.OLLAMA_HOST ?? DEFAULT_HOST;
const gpuTotalMiB = 4096; // GTX 1050 Ti Max-Q; only used to label the residency ratio.

console.log(`decisaur GPU benchmark`);
console.log(`  host         ${host}`);
console.log(`  model        ${args.model}`);
console.log(`  num_predict  ${args.numPredict} (inside options - top-level num_predict is ignored by Ollama)`);
console.log(`  levels       ${args.levels.join(', ')}`);
console.log(`  requests     ${args.requests} per level, all overlapping`);
console.log(`  warmup       ${args.warmup} requests before any timing`);
console.log(`  sampling     nvidia-smi every ${args.sampleMs}ms`);
console.log('');

if (args.skipGenerate && args.skipSystemone) {
  console.log('nothing to do: both --skip-generate and --skip-systemone given');
  process.exit(0);
}

// ---- warmup: load the model and confirm GPU residency before timing anything ----

console.log(`=== warmup (${args.warmup} request(s), unmeasured) ===`);
try {
  for (let i = 0; i < args.warmup; i += 1) {
    const startedAt = Date.now();
    const r = await generateOnce(host, args.model, args.numPredict);
    console.log(`  warmup ${i + 1}: ${r.evalCount} tok in ${fmtMs(Date.now() - startedAt)} (done_reason ${r.doneReason})`);
  }
} catch (error) {
  console.error(`FATAL: warmup generate failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error('Is Ollama running and the model pulled? The sweep cannot run without it.');
  process.exit(1);
}

/** Residency from /api/ps: size_vram / size, reported PROCESSOR-style. */
let residency = null;
try {
  const psResponse = await fetch(`${host}/api/ps`);
  const ps = await psResponse.json();
  const entry = (ps.models ?? []).find((m) => m.name === args.model || m.model === args.model);
  if (entry && entry.size > 0) {
    residency = {
      sizeVram: entry.size_vram ?? 0,
      size: entry.size,
      contextLength: entry.context_length ?? null,
    };
  }
} catch {
  // reported below as unknown
}

if (residency) {
  const gpuFraction = residency.sizeVram / residency.size;
  const processor = gpuFraction >= 0.99 ? '100% GPU' : `${Math.round(gpuFraction * 100)}% GPU`;
  const vramMiB = (residency.sizeVram / (1024 * 1024)).toFixed(0);
  console.log(`  residency    ${args.model}: ${vramMiB} MB in VRAM, PROCESSOR ${processor}${residency.contextLength ? `, CONTEXT ${residency.contextLength}` : ''} (of ${gpuTotalMiB} MiB card)`);
  if (gpuFraction < 0.99) {
    console.log('');
    console.log('  *** WARNING: model is NOT fully resident on the GPU. ***');
    console.log('  *** Every number below this line is partly CPU-bound and does not describe GPU capacity. ***');
  }
} else {
  console.log('  residency    UNKNOWN - /api/ps did not report the model.');
  console.log('  *** Numbers below are unqualified: confirm GPU residency before trusting them. ***');
}
console.log('');

const sweepResults = [];

// ---- phase 1: concurrency sweep over /api/generate ----

if (!args.skipGenerate) {
  for (const level of args.levels) {
    console.log(`=== concurrency ${level} : ${args.requests} overlapping generate request(s), ${args.numPredict} tok each ===`);
    const sampler = new GpuSampler(args.sampleMs);
    sampler.start();

    const startedAt = Date.now();
    const settled = await Promise.allSettled(
      Array.from({ length: args.requests }, (_, i) =>
        generateOnce(host, args.model, args.numPredict).then((r) => ({ index: i, ...r }))),
    );
    const levelWallMs = Date.now() - startedAt;

    const telemetry = sampler.stop();

    const latencies = [];
    let ok = 0;
    let errors = 0;
    let evalCount = 0;
    let evalDurationNs = 0;
    let promptEvalCount = 0;
    let promptEvalDurationNs = 0;
    let decodeTokPerS = NaN;
    let prefillTokPerS = NaN;

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        ok += 1;
        latencies.push(s.value.wallMs);
        evalCount += s.value.evalCount;
        evalDurationNs += s.value.evalDurationNs;
        promptEvalCount += s.value.promptEvalCount;
        promptEvalDurationNs += s.value.promptEvalDurationNs;
      } else {
        errors += 1;
        const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
        console.log(`  request failed: ${reason}`);
      }
    }

    // Aggregate tok/s from Ollama's own counters: total tokens / total model time
    // across all requests in the level. For wall-clock-request tok/s, decode time
    // dominates, so this is the throughput the card actually sustained.
    if (evalDurationNs > 0) decodeTokPerS = evalCount / (evalDurationNs / 1e9);
    if (promptEvalDurationNs > 0) prefillTokPerS = promptEvalCount / (promptEvalDurationNs / 1e9);
    const sorted = [...latencies].sort((a, b) => a - b);
    const rps = levelWallMs > 0 ? (ok / (levelWallMs / 1000)) : NaN;

    console.log(`  ok ${ok}/${args.requests}  errors ${errors}  level wall ${fmtMs(levelWallMs)}`);
    console.log(`  decode    ${fmtNum(decodeTokPerS)} tok/s  (sum eval_count / sum eval_duration over all requests)`);
    console.log(`  prefill   ${fmtNum(prefillTokPerS)} tok/s  (sum prompt_eval_count / sum prompt_eval_duration)`);
    console.log(`  latency   p50 ${fmtMs(percentile(sorted, 50))}  p95 ${fmtMs(percentile(sorted, 95))}  p99 ${fmtMs(percentile(sorted, 99))}  min ${fmtMs(sorted[0] ?? NaN)}  max ${fmtMs(sorted[sorted.length - 1] ?? NaN)}`);
    console.log(`  requests  ${fmtNum(rps)}/s achieved`);
    if (telemetry.available) {
      console.log(`  gpu       peak VRAM ${telemetry.peakVramMiB} MiB / ${gpuTotalMiB} MiB  util mean ${telemetry.meanUtil.toFixed(0)}%  max ${telemetry.maxUtil}%  (${telemetry.samples} samples)`);
    } else {
      console.log(`  gpu       ${telemetry.note || 'nvidia-smi unavailable - no GPU telemetry this level'}`);
    }
    console.log('');

    sweepResults.push({ level, ok, errors, decodeTokPerS, prefillTokPerS, sorted, rps, levelWallMs, telemetry });
  }
}

// ---- phase 2: the load the game loop actually applies - System One ----

const systemoneResults = [];

if (!args.skipSystemone) {
  console.log(`=== System One (POST /v1/systemone) : the one-query-per-obstacle load the game loop actually applies ===`);
  for (const level of [1, Math.max(...args.levels)]) {
    console.log(`  concurrency ${level}: ${args.requests} queries`);
    const latencies = [];
    let errors = 0;
    const startedAt = Date.now();
    const settled = await Promise.allSettled(
      Array.from({ length: args.requests }, (_, i) =>
        systemoneOnce(host, args.model, SCENES[i % SCENES.length]).then((ms) => ({ ms, index: i }))),
    );
    const wallMs = Date.now() - startedAt;
    for (const s of settled) {
      if (s.status === 'fulfilled') latencies.push(s.value.ms);
      else {
        errors += 1;
        const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
        console.log(`    query failed: ${reason}`);
      }
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const qps = wallMs > 0 ? (latencies.length / (wallMs / 1000)) : NaN;
    console.log(`    latency  p50 ${fmtMs(percentile(sorted, 50))}  p95 ${fmtMs(percentile(sorted, 95))}  n ${latencies.length}  errors ${errors}`);
    console.log(`    throughput ${fmtNum(qps)} queries/s sustained`);
    systemoneResults.push({ level, sorted, qps, errors });
  }

  // What the game loop can consume: one obstacle query at a time, an obstacle
  // visible for perceptionRange / speed. At top speed 13px/frame @ 60fps that
  // is 460px / 780px/s ~= 590ms per obstacle.
  const topSpeedPxPerS = 13 * 60;
  const visibleMs = (LOOP.perceptionRange / topSpeedPxPerS) * 1000;
  const loopQps = 1000 / visibleMs;
  const c1 = systemoneResults.find((r) => r.level === 1);
  const p95 = c1 ? percentile(c1.sorted, 95) : NaN;
  const headroom = Number.isFinite(p95) ? visibleMs / p95 : NaN;
  console.log('');
  console.log(`  game loop demand: 1 obstacle query at a time (LOOP.maxConcurrent 1),`);
  console.log(`  an obstacle visible ~${visibleMs.toFixed(0)}ms (perceptionRange ${LOOP.perceptionRange}px / ${topSpeedPxPerS}px/s) -> ~${loopQps.toFixed(1)} query/s needed.`);
  if (Number.isFinite(p95)) {
    console.log(`  vs System One p95 ${fmtMs(p95)} per query -> ${headroom.toFixed(1)}x headroom (${p95 > visibleMs ? 'one query may outlast one obstacle window' : 'fits inside one obstacle window'}); the game also caps itself at 1 query in flight (LOOP.maxConcurrent).`);
  }
  console.log('');
}

// ---- comparison table + verdict ----

if (sweepResults.length > 0) {
  console.log(`=== comparison ===`);
  const header = 'level  wall    ok  decode tok/s  prefill tok/s  p50     p95     p99     req/s   gpu util mean/max  peak VRAM';
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of sweepResults) {
    const gpuCell = r.telemetry.available
      ? `${r.telemetry.meanUtil.toFixed(0)}% / ${r.telemetry.maxUtil}%`.padEnd(19)
      : 'n/a'.padEnd(19);
    const vramCell = r.telemetry.available ? `${r.telemetry.peakVramMiB} MiB` : '-';
    console.log(
      `${String(r.level).padEnd(7)}${fmtMs(r.levelWallMs).padEnd(8)}${String(r.ok).padEnd(4)}${fmtNum(r.decodeTokPerS).padEnd(14)}${fmtNum(r.prefillTokPerS).padEnd(15)}${fmtMs(percentile(r.sorted, 50)).padEnd(8)}${fmtMs(percentile(r.sorted, 95)).padEnd(8)}${fmtMs(percentile(r.sorted, 99)).padEnd(8)}${fmtNum(r.rps).padEnd(8)}${gpuCell}${vramCell}`,
    );
  }

  const base = sweepResults[0];
  const best = sweepResults.reduce((a, b) => (b.decodeTokPerS > a.decodeTokPerS ? b : a));
  // `best` collapses onto `base` whenever throughput is flat, which is exactly the
  // serialisation case - quoting it would print "concurrency 1 -> concurrency 1" and
  // hide the level that actually proved the point. The widest level tested is the
  // honest comparison target for that verdict.
  const top = sweepResults.reduce((a, b) => (b.level > a.level ? b : a));
  const baseVram = sweepResults.map((r) => r.telemetry.peakVramMiB).filter(Number.isFinite);
  const vramFlat = baseVram.length > 1 && Math.max(...baseVram) - Math.min(...baseVram) < 32;

  console.log('');
  if (!Number.isFinite(best.decodeTokPerS) || !Number.isFinite(base.decodeTokPerS)) {
    console.log('VERDICT: UNDETERMINED - no level produced decodable counters (all requests failed?).');
  } else {
    const scaling = best.decodeTokPerS / base.decodeTokPerS;
    const levelWallMs = base.levelWallMs;
    const bestWallMs = best.levelWallMs;
    // With a fixed request count per level, a serialising server keeps level wall
    // flat (it is always requests x per-request time) while one request runs alone
    // early on - so min latency is far below the wall. A parallel server would cut
    // wall toward one request's time as concurrency rises. Both shapes mean the
    // requests were queued, not batched.
    const overlapped = bestWallMs < 0.9 * levelWallMs;
    if (overlapped && scaling < 1.1) {
      console.log(`VERDICT: GPU SATURATED - requests genuinely overlapped (level wall ${fmtMs(bestWallMs)} at concurrency ${best.level} vs ${fmtMs(levelWallMs)} at concurrency ${base.level}) and aggregate decode throughput still did not rise (${scaling.toFixed(2)}x, ${fmtNum(base.decodeTokPerS)} -> ${fmtNum(best.decodeTokPerS)} tok/s). The card cannot go faster.`);
    } else if (overlapped) {
      console.log(`VERDICT: GPU NOT SATURATED - overlapping requests raised aggregate decode throughput ${scaling.toFixed(2)}x (${fmtNum(base.decodeTokPerS)} -> ${fmtNum(best.decodeTokPerS)} tok/s at concurrency ${best.level}).`);
    } else {
      console.log(`VERDICT: SERVER SERIALISES - level wall time never dropped (${fmtMs(levelWallMs)} at concurrency ${base.level} -> ${fmtMs(top.levelWallMs)} at concurrency ${top.level}) while aggregate tok/s stayed flat (${scaling.toFixed(2)}x). Peak VRAM was ${vramFlat ? `flat across all levels (${baseVram[0]} MiB)` : `${Math.min(...baseVram)}-${Math.max(...baseVram)} MiB across levels`}, so nothing extra was allocated per slot either. This is queueing, not a GPU result: the server ran requests one at a time, the GPU was never asked to do concurrent work, and NO saturation conclusion can be drawn from this sweep.`);
      console.log('');
      console.log('  Why: Ollama starts llama-server with a fixed slot count - `llama-server -np <n>`,');
      console.log('  from OLLAMA_NUM_PARALLEL in the `ollama serve` environment, default 1. With -np 1');
      console.log('  every request is queued and decoded alone no matter how many clients send at once.');
      console.log('  To actually test the GPU: set OLLAMA_NUM_PARALLEL=<n> (and/or OLLAMA_MAX_LOADED_MODELS)');
      console.log('  in the ollama serve environment and re-run this harness. Caveat: a 4GB card may not');
      console.log('  fit n>1 slots at this context length anyway (852MB weights + context per slot), so');
      console.log('  the honest answer may be "one slot is all this card has".');
    }
  }
  console.log('');
  console.log('Reminder: this measures how much raw generation the card can serve concurrently.');
  console.log('It says nothing about model accuracy or the game loop, which needs ~1.7 query/s at');
  console.log('most and is bounded by LOOP.maxConcurrent 1 regardless.');
}

if (systemoneResults.length > 0) {
  const c1 = systemoneResults.find((r) => r.level === 1);
  const p50 = c1 ? percentile(c1.sorted, 50) : NaN;
  console.log('');
  console.log(`System One: p50 ${fmtMs(p50)} per decision at concurrency 1 - this is the latency budget the`);
  console.log(`game loop lives inside, not the tok/s figures above. README claims 67-280ms for this endpoint.`);
}

process.exit(0);