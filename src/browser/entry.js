/**
 * Entry point for the browser bundle.
 *
 * Exposes a small console API on `window.decisaur` and attaches to
 * `chrome://dino` automatically when the game is present.
 *
 *   decisaur.stop()    detach
 *   decisaur.stats()   current counters
 *   decisaur.mode      which build this is
 *
 * The mode is baked in at build time by `scripts/build.mjs`, so there is no mode
 * switch here to get wrong. There used to be: `decisaur.modelOnly()` meant "model
 * enabled" (i.e. model *plus* reflex) and there was no way at all to drop the
 * reflex from the console, which is the build you want when measuring what the
 * model does unaided. Both live in `modes.js`.
 */

import { Agent } from './agent.js';
import { DEFAULT_HOST, DEFAULT_MODEL } from '../config.js';
import { DEFAULT_MODE, MODES, isMode } from './modes.js';

/**
 * Replaced at bundle time by esbuild's `define`. The `typeof` guard keeps this
 * file loadable unbundled (tests, a REPL), where the identifier does not exist.
 */
const BUILD_MODE = typeof __DECISAUR_MODE__ === 'string' ? __DECISAUR_MODE__ : DEFAULT_MODE;

if (!isMode(BUILD_MODE)) {
  throw new Error(`decisaur: unknown build mode "${BUILD_MODE}"`);
}

/** @type {Agent|null} */
let agent = null;

function readOptions() {
  const g = /** @type {any} */ (globalThis);
  return {
    model: g.decisaurModel ?? DEFAULT_MODEL,
    host: g.decisaurHost ?? DEFAULT_HOST,
    hud: g.decisaurHud !== false,
  };
}

function boot() {
  agent?.stop();
  const mode = MODES[BUILD_MODE];
  agent = new Agent({ ...readOptions(), useModel: mode.useModel, useReflex: mode.useReflex, mode });
  agent.start();
  return agent;
}

const api = {
  stop: () => {
    agent?.stop();
    agent = null;
  },
  stats: () => agent?.controller.stats.summary() ?? null,
  mode: BUILD_MODE,
  get agent() {
    return agent;
  },
};

Object.defineProperty(globalThis, 'decisaur', { value: api, writable: true, configurable: true });

// Boot unconditionally. Chrome constructs `Runner.instance_` lazily, so gating on
// it here raced the game and usually lost: the bot reported "loaded, call start()"
// on a page where the game was already visible. The controller copes with a
// missing runner every frame, so there is nothing to wait for.
boot();

const mode = MODES[BUILD_MODE];
console.info(
  `[decisaur] ${mode.userscriptName} attached - ${mode.label(DEFAULT_MODEL)}. ${mode.blurb}`,
);
console.info('[decisaur] click the page so it has keyboard focus, then press space.');
