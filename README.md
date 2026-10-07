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

The model chooses the maneuver. Geometry still chooses *when* a jump is pressed, and
still fills the frames before the model has answered:

| Layer | Question it answers | Latency | Measured |
|---|---|---|---|
| **Model** (`tev1:0.8b`) | *jump, bow, or hold?* | ~210ms | **~73%** maneuver accuracy |
| **Geometry** | *when is a jump survivable, and what do we do meanwhile?* | ~0 (per frame) | exact |
| **Policy** | *is the model's opinion allowed to act?* | ~0 | — nothing is gated |

The model is asked one question per obstacle per approach phase: a `choice` between
`jump` and `bow`, plus a `noul` on whether the obstacle needs acting on yet. `hold` is
derived from the second, so it never competes for probability mass against the two
maneuvers that press a key. That decomposition is the only framing that reached all
three maneuvers on `tev1:0.8b` - a single three-way question latches onto whichever
option is described most forcefully, and eleven attempts are tabulated in
`src/ollama/decider.js`.

### The model cannot win, and now it can be shown crashing

The previous design asked the model for an obstacle *class* and gated its answer against
collision geometry, which made a confidently-wrong model harmless: `--oracle` and
`--adversarial` scored identically to reflex-only. That safety came from the gate, not
from the model.

This design removes the gate. `clear` reports confidence 0.000-0.054 on *correct*
answers, with probabilities as flat as `bow 0.51 / jump 0.49` - this model can name the
right maneuver and cannot tell you how sure it is, so any confidence floor rejects
nearly everything including the right answers. There is nothing to gate with, and the
consequence is measured rather than argued:

```
reflex only     5/5 survived    score 5888
--oracle        5/5 survived    score 5888    model ~90% maneuver accuracy
--model         0/5 survived    score ~700    model ~73%, crashes into pterodactyls
--adversarial   0/5 survived    score 13     model 0%, always confident
```

Same seeds, 20000 frames each. The oracle still scores exactly what reflex scores, which
is the project's original thesis holding: on this game the correct maneuver is fully
determined by the game's own collision boxes, so a perfect decision-maker adds nothing
to the score. Give the model sole authority over a bad decision-maker and it dies.

Two things make the difference between `--oracle` and `--model`, and both are the model's:
it cannot reliably tell a bowable bird from a jumpable one, and its answer arrives too
late to matter without the geometry layer timing the jump.

### What the model gets wrong

~73% over 20000-frame runs, and the error is concentrated rather than random: the
failures are almost all pterodactyls. Where the model is wrong about a bird's height it
either bows something that must be jumped or runs into something it could have bowed.

One scene dominated everything until it was found. `yPos 75` is bowable and was
described to the model as being at "head height", which the clearance rules then said
must be jumped - the model read the description correctly, followed the rule correctly,
and died. Describing it as "above the runner" instead moved that scene from wrong to
right. That string is load-bearing and the comment in `src/core/vocabulary.js` says so.

The model is scored on every decision against what collision geometry would have done,
in the HUD and in `npm run replay`, so its error rate is a number rather than an
anecdote.


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
| `dist/decisaur.model-only.user.js` | decides, no pre-answer cover | off | seeing what the model does unaided |
| `dist/decisaur.reflex-only.user.js` | never queried | on | the A/B baseline |
| `dist/decisaur.user.js` | decides | covers pre-answer frames, owns jump timing | normal play |

Pick the file, paste it, done. In all three builds the geometry layer times the jump -
the model's `jump` is armed and fired at the clearance window, never the frame its
answer arrives. What the builds differ on is who decides, and what happens during the
~210ms before the model has answered.

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
npm run replay                       # score the model's maneuver against collision geometry
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
node src/node/probe-maneuver.js      # why one 3-way maneuver question cannot work
node src/node/probe-decompose.js     # why the question is split in two, and why L
node src/node/probe-wording.js       # why the yPos 75 description is load-bearing
node src/node/probe-latency.js       # latency vs question count
npm run bench                        # GPU throughput vs the load the loop applies
```

`npm run replay` asks every obstacle about at three distances, because the correct
maneuver is a function of distance and not only of shape - a high bird 900px out wants
`hold`, the same bird at 130px wants `bow`.


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
    reflex.js            60Hz geometry net; also owns jump timing
    policy.js            model maneuver -> action, ungated by design
    controller.js        the pipeline; DOM-free
    vocabulary.js        the model-facing scene description
  ollama/decider.js      System One client: dedup per approach band, one in flight
  browser/
    agent.js             rAF loop + keyboard
    keys.js              synthetic keydown/keyup carrying keyCode
    hud.js               live telemetry
    entry.js             window.decisaur console API
    modes.js             the three build modes, shared by build.mjs and the bundle
  node/
    sim.js               headless port of the game
    run-sim.js           simulator CLI (reflex / oracle / adversarial / model)
    replay.js            maneuver accuracy harness, obstacle x distance
    sweep-aim.js         JUMP_AIM sweep
    probe-maneuver.js    single 3-way maneuver question, 6 framings
    probe-decompose.js   the split question, 4 framings (L is production)
    probe-wording.js     the yPos 75 description, 4 wordings
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

- **With the model deciding, the bot does not survive.** 0/5 seeds reach 20000 frames
  against reflex-only's 5/5, and every crash is a pterodactyl. This is the honest
  consequence of removing the policy gate: at ~73% maneuver accuracy, a quarter of the
  decisions are wrong and a wrong answer at the wrong moment is fatal. The gate that used
  to absorb this is gone because the new question reports no usable confidence to gate
  on. `npm run replay` and the HUD count the mistakes; `--oracle` shows what a model
  that were reliable would give, which is a score identical to reflex.
- **Two queries per obstacle, not one.** A maneuver depends on distance: the right answer
  at 460px is `hold` and at 230px it is `jump`. Asking once cached `hold` for the whole
  approach and the dino ran into what it was told to wait for. `Decider` dedups per
  `(token, band)` and the controller re-asks on entering the near band at 300px, which
  is the most the ~210ms round trip allows at the game's top speed.
- **The bot reads and writes `Runner` internals, which are not a public API.**
  Current Chrome has modularised them, and a sufficiently large rename would need
  attention. See [ARCHITECTURE.md §8](ARCHITECTURE.md#8-agentrunner-three-shapes).
- **Reaching Ollama from `chrome://dino` requires disabling a security check**, and
  the second, Ollama-side refusal always needs the proxy. Both are measured, and
  the proxy is not optional: dropping `Origin` upstream is what gets a `200` at all.
  Only the Chrome column depends on current Chrome behaviour - if the feature is
  renamed or the flag stops working, the flag-based setup breaks with it. See
  [ARCHITECTURE.md §9](ARCHITECTURE.md#9-the-two-refusals).
- **With Ollama down or unreachable, the bot falls back to geometry.** In the default
  build the reflex covers every frame the model has not answered for, so the dino keeps
  playing. The model-only build does not: it does nothing until an answer arrives. The
  HUD shows `model query failed` and `model share 0%`, which is the honest report of a
  model that contributed nothing that run.
- **`yPos 75` is described to the model in words, not numbers, and the wording is
  load-bearing.** "about head height" made the model jump a bowable bird and die; "above
  the runner" fixed it. `node src/node/probe-wording.js` reproduces the comparison.

Game internals - transcribed constants, which maneuver is actually possible, and
the upstream typo that will silently break your jump - are collected in
[ARCHITECTURE.md §12](ARCHITECTURE.md#12-traps-the-code-guards-against).