# FREUDE — choir rehearsal reader

A browser rehearsal aid for Beethoven's 9th, 4th movement (*An die Freude*, SATB + piano
reduction). The notation is drawn by **Verovio** from MusicXML; the sound comes from a
**prebuilt, pitch- and timing-correct per-voice MIDI**, so you can isolate, slow down, and
follow any single voice.

## Features
- **Per-voice isolation** — Full / Solo S+A / Solo T+B / S / A / T / B / Piano. Each part button
  has a menu for solo-mute, volume, and instrument.
- **Transport** — back-to-start, previous/next section, play/pause, and *jump to playhead*.
- **Jump to section** — dropdown of all 24 tempo headings (Presto, Allegro assai, Andante
  maestoso, …); selecting one moves the view and cues playback there.
- **Follow cursor** — a box highlights the current bar set; the repeat is played out with 1st/2nd
  endings and the cursor revisits the repeated bars.
- **Tempo** slider, **Dim solo / Dim piano**, zoom, first-load progress bar.

## Run locally
```
python -m http.server 8770      # from this folder
# open http://localhost:8770
```
(First load pulls Verovio + the MIDI player from CDNs.)

## Rebuilding the audio
`source/practice.mid` + `source/sync.json` are generated offline from the MusicXML — see
[AUDIO_BUILD.md](AUDIO_BUILD.md). Regenerate after editing the score:
```
pip install mido
python build_practice.py
```

## Why a prebuilt MIDI (not Verovio's)
Verovio's own MusicXML→MIDI mis-rendered this score late on (wrong accidentals from a dropped key
change, plus accumulating timing drift). `build_practice.py` resolves pitch and timing correctly
and matches MuseScore's reference within 99–100%. Verovio still draws the notation.

## Source / licence
The score is Beethoven's 9th finale — public domain (CPDL). Engine/player libraries load from
their respective CDNs.
