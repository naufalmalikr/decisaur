/**
 * Shared tunables for decisaur.
 *
 * Imported by both the browser bundle and the Node CLIs, so it must stay free of
 * Node-only and DOM-only APIs.
 */

/** Default local Ollama endpoint. */
export const DEFAULT_HOST = 'http://127.0.0.1:11434';

/**
 * System One decision model.
 *
 * `tev1` is a compact decision head served by Ollama's `POST /v1/systemone`
 * endpoint. It answers `choice` / `noul` / `score` questions with probability
 * distributions in a single forward pass.
 */
export const DEFAULT_MODEL = 'tev1:0.8b';

/** Keep the model resident; cold start costs ~300ms before the first answer. */
export const KEEP_ALIVE = '10m';

/** Perception and actuation cadence. */
export const LOOP = {
  /**
   * How far ahead, in game pixels, an obstacle enters the model's field of view.
   * At the game's top speed of 13px/frame @60fps that is 780px/s, so 460px buys
   * ~590ms of warning - enough for the ~260ms round trip plus slack.
   */
  perceptionRange: 460,
  /** Hard cap on concurrent queries; the server serialises small models anyway. */
  maxConcurrent: 1,
};

/**
 * Where in the clearance window to line an obstacle up.
 *
 * A jump lasts ~34 frames, and at top speed consecutive obstacles can be only
 * 22-34 frames apart (`getGap` gives 293-440px at 13px/frame), so the dino is
 * sometimes still airborne when the next obstacle arrives.
 *
 * `0.54` sits just past the middle of the window, which is where the dino is
 * highest for the longest time - so a slightly late jump still clears. Measured
 * by sweeping the value across seeds (`node src/node/sweep-aim.js`); survival of a
 * 20000-frame run:
 *
 *   aim  0.40  0.46  0.50  0.54  0.58  0.60  0.70  0.90
 *   ok   8/20  14/20 15/20 19/24 13/24  9/20   0/12  0/12
 *
 * The curve is sharply peaked and aiming late is fatal, because the obstacle then
 * arrives exactly as the dino descends back through the clearance height.
 * 0.54 holds up on held-out seeds (19/30 at 30000 frames).
 */
export const JUMP_AIM = 0.54;
