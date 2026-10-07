/**
 * Synthetic key dispatch for the T-Rex game.
 *
 * The game reads `String(e.keyCode)` and matches it against `Runner.keycodes`,
 * so these helpers construct events that expose a correct `keyCode` and bubble
 * to the `document` listener the game registers on.
 */

/** `Runner.keycodes.JUMP` */
export const JUMP_KEY = 32; // Space
/** `Runner.keycodes.DUCK` */
export const DUCK_KEY = 40; // ArrowDown

/**
 * Build a KeyboardEvent that reliably carries `keyCode`.
 *
 * `keyCode` is a legacy member of `KeyboardEventInit`; Chrome honours it, but
 * we verify and fall back to `Object.defineProperty` so the helper still works
 * if that ever changes (and never silently sends a keyCode of 0, which the game
 * would ignore).
 *
 * @param {'keydown'|'keyup'} type
 * @param {number} keyCode
 * @returns {KeyboardEvent}
 */
function makeKeyEvent(type, keyCode) {
  const event = new KeyboardEvent(type, {
    keyCode,
    which: keyCode,
    code: keyCode === JUMP_KEY ? 'Space' : 'ArrowDown',
    key: keyCode === JUMP_KEY ? ' ' : 'ArrowDown',
    bubbles: true,
    cancelable: true,
  });

  if (event.keyCode !== keyCode) {
    Object.defineProperty(event, 'keyCode', { get: () => keyCode });
    Object.defineProperty(event, 'which', { get: () => keyCode });
  }

  return event;
}

/** @param {number} keyCode */
function dispatch(keyCode, type) {
  const event = makeKeyEvent(type, keyCode);
  // The game listens on `document`; dispatch there first so the event lands in
  // the capture/bubble path the game actually uses.
  document.dispatchEvent(event);
}

/** Press and release jump. */
export function jump() {
  dispatch(JUMP_KEY, 'keydown');
  dispatch(JUMP_KEY, 'keyup');
}

/** Begin a duck. Held until {@link endDuck}. */
export function startDuck() {
  dispatch(DUCK_KEY, 'keydown');
}

/**
 * Release a duck.
 *
 * Releasing ArrowDown while airborne calls `setSpeedDrop()` inside the game,
 * which slams the dino to the floor. So never duck mid-jump.
 */
export function endDuck() {
  dispatch(DUCK_KEY, 'keyup');
}
