# decisaur

A bot for the Chrome T-Rex Runner (`chrome://dino`) whose obstacle perception is a
local [Ollama](https://ollama.com) **System One** decision model, `tev1:0.8b`,
reached over `POST /v1/systemone`.

The interesting part is not that it plays well. It is the finding underneath:
**on this game the model cannot improve the score, and the project is built so
that is measurable rather than asserted.**

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the decision pipeline, every module, the policy
  gates, the prompt design, the build modes, the offline harness, and the platform traps
  the code guards.

---

## The short version

Three layers, each with a job it is actually good at:

| Layer | Question it answers | Latency | Measured accuracy |
|---|---|---|---|
| **Model** (`tev1:0.8b`) | *what kind of obstacle is this?* | 67-280ms | **80%** (32/40) |
| **Geometry** | *what can be done about it, and when?* | ~0 (per frame) | exact |
| **Policy** | *is the model's opinion allowed to act?* | ~0 | — |

Geometry is what actually drives the dino. The model is asked once per obstacle,
and its answer is checked against collision geometry before it is allowed to do
anything.

### Why the model cannot win

In this game the correct maneuver is fully determined by the game's own collision
boxes. There is no judgement call, no trade-off, no strategy to infer. So a perfect
classifier adds exactly nothing to the score, and a mediocre one can only hurt.

Rather than pretend otherwise, the project measures it. `npm run sim` runs the same
seeds three ways:

```
reflex only     5/6 survived    score 5888
--oracle        5/6 survived    score 5888     model 100% accurate
--adversarial   5/6 survived    score 5888     model ~20% accurate, always confident
```

Crash frames, scores and jump counts come out byte-identical across all three
(same md5 over the run summary). An always-wrong, maximally-confident model
changes nothing, because the policy layer refuses answers that disagree with
geometry. That is the safety property, and it is demonstrated rather than claimed.

The one place the model does move the needle is mild: it labels a bird that could
simply be run under as `bird_high`, so the dino ducks when it did not need to
(283 duck frames instead of 51 over 4000 frames). That is safe - ducking clears
those birds - and the score is unchanged, but it is the model adding motion rather
than accuracy. Worth knowing before reading too much into the agreement above.

The model still does something real: it is scored on every obstacle against the
geometric reference, in the HUD and in `npm run replay`, and its one systematic
error is visible rather than silent.

---

## Install

Requires Node 20+ and a local Ollama with the model pulled.

```sh
ollama pull tev1:0.8b
npm install
npm run build
```

## Use it in the browser

Chrome will not let `chrome://dino` reach a loopback address at all, so two separate
things are needed before the bot can query the model: a launch flag, and the proxy.
Both refusals are measured and explained in
[ARCHITECTURE.md §9](ARCHITECTURE.md#9-the-two-refusals); this is the short version.

1. **Launch Chrome with the local-network check disabled.** There is no
   `chrome://flags` entry for this any more, so it has to go on the command line:

   ```sh
   google-chrome --disable-features=LocalNetworkAccessChecks
   ```

   To make it permanent, add the flag to the `Exec=` line in
   `~/.local/share/applications/google-chrome.desktop`. Serving the game from an
   `http://localhost` page instead also works and disables nothing.

2. **Start the proxy**, which fixes the separate Ollama-side refusal:

   ```sh
   npm run proxy                 # 127.0.0.1:11436 -> 127.0.0.1:11434
   ```

3. Open `chrome://dino`, press <kbd>F12</kbd>, open the **Console**.
4. Set the host, then paste and run the build you want - `dist/decisaur.user.js`
   for normal play, or one of the two A/B builds below:

   ```js
   decisaurHost = 'http://127.0.0.1:11436';
   ```

5. **Click the game page** so it holds keyboard focus, then press <kbd>Space</kbd>.

Or install `dist/decisaur.user.js` as a Tampermonkey userscript - it already
carries the `@match chrome://dino` header.

A HUD appears in the bottom left showing the model's class next to the class
derived from collision geometry, whether they agree, the classification accuracy
so far, and the round-trip latency. Disagreements turn red the instant they happen.

### The three builds

`npm run build` writes three bundles. They differ only in which layer is in
charge, decided at compile time - there is no runtime switch to get wrong.

| File | Model | Reflex | For |
|---|---|---|---|
| `dist/decisaur.model-only.user.js` | sole pilot | off | seeing what the model does unaided |
| `dist/decisaur.reflex-only.user.js` | never queried | on | the A/B baseline |
| `dist/decisaur.user.js` | classifies | vetoes, owns timing | normal play |

Pick the file, paste it, done. The model-only build has no geometry veto and no
timing help, so the dino dies the moment an answer is late or wrong - that is the
experiment, and `npm run sim -- --no-reflex --model` measures the same thing
headlessly (it dies around frame 89).

Each bundle prints its own mode on attach, and `decisaur.mode` reports it.

### Console API

```js
decisaur.stop()    // detach
decisaur.stats()   // counters
decisaur.mode      // which build this is
```

## Use it headlessly

Everything runs without a browser, against a port of the game's physics in
`src/node/sim.js`. The full harness list is in
[ARCHITECTURE.md §10](ARCHITECTURE.md#10-offline-harness).

```sh
npm run replay                       # score the model against collision geometry
npm run sim                          # reflex layer alone
npm run sim -- --oracle              # model stands in for geometry
npm run sim -- --adversarial         # model confidently wrong
npm run sim -- --model --fps 60      # real tev1:0.8b, paced like a real game
npm run sim -- --frames 20000 --runs 10 --seed 900
```

`--fps 60` matters. Without it the loop finishes in milliseconds and almost no
model query ever completes, which looks like success while measuring nothing.

```sh
node src/node/sweep-aim.js           # how JUMP_AIM was chosen
node src/node/probe-prompt.js        # why the prompt asks for a class, not a maneuver
node src/node/probe-latency.js       # latency vs question count
npm run bench                        # GPU throughput vs the load the loop applies
```

---

## What the model gets wrong

80% over 40 samples, and the error is systematic rather than random:

| Scene | Model | Geometry | Outcome |
|---|---|---|---|
| cactus, small / large | `cactus` | `cactus` | jump |
| bird at y=100 | **`bird_high`** | `bird_low` | **caught by the gate** -> jump |
| bird at y=75 | `bird_high` | `bird_high` | duck |
| bird at y=50 | `bird_high` | `bird_high` | duck |

It reads a body-height bird as "high overhead" every single time. The gate catches
all 8 of 8, the dino jumps correctly, and the HUD counts the mistake.

The model is asked what it is *looking at* rather than what it should *do*, because
that question measured both cheaper and sharper than asking for a maneuver, and
because a sentence is scored far better than a JSON blob. The description
deliberately never names the class or the collision extents - otherwise scoring the
model against geometry would just be measuring an echo. The prompt, the encoding
comparison behind it, and the swept `JUMP_AIM` value are in
[ARCHITECTURE.md §6](ARCHITECTURE.md#6-model-transport) and
[§4](ARCHITECTURE.md#4-geometry-and-classification).

---

## Layout

```
src/
  config.js              tunables: model, host, confidence gates, JUMP_AIM
  core/
    constants.js         game physics, transcribed, with provenance
    geometry.js          jump arc, clearance windows, collision extents
    state.js             defensive BotState extraction from Runner.instance_
    classify.js          class + feasible maneuvers, from collision geometry
    reflex.js            60Hz safety net
    policy.js            model answer -> action, gated
    controller.js        the pipeline; DOM-free
    vocabulary.js        class space and the model-facing description
  ollama/decider.js      System One client: dedup, one in flight, keep_alive
  browser/
    agent.js             rAF loop + keyboard
    keys.js              synthetic keydown/keyup carrying keyCode
    hud.js               live telemetry
    entry.js             window.decisaur console API
    modes.js             the three build modes, shared by build.mjs and the bundle
  node/
    sim.js               headless port of the game
    run-sim.js           simulator CLI (reflex / oracle / adversarial / model)
    replay.js            model accuracy harness
    sweep-aim.js         JUMP_AIM sweep
    probe-prompt.js      prompt-encoding comparison
    probe-latency.js     latency vs question count
    bench-gpu.js         concurrency + System One benchmark
scripts/build.mjs        esbuild -> dist/*.user.js
scripts/cors-proxy.mjs   127.0.0.1:11436 -> Ollama, Origin stripped
```

`controller.js` is DOM-free on purpose: the browser agent and the headless
simulator drive the same object, so the simulator exercises the real decision path
rather than a reimplementation that can drift from it. Module-by-module
responsibilities are in [ARCHITECTURE.md §4](ARCHITECTURE.md#modules).

---

## Limitations

- **70% of seeds survive 30000 frames** (42/60 on seeds 3000-3059, mean score
  ~7800); the rest die almost entirely to one case: the dino is still airborne
  when the next obstacle needs a jump, and it lands after that obstacle's window
  has already opened. Crash breakdown across those 18 failures - 14 airborne into
  `CACTUS_LARGE`, 2 running into `CACTUS_LARGE`, 2 into a pterodactyl.
  This is a limit of a jump-only strategy, not something the model addresses.
  It was traced rather than papered over, and ArrowDown speed-drop does not fix it:
  from the apex it descends *slower* than gravity alone (3px/frame against ~5px/frame
  average), so cutting the jump short lands the dino later, not sooner.
- **Chrome's pterodactyl has two heights, not three.** Some mirrors use three.
  Classification reads `yPos` from the live game so both work, but the constants
  table lists three.
- **The bot reads and writes `Runner` internals, which are not a public API.**
  Current Chrome has modularised them, and a sufficiently large rename would need
  attention. See [ARCHITECTURE.md §8](ARCHITECTURE.md#agentrunner-three-shapes).
- **Reaching Ollama from `chrome://dino` requires disabling a security check**, and
  the second, Ollama-side refusal always needs the proxy. Both are measured, and
  the proxy is not optional: dropping `Origin` upstream is what gets a `200` at all.
  Only the Chrome column depends on current Chrome behaviour - if the feature is
  renamed or the flag stops working, the flag-based setup breaks with it. See
  [ARCHITECTURE.md §9](ARCHITECTURE.md#9-the-two-refusals).
- **With Ollama down or unreachable, the bot still plays.** This is the design
  working, not a bug: the reflex layer is geometry-driven and synchronous, so it
  never waits on a model round trip. The HUD then shows `model query failed` as the
  reason and `model share 0%`, which is the honest report of a model that
  contributed nothing that run.

Game internals - transcribed constants, which maneuver is actually possible, and
the upstream typo that will silently break your jump - are collected in
[ARCHITECTURE.md §12](ARCHITECTURE.md#12-traps-the-code-guards-against).