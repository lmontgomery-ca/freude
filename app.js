/* FREUDE ribbon v2 — Verovio draws the notation; a PREBUILT per-voice MIDI plays the sound.
 * Verovio's own MusicXML->MIDI was wrong on this score (mis-tracked a late key signature ->
 * wrong accidentals, and dropped ~a bar -> accumulating lateness). So audio now comes from
 * source/practice.mid (built offline by build_practice.py: correct pitch + timing, one track
 * per voice S/A/T/B/SoloSA/SoloTB/Piano). The highlight box follows by MEASURE via source/
 * sync.json (measure->seconds) + Verovio's measure positions — independent of Verovio's clock.
 * Per-part isolation = mute tracks in the prebuilt MIDI. Falls back to Verovio audio for the demo.
 */
"use strict";

const CONFIG = {
  candidates: ["source/score.mxl", "source/score.musicxml", "source/score.xml"],
  pageWidth: 3000,   // Verovio units; with systemMaxPerPage:1 this sets bars-per-ribbon-line
};

/* extract the main MusicXML text out of a compressed .mxl (a zip) */
function unzipMxl(arrayBuffer) {
  const files = fflate.unzipSync(new Uint8Array(arrayBuffer));
  const dec = new TextDecoder("utf-8");
  let root = null;
  if (files["META-INF/container.xml"]) {
    const m = dec.decode(files["META-INF/container.xml"]).match(/full-path="([^"]+)"/);
    if (m) root = m[1];
  }
  if (!root || !files[root]) {
    root = Object.keys(files).find(
      (f) => /\.(xml|musicxml)$/i.test(f) && !/container\.xml$/i.test(f) && !f.startsWith("META-INF/")
    );
  }
  if (!root) throw new Error("no MusicXML inside the .mxl archive");
  return dec.decode(files[root]);
}

const el = (id) => document.getElementById(id);
const statusBox = el("status");
function note(msg, show = true) {
  statusBox.textContent = msg;
  statusBox.classList.toggle("show", show && !!msg);
}
window.addEventListener("error", (e) => note("JS error: " + e.message + " @ " + e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => note("Promise error: " + ((e.reason && e.reason.message) || e.reason)));

/* ---------- first-load progress bar ---------- */
function setProgress(pct, label) {
  const fill = el("loaderfill"); if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
  if (label != null) { const l = el("loaderlabel"); if (l) l.textContent = label; }
}
function hideLoader() { const ld = el("loader"); if (ld) { ld.classList.add("done"); setTimeout(() => ld.remove(), 450); } }
const paint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));   // let the bar repaint before a blocking call

let tk = null;            // Verovio toolkit (full piece, drives both notation and MIDI)
let originalDoc = null;   // parsed full-score DOM (all parts)
let parts = [];           // [{id, name, role, voices[]}]
let lanes = [];           // user-facing toggles [{id,label,partId,voice|null}]
let selected = new Set(); // lane ids currently shown/played
let raf = 0;
let pageCount = 1;
let totalMeasures = 0;
let firstVocalMeasure = 0;

// AUDIO: prebuilt MuseScore-correct per-voice MIDI (source/practice.mid) drives sound.
// SYNC: source/sync.json maps each linear measure -> start time (s); the box follows by measure.
let practiceBytes = null, usePractice = false;
// sync.json is in EXPANDED playback order (the repeat is played out with 1st/2nd endings):
let syncTimes = [], syncPrinted = [], syncTotal = 0;  // per expanded step: start seconds + PRINTED measure index
let printedCount = 0;

// TEMPO: tempoRate = slider target; appliedRate = rate currently baked into the playing MIDI.
// The player's clock runs in REAL seconds at appliedRate; sync.json/cues are in MUSICAL seconds.
let tempoRate = 1, appliedRate = 1;
const toOrig = (realSec) => realSec * appliedRate;   // player time -> musical (score) time
const toReal = (origSec) => origSec / appliedRate;   // musical time -> player time
let sections = [], cueTime = null, curSectionIdx = -1;   // tempo/section headings for the jump dropdown
let bassEntries = [];   // bars where the choir bass enters after a rest -> rehearsal letters A,B,C…

// PER-PART AUDIO: each part button has a dropdown (solo/mute, volume, instrument)
const laneVolume = new Map();     // lane.id -> volume multiplier (0..1.5), default 1
const laneProgram = new Map();    // lane.id -> GM program (default 0 = Acoustic Grand Piano)
let activeLaneId = null;          // lane whose dropdown menu is open
const GM_INSTRUMENTS = [
  { n: 0, name: "Piano" }, { n: 4, name: "Electric Piano" }, { n: 6, name: "Harpsichord" },
  { n: 19, name: "Church Organ" }, { n: 24, name: "Nylon Guitar" }, { n: 48, name: "Strings" },
  { n: 52, name: "Choir Aahs" }, { n: 73, name: "Flute" },
];

/* ---------- part label cleanup (handles closed-score "Solo S & A" names) ---------- */
function roleOf(name) {
  const n = (name || "").replace(/\s+/g, " ").replace(/&amp;|&/g, "&").trim();
  if (/pian|klav|keyb|organ|harm/i.test(n)) return "Piano";
  const grp = /solo/i.test(n) ? "Solo " : /cho(ir|rus)/i.test(n) ? "Choir " : "";
  const letters = (n.match(/\b[SATB]\b/g) || []).filter((v, i, a) => a.indexOf(v) === i);
  if (letters.length) return (grp + letters.join("+")).trim();
  if (/sopr|descant/i.test(n)) return "S";
  if (/alto|mezzo/i.test(n)) return "A";
  if (/ten/i.test(n)) return "T";
  if (/bass|bari/i.test(n)) return "B";
  return n || "?";
}

/* ---------- find any score file in /source (dir listing) ---------- */
async function discoverInSource() {
  try {
    const r = await fetch("source/", { cache: "no-store" });
    if (!r.ok) return null;
    const html = await r.text();
    const hits = [...html.matchAll(/href="([^"?]+\.(?:mxl|musicxml|xml))"/gi)]
      .map((m) => decodeURIComponent(m[1].replace(/^.*\//, "")))
      .filter((f) => !/^\./.test(f));
    if (!hits.length) return null;
    hits.sort((a, b) => rank(a) - rank(b));
    return "source/" + hits[0];
  } catch (e) { return null; }
}
// prefer the canonical trimmed score.* ; otherwise rank by format (.mxl > .musicxml > .xml)
const rank = (f) => {
  const named = /^score\.(mxl|musicxml|xml)$/i.test(f) ? 0 : 10;
  return named + (/\.mxl$/i.test(f) ? 0 : /\.musicxml$/i.test(f) ? 1 : 2);
};

async function fetchScore(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("fetch " + url + " -> " + r.status);
  const text = url.toLowerCase().endsWith(".mxl") ? unzipMxl(await r.arrayBuffer()) : await r.text();
  note("Loaded " + url, false);
  return text;
}

async function loadSource() {
  const found = await discoverInSource();
  const tries = found ? [found, ...CONFIG.candidates] : CONFIG.candidates;
  for (const url of tries) {
    try { return await fetchScore(url); } catch (e) { /* keep trying */ }
  }
  note("Waiting for a score — drop any .mxl or .musicxml file into  apps/source/  and refresh. " +
       "(Showing the built-in Ode to Joy demo for now.)");
  return PLACEHOLDER_XML;
}

/* earliest measure index where any vocal part actually sings (skip orchestral intro) */
function computeFirstVocalMeasure() {
  const vocal = parts.filter((p) => !/pian|klav|keyb|organ/i.test(p.name));
  let best = Infinity;
  for (const p of vocal) {
    const partEl = originalDoc.querySelector('part[id="' + p.id + '"]');
    if (!partEl) continue;
    const measures = [...partEl.children].filter((c) => c.tagName === "measure");
    for (let i = 0; i < measures.length; i++) {
      if (measures[i].querySelector("note pitch")) { if (i < best) best = i; break; }
    }
  }
  return best === Infinity ? 0 : best;
}

/* ---------- build the user-facing lanes from the parts ---------- */
function buildLanes() {
  const out = [];
  parts.forEach((p) => {
    const letters = (p.name.replace(/&amp;|&/g, "&").match(/\b[SATB]\b/g) || []);
    const splittable = /cho(ir|rus)/i.test(p.name) && letters.length === 2 && p.voices.length >= 2;
    if (splittable) {
      out.push({ id: p.id + ":" + p.voices[0], label: letters[0], partId: p.id, voice: p.voices[0] });
      out.push({ id: p.id + ":" + p.voices[1], label: letters[1], partId: p.id, voice: p.voices[1] });
    } else {
      out.push({ id: p.id + ":all", label: p.role, partId: p.id, voice: null });
    }
  });
  return out;
}

/* turn a note element into a rest of the same duration (silences one voice) */
function toRest(nEl) {
  if (nEl.querySelector("chord")) { nEl.remove(); return; }
  [...nEl.children].forEach((c) => {
    if (!/^(duration|type|dot|voice|staff|time-modification)$/i.test(c.tagName)) c.remove();
  });
  nEl.insertBefore(nEl.ownerDocument.createElement("rest"), nEl.firstChild);
}

/* build part-groups: a bracket around the Solo section, one around the Choir section
 * (the Piano part is multi-staff so Verovio braces it as a grand staff automatically). */
function rebuildGroups(doc) {
  doc.querySelectorAll("part-group").forEach((g) => g.remove());
  const pl = doc.querySelector("part-list");
  if (!pl) return;
  const sps = [...pl.querySelectorAll("score-part")];
  const groupOf = (sp) => {
    const n = sp.querySelector("part-name")?.textContent || "";
    if (/pian|klav|keyb|organ/i.test(n)) return "Piano";
    if (/solo/i.test(n)) return "Solo";
    if (/cho(ir|rus)/i.test(n)) return "Choir";
    return "";
  };
  let num = 1, i = 0;
  while (i < sps.length) {
    const g = groupOf(sps[i]);
    let j = i;
    while (j + 1 < sps.length && groupOf(sps[j + 1]) === g) j++;
    if (g === "Solo" || g === "Choir") {
      const start = doc.createElement("part-group");
      start.setAttribute("type", "start"); start.setAttribute("number", String(num));
      const sym = doc.createElement("group-symbol"); sym.textContent = "bracket"; start.appendChild(sym);
      const bl = doc.createElement("group-barline"); bl.textContent = "yes"; start.appendChild(bl);
      pl.insertBefore(start, sps[i]);
      const stop = doc.createElement("part-group");
      stop.setAttribute("type", "stop"); stop.setAttribute("number", String(num));
      pl.insertBefore(stop, sps[j].nextSibling);
      num++;
    }
    i = j + 1;
  }
}

/* force every part to play with a piano timbre (MIDI program 1 = Acoustic Grand) */
function forcePiano(doc) {
  doc.querySelectorAll("score-part").forEach((sp) => {
    let mi = sp.querySelector("midi-instrument");
    if (!mi) {
      mi = doc.createElement("midi-instrument");
      mi.setAttribute("id", sp.getAttribute("id") + "-I1");
      sp.appendChild(mi);
    }
    let prog = mi.querySelector("midi-program");
    if (!prog) { prog = doc.createElement("midi-program"); mi.appendChild(prog); }
    prog.textContent = "1";
    const unp = mi.querySelector("midi-unpitched"); if (unp) unp.remove();
  });
}

/* ---------- DISPLAY: the full closed score (all 6 staves, braces), loaded ONCE ---------- */
function displayXml() {
  const doc = originalDoc.cloneNode(true);
  rebuildGroups(doc);   // Solo bracket + Choir bracket (Piano grand staff braces itself)
  forcePiano(doc);
  return new XMLSerializer().serializeToString(doc);   // dim is now fade-only (pure CSS) -> no re-render
}

/* ---------- AUDIO: a "split" score where every lane is its own part => its own MIDI track,
 * built ONCE; toggling a part then just mutes tracks in JS (no Verovio = no freeze) -------- */
let laneTrackOrder = [];
function buildSplitForAudio() {
  const doc = originalDoc.cloneNode(true);
  const origPart = {}; doc.querySelectorAll("part[id]").forEach((p) => (origPart[p.getAttribute("id")] = p));
  const origSP = {}; doc.querySelectorAll("score-part[id]").forEach((sp) => (origSP[sp.getAttribute("id")] = sp));
  const pl = doc.querySelector("part-list");
  const root = doc.documentElement;
  const newSPs = [], newParts = []; laneTrackOrder = [];
  lanes.forEach((lane, i) => {
    const nid = "A" + i;
    const sp = origSP[lane.partId].cloneNode(true); sp.setAttribute("id", nid);
    const pn = sp.querySelector("part-name");
    if (pn) pn.textContent = lane.id; else { const e = doc.createElement("part-name"); e.textContent = lane.id; sp.insertBefore(e, sp.firstChild); }
    const part = origPart[lane.partId].cloneNode(true); part.setAttribute("id", nid);
    if (lane.voice != null) {
      part.querySelectorAll("note").forEach((n) => { const v = n.querySelector("voice")?.textContent.trim(); if (v && v !== lane.voice) toRest(n); });
    }
    const nStaves = new Set([...part.querySelectorAll("staff")].map((s) => s.textContent.trim())).size || 1;
    newSPs.push(sp); newParts.push(part);
    laneTrackOrder.push({ laneId: lane.id, staves: nStaves });
  });
  [...pl.querySelectorAll("score-part, part-group")].forEach((n) => n.remove());
  newSPs.forEach((sp) => pl.appendChild(sp));
  doc.querySelectorAll("part[id]").forEach((p) => p.remove());
  newParts.forEach((p) => root.appendChild(p));
  forcePiano(doc);
  return new XMLSerializer().serializeToString(doc);
}

function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function bytesToB64(u8) { let s = ""; const C = 0x8000; for (let i = 0; i < u8.length; i += C) s += String.fromCharCode.apply(null, u8.subarray(i, i + C)); return btoa(s); }

let audioTk = null, audioMidiBytes = null;
const laneTracks = new Map();   // laneId -> [trackIndex,...]
function buildAudioBank() {
  if (!audioTk) audioTk = new verovio.toolkit();
  audioTk.setOptions({ breaks: "none", header: "none", footer: "none" });
  audioTk.loadData(buildSplitForAudio());
  audioMidiBytes = b64ToBytes(audioTk.renderToMIDI());
  laneTracks.clear(); lanes.forEach((l) => laneTracks.set(l.id, []));
  const m = new Midi(audioMidiBytes.buffer.slice(0));
  const used = new Set();
  m.tracks.forEach((tr, i) => {                       // vocal lanes: match by track name (= lane.id)
    const lane = lanes.find((l) => tr.name && tr.name.indexOf(l.id) !== -1);
    if (lane) { laneTracks.get(lane.id).push(i); used.add(i); }
  });
  const pianoLane = lanes.find((l) => /Piano/i.test(l.label));  // piano tracks are unnamed
  if (pianoLane) m.tracks.forEach((tr, i) => { if (!used.has(i) && tr.notes.length) laneTracks.get(pianoLane.id).push(i); });
}

/* The MIDI re-encode (Tone.Midi toArray) is ~1.4s for this score, so run it in a Web Worker
 * (UI never freezes) and cache results per selection+tempo (repeats are instant). */
const MIDI_WORKER_SRC =
  "importScripts('https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/build/Midi.js');" +
  "let bytes=null;" +
  "function b64(u){let s='',C=0x8000;for(let i=0;i<u.length;i+=C)s+=String.fromCharCode.apply(null,u.subarray(i,i+C));return btoa(s);}" +
  "self.onmessage=function(e){var d=e.data;" +
  "if(d.init){bytes=new Uint8Array(d.init);return;}" +
  "try{var m=new Midi(bytes.buffer.slice(0));" +
  "m.tracks.forEach(function(tr,i){var mu=d.mult[i]==null?1:d.mult[i];" +
  "if(mu<=0){tr.notes=[];return;}" +
  "if(mu!==1)tr.notes.forEach(function(n){var v=n.velocity*mu;n.velocity=v<0?0:(v>1?1:v);});" +
  "if(d.prog&&d.prog[i]!=null)tr.instrument.number=d.prog[i];});" +
  "if(d.rate!==1){if(!m.header.tempos.length)m.header.tempos.push({ticks:0,bpm:120});m.header.tempos.forEach(function(tp){tp.bpm=tp.bpm*d.rate;});}" +
  "self.postMessage({jobId:d.jobId,src:'data:audio/midi;base64,'+b64(m.toArray())});" +
  "}catch(err){self.postMessage({jobId:d.jobId,error:String(err)});}};";

let midiWorker = null, midiJobId = 0, midiWorkerOk = true, pendingAudio = null;
const audioSrcCache = new Map();   // "tracks@tempo" -> data URI
function cacheSrc(key, src) { audioSrcCache.set(key, src); if (audioSrcCache.size > 30) audioSrcCache.delete(audioSrcCache.keys().next().value); }

function ensureMidiWorker() {
  if (midiWorker || !midiWorkerOk) return;
  try {
    midiWorker = new Worker(URL.createObjectURL(new Blob([MIDI_WORKER_SRC], { type: "text/javascript" })));
    midiWorker.onmessage = (e) => {
      const d = e.data;
      if (!d || d.jobId !== midiJobId) return;            // ignore superseded jobs
      if (d.error) { console.warn("midi worker:", d.error); note("", false); return; }
      if (pendingAudio) cacheSrc(pendingAudio.key, d.src);
      applyMidiSrc(d.src);
      note("", false);
    };
    midiWorker.onerror = () => { midiWorkerOk = false; midiWorker = null; };   // fall back to sync
    midiWorker.postMessage({ init: audioMidiBytes.buffer.slice(0) });
  } catch (e) { midiWorkerOk = false; midiWorker = null; }
}

function applyMidiSrc(src) {
  const midi = el("midi");
  appliedRate = pendingAudio ? pendingAudio.rate : tempoRate;
  const origPos = pendingAudio ? pendingAudio.origPos : (midi.currentTime || 0) * appliedRate;
  const wasPlaying = pendingAudio ? pendingAudio.wasPlaying : isPlaying;
  midi.src = src;
  el("play").disabled = false;
  if (wasPlaying) {   // resume at the same MUSICAL spot after the new MIDI loads
    const onload = () => { midi.removeEventListener("load", onload); try { midi.currentTime = origPos / appliedRate; } catch (e) {} midi.start(); };
    midi.addEventListener("load", onload);
  }
}

function updateAudio() {
  if (!audioMidiBytes || typeof Midi === "undefined") return;
  // per-track velocity multiplier (mute->0, else volume) + per-track GM program
  const mult = [], prog = [];
  lanes.forEach((l) => {
    const eff = selected.has(l.id) ? (laneVolume.has(l.id) ? laneVolume.get(l.id) : 1) : 0;
    const p = laneProgram.has(l.id) ? laneProgram.get(l.id) : 0;
    (laneTracks.get(l.id) || []).forEach((ti) => { mult[ti] = eff; prog[ti] = p; });
  });
  const key = mult.join(",") + "|" + prog.join(",") + "@" + tempoRate;
  pendingAudio = { key, origPos: (el("midi").currentTime || 0) * appliedRate, wasPlaying: isPlaying, rate: tempoRate };
  const cached = audioSrcCache.get(key);
  if (cached) { applyMidiSrc(cached); return; }            // instant for mixes we've built before
  ensureMidiWorker();
  if (midiWorker) {
    note("updating audio…", true);
    midiWorker.postMessage({ jobId: ++midiJobId, mult, prog, rate: tempoRate });
  } else {                                                 // worker unavailable -> synchronous fallback
    const m = new Midi(audioMidiBytes.buffer.slice(0));
    m.tracks.forEach((tr, i) => {
      const mu = mult[i] == null ? 1 : mult[i];
      if (mu <= 0) { tr.notes = []; return; }
      if (mu !== 1) tr.notes.forEach((n) => { n.velocity = Math.max(0, Math.min(1, n.velocity * mu)); });
      if (prog[i] != null) tr.instrument.number = prog[i];
    });
    if (tempoRate !== 1) { if (!m.header.tempos.length) m.header.tempos.push({ ticks: 0, bpm: 120 }); m.header.tempos.forEach((tp) => { tp.bpm *= tempoRate; }); }
    const src = "data:audio/midi;base64," + bytesToB64(m.toArray());
    cacheSrc(key, src); applyMidiSrc(src);
  }
}

/* ---------- AUDIO source: prebuilt correct per-voice MIDI (no Verovio MIDI) ---------- */
async function loadPractice() {
  try {
    const r = await fetch("source/practice.mid", { cache: "no-store" });
    if (!r.ok) return false;
    practiceBytes = new Uint8Array(await r.arrayBuffer());
    if (typeof Midi === "undefined") return false;
    const m = new Midi(practiceBytes.buffer.slice(0));
    const norm = (s) => (s || "").replace(/[^A-Za-z]/g, "").toUpperCase();   // "Solo S+A" -> "SOLOSA"
    laneTracks.clear(); lanes.forEach((l) => laneTracks.set(l.id, []));
    lanes.forEach((l) => {
      const want = norm(l.label);
      m.tracks.forEach((tr, i) => { if (norm(tr.name) === want) laneTracks.get(l.id).push(i); });
    });
    const miss = lanes.filter((l) => !(laneTracks.get(l.id) || []).length).map((l) => l.label);
    if (miss.length) { console.warn("practice.mid: unmapped lanes -> fallback", miss); return false; }
    audioMidiBytes = practiceBytes;   // updateAudio() now mutes/plays the prebuilt MIDI
    return true;
  } catch (e) { console.warn("loadPractice failed", e); return false; }
}
async function loadSync() {
  try {
    const r = await fetch("source/sync.json", { cache: "no-store" });
    if (!r.ok) return false;
    const j = await r.json();
    syncTimes = (j.measures || []).map((x) => x.t);     // ascending expanded start times
    syncPrinted = (j.measures || []).map((x) => x.m);   // -> printed measure index (jumps back on the repeat)
    syncTotal = j.total || 0;
    printedCount = j.printedMeasures || (syncPrinted.length ? Math.max(...syncPrinted) + 1 : 0);
    return syncTimes.length > 0;
  } catch (e) { return false; }
}
function currentMeasureAt(t) {       // largest measure whose start time <= t
  let lo = 0, hi = syncTimes.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (syncTimes[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

/* ---------- section markings -> jump dropdown ----------
 * tempo/section headings live as bold <words> directions in the top part (P1). We collect them
 * (dropping the minor directives a tempo / Tempo I / ritard / accel. / poco ritenuto) and expose a
 * printed measure index for jumping. The markings stay printed on the score. */
function detectSections() {
  const out = [];
  const partEl = originalDoc.querySelector("part");
  if (!partEl) return out;
  const measures = [...partEl.children].filter((c) => c.tagName === "measure");
  const MINOR = /^(a\s*tempo|tempo\s*i|ritard|accel|poco\s*ritenuto)\.?$/i;
  measures.forEach((meas, idx) => {
    const num = meas.getAttribute("number");
    meas.querySelectorAll("direction").forEach((d) => {
      const wEls = [...d.getElementsByTagName("words")];
      if (!wEls.length) return;
      const w0 = wEls[0];
      const bold = (w0.getAttribute("font-weight") || "").toLowerCase() === "bold";
      const size = parseFloat(w0.getAttribute("font-size") || "0");
      if (!bold || size < 11) return;
      const text = wEls.map((w) => (w.textContent || "").trim()).join(" ").replace(/\s+/g, " ").trim();
      if (!text || MINOR.test(text)) return;
      out.push({ idx, num, text });   // markings stay visible on the score; this just feeds the dropdown
    });
  });
  const dedup = [];                                       // drop adjacent same-text (e.g. Prestissimo m838/m839)
  for (const s of out) {
    const p = dedup[dedup.length - 1];
    if (p && p.text === s.text && s.idx - p.idx <= 2) continue;
    dedup.push(s);
  }
  dedup.forEach((s) => { s.label = s.text.replace(/\s*\.\s*$/, "") + "  ·  m." + s.num; });
  return dedup;
}
/* ---------- bass entries -> rehearsal letters ----------
 * Find every bar where the choir bass (lane "B") starts singing after a full bar+ of rest, stamp
 * a boxed rehearsal letter (A, B, C…) above that bar in the top part, and feed the jump dropdown. */
function bassLetter(n) {
  return n < 26 ? String.fromCharCode(65 + n)
                : String.fromCharCode(64 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26));
}
function injectRehearsal(measureEl, letter) {
  const doc = measureEl.ownerDocument;
  const dir = doc.createElement("direction"); dir.setAttribute("placement", "above");
  dir.setAttribute("data-freude-reh", "1");
  const dt = doc.createElement("direction-type");
  const reh = doc.createElement("rehearsal"); reh.setAttribute("enclosure", "rectangle"); reh.textContent = letter;
  dt.appendChild(reh); dir.appendChild(dt);
  const firstNote = measureEl.querySelector("note");
  if (firstNote) measureEl.insertBefore(dir, firstNote); else measureEl.appendChild(dir);
}
function detectBassEntries() {
  const out = [];
  const bassLane = lanes.find((l) => l.label === "B");      // choir bass section
  if (!bassLane) return out;
  const partEl = originalDoc.querySelector('part[id="' + bassLane.partId + '"]');
  if (!partEl) return out;
  const voice = bassLane.voice;
  const measures = [...partEl.children].filter((c) => c.tagName === "measure");
  const sings = measures.map((m) =>
    [...m.querySelectorAll("note")].some((n) => {
      const v = n.querySelector("voice");
      return (v ? v.textContent.trim() : "1") === voice && n.querySelector("pitch") && !n.querySelector("rest");
    })
  );
  const topPart = originalDoc.querySelector("part");
  const topMeasures = topPart ? [...topPart.children].filter((c) => c.tagName === "measure") : [];
  let li = 0;
  for (let i = 0; i < sings.length; i++) {
    if (!sings[i] || (i !== 0 && sings[i - 1])) continue;   // entry = sings now, rested the whole previous bar
    const letter = bassLetter(li++);
    out.push({ idx: i, num: measures[i].getAttribute("number"), letter });
    if (topMeasures[i]) injectRehearsal(topMeasures[i], letter);
  }
  return out;
}

function buildSectionUI() {
  const sel = el("sectionjump");
  if (!sel) return;
  sel.innerHTML = "";
  const def = document.createElement("option");
  def.value = ""; def.textContent = (sections.length || bassEntries.length) ? "Jump to…" : "(none)";
  sel.appendChild(def);
  if (sections.length) {
    const g = document.createElement("optgroup"); g.label = "Tempo / sections";
    sections.forEach((s, i) => { const o = document.createElement("option"); o.value = "s" + i; o.textContent = s.label; g.appendChild(o); });
    sel.appendChild(g);
  }
  if (bassEntries.length) {
    const g = document.createElement("optgroup"); g.label = "Bass entries";
    bassEntries.forEach((b, i) => { const o = document.createElement("option"); o.value = "b" + i; o.textContent = "▯ " + b.letter + "  ·  m." + b.num; g.appendChild(o); });
    sel.appendChild(g);
  }
  sel.addEventListener("change", () => {
    const v = sel.value;
    if (v[0] === "s") jumpToSection(parseInt(v.slice(1), 10));
    else if (v[0] === "b") jumpToBassEntry(parseInt(v.slice(1), 10));
    sel.blur();
  });
}
function markSection(i) {   // reflect the current section in the dropdown (unless the user is using it)
  const sel = el("sectionjump");
  if (sel && document.activeElement !== sel) sel.value = i >= 0 ? "s" + i : "";
}
function updateCurrentSection(printedIdx) {
  let si = -1;
  for (let k = 0; k < sections.length; k++) { if (sections[k].idx <= printedIdx) si = k; else break; }
  if (si !== curSectionIdx) { curSectionIdx = si; markSection(si); }
}
function gotoBar(idx) {          // box + glide to a printed bar, and cue the playhead there
  boxBar(idx); scrollToBar(idx, true);
  if (usePractice && syncPrinted.length) {
    const e = syncPrinted.indexOf(idx);
    if (e >= 0) {
      try { el("midi").currentTime = toReal(syncTimes[e]); } catch (_) {}
      cueTime = isPlaying ? null : syncTimes[e];      // musical seconds; remembered for the next Play
    }
  }
}
function jumpToSection(i) { const s = sections[i]; if (!s) return; gotoBar(s.idx); curSectionIdx = i; markSection(i); }
function jumpToBassEntry(i) { const b = bassEntries[i]; if (!b) return; gotoBar(b.idx); }

/* ---------- transport: back-to-start / prev+next section / locate playhead ---------- */
function nowMusical() { return toOrig(el("midi").currentTime || 0); }     // playhead in musical (score) seconds
function printedForMusical(origSec) {
  if (!syncPrinted.length) return 0;
  const e = currentMeasureAt(Math.max(0, origSec));
  return syncPrinted[Math.min(syncPrinted.length - 1, Math.max(0, e))];
}
function showPrinted(printed) {     // box this printed bar, glide the view to it, reflect the section
  boxBar(printed); scrollToBar(printed, true);
  updateCurrentSection(printed);
}
function seekMusical(origSec) {     // move the playhead AND the view to a musical time
  origSec = Math.max(0, Math.min(origSec, syncTotal || origSec));
  try { el("midi").currentTime = toReal(origSec); } catch (_) {}
  cueTime = isPlaying ? null : origSec;          // resume here on next Play if stopped
  showPrinted(printedForMusical(origSec));
}
function currentSectionIndex() {
  const printed = printedForMusical(nowMusical());
  let si = 0;
  for (let k = 0; k < sections.length; k++) { if (sections[k].idx <= printed) si = k; else break; }
  return si;
}
function sectionStartMusical(i) {
  if (!sections[i] || !syncPrinted.length) return 0;
  const e = syncPrinted.indexOf(sections[i].idx);
  return e >= 0 ? syncTimes[e] : 0;
}
function stepBar(delta) {                 // move the playhead one bar back/forward
  if (!syncTimes.length) { browseBar(delta); return; }   // no sync map -> manual bar step
  const now = nowMusical();
  let e = Math.min(syncTimes.length - 1, Math.max(0, currentMeasureAt(now)));
  if (delta < 0) e = (now - syncTimes[e] > 0.25) ? e : Math.max(0, e - 1);   // back: snap to this bar's start, else prev bar
  else e = Math.min(syncTimes.length - 1, e + 1);
  seekMusical(syncTimes[e]);
}
function transport(action) {
  if (action === "start") return seekMusical(0);
  if (action === "locate") return showPrinted(printedForMusical(nowMusical()));   // re-centre the view on the playhead
  if (action === "next") return stepBar(1);
  if (action === "prev") return stepBar(-1);
}

/* ===== continuous virtualized strip: whole piece as one scrolling ribbon ===== */
function renderOptions() {
  return {
    breaks: "auto",
    systemMaxPerPage: 1,        // one system per "page" => each page is one ribbon line
    condense: "none",           // NEVER hide empty staves -> all 6 staves on every system
    pageWidth: CONFIG.pageWidth,
    adjustPageHeight: true,
    pageMarginTop: 6, pageMarginBottom: 6, pageMarginLeft: 6, pageMarginRight: 6,
    scale: parseInt(el("zoom").value, 10),
    footer: "none", header: "none",
    spacingStaff: 16, spacingSystem: 4,   // reserve enough room that lyrics never shift the vocal staves
  };
}

/* ===== continuous virtualized strip: the whole piece is one horizontal ribbon ===== */
let isPlaying = false;
const pageSvgCache = new Map();   // page (system) -> rendered SVG string
let renderedScale = 40;
let dimPiano = false;             // fade the piano staves (+ their markings) so the voices stand out
let dimSolo = false;              // fade the soloist staves
let maxAboveU = 0, maxBlockU = 0, maxBelowU = 0, measuredLayout = false;  // scale-independent system metrics
const FRAME_PAD = 16;

let systems = [];          // per system: {svg, x, w, mounted}
let measureX = [];         // printed bar index -> {x, w} in strip coordinates (staff-line union)
const measureIdToIndex = new Map();   // Verovio measure id -> printed bar index (for the demo follow)
let stripW = 0, frameH = 0, anchorY = 0, blockH = 0;
let boxedBar = -1;
const MOUNT_PAD = 1000;    // px beyond the viewport to keep systems mounted
const READ_FRAC = 0.30;    // where the current bar / playhead sits across the viewport

/* make each system ~1.6 screens wide: fewer clef/key restatements, still light to mount */
function renderOptionsPaged() {
  const o = renderOptions();
  const wrapW = el("ribbon-wrap").clientWidth || 1200;
  o.pageWidth = Math.round((wrapW * 1.6 - 40) * 100 / o.scale);
  return o;
}

/* Render every system once into an off-screen scratch, measuring (a) the uniform vertical metrics
 * so all staves line up, (b) each system's width, (c) each bar's x-extent (staff-line union).
 * Then lay the systems end-to-end in #ribbon, build measureX, and mount the visible ones. */
function buildStrip() {
  note("laying out the ribbon…", true);
  const scale = parseInt(el("zoom").value, 10);
  const stage = document.createElement("div");
  stage.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden";
  document.body.appendChild(stage);
  if (!measuredLayout) { maxAboveU = maxBlockU = maxBelowU = 0; }
  pageSvgCache.clear();
  const pageW = [], pageBars = [];
  for (let p = 1; p <= pageCount; p++) {
    const svgStr = tk.renderToSVG(p); pageSvgCache.set(p, svgStr);
    stage.innerHTML = svgStr;
    const svg = stage.querySelector("svg");
    if (!svg) { pageW.push(0); pageBars.push([]); continue; }
    const sr = svg.getBoundingClientRect();
    pageW.push(sr.width);
    if (!measuredLayout) {
      const six = [...svg.querySelectorAll(".staff")].slice(0, 6).map((s) => s.getBoundingClientRect());
      if (six.length >= 6) {
        maxAboveU = Math.max(maxAboveU, six[0].top - sr.top);
        maxBlockU = Math.max(maxBlockU, six[5].bottom - six[0].top);
        maxBelowU = Math.max(maxBelowU, sr.bottom - six[5].bottom);
      }
    }
    const bars = [];
    svg.querySelectorAll(".measure").forEach((mEl) => {
      let l = Infinity, r = -Infinity;
      mEl.querySelectorAll(".staff").forEach((s) => { const b = s.getBoundingClientRect(); if (b.width > 4) { l = Math.min(l, b.left); r = Math.max(r, b.right); } });
      if (l === Infinity) { const b = mEl.getBoundingClientRect(); l = b.left; r = b.right; }
      bars.push({ id: mEl.id, l: l - sr.left, r: r - sr.left });
    });
    pageBars.push(bars);
  }
  stage.remove();
  if (!measuredLayout) { const f = 100 / scale; maxAboveU *= f; maxBlockU *= f; maxBelowU *= f; measuredLayout = true; }
  const k = scale / 100;
  const above = Math.round(maxAboveU * k), block = Math.round(maxBlockU * k), below = Math.round(maxBelowU * k);
  frameH = FRAME_PAD + above + block + below + FRAME_PAD;
  anchorY = FRAME_PAD + above; blockH = block;

  systems = []; measureX = []; measureIdToIndex.clear();
  let x = 0;
  for (let p = 1; p <= pageCount; p++) {
    const w = pageW[p - 1] || 0;
    systems.push({ svg: pageSvgCache.get(p), x, w, mounted: null });
    (pageBars[p - 1] || []).forEach((m) => {
      if (m.id) measureIdToIndex.set(m.id, measureX.length);
      measureX.push({ x: Math.round(x + m.l), w: Math.max(10, Math.round(m.r - m.l)) });
    });
    x += w;
  }
  stripW = Math.round(x);
  if (printedCount && measureX.length !== printedCount)
    console.warn("measure count mismatch: strip=" + measureX.length + " sync=" + printedCount);

  const ribbon = el("ribbon"), box = el("box");
  ribbon.style.width = stripW + "px";
  ribbon.style.height = frameH + "px";
  [...ribbon.querySelectorAll(".sys")].forEach((n) => n.remove());
  if (box.parentNode !== ribbon) ribbon.appendChild(box);
  mountVisible();
  note("", false);
}

/* mount the systems intersecting the viewport (+pad); unmount the rest (virtualization) */
function mountVisible() {
  if (!systems.length) return;
  const wrap = el("ribbon-wrap"), ribbon = el("ribbon"), box = el("box");
  const vl = wrap.scrollLeft - MOUNT_PAD, vr = wrap.scrollLeft + wrap.clientWidth + MOUNT_PAD;
  for (const s of systems) {
    const vis = (s.x < vr && s.x + s.w > vl);
    if (vis && !s.mounted) {
      const d = document.createElement("div"); d.className = "sys";
      d.style.cssText = "left:" + s.x + "px;width:" + s.w + "px;height:" + frameH + "px";
      d.innerHTML = s.svg;
      ribbon.insertBefore(d, box);   // keep the box as the last child so it draws on top
      const svg = d.querySelector("svg");
      if (svg) {
        const sr = svg.getBoundingClientRect(), s1 = svg.querySelector(".staff");
        if (s1) svg.style.marginTop = Math.round(anchorY - (s1.getBoundingClientRect().top - sr.top)) + "px";
        dimSvg(svg);
      }
      s.mounted = d;
    } else if (!vis && s.mounted) { s.mounted.remove(); s.mounted = null; }
  }
}

/* place the highlight box over printed bar k (strip coords — it scrolls with the music) */
function boxBar(k) {
  const m = measureX[k], box = el("box");
  if (!m) { box.classList.remove("on"); boxedBar = -1; return; }
  box.style.left = m.x + "px"; box.style.width = m.w + "px";
  box.style.top = anchorY + "px"; box.style.height = blockH + "px";
  box.classList.add("on"); boxedBar = k;
  el("barpos").textContent = measureX.length ? ("bar " + (k + 1) + " / " + measureX.length) : "—";
}
function scrollToBar(k, smooth) {
  const wrap = el("ribbon-wrap"), m = measureX[k]; if (!m) return;
  wrap.scrollTo({ left: Math.max(0, m.x - wrap.clientWidth * READ_FRAC), behavior: smooth ? "smooth" : "auto" });
  mountVisible();
}
/* bar nearest the read line at the current scroll position (manual stepping) */
function barAtScroll() {
  const wrap = el("ribbon-wrap"), cx = wrap.scrollLeft + wrap.clientWidth * READ_FRAC;
  let lo = 0, hi = measureX.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (measureX[mid].x <= cx) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
function browseBar(dir) {
  if (!measureX.length) return;
  const k = Math.max(0, Math.min(measureX.length - 1, barAtScroll() + dir));
  boxBar(k); scrollToBar(k, true);
}

function relayoutDisplay() {
  note("preparing…", true);
  requestAnimationFrame(() => {
    try {
      renderedScale = parseInt(el("zoom").value, 10);
      tk.setOptions(renderOptionsPaged());
      if (!tk.loadData(displayXml())) { note("Verovio could not parse the score."); return; }
      pageCount = tk.getPageCount();
      const keep = boxedBar;
      buildStrip();
      if (keep >= 0) { boxBar(keep); scrollToBar(keep, false); }
      note("", false);
    } catch (e) { note("display error: " + e.message); }
  });
}

/* Fade dimmed parts AND everything that visually belongs to them (dynamics, slurs, ties,
 * cresc/dolce text, fermatas, the part name + brace). Markings carry no staff reference
 * in the SVG, so classify them by vertical position: piano = below the choir/piano midline,
 * solo = above the solo/choir midline. NOTE: tempo/section headings (.tempo, e.g. "Presto",
 * "Allegro assai") are headings for the WHOLE system, so they're deliberately NOT dimmable. */
const DIM_MARKS = ".above,.below,.dynam,.dynamList,.hairpin,.dir,.fermata,.slur,.tie," +
  ".pedal,.trill,.mordent,.turn,.arpeg,.breath,.fing,.harm,.octave,.gliss,.reh,.label,.labelAbbr,.grpSym,.ending,.bracketSpan";
/* fade one system's svg: classify staves + markings by vertical position (uniform across systems) */
function dimSvg(svg) {
  if (!svg) return;
  svg.querySelectorAll(".dim").forEach((e) => e.classList.remove("dim"));
  if (!dimPiano && !dimSolo) return;
  const m0 = svg.querySelector(".measure");
  const six = m0 ? [...m0.querySelectorAll(".staff")].slice(0, 6).map((s) => s.getBoundingClientRect()) : [];
  if (six.length < 6) return;
  const pianoMid = (six[3].bottom + six[4].top) / 2;   // below this = piano region
  const soloMid = (six[1].bottom + six[2].top) / 2;    // above this = solo region
  const dimY = (cy) => (dimPiano && cy > pianoMid) || (dimSolo && cy < soloMid);
  svg.querySelectorAll(".measure").forEach((m) => {
    const st = m.querySelectorAll(".staff"); const n = st.length;
    st.forEach((s, i) => { if ((dimPiano && i >= n - 2) || (dimSolo && i < 2)) s.classList.add("dim"); });
  });
  svg.querySelectorAll(DIM_MARKS).forEach((e) => {
    if (e.closest(".staff") || e.closest(".dim")) return;   // already faded by an ancestor
    const r = e.getBoundingClientRect();
    if (r.height && dimY((r.top + r.bottom) / 2)) e.classList.add("dim");
  });
}
/* apply the current dim state to every mounted system + reflect the toggle buttons */
function applyDim() {
  el("dimpiano")?.classList.toggle("on", dimPiano);
  el("dimsolo")?.classList.toggle("on", dimSolo);
  el("ribbon").querySelectorAll(".sys svg").forEach((svg) => dimSvg(svg));
}

/* ---------- playback: full-piece MIDI; a tall box follows the current bar, gliding smoothly ---------- */
function clearHighlight() { el("box").classList.remove("on"); }
// Research-informed timing (sight-reading eye-hand span ~1s/0-2 beats; tap anticipation ~tens of ms):
//   BOX sits ~on the beat with a small lead to cancel latency; the SET turns ~1 beat early.
const BOX_LEAD_MS = 150;    // where the highlight sits (on-the-beat feel)
const SWAP_LEAD_MS = 500;   // how early the page turns (within the natural look-ahead)
/* measure-driven follow: the prebuilt MIDI's clock (seconds) -> current bar via sync.json,
 * then box that bar and turn the set early. Independent of Verovio's (incorrect) MIDI clock. */
function followPractice(t) {
  if (!measureX.length || !syncTimes.length) return;
  const ot = toOrig(t);
  const lastE = syncPrinted.length - 1;
  const boxE = Math.min(lastE, currentMeasureAt(ot + BOX_LEAD_MS / 1000));   // small lead so the box sits on the beat
  const printed = syncPrinted[boxE];                                          // revisits the repeated bars on pass 2
  updateCurrentSection(printed);
  if (printed !== boxedBar) boxBar(printed);
  // smooth continuous scroll: interpolate the playhead's x within the current bar's time span
  const eNow = Math.min(lastE, currentMeasureAt(ot));
  const m = measureX[syncPrinted[eNow]];
  let x = m ? m.x : 0;
  if (m) {
    const t0 = syncTimes[eNow], t1 = eNow < lastE ? syncTimes[eNow + 1] : (syncTotal || t0 + 1);
    const frac = t1 > t0 ? Math.max(0, Math.min(1, (ot - t0) / (t1 - t0))) : 0;
    x = m.x + frac * m.w;
  }
  const wrap = el("ribbon-wrap");
  wrap.scrollLeft = Math.max(0, x - wrap.clientWidth * READ_FRAC);
  mountVisible();
}
function follow(ms) {   // demo fallback (Verovio's own clock): box the current note's bar when mounted
  let at; try { at = tk.getElementsAtTime(ms + BOX_LEAD_MS); } catch (e) { return; }
  const noteId = (at && at.notes || [])[0]; if (!noteId) return;
  const nEl = document.getElementById(noteId);
  const mEl = nEl && nEl.closest(".measure");
  const k = mEl ? measureIdToIndex.get(mEl.id) : null;
  if (k == null) return;
  if (k !== boxedBar) boxBar(k);
  scrollToBar(k, false);
}
const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
/* ONE persistent loop — never cancelled, so interacting can't permanently stop following */
function loop() {
  const midi = el("midi");
  const t = midi.currentTime || 0;
  el("time").textContent = fmt(t);
  if (isPlaying) { try { usePractice ? followPractice(t) : follow(t * 1000); } catch (e) { /* keep looping */ } }
  raf = requestAnimationFrame(loop);
}

/* ---------- UI ---------- */
function buildLaneUI() {
  const box = el("parts");
  box.innerHTML = "";
  addBtn(box, "Full", "preset", () => selectAll(true));
  lanes.forEach((l) => {
    if (!laneVolume.has(l.id)) laneVolume.set(l.id, 1);
    const grp = document.createElement("span"); grp.className = "lanegrp";
    const b = document.createElement("button"); b.className = "lanebtn"; b.textContent = l.label; b.dataset.id = l.id;
    b.addEventListener("click", () => {                 // quick mute/unmute
      if (selected.has(l.id)) selected.delete(l.id); else selected.add(l.id);
      syncButtons(); updateAudio();
    });
    const caret = document.createElement("button"); caret.className = "lanecaret"; caret.textContent = "▾"; caret.dataset.id = l.id;
    caret.addEventListener("click", (e) => { e.stopPropagation(); openLaneMenu(l, caret); });  // solo/mute, volume, instrument
    grp.appendChild(b); grp.appendChild(caret);
    box.appendChild(grp);
  });
  syncButtons();
}
function addBtn(box, label, cls, onClick, dataId) {
  const b = document.createElement("button");
  b.textContent = label; if (cls) b.className = cls;
  if (dataId) b.dataset.id = dataId;
  b.addEventListener("click", onClick);
  box.appendChild(b);
}
function syncButtons() {
  document.querySelectorAll("#parts .lanebtn[data-id]").forEach((b) => {
    b.classList.toggle("on", selected.has(b.dataset.id));
  });
}
function selectAll(on) {
  selected = new Set(on ? lanes.map((l) => l.id) : []);
  syncButtons(); updateAudio();
}

/* ---------- per-part dropdown: solo/mute, volume, instrument ---------- */
function setupLaneMenu() {
  const menu = el("lanemenu"); if (!menu) return;
  const inst = menu.querySelector(".lm-inst");
  GM_INSTRUMENTS.forEach((g) => { const o = document.createElement("option"); o.value = String(g.n); o.textContent = g.name; inst.appendChild(o); });
  const muteBtn = menu.querySelector(".lm-mute");
  menu.querySelector(".lm-solo").addEventListener("click", () => {
    if (!activeLaneId) return; selected = new Set([activeLaneId]); syncButtons(); updateAudio(); muteBtn.textContent = "Mute";
  });
  muteBtn.addEventListener("click", () => {
    if (!activeLaneId) return;
    if (selected.has(activeLaneId)) selected.delete(activeLaneId); else selected.add(activeLaneId);
    syncButtons(); updateAudio(); muteBtn.textContent = selected.has(activeLaneId) ? "Mute" : "Unmute";
  });
  let vt; const vol = menu.querySelector(".lm-vol input"), vlab = menu.querySelector(".lm-vol .v");
  vol.addEventListener("input", () => {
    vlab.textContent = vol.value + "%";
    if (activeLaneId) laneVolume.set(activeLaneId, parseInt(vol.value, 10) / 100);
    clearTimeout(vt); vt = setTimeout(updateAudio, 180);   // debounce the re-encode
  });
  inst.addEventListener("change", () => { if (activeLaneId) laneProgram.set(activeLaneId, parseInt(inst.value, 10)); updateAudio(); });
  document.addEventListener("click", (e) => {              // close on outside click
    if (!menu.hidden && !menu.contains(e.target) && !e.target.classList.contains("lanecaret")) menu.hidden = true;
  });
}
function openLaneMenu(lane, anchor) {
  const menu = el("lanemenu"); if (!menu) return;
  activeLaneId = lane.id;
  menu.querySelector(".lm-title").textContent = lane.label;
  menu.querySelector(".lm-mute").textContent = selected.has(lane.id) ? "Mute" : "Unmute";
  const vol = menu.querySelector(".lm-vol input");
  vol.value = String(Math.round((laneVolume.has(lane.id) ? laneVolume.get(lane.id) : 1) * 100));
  menu.querySelector(".lm-vol .v").textContent = vol.value + "%";
  menu.querySelector(".lm-inst").value = String(laneProgram.has(lane.id) ? laneProgram.get(lane.id) : 0);
  menu.hidden = false;
  const r = anchor.getBoundingClientRect(), w = menu.offsetWidth || 220;
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
  menu.style.top = (r.bottom + 4) + "px";
}

/* ---------- boot ---------- */
function bootVerovio(cb) {
  setProgress(8, "Loading notation engine…");
  const ready = () => { setProgress(25, "Engine ready"); tk = new verovio.toolkit(); cb(); };
  (function wait() {
    if (window.verovio && window.verovio.module) {
      if (verovio.module.calledRun) ready();
      else verovio.module.onRuntimeInitialized = ready;
    } else { setTimeout(wait, 50); }
  })();
}

async function main() {
  setProgress(32, "Loading score…");
  const xml = await loadSource();
  originalDoc = new DOMParser().parseFromString(xml, "application/xml");
  parts = [...originalDoc.querySelectorAll("score-part")].map((sp) => {
    const id = sp.getAttribute("id");
    const rawName = (sp.querySelector("part-name")?.textContent || "").trim();
    const role = roleOf(rawName);
    const partEl = originalDoc.querySelector('part[id="' + id + '"]');
    const voices = partEl
      ? [...new Set([...partEl.querySelectorAll("voice")].map((v) => v.textContent.trim()))]
      : [];
    const pn = sp.querySelector("part-name"); if (pn) pn.textContent = role;       // 1st system label
    let pa = sp.querySelector("part-abbreviation");                                 // later-system label
    if (!pa) { pa = originalDoc.createElement("part-abbreviation"); sp.appendChild(pa); }
    pa.textContent = role;
    return { id, name: rawName, role, voices };
  });
  if (!parts.length) { note("No <score-part> entries found in the file."); return; }
  lanes = buildLanes();
  selected = new Set(lanes.map((l) => l.id));

  const firstPart = originalDoc.querySelector("part");
  totalMeasures = firstPart ? [...firstPart.children].filter((c) => c.tagName === "measure").length : 0;
  firstVocalMeasure = computeFirstVocalMeasure();
  sections = detectSections();   // tags section directions in originalDoc (so displayXml hides them)
  bassEntries = detectBassEntries();   // stamp rehearsal letters at bass entries + feed the dropdown

  buildLaneUI();
  setupLaneMenu();
  buildSectionUI();
  // prefer the prebuilt correct per-voice MIDI + measure sync map; fall back to Verovio audio (demo)
  setProgress(45, "Loading audio…");
  usePractice = (await loadPractice()) && (await loadSync());
  // one-time heavy load: full display score + audio (awaited so the bar can paint between stages)
  setProgress(58, "Laying out the score…"); await paint();
  let displayOk = true;
  try {
    tk.setOptions(renderOptionsPaged());
    tk.loadData(displayXml());
    pageCount = tk.getPageCount();
    setProgress(76, "Rendering…"); await paint();
    buildStrip();
    boxBar(0); scrollToBar(0, false);
  } catch (e) { displayOk = false; note("display error: " + e.message); }
  if (displayOk) {
    try {
      setProgress(88, "Indexing bars…"); await paint();
      if (usePractice) { updateAudio(); }
      else { buildAudioBank(); updateAudio(); }
    } catch (e) { console.warn("audio setup failed", e); note("audio error: " + e.message); }
  }
  setProgress(100, "Ready"); note("", false); hideLoader();

  // ZOOM: re-render the whole strip at the new scale on release (positions depend on every system)
  el("zoom").addEventListener("change", () => relayoutDisplay());
  // prev/next: page through by ~one screen of bars
  const scrollScreen = (dir) => { const w = el("ribbon-wrap"); w.scrollBy({ left: dir * w.clientWidth * 0.85, behavior: "smooth" }); };
  el("prev").addEventListener("click", () => scrollScreen(-1));
  el("next").addEventListener("click", () => scrollScreen(+1));

  // ----- manual browse: native horizontal scroll (touch swipe + trackpad) is smooth & bar-by-bar
  //       for free; arrow keys step one bar, Home/End jump to the ends -----
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;   // don't hijack sliders/dropdowns
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case "ArrowRight": case "ArrowDown": case "PageDown": browseBar(+1); e.preventDefault(); break;
      case "ArrowLeft":  case "ArrowUp":   case "PageUp":   browseBar(-1); e.preventDefault(); break;
      case "Home": boxBar(0); scrollToBar(0, true); e.preventDefault(); break;
      case "End":  boxBar(measureX.length - 1); scrollToBar(measureX.length - 1, true); e.preventDefault(); break;
    }
  });
  const wrap = el("ribbon-wrap");
  // a vertical wheel over the ribbon scrolls it horizontally (nice on a mouse with no h-wheel)
  wrap.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || e.shiftKey) return;   // trackpads already send deltaX
    wrap.scrollLeft += e.deltaY; e.preventDefault();
  }, { passive: false });
  // keep systems mounted as the user scrolls manually (rAF-throttled)
  let mountQueued = false;
  wrap.addEventListener("scroll", () => {
    if (mountQueued) return; mountQueued = true;
    requestAnimationFrame(() => { mountQueued = false; if (!isPlaying) mountVisible(); });
  }, { passive: true });

  // transport: back-to-start / prev section / next section / jump-to-playhead
  el("toStart").addEventListener("click", () => transport("start"));
  el("prevSection").addEventListener("click", () => transport("prev"));
  el("nextSection").addEventListener("click", () => transport("next"));
  el("locate").addEventListener("click", () => transport("locate"));
  // DIM: fade-only -> pure CSS, instant, no Verovio re-render
  el("dimpiano").addEventListener("click", () => { dimPiano = !dimPiano; applyDim(); });
  el("dimsolo").addEventListener("click", () => { dimSolo = !dimSolo; applyDim(); });

  let tempoT;   // -100%..+100% : "100% slower" = 0.5x, "100% faster" = 2x; show resulting tempo %
  el("tempo").addEventListener("input", () => {
    const v = parseInt(el("tempo").value, 10);
    tempoRate = v >= 0 ? (1 + v / 100) : (1 + v / 200);
    el("tempopct").textContent = Math.round(tempoRate * 100) + "%";
    clearTimeout(tempoT);
    tempoT = setTimeout(updateAudio, 140);   // re-encode MIDI at the new tempo, keep musical position
  });

  const midi = el("midi");
  const play = el("play");
  play.addEventListener("click", () => {
    if (isPlaying) { midi.stop(); return; }
    if (cueTime != null) { try { midi.currentTime = toReal(cueTime); } catch (_) {} cueTime = null; }  // start at the cued section
    midi.start();
  });
  midi.addEventListener("start", () => { isPlaying = true; play.textContent = "⏸︎"; play.title = "Pause"; });
  midi.addEventListener("stop", () => { isPlaying = false; play.textContent = "▶︎"; play.title = "Play"; clearHighlight(); });

  raf = requestAnimationFrame(loop);   // single persistent follow loop
}

bootVerovio(main);

/* ===================== built-in demo (Ode to Joy, SATB + piano) ===================== */
const DEMO_REPS = 4;
const PLACEHOLDER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Alto</part-name></score-part>
    <score-part id="P3"><part-name>Tenor</part-name></score-part>
    <score-part id="P4"><part-name>Bass</part-name></score-part>
    <score-part id="P5"><part-name>Piano</part-name></score-part>
  </part-list>
  ${demoPart("P1", "G", 2, 0, [["F",1,4],["F",1,4],["G",0,4],["A",0,4]], [["A",0,4],["G",0,4],["F",1,4],["E",0,4]])}
  ${demoPart("P2", "G", 2, 0, [["D",0,4],["D",0,4],["D",0,4],["D",0,4]], [["D",0,4],["D",0,4],["D",0,4],["C",1,4]])}
  ${demoPart("P3", "G", 2, -1, [["A",0,3],["A",0,3],["B",0,3],["A",0,3]], [["A",0,3],["B",0,3],["A",0,3],["A",0,3]])}
  ${demoPart("P4", "F", 4, 0, [["D",0,3],["D",0,3],["G",0,2],["D",0,3]], [["F",1,3],["G",0,2],["A",0,2],["A",0,2]])}
  ${demoPartHalves("P5", "F", 4, [["D",0,3],["A",0,2]], [["D",0,3],["A",0,2]])}
</score-partwise>`;

function pitch(p) {
  const [step, alter, oct] = p;
  return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${oct}</octave></pitch>`;
}
function clefXml(sign, line, oct) {
  return `<clef><sign>${sign}</sign><line>${line}</line>${oct ? `<clef-octave-change>${oct}</clef-octave-change>` : ""}</clef>`;
}
function attrXml(clefSign, clefLine, clefOct) {
  return `<attributes><divisions>1</divisions><key><fifths>2</fifths></key>` +
    `<time><beats>4</beats><beat-type>4</beat-type></time>${clefXml(clefSign, clefLine, clefOct)}</attributes>`;
}
function demoPartGen(id, noteFn, attr, pattern) {
  let body = "";
  for (let i = 0; i < DEMO_REPS * pattern.length; i++) {
    const notes = pattern[i % pattern.length].map(noteFn).join("");
    body += `<measure number="${i + 1}">${i === 0 ? attr : ""}${notes}</measure>`;
  }
  return `<part id="${id}">${body}</part>`;
}
function demoPart(id, clefSign, clefLine, clefOct, m1, m2) {
  const q = (p) => `<note>${pitch(p)}<duration>1</duration><type>quarter</type></note>`;
  return demoPartGen(id, q, attrXml(clefSign, clefLine, clefOct), [m1, m2]);
}
function demoPartHalves(id, clefSign, clefLine, m1, m2) {
  const h = (p) => `<note>${pitch(p)}<duration>2</duration><type>half</type></note>`;
  return demoPartGen(id, h, attrXml(clefSign, clefLine, 0), [m1, m2]);
}
