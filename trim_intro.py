"""Trim the orchestral intro: keep measures from the vocal-entry Presto (index 207, bar 207)
onward — the part of the score where the voices actually sing. Measure 207 already declares the
Presto's new key (-1) and 3/4 time, but NOT the prevailing divisions (=24) or the clefs, which
were set earlier and never restated; this script carries those (plus piano <staves>) into the new
first measure so the trimmed score both renders (Verovio) and builds audio (build_practice.py)
correctly. Original bar numbers are kept (207+). Writes source/score.mxl. Re-run build_practice.py
afterward to regenerate practice.mid + sync.json from the trimmed score."""
import zipfile, copy, io
import xml.etree.ElementTree as ET

SRC = r"e:/2026/FREUDE!!!/apps/source/beethoven-symphony-no-9-4th-movement-piano-solo-with-chorus.mxl"
OUT = r"e:/2026/FREUDE!!!/apps/source/score.mxl"
CUT = 207

zin = zipfile.ZipFile(SRC)
container = zin.read("META-INF/container.xml")
root = ET.fromstring(zin.read("score.xml").decode("utf-8"))

def order_keys(d):  # None (single, staff-less) first, then "1","2",...
    return sorted(d, key=lambda x: (x is not None, x))

for part in root.findall("part"):
    measures = part.findall("measure")
    # prevailing context (last-seen) while scanning the dropped intro 0..CUT-1
    div_el = staves_el = None
    keys, times, clefs = {}, {}, {}
    for m in measures[:CUT]:
        for at in m.findall("attributes"):
            d = at.find("divisions")
            if d is not None: div_el = copy.deepcopy(d)
            st = at.find("staves")
            if st is not None: staves_el = copy.deepcopy(st)
            for k in at.findall("key"):  keys[k.get("number")]  = copy.deepcopy(k)
            for t in at.findall("time"): times[t.get("number")] = copy.deepcopy(t)
            for c in at.findall("clef"): clefs[c.get("number")] = copy.deepcopy(c)

    keep = measures[CUT:]
    first = keep[0]
    own = first.find("attributes")
    own_div = own_keys = own_times = own_clefs = None
    if own is not None:
        d = own.find("divisions"); own_div = copy.deepcopy(d) if d is not None else None
        own_keys  = {k.get("number"): copy.deepcopy(k) for k in own.findall("key")}
        own_times = {t.get("number"): copy.deepcopy(t) for t in own.findall("time")}
        own_clefs = {c.get("number"): copy.deepcopy(c) for c in own.findall("clef")}

    # measure 207's own declarations win (the Presto change); backfill the rest from prevailing
    m_div   = own_div if own_div is not None else div_el
    m_keys  = own_keys  if own_keys  else keys
    m_times = own_times if own_times else times
    m_clefs = own_clefs if own_clefs else clefs

    # rebuild <attributes> in MusicXML schema order: divisions, key, time, staves, clef
    new_at = ET.Element("attributes")
    if m_div is not None: new_at.append(m_div)
    for n in order_keys(m_keys):  new_at.append(m_keys[n])
    for n in order_keys(m_times): new_at.append(m_times[n])
    if staves_el is not None: new_at.append(staves_el)
    for n in order_keys(m_clefs): new_at.append(m_clefs[n])

    if own is not None:
        idx = list(first).index(own); first.remove(own); first.insert(idx, new_at)
    else:
        first.insert(0, new_at)

    for m in measures[:CUT]:
        part.remove(m)

out_xml = ET.tostring(root, encoding="utf-8", xml_declaration=True)
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zo:
    zo.writestr("META-INF/container.xml", container)
    zo.writestr("score.xml", out_xml)
with open(OUT, "wb") as f:
    f.write(buf.getvalue())

kept = root.find("part").findall("measure")
print(f"kept {len(kept)} measures, bars {kept[0].get('number')}..{kept[-1].get('number')} -> {OUT}")
