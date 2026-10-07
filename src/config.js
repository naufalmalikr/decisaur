/**
 * Shared tunables for decisaur, resolved from `.env`.
 *
 * Imported by both the browser bundle and the Node CLIs, so it must stay free of
 * Node-only and DOM-only APIs. That constraint is what shapes the design: a script
 * pasted into the DevTools console on `chrome://dino` cannot open a file, so the
 * values reach the browser by being inlined at build time instead of read at runtime.
 * There are two transports for one file:
 *
 *   - `scripts/build.mjs` reads `.env` and substitutes it as the `__DECISAUR_ENV__`
 *     esbuild define, the same mechanism `__DECISAUR_MODE__` already uses for the
 *     build mode. The bundle therefore carries its own copy of the config.
 *   - The Node CLIs read `.env` at startup through `process.loadEnvFile`.
 *
 * Both paths hand raw strings to `resolveConfig` in `./env.js`, so there is exactly one
 * definition of what a valid value is and exactly one error message for a bad one.
 *
 * The consequence worth remembering: editing `.env` does not change a bundle that has
 * already been built. `npm run build` again, or the old values are still in the file
 * you pasted.
 *
 * No value is defaulted here. The defaults live in `.env.example`, and a missing key
 * is a loud failure on purpose.
 */

import { pickConfigKeys, resolveConfig } from './env.js';

/**
 * Replaced at bundle time by esbuild's `define`. The `typeof` guard keeps this file
 * loadable unbundled (tests, a REPL), where the identifier does not exist.
 */
const BAKED = typeof __DECISAUR_ENV__ === 'object' && __DECISAUR_ENV__ !== null ? __DECISAUR_ENV__ : null;

/**
 * Read `.env` into `process.env` and return the config keys.
 *
 * Node only. The guard is what keeps this out of the browser bundle's path: there is
 * no `process` there, and the baked object is used instead.
 *
 * `process.loadEnvFile` (Node >= 20.12) does not overwrite variables that are already
 * set, so a shell export beats `.env`. That is deliberate - it is how a one-off
 * experiment overrides the file without editing it.
 *
 * @returns {Record<string, string | undefined>}
 */
function fromFile() {
  if (typeof process === 'undefined' || typeof process.loadEnvFile !== 'function') {
    throw new Error(
      'decisaur: no configuration available. In a browser bundle this means the bundle was built ' +
        'without a config; rebuild with `npm run build`. In Node it means this runtime predates ' +
        'process.loadEnvFile (needs 20.12+).',
    );
  }

  // Resolved against the working directory rather than the module URL, because
  // `import.meta` does not survive the IIFE build that this file is also part of.
  // `DECISAUR_ENV_FILE` covers running from elsewhere.
  const path = process.env.DECISAUR_ENV_FILE ?? `${process.cwd()}/.env`;

  try {
    process.loadEnvFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `decisaur: no configuration at ${path}. Copy the template and edit it:\n` +
          '  cp .env.example .env\n' +
          '(set DECISAUR_ENV_FILE to point somewhere else)',
      );
    }
    throw error;
  }

  return pickConfigKeys(process.env);
}

/**
 * Validated once, at load. A bad `.env` therefore fails at import rather than at the
 * first obstacle, with every problem in the file reported at once.
 */
const CONFIG = resolveConfig(BAKED ?? fromFile());

/** Base URL of the Ollama server. */
export const HOST = CONFIG.host;

/**
 * System One decision model.
 *
 * A compact decision head served by Ollama's `POST /v1/systemone` endpoint. It answers
 * `choice` / `noul` / `score` questions with probability distributions in a single
 * forward pass.
 *
 * The reasoning behind each default, and the measurements behind `JUMP_AIM` in
 * particular, live in `.env.example` next to the value they justify.
 */
export const MODEL = CONFIG.model;

/** How long Ollama keeps the model resident; a cold start costs ~300ms. */
export const KEEP_ALIVE = CONFIG.keepAlive;

/** Perception and actuation cadence. */
export const LOOP = Object.freeze({
  /**
   * How far ahead, in game pixels, an obstacle enters the model's field of view.
   *
   * Sized from the round trip rather than picked: at the game's top speed of
   * 13px/frame @60fps, 460px is ~590ms of warning against a ~260ms query.
   */
  perceptionRange: CONFIG.perceptionRange,
  /** Hard cap on concurrent queries; the server serialises small models anyway. */
  maxConcurrent: CONFIG.maxConcurrent,
});

/**
 * Where in the clearance window to line an obstacle up.
 *
 * Just past the middle of the window, which is where the dino is highest for the
 * longest time, so a slightly late jump still clears. Sharply peaked, and aiming late
 * is fatal - the obstacle arrives exactly as the dino descends back through the
 * clearance height. Swept across seeds, not guessed; re-run `node src/node/sweep-aim.js`
 * after changing it. See `.env.example` for the numbers.
 */
export const JUMP_AIM = CONFIG.jumpAim;