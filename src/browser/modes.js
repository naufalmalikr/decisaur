/**
 * The three browser builds, in one place.
 *
 * The mode is fixed at compile time by `scripts/build.mjs` via esbuild's
 * `define`, so each `dist/*.user.js` is a self-contained bot that already knows
 * what it is. That replaced a runtime toggle (`Controller.setUseReflex`) plus the
 * `decisaur.modelOnly()` console function - which meant "model *enabled*", the
 * opposite of what the name implies, and had no way to turn the reflex off at
 * all from the console.
 *
 * The reflex is a 60Hz geometry safety net; in `model-only` it is not consulted
 * at all for what to press, so the bot dies as soon as a model answer is late or
 * wrong. That is the experiment, not a defect - see `npm run sim -- --no-reflex`.
 */

export const MODES = {
  'model-only': {
    id: 'model-only',
    file: 'decisaur.model-only.user.js',
    userscriptName: 'decisaur (model only)',
    /** @param {string} model */
    label: (model) => `${model} only - no reflex`,
    useModel: true,
    useReflex: false,
    /** In this build a non-model decision is a miss, not the reflex layer. */
    reflexLabel: 'unanswered',
    blurb: 'Model is the sole pilot. No geometry veto, no timing from the reflex.',
  },
  'reflex-only': {
    id: 'reflex-only',
    file: 'decisaur.reflex-only.user.js',
    userscriptName: 'decisaur (reflex only)',
    label: () => 'reflex only - no model',
    useModel: false,
    useReflex: true,
    reflexLabel: 'reflex',
    blurb: 'Geometry only. The model is never queried; this is the A/B baseline.',
  },
  'model+reflex': {
    id: 'model+reflex',
    file: 'decisaur.user.js',
    userscriptName: 'decisaur',
    label: (model) => `${model} + reflex`,
    useModel: true,
    useReflex: true,
    reflexLabel: 'reflex',
    blurb: 'The normal build: model classifies, reflex owns timing and vetoes.',
  },
};

export const DEFAULT_MODE = 'model+reflex';

/** @param {string} id */
export function isMode(id) {
  return Object.hasOwn(MODES, id);
}
