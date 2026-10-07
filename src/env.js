/**
 * The configuration contract: what a `.env` file is allowed to say.
 *
 * `src/config.js` receives its values from two directions. The Node CLIs read `.env`
 * off disk at startup; the browser bundles get the same values inlined by
 * `scripts/build.mjs`, because an IIFE pasted into the DevTools console cannot open a
 * file. Both paths hand the raw strings to this module, so it is the only place that
 * knows which keys exist and what counts as a legal value - there is one
 * implementation of "is this number usable", not one per consumer.
 *
 * It touches neither `node:fs` nor `process`, deliberately. Everything imported from
 * here ends up inside `dist/*.user.js`, and a Node builtin in that graph is either a
 * shim or a build failure.
 *
 * There are no fallback values anywhere in this file. Every key is required, because
 * the defaults live in `.env.example` and nowhere else. A config that invents a value
 * when one is missing is a config you cannot reason about: a typo in `DECISAUR_HOST`
 * would quietly talk to a different endpoint than the operator believes they set.
 */

/**
 * A parsed value, or the reason it is not one. Returning the failure instead of
 * throwing is what lets `resolveConfig` report every bad key in a single run - a user
 * who mistyped two lines of `.env` should learn about both from one command, not one
 * per attempt.
 *
 * @typedef {{ ok: true, value: string | number } | { ok: false, message: string }} Parse
 */

/** Ollama's `keep_alive` is a duration with an s/m/h suffix, or `0` to disable it. */
const DURATION = /^\d+(\.\d+)?[smh]$/;

/**
 * A number with no trailing junk.
 *
 * `Number.parseFloat('460px')` returns `460`, so a plain parse would silently accept
 * `460px` and `460,` and then fail somewhere unrelated. The pattern is the check.
 */
const NUMBER = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;

/**
 * Parse a number and apply a range rule.
 *
 * @param {string} value Already trimmed and known to be non-empty.
 * @param {string} describe How to name the expected shape, e.g. `a pixel distance`.
 * @param {(n: number) => string | null} check Range rule; returns the problem, or null when fine.
 * @returns {Parse}
 */
function number(value, describe, check) {
  if (!NUMBER.test(value)) return { ok: false, message: `"${value}" is not ${describe}` };
  const problem = check(Number(value));
  return problem === null ? { ok: true, value: Number(value) } : { ok: false, message: `"${value}" ${problem}` };
}

/**
 * The six tunables, in the order they appear in `.env.example`.
 *
 * `name` is the field on the object `resolveConfig` returns. It differs from `key`
 * only where the JavaScript name and the env var name genuinely diverge.
 *
 * @type {ReadonlyArray<{ key: string, name: string, hint: string, parse: (value: string) => Parse }>}
 */
const FIELDS = [
  {
    key: 'DECISAUR_HOST',
    name: 'host',
    hint: 'a base URL such as http://127.0.0.1:11434',
    // Ollama's own JS client wants the scheme in the URL, and the single most likely
    // paste here is the bare `127.0.0.1:11434` that the browser console asks for.
    parse: (value) =>
      /^https?:\/\/\S+$/.test(value)
        ? { ok: true, value }
        : { ok: false, message: `"${value}" is not a base URL starting with http:// or https://` },
  },
  {
    key: 'DECISAUR_MODEL',
    name: 'model',
    hint: 'the model tag to query, such as tev1:0.8b',
    // Model tags cannot contain whitespace, and `tev1 0.8b` for `tev1:0.8b` is the
    // typo worth catching rather than letting Ollama answer "model not found" later.
    parse: (value) =>
      /\S/.test(value)
        ? { ok: true, value }
        : { ok: false, message: `"${value}" is not a model tag such as tev1:0.8b` },
  },
  {
    key: 'DECISAUR_KEEP_ALIVE',
    name: 'keepAlive',
    hint: 'a duration such as 10m, or 0 to let Ollama unload it',
    parse: (value) =>
      value === '0' || DURATION.test(value)
        ? { ok: true, value }
        : { ok: false, message: `"${value}" is not a duration such as 90s, 10m or 1h (or 0 to disable)` },
  },
  {
    key: 'DECISAUR_PERCEPTION_RANGE',
    name: 'perceptionRange',
    hint: 'a distance in game pixels',
    parse: (value) => number(value, 'a pixel distance', (n) => (n > 0 ? null : 'must be greater than 0')),
  },
  {
    key: 'DECISAUR_MAX_CONCURRENT',
    name: 'maxConcurrent',
    hint: 'a whole number of in-flight queries, 1 or more',
    parse: (value) =>
      number(
        value,
        'a whole number',
        // 0 would silently disable the model - the bot would fall back to the reflex
        // forever and look like it works - so it is rejected rather than accepted.
        (n) => (Number.isInteger(n) ? (n >= 1 ? null : 'must be at least 1') : 'must be a whole number'),
      ),
  },
  {
    key: 'DECISAUR_JUMP_AIM',
    name: 'jumpAim',
    hint: 'a fraction of the clearance window, between 0 and 1',
    // Exclusive bounds: 0 and 1 sit at the edges of the clearance window, where the
    // dino is neither rising nor descending, and both are outside where a jump works.
    parse: (value) =>
      number(value, 'a number between 0 and 1', (n) => (n > 0 && n < 1 ? null : 'must be strictly between 0 and 1')),
  },
];

/** The env var names, in `.env.example` order. */
export const ENV_KEYS = FIELDS.map((field) => field.key);

/**
 * Pull the config keys out of an environment-shaped record.
 *
 * Used by both callers that hold a whole `process.env` (the Node CLIs and the build
 * script) so neither has to re-state the key list.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function pickConfigKeys(env) {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, env[key]]));
}

/**
 * Validate a raw `.env` record into the config the rest of the codebase reads.
 *
 * @param {Record<string, string | undefined>} raw Values as read from `.env`, not yet parsed.
 * @returns {{ host: string, model: string, keepAlive: string, perceptionRange: number, maxConcurrent: number, jumpAim: number }}
 * @throws {Error} One error naming every missing or illegal key, not just the first.
 */
export function resolveConfig(raw) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Record<string, string | number>} */
  const config = {};

  for (const field of FIELDS) {
    const value = typeof raw?.[field.key] === 'string' ? raw[field.key].trim() : '';
    if (value === '') {
      problems.push(`${field.key}: missing (expected ${field.hint})`);
      continue;
    }
    const parsed = field.parse(value);
    if (parsed.ok) config[field.name] = parsed.value;
    else problems.push(`${field.key}: ${parsed.message}`);
  }

  if (problems.length > 0) {
    throw new Error(
      `decisaur: ${problems.length} problem(s) reading .env\n` + problems.map((p) => `  ${p}`).join('\n'),
    );
  }

  return /** @type {{ host: string, model: string, keepAlive: string, perceptionRange: number, maxConcurrent: number, jumpAim: number }} */ (
    config
  );
}