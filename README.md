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
- **Manual browse** — page through the score with arrow keys (Home/End for first/last), a touch
  swipe, or a horizontal trackpad flick — no audio needed.
- **Tempo** slider, **Dim solo / Dim piano**, zoom, first-load progress bar.

## Run locally
```
python -m http.server 8770      # from this folder
# open http://localhost:8770
```
(First load pulls Verovio + the MIDI player from CDNs.)

## Install / offline (PWA)
The app is an installable Progressive Web App. Open the live site
(https://lmontgomery-ca.github.io/freude/) once **online**, then either tap **⬇ Install** in
the header or use your browser's *Install app* / *Add to Home Screen*. A service worker
(`sw.js`) caches the app shell, the notation engine + player, and the score; the Verovio WASM is
cached the first time it's used. On the first online load the app also **pre-warms the soundfont
in the background** — every sample this score needs for all 8 instruments (the 69 pitches it uses
× the 8 GM instruments ≈ 561 files / ~21 MB, listed in `sf-precache.json`) — so **after that
completes, all instruments play fully offline at normal volume**. (Extreme per-part volume changes
offline can land on an un-cached velocity layer until it's played online once.) Pre-warming is
gated by a `localStorage` flag (`sf-warmed-freude-v1`); bump `CACHE` in `sw.js` and that flag to
force a refresh. Regenerate `sf-precache.json` after changing the score:
```
python -c "import mido,json; BASE='https://storage.googleapis.com/magentadata/js/soundfonts/sgm_plus'; F=['acoustic_grand_piano','electric_piano_1','harpsichord','church_organ','acoustic_guitar_nylon','string_ensemble_1','choir_aahs','flute']; m=mido.MidiFile('source/practice.mid'); P=sorted({x.note for t in m.tracks for x in t if x.type=='note_on' and x.velocity>0}); u=[BASE+'/soundfont.json']+[BASE+'/'+f+'/instrument.json' for f in F]+[BASE+'/'+f+'/p'+str(p)+'_v79.mp3' for f in F for p in P]; json.dump(u,open('sf-precache.json','w'))"
```

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
