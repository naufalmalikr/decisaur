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
 */

import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const minify = process.argv.includes('--minify');

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
    define: { __DECISAUR_MODE__: JSON.stringify(id) },
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
