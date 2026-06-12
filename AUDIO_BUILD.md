# Practice audio build (`practice.mid` + `sync.json`)

**Why this exists:** Verovio's in-browser MusicXML→MIDI is wrong on this score — it mis-tracks
a late key-signature change (wrong accidentals: D-major rendered as B♭-major → sharps play as
naturals) and drops ~a bar in the finale (accumulating lateness). Verified by a three-way
comparison: Verovio vs. MuseScore's own `.mid` vs. music21 — MuseScore and music21 agree;
Verovio is the lone outlier. See the note in `app.js`'s header comment.

So the app no longer plays Verovio-generated MIDI. Audio comes from a **prebuilt** MIDI with
**correct pitch and timing**, one track per practice lane.

## What the build produces (in `source/`)

- **`practice.mid`** — 7 named tracks: `SoloSA`, `SoloTB`, `S`, `A`, `T`, `B`, `Piano`
  (single-voice choir parts split out so S/A/T/B isolate). The repeat is **expanded** with
  1st/2nd endings (first pass → 1st ending → back to the repeat-start → 2nd ending → on),
  matching MuseScore's playback. All tracks are piano timbre.
- **`sync.json`** — `{ ppq, lanes, printedMeasures, measures:[{t,m}], total }`. `measures` is in
  **expanded playback order** (944 steps for 929 printed bars); each step gives its start time `t`
  (seconds) and the **printed** measure index `m`. The highlight box follows by step → printed bar,
  so on the second pass it jumps back to the repeated printed bars and skips the 1st ending.

## How the app uses them

`app.js`: `loadPractice()` maps each lane button to a track by name; `updateAudio()` mutes
non-selected tracks and plays the result. `followPractice()` converts the player clock → current
measure (`sync.json`) → Verovio measure id (`getMEI`) → page (`getPageWithElement`) → boxes the
bar. None of this depends on Verovio's (incorrect) MIDI clock. Falls back to the old Verovio
audio path only for the built-in demo (no `practice.mid`).

## Regenerating (after editing the source score)

```
pip install mido         # one-time
python build_practice.py # reads source/*.mxl, writes source/practice.mid + source/sync.json
```

The converter resolves each note's true pitch (key signature + within-measure accidentals +
explicit `<alter>`) and computes timing from `<divisions>` + `<backup>`/`<forward>`. It was
validated to 99–100% pitch match and **0 timing drift** against MuseScore's reference `.mid`
across the whole piece (Verovio drifted +4 beats in the same region).
