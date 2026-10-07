/**
 * Bundles the browser agent into one self-contained script per build mode.
 *
 * Output is one IIFE with no imports, suitable for:
 *   - pasting into the DevTools console on chrome://dino
 *   - a Tampermonkey userscript
 *
 * Three artefacts come out, differing only in the compile-time `__DECISAUR_MODE__`
 * define, which `src/browser/entry.js` reads to decide whether the model and/or
 * the reflex is in charge:
 *
 *   dist/decisaur.model-only.user.js   model flies alone (no geometry veto)
 *   dist/decisaur.reflex-only.user.js  geometry only, model never queried
 *   dist/decisaur.user.js              model classifies, reflex owns timing
 *
 * `decisaur.user.js` keeps its original name so an existing Tampermonkey install
 * and the README instructions keep working unchanged.
 *
 * The bundles also carry their configuration. A pasted script cannot open `.env`
 * itself, so the values are read here and inlined as `__DECISAUR_ENV__` - the same
 * define mechanism `__DECISAUR_MODE__` uses for the mode. Consequence: editing `.env`
 * has no effect on an already-built bundle until this runs again.
 */

import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickConfigKeys, resolveConfig } from '../src/env.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const minify = process.argv.includes('--minify');

/**
 * Read `.env` and hand back the raw key/value pairs.
 *
 * Validated here as well as in the bundle, so a typo fails the build instead of
 * producing an artefact that throws when it is pasted into the console. The strings
 * are passed through raw rather than the parsed numbers: the bundle re-runs
 * `resolveConfig` at load, so there is one implementation of the rules rather than one
 * per transport.
 *
 * @returns {Record<string, string | undefined>}
 */
function loadEnv() {
  const path = process.env.DECISAUR_ENV_FILE ?? resolve(root, '.env');
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

  const raw = pickConfigKeys(process.env);
  resolveConfig(raw);
  return raw;
}

const rawEnv = loadEnv();
const built = resolveConfig(rawEnv);

/** Build one mode. Returns the output size in kB. */
async function buildMode(id, file, userscriptName) {
  const result = await build({
    entryPoints: [resolve(root, 'src/browser/entry.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110'],
    minify,
    write: false,
    legalComments: 'none',
    logLevel: 'warning',
    define: {
      __DECISAUR_MODE__: JSON.stringify(id),
      __DECISAUR_ENV__: JSON.stringify(rawEnv),
    },
  });

  const [output] = result.outputFiles;

  // Tampermonkey header so the same artefact can be installed as a userscript.
  // @name is per mode, otherwise Tampermonkey sees three scripts claiming to be
  // "decisaur" and the user cannot tell them apart in the dashboard.
  const header = `// ==UserScript==
// @name         ${userscriptName}
// @description  T-Rex Runner bot steered by an Ollama System One decision model
// @match        chrome://dino
// @match        chrome-error://chromewebdata/
// @grant        none
// @run-at       document-idle
// ==/UserScript==
`;

  const outfile = resolve(root, `dist/${file}`);
  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, header + output.text, 'utf8');
  return Buffer.byteLength(header + output.text, 'utf8') / 1024;
}

// Imported rather than re-listed, so the filenames and userscript names in the
// dist/ directory can never drift from what the code calls itself.
const { MODES } = await import(resolve(root, 'src/browser/modes.js'));
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

for (const mode of Object.values(MODES)) {
  const kb = await buildMode(mode.id, mode.file, mode.userscriptName);
  console.log(`decisaur v${pkg.version}  ${mode.id.padEnd(12)} -> dist/${mode.file} (${kb.toFixed(1)} kB)`);
}

console.log(`decisaur: 3 builds written to dist/.`);
console.log(
  `decisaur: config baked in from .env - host ${built.host}, model ${built.model}, ` +
    `perceptionRange ${built.perceptionRange}px, jumpAim ${built.jumpAim}`,
);
console.log(`decisaur: editing .env now changes nothing until this build runs again.`);
