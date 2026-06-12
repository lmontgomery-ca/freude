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
let currentPage = 1;
let pageCount = 1;
let totalMeasures = 0;
let firstVocalMeasure = 0;

// AUDIO: prebuilt MuseScore-correct per-voice MIDI (source/practice.mid) drives sound.
// SYNC: source/sync.json maps each linear measure -> start time (s); the box follows by measure.
let practiceBytes = null, usePractice = false;
// sync.json is in EXPANDED playback order (the repeat is played out with 1st/2nd endings):
let syncTimes = [], syncPrinted = [], syncTotal = 0;  // per expanded step: start seconds + PRINTED measure index
let printedCount = 0;
let measureIds = [], measurePages = [];     // measureIds[i] = Verovio measure id (PRINTED i); measurePages[i] = {id,page}

// TEMPO: tempoRate = slider target; appliedRate = rate currently baked into the playing MIDI.
// The player's clock runs in REAL seconds at appliedRate; sync.json/cues are in MUSICAL seconds.
let tempoRate = 1, appliedRate = 1;
const toOrig = (realSec) => realSec * appliedRate;   // player time -> musical (score) time
const toReal = (origSec) => origSec / appliedRate;   // musical time -> player time
let sections = [], cueTime = null, curSectionIdx = -1;   // tempo/section headings for the jump dropdown

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
const rank = (f) => (/\.mxl$/i.test(f) ? 0 : /\.musicxml$/i.test(f) ? 1 : 2);

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
/* measure id list (linear, from MEI) + per-measure page (layout-dependent, rebuilt on relayout) */
function rebuildMeasureMap() {
  try {
    if (!measureIds.length) {
      const mei = tk.getMEI({});
      measureIds = [...mei.matchAll(/<measure\b[^>]*?xml:id="([^"]+)"/g)].map((x) => x[1]);
      if (printedCount && measureIds.length !== printedCount)
        console.warn("printed measure count mismatch: MEI=" + measureIds.length + " sync=" + printedCount);
    }
    measurePages = measureIds.map((id) => ({ id, page: tk.getPageWithElement(id) }));
  } catch (e) { console.warn("measure map failed", e); measurePages = []; }
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
function buildSectionUI() {
  const sel = el("sectionjump");
  if (!sel) return;
  sel.innerHTML = "";
  const def = document.createElement("option");
  def.value = ""; def.textContent = sections.length ? "Jump to section…" : "(no sections)";
  sel.appendChild(def);
  sections.forEach((s, i) => {
    const o = document.createElement("option");
    o.value = String(i); o.textContent = s.label; sel.appendChild(o);
  });
  sel.addEventListener("change", () => {
    const i = parseInt(sel.value, 10);
    if (!isNaN(i) && sections[i]) jumpToSection(i);
    sel.blur();
  });
}
function markSection(i) {   // reflect the current section in the dropdown (unless the user is using it)
  const sel = el("sectionjump");
  if (sel && document.activeElement !== sel) sel.value = i >= 0 ? String(i) : "";
}
function updateCurrentSection(printedIdx) {
  let si = -1;
  for (let k = 0; k < sections.length; k++) { if (sections[k].idx <= printedIdx) si = k; else break; }
  if (si !== curSectionIdx) { curSectionIdx = si; markSection(si); }
}
function jumpToSection(i) {
  const s = sections[i]; if (!s) return;
  const mp = measurePages[s.idx];
  if (mp && mp.page > 0) {
    renderPage(mp.page);
    const n = document.getElementById(mp.id); if (n) boxOverMeasure(n);
  } else { renderPage(pageForMeasureFraction(s.idx)); }
  if (usePractice && syncPrinted.length) {           // cue the playhead to where this bar first plays
    const e = syncPrinted.indexOf(s.idx);
    if (e >= 0) {
      const midi = el("midi");
      try { midi.currentTime = toReal(syncTimes[e]); } catch (_) {}
      cueTime = isPlaying ? null : syncTimes[e];      // musical seconds; remembered for the next Play
    }
  }
  curSectionIdx = i; markSection(i);
}

/* ---------- transport: back-to-start / prev+next section / locate playhead ---------- */
function nowMusical() { return toOrig(el("midi").currentTime || 0); }     // playhead in musical (score) seconds
function printedForMusical(origSec) {
  if (!syncPrinted.length) return 0;
  const e = currentMeasureAt(Math.max(0, origSec));
  return syncPrinted[Math.min(syncPrinted.length - 1, Math.max(0, e))];
}
function showPrinted(printed) {     // render the page holding this printed bar, box it, reflect the section
  const mp = measurePages[printed];
  if (mp && mp.page > 0) { renderPage(mp.page); const n = document.getElementById(mp.id); if (n) boxOverMeasure(n); }
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
function transport(action) {
  if (action === "start") return seekMusical(0);
  if (action === "locate") return showPrinted(printedForMusical(nowMusical()));   // re-centre the view on the playhead
  if (!sections.length) return;
  const i = currentSectionIndex();
  if (action === "next") jumpToSection(Math.min(sections.length - 1, i + 1));
  else if (action === "prev") jumpToSection((nowMusical() - sectionStartMusical(i) > 1.5) ? i : Math.max(0, i - 1));
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

/* ===== paged "set of bars": one system fills the screen; a tall box highlights the current bar ===== */
let isPlaying = false;
const pageSvgCache = new Map();   // page -> rendered SVG string (avoids re-rendering on nav/page-turn)
let renderedScale = 40;           // zoom Verovio last actually rendered at (for instant CSS-scale preview)
let dimPiano = false;             // fade the piano staves (+ their markings) so the voices stand out
let dimSolo = false;              // fade the soloist staves
let sysBoxTop = 0, sysBoxH = 0;   // vertical extent of the staves on the current set (for the box)
let maxAboveU = 0, maxBlockU = 0, maxBelowU = 0, measuredLayout = false;  // max system metrics (units)
const FRAME_PAD = 16;             // breathing room above the highest content and below the lowest

/* size pageWidth so one system fills the viewport width at the current zoom */
function renderOptionsPaged() {
  const o = renderOptions();
  const wrapW = el("ribbon-wrap").clientWidth || 1200;
  o.pageWidth = Math.round((wrapW - 60) * 100 / o.scale);   // SVG width ≈ pageWidth*scale/100 ≈ viewport
  return o;
}

/* Measure ONCE the MAX vertical space the system needs: above the top staff (dynamics, tempo,
 * rehearsal letters), the staff block itself, and below the bottom staff (ledgers, text). Then
 * size every set's frame to that maximum and TOP-ANCHOR the staff block to a fixed Y. Combined
 * with staff spacing high enough to reserve lyric room, every set has identical staff positions. */
function applyUniformHeight() {
  const scale = parseInt(el("zoom").value, 10);
  if (!measuredLayout) {
    note("measuring layout…", true);
    const stage = document.createElement("div");   // throwaway off-screen scratch (keep #ribbon/#box intact)
    stage.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden";
    document.body.appendChild(stage);
    for (let p = 1; p <= pageCount; p++) {
      const svgStr = tk.renderToSVG(p);
      pageSvgCache.set(p, svgStr);                 // these renders double as the display cache (instant nav)
      stage.innerHTML = svgStr;
      const svg = stage.querySelector("svg"); if (!svg) continue;
      const sr = svg.getBoundingClientRect();
      const six = [...svg.querySelectorAll(".staff")].slice(0, 6).map((s) => s.getBoundingClientRect());
      if (six.length < 6) continue;
      maxAboveU = Math.max(maxAboveU, six[0].top - sr.top);
      maxBlockU = Math.max(maxBlockU, six[5].bottom - six[0].top);
      maxBelowU = Math.max(maxBelowU, sr.bottom - six[5].bottom);
    }
    stage.remove();
    const f = 100 / scale;                 // px -> scale-independent units
    maxAboveU *= f; maxBlockU *= f; maxBelowU *= f;
    measuredLayout = true;
  }
  const k = scale / 100;
  const above = Math.round(maxAboveU * k), block = Math.round(maxBlockU * k), below = Math.round(maxBelowU * k);
  const r = el("ribbon");
  r.style.height = (FRAME_PAD + above + block + below + FRAME_PAD) + "px";
  r.dataset.anchor = String(FRAME_PAD + above);   // y (within the frame) where the top staff must sit
}

function relayoutDisplay() {
  note("preparing…", true);
  requestAnimationFrame(() => {
    try {
      pageSvgCache.clear();                    // layout/data changed -> old renders are stale
      renderedScale = parseInt(el("zoom").value, 10);
      tk.setOptions(renderOptionsPaged());
      if (!tk.loadData(displayXml())) { note("Verovio could not parse the score."); return; }
      pageCount = tk.getPageCount();
      applyUniformHeight();
      renderPage(currentPage);
      if (usePractice) rebuildMeasureMap();   // page numbers change with zoom
      note("", false);
    } catch (e) { note("display error: " + e.message); }
  });
}

function renderPage(p) {
  currentPage = Math.max(1, Math.min(p, pageCount));
  const ribbon = el("ribbon");
  const box = el("box");
  ribbon.innerHTML = "";
  let svgStr = pageSvgCache.get(currentPage);          // reuse the rendered system if we've seen it
  if (svgStr === undefined) { svgStr = tk.renderToSVG(currentPage); pageSvgCache.set(currentPage, svgStr); }
  ribbon.insertAdjacentHTML("beforeend", svgStr);
  ribbon.appendChild(box);
  box.classList.remove("on");                 // hide until placed on a bar
  const svg = ribbon.querySelector("svg");
  // TOP-ANCHOR: shift the system so its top staff sits at the same Y on every set (no jump)
  if (svg) {
    const sr = svg.getBoundingClientRect();
    const s1 = svg.querySelector(".staff");
    const anchor = parseFloat(ribbon.dataset.anchor || "0");
    if (s1) svg.style.marginTop = Math.round(anchor - (s1.getBoundingClientRect().top - sr.top)) + "px";
  }
  // vertical extent of the 6-staff block (for the highlight box) AFTER anchoring
  let t = Infinity, b = -Infinity;
  if (svg) svg.querySelectorAll(".staff").forEach((s) => { const r = s.getBoundingClientRect(); if (r.height > 2) { t = Math.min(t, r.top); b = Math.max(b, r.bottom); } });
  const rr = ribbon.getBoundingClientRect();
  sysBoxTop = (t === Infinity) ? 0 : (t - rr.top);
  sysBoxH = (b === -Infinity) ? 0 : (b - t);
  applyDim();
  el("barpos").textContent = pageCount ? ("set " + currentPage + " / " + pageCount) : "—";
}

/* Fade dimmed parts AND everything that visually belongs to them (dynamics, slurs, ties,
 * cresc/dolce text, fermatas, the part name + brace). Markings carry no staff reference
 * in the SVG, so classify them by vertical position: piano = below the choir/piano midline,
 * solo = above the solo/choir midline. NOTE: tempo/section headings (.tempo, e.g. "Presto",
 * "Allegro assai") are headings for the WHOLE system, so they're deliberately NOT dimmable. */
const DIM_MARKS = ".above,.below,.dynam,.dynamList,.hairpin,.dir,.fermata,.slur,.tie," +
  ".pedal,.trill,.mordent,.turn,.arpeg,.breath,.fing,.harm,.octave,.gliss,.reh,.label,.labelAbbr,.grpSym,.ending,.bracketSpan";
function applyDim() {
  el("dimpiano")?.classList.toggle("on", dimPiano);
  el("dimsolo")?.classList.toggle("on", dimSolo);
  const svg = el("ribbon").querySelector("svg");
  if (!svg) return;
  svg.querySelectorAll(".dim").forEach((e) => e.classList.remove("dim"));
  if (!dimPiano && !dimSolo) return;
  const m0 = svg.querySelector(".measure");
  const six = m0 ? [...m0.querySelectorAll(".staff")].slice(0, 6).map((s) => s.getBoundingClientRect()) : [];
  if (six.length < 6) return;
  const pianoMid = (six[3].bottom + six[4].top) / 2;   // below this = piano region
  const soloMid = (six[1].bottom + six[2].top) / 2;    // above this = solo region
  const dimY = (cy) => (dimPiano && cy > pianoMid) || (dimSolo && cy < soloMid);
  // staves
  svg.querySelectorAll(".measure").forEach((m) => {
    const st = m.querySelectorAll(".staff"); const n = st.length;
    st.forEach((s, i) => { if ((dimPiano && i >= n - 2) || (dimSolo && i < 2)) s.classList.add("dim"); });
  });
  // markings, classified by vertical position (document order -> ancestors first, no opacity compounding)
  svg.querySelectorAll(DIM_MARKS).forEach((e) => {
    if (e.closest(".staff") || e.closest(".dim")) return;   // already faded by an ancestor
    const r = e.getBoundingClientRect();
    if (r.height && dimY((r.top + r.bottom) / 2)) e.classList.add("dim");
  });
}

/* put the highlight box over a SINGLE bar (covers all staves, full system height).
 * Use the STAFF lines for the bar width (they never overhang, unlike slurs/beams/ties). */
function boxOverMeasure(measureEl) {
  const ribbon = el("ribbon"), box = el("box");
  const svg = ribbon.querySelector("svg");
  if (!measureEl || !svg) { box.classList.remove("on"); return; }
  // union the x-extent of this bar's staff groups (staff lines = exact bar width)
  let left = Infinity, right = -Infinity;
  measureEl.querySelectorAll(".staff").forEach((s) => {
    const r = s.getBoundingClientRect();
    if (r.width > 4) { left = Math.min(left, r.left); right = Math.max(right, r.right); }
  });
  if (left === Infinity) { const mr = measureEl.getBoundingClientRect(); left = mr.left; right = mr.right; }
  const rr = ribbon.getBoundingClientRect();
  box.style.left = (left - rr.left) + "px";
  box.style.width = Math.max(10, right - left) + "px";
  box.style.top = sysBoxTop + "px";           // cover the staff block (set in renderPage), not the headroom
  box.style.height = sysBoxH + "px";
  box.classList.add("on");
}

function pageForMeasureFraction(measureIdx) {
  if (!totalMeasures) return 1;
  return Math.max(1, Math.min(pageCount, Math.round((measureIdx / totalMeasures) * pageCount) + 1));
}

/* ---------- playback: full-piece MIDI; a tall box follows the current bar, set-by-set ---------- */
function clearHighlight() { el("box").classList.remove("on"); }
// Research-informed timing (sight-reading eye-hand span ~1s/0-2 beats; tap anticipation ~tens of ms):
//   BOX sits ~on the beat with a small lead to cancel latency; the SET turns ~1 beat early.
const BOX_LEAD_MS = 150;    // where the highlight sits (on-the-beat feel)
const SWAP_LEAD_MS = 500;   // how early the page turns (within the natural look-ahead)
/* measure-driven follow: the prebuilt MIDI's clock (seconds) -> current bar via sync.json,
 * then box that bar and turn the set early. Independent of Verovio's (incorrect) MIDI clock. */
function followPractice(t) {
  if (!measurePages.length || !syncTimes.length) return;
  const lastP = measurePages.length - 1, lastE = syncPrinted.length - 1;
  const printedAt = (lead) => Math.min(lastP, syncPrinted[Math.min(lastE, currentMeasureAt(toOrig(t) + lead))]);
  const boxPrinted = printedAt(BOX_LEAD_MS / 1000);            // expanded step -> printed bar (revisits on repeat)
  const box = measurePages[boxPrinted];
  const swap = measurePages[printedAt(SWAP_LEAD_MS / 1000)];
  if (!box) return;
  updateCurrentSection(boxPrinted);
  const target = Math.max(box.page > 0 ? box.page : currentPage, swap && swap.page > 0 ? swap.page : currentPage);
  if (target !== currentPage) renderPage(target);
  const id = (box.page === currentPage) ? box.id : (swap ? swap.id : box.id);   // at a set-swap, box the upcoming bar
  const n = id ? document.getElementById(id) : null;
  if (n) boxOverMeasure(n);
}
function follow(ms) {
  let atBox, atSwap;
  try { atBox = tk.getElementsAtTime(ms + BOX_LEAD_MS); atSwap = tk.getElementsAtTime(ms + SWAP_LEAD_MS); } catch (e) { return; }
  const boxNote = (atBox && atBox.notes || [])[0];
  const swapNote = (atSwap && atSwap.notes || [])[0];
  if (!boxNote && !swapNote) return;
  const boxPage = boxNote ? tk.getPageWithElement(boxNote) : currentPage;   // at.page is unreliable
  const swapPage = swapNote ? tk.getPageWithElement(swapNote) : boxPage;
  const target = Math.max(boxPage > 0 ? boxPage : currentPage, swapPage > 0 ? swapPage : currentPage);
  if (target !== currentPage) renderPage(target);                           // turn the set early
  // box the on-beat bar if it's on the shown set; at a boundary swap, box the upcoming bar (new set)
  const boxId = (boxPage === currentPage && boxNote) ? boxNote : swapNote;
  const n = boxId ? document.getElementById(boxId) : null;
  const measureEl = n && n.closest(".measure");
  if (measureEl) boxOverMeasure(measureEl);
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
    applyUniformHeight();
    setProgress(76, "Rendering…"); await paint();
    renderPage(1);
  } catch (e) { displayOk = false; note("display error: " + e.message); }
  if (displayOk) {
    try {
      setProgress(88, "Indexing bars…"); await paint();
      if (usePractice) { rebuildMeasureMap(); updateAudio(); }
      else { buildAudioBank(); updateAudio(); }
    } catch (e) { console.warn("audio setup failed", e); note("audio error: " + e.message); }
  }
  setProgress(100, "Ready"); note("", false); hideLoader();

  // ZOOM: instant CSS-scale preview while dragging; one real re-layout on release (no per-tick freeze)
  el("zoom").addEventListener("input", () => {
    const s = parseInt(el("zoom").value, 10);
    el("ribbon").style.transform = "scale(" + (s / renderedScale) + ")";
  });
  el("zoom").addEventListener("change", () => { el("ribbon").style.transform = ""; relayoutDisplay(); });
  el("prev").addEventListener("click", () => renderPage(currentPage - 1));
  el("next").addEventListener("click", () => renderPage(currentPage + 1));
  el("jumpvoices").addEventListener("click", () => renderPage(pageForMeasureFraction(firstVocalMeasure)));
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
