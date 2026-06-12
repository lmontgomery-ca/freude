"""Offline build: MusicXML -> multi-track practice MIDI with one track per practice lane
(SoloSA, SoloTB, S, A, T, B, Piano), correct pitch (key+accidental resolution) and correct
timing (divisions-based). The repeat is EXPANDED with 1st/2nd endings (first pass -> 1st ending
-> back to the repeat-start -> 2nd ending -> on), matching MuseScore's playback.
sync.json maps each EXPANDED playback step -> {t: start seconds, m: PRINTED measure index}, so the
app's cursor jumps back to the repeated printed bars on the second pass. Outputs into apps/source/."""
import zipfile, json, os
import xml.etree.ElementTree as ET
import mido

SRC = r"e:/2026/FREUDE!!!/apps/source/beethoven-symphony-no-9-4th-movement-piano-solo-with-chorus.mxl"
OUTDIR = r"e:/2026/FREUDE!!!/apps/source"
PPQ = 480

SHARP_ORDER = ["F","C","G","D","A","E","B"]; FLAT_ORDER = ["B","E","A","D","G","C","F"]
ACC2ALTER = {"natural":0,"sharp":1,"flat":-1,"double-sharp":2,"sharp-sharp":2,
             "flat-flat":-2,"double-flat":-2,"natural-sharp":1,"natural-flat":-1}
STEP_SEMI = {"C":0,"D":2,"E":4,"F":5,"G":7,"A":9,"B":11}
def key_alters(f):
    m={}
    if f>0:
        for s in SHARP_ORDER[:f]: m[s]=1
    elif f<0:
        for s in FLAT_ORDER[:abs(f)]: m[s]=-1
    return m
def txt(e): return e.text.strip() if e is not None and e.text else None
def midi_of(step,alter,octave): return (octave+1)*12+STEP_SEMI[step]+int(round(alter))

LANES = ["SoloSA","SoloTB","S","A","T","B","Piano"]
def lane_for(pidx, voice):
    if pidx==0: return "SoloSA"
    if pidx==1: return "SoloTB"
    if pidx==2: return "S" if voice=="1" else "A"
    if pidx==3: return "T" if voice=="1" else "B"
    if pidx==4: return "Piano"
    return None

with zipfile.ZipFile(SRC) as z: data=z.read("score.xml").decode("utf-8")
root=ET.fromstring(data)
parts=root.findall("part")
nmeas=min(len(p.findall("measure")) for p in parts)
pmeas=[p.findall("measure")[:nmeas] for p in parts]   # measures per part

# --- per-measure length (output ticks), and per-measure key/divisions in force (robust to replay) ---
mlen=[0]*nmeas
keyAt=[[0]*nmeas for _ in parts]
divAt=[[1]*nmeas for _ in parts]
for pi,measures in enumerate(pmeas):
    divisions=1; fifths=0
    for mi,meas in enumerate(measures):
        for at in meas.findall("attributes"):
            d=at.find("divisions")
            if d is not None and d.text: divisions=int(d.text)
            for k in at.findall("key"):
                f=k.find("fifths")
                if f is not None and f.text and f.text.lstrip("-").isdigit(): fifths=int(f.text)
        divAt[pi][mi]=divisions; keyAt[pi][mi]=fifths
        cur=0; mx=0
        for el in list(meas):
            if el.tag=="note":
                if el.find("grace") is not None or el.find("chord") is not None: continue
                d=el.find("duration"); cur+= int(d.text) if d is not None else 0
            elif el.tag=="backup": cur-=int(el.find("duration").text)
            elif el.tag=="forward": cur+=int(el.find("duration").text)
            mx=max(mx,cur)
        mlen[mi]=max(mlen[mi], int(round(mx*PPQ/divisions)))

# --- detect repeat + voltas -> expanded playback order of PRINTED measure indices ---
def find_repeat(measures):
    rs=re_=e1s=e2s=None
    for mi,meas in enumerate(measures):
        for r in meas.iter("repeat"):
            if r.get("direction")=="forward" and rs is None: rs=mi
            if r.get("direction")=="backward": re_=mi
        for e in meas.iter("ending"):
            if e.get("type")=="start":
                num=(e.get("number") or "").strip()
                if num.startswith("1") and e1s is None: e1s=mi
                if num.startswith("2") and e2s is None: e2s=mi
    return rs,re_,e1s,e2s
rs,re_,e1s,e2s = find_repeat(pmeas[0])
if re_ is not None:
    if rs is None: rs=0
    if e1s is not None and e2s is not None:
        order = list(range(0,re_+1)) + list(range(rs,e1s)) + list(range(e2s,nmeas))   # voltas
    else:
        order = list(range(0,re_+1)) + list(range(rs,re_+1)) + list(range(re_+1,nmeas))  # plain repeat
    print(f"repeat: forward@{rs} backward@{re_} ending1@{e1s} ending2@{e2s} -> {len(order)} played bars ({nmeas} printed)")
else:
    order = list(range(nmeas)); print("no repeat found -> linear")

# expanded playback start ticks
pstart=[0]*(len(order)+1)
for k,mi in enumerate(order): pstart[k+1]=pstart[k]+mlen[mi]

# --- emit notes per lane (walk the expanded order) + tempos ---
events={ln:[] for ln in LANES}
tempos={}
for pi,measures in enumerate(pmeas):
    for k,mi in enumerate(order):
        meas=measures[mi]
        divisions=divAt[pi][mi]; keymap=key_alters(keyAt[pi][mi]); macc={}
        base=pstart[k]; cur=0; last_on=0
        scale=lambda t: int(round(t*PPQ/divisions))
        for el in list(meas):
            if el.tag=="attributes":
                d=el.find("divisions")
                if d is not None and d.text: divisions=int(d.text)
                for kk in el.findall("key"):
                    f=kk.find("fifths")
                    if f is not None and f.text and f.text.lstrip("-").isdigit(): keymap=key_alters(int(f.text))
            elif el.tag=="direction" or el.tag=="sound":
                snd=el if el.tag=="sound" else el.find(".//sound")
                if snd is not None and snd.get("tempo"):
                    tempos[base+scale(cur)] = int(round(60_000_000/float(snd.get("tempo"))))
            elif el.tag=="backup": cur-=int(el.find("duration").text)
            elif el.tag=="forward": cur+=int(el.find("duration").text)
            elif el.tag=="note":
                if el.find("grace") is not None: continue
                is_chord=el.find("chord") is not None
                dur_el=el.find("duration"); dur=int(dur_el.text) if dur_el is not None else 0
                pitch=el.find("pitch")
                onset = last_on if is_chord else cur
                if pitch is not None:
                    step=txt(pitch.find("step")); octave=int(txt(pitch.find("octave")))
                    alter_el=pitch.find("alter"); acc_el=el.find("accidental")
                    if alter_el is not None and alter_el.text is not None: alter=float(alter_el.text); macc[(step,octave)]=alter
                    elif acc_el is not None and txt(acc_el) in ACC2ALTER: alter=ACC2ALTER[txt(acc_el)]; macc[(step,octave)]=alter
                    elif (step,octave) in macc: alter=macc[(step,octave)]
                    else: alter=keymap.get(step,0)
                    midi=midi_of(step,alter,octave)
                    ln=lane_for(pi, txt(el.find("voice")) or "1")
                    if ln:
                        on_t=base+scale(onset); off_t=base+scale(onset+dur)
                        ties=[t.get("type") for t in el.findall("tie")]
                        merged=False
                        if "stop" in ties:
                            for ev in reversed(events[ln]):
                                if ev["pitch"]==midi and ev.get("open") and abs(ev["off"]-on_t)<=2:
                                    ev["off"]=off_t; merged=True
                                    if "start" not in ties: ev["open"]=False
                                    break
                        if not merged:
                            events[ln].append({"on":on_t,"off":off_t,"pitch":midi,"open":("start" in ties)})
                if not is_chord:
                    last_on=cur; cur+=dur

# --- write MIDI ---
mf=mido.MidiFile(type=1, ticks_per_beat=PPQ)
meta=mido.MidiTrack(); mf.tracks.append(meta)
if 0 not in tempos: tempos[0]=int(round(60_000_000/120))
last=0
for tick in sorted(tempos):
    meta.append(mido.MetaMessage("set_tempo", tempo=tempos[tick], time=tick-last)); last=tick
for ln in LANES:
    tr=mido.MidiTrack(); mf.tracks.append(tr)
    tr.append(mido.MetaMessage("track_name", name=ln, time=0))
    tr.append(mido.Message("program_change", program=0, channel=0, time=0))
    msgs=[]
    for ev in events[ln]:
        msgs.append((ev["on"],1,ev["pitch"])); msgs.append((ev["off"],0,ev["pitch"]))
    msgs.sort(key=lambda x:(x[0],x[1]))
    last=0
    for tick,kind,pitch in msgs:
        msg="note_on" if kind==1 else "note_off"
        tr.append(mido.Message(msg,note=pitch,velocity=80 if kind else 0,channel=0,time=tick-last)); last=tick
mf.save(os.path.join(OUTDIR,"practice.mid"))

# --- sync.json: expanded step -> {t seconds, m printed-measure-index} ---
def sec_at(tick):
    ts=sorted(tempos); s=0.0; prev=0; cur_t=tempos[ts[0]]
    for tk in ts:
        if tk>=tick: break
        s+=(tk-prev)*cur_t/1e6/PPQ; prev=tk; cur_t=tempos[tk]
    s+=(tick-prev)*cur_t/1e6/PPQ
    return s
sync={"ppq":PPQ,"lanes":LANES,"printedMeasures":nmeas,
      "measures":[{"m":order[k],"t":round(sec_at(pstart[k]),4)} for k in range(len(order))],
      "total": round(sec_at(pstart[len(order)]),4)}
with open(os.path.join(OUTDIR,"sync.json"),"w") as f: json.dump(sync,f)

print("lanes:", {l:len(events[l]) for l in LANES})
print(f"total notes={sum(len(events[l]) for l in LANES)}  printed={nmeas} played={len(order)}  duration={sync['total']:.0f}s")
print("wrote practice.mid + sync.json to", OUTDIR)
