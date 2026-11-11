# Responsive check for VR ShortsDrop (not part of npm test). Headless Chromium via Python playwright.
# usage: python3 qa/responsive-check.py [ROOT] [OUT_DIR]
# Opens index.html from ROOT as a file, makes the device account, adds two clips and some text, then at each
# width measures horizontal overflow, the size of every tap target, and the hit area of the file picker.
import json, pathlib, subprocess, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
ROOT = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else HERE.parent
OUT = pathlib.Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else HERE
OUT.mkdir(parents=True, exist_ok=True)
FIX = pathlib.Path("/tmp/vrs-fixtures"); FIX.mkdir(exist_ok=True)
LONG = FIX / "a_very_long_clip_name_without_any_spaces_or_breaks_0123456789_final_cut_v2.mp4"
WIDE = FIX / "wide-clip.mp4"
if not LONG.exists():
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=360x640:rate=25", "-t", "20", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(LONG)], check=True, timeout=120)
if not WIDE.exists():
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-t", "70", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(WIDE)], check=True, timeout=120)

WIDTHS = [360, 390, 430, 768, 1024, 1440, 1920]   # the six required widths plus 430 (top of the phone range)
TOUCH = {360, 390, 430, 768}   # phones and the tablet, emulated as touch devices
PHONE = {360, 390, 430}        # the 44 px rule is required here; it is measured everywhere

OVERFLOW_JS = """() => {
  const vw = document.documentElement.clientWidth;
  const sw = document.documentElement.scrollWidth;
  const bad = [];
  document.querySelectorAll('body *').forEach(el => {
    if (el.closest('[hidden]')) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    if (r.right > vw + 0.5 || r.left < -0.5) bad.push((el.id || el.className || el.tagName).toString().slice(0, 60) + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
  });
  return { vw, sw, scrollsSideways: sw > vw, outside: bad.length, examples: bad.slice(0, 8) };
}"""

TAP_JS = """() => {
  const sel = 'button, input:not([type=file]):not([type=checkbox]):not([type=hidden]), select, textarea, a[href], label.check, label.dropzone';
  const out = [];
  document.querySelectorAll(sel).forEach(el => {
    if (el.closest('[hidden]')) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    out.push({ tag: el.tagName.toLowerCase(), id: el.id || el.getAttribute('name') || '', label: (el.textContent || el.value || el.getAttribute('placeholder') || '').trim().slice(0, 28), w: Math.round(r.width), h: Math.round(r.height * 10) / 10 });
  });
  return out;
}"""

PICKER_JS = """() => {
  document.getElementById('dropzone').scrollIntoView({ block: 'center' });
  const dz = document.getElementById('dropzone').getBoundingClientRect();
  const cx = dz.left + dz.width / 2, cy = dz.top + dz.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  const input = document.getElementById('file-input');
  return { accept: input.getAttribute('accept'), multiple: input.multiple, hitIsPicker: hit === input, dropzoneH: Math.round(dz.height) };
}"""

def unlock_and_fill(page):
    page.goto((ROOT / "index.html").as_uri())
    page.wait_for_selector("#gate-create", state="visible")
    page.fill("#gate-create input[name=email]", "qa@example.com")
    page.fill("#gate-create input[name=password]", "long-enough-pass")
    page.fill("#gate-create input[name=password2]", "long-enough-pass")
    page.click("#gate-create button[type=submit]")
    page.wait_for_selector("#step-drop", state="visible")
    page.set_input_files("#file-input", [str(LONG), str(WIDE)])
    page.wait_for_function("document.querySelectorAll('#cards .card').length === 2 && document.querySelectorAll('#review .rv').length === 2")
    page.fill("#mix", "Title: Morning light on the bay\nDescription: a short look at the water at six.\nTags: bay, morning\n---\nTitle: A wide clip with a title that is long enough to wrap onto a second line in the index\nDescription: the landscape one.\nTags: wide")
    page.click("#split")
    # a finished run in the log, so the log step has entries to lay out
    page.evaluate("""() => {
      const videos = [{id:'v1', name:'a_very_long_clip_name_without_any_spaces.mp4', fields:{title:'Morning light', description:'a short look', tags:['bay'], privacyStatus:'private', instagramCaption:'', youtubeCaptions:''}, include:true, isShort:true}];
      const run = ClipRunLog.newRun(new Date().toISOString(), videos);
      ClipRunLog.markFailed(run, 'v1', 'quota reached before this video');
      ClipRunLog.finishRun(run, {stoppedForQuota:true, cancelled:false});
      ClipRunLog.saveRun(window.localStorage, run);
    }""")
    page.reload()
    page.wait_for_selector("#gate-signin", state="visible")
    page.fill("#gate-signin input[name=password]", "long-enough-pass")
    page.click("#gate-signin button[type=submit]")
    page.wait_for_selector("#step-drop", state="visible")
    # the page is reloaded, so the cards and review are rebuilt from the video list only after a new pick
    page.set_input_files("#file-input", [str(LONG), str(WIDE)])
    page.wait_for_function("document.querySelectorAll('#cards .card').length === 2")
    page.fill("#mix", "Title: Morning light on the bay\nDescription: a short look at the water at six.\nTags: bay, morning\n---\nTitle: A wide clip\nDescription: the landscape one.\nTags: wide")
    page.click("#split")
    page.wait_for_function("document.querySelectorAll('#review .rv').length === 2")

def run():
    report = {"root": str(ROOT), "widths": {}}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for w in WIDTHS:
            h = 900 if w < 900 else 1000
            touch = w in TOUCH
            ctx = browser.new_context(viewport={"width": w, "height": h}, is_mobile=touch, has_touch=touch, device_scale_factor=1)
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            # the gate, before sign-in
            page.goto((ROOT / "index.html").as_uri())
            page.wait_for_selector("#gate-create", state="visible")
            gate = {"overflow": page.evaluate(OVERFLOW_JS), "tap": page.evaluate(TAP_JS)}
            page.screenshot(path=str(OUT / f"responsive-{w}-gate.png"), full_page=True)
            unlock_and_fill(page)
            page.wait_for_timeout(300)
            r = {
                "gate": gate,
                "overflow": page.evaluate(OVERFLOW_JS),
                "tap": page.evaluate(TAP_JS),
                "picker": page.evaluate(PICKER_JS),
                "errors": errors[:10],
            }
            small = [t for t in r["tap"] if t["h"] < 44]
            r["tapBelow44"] = small
            r["tapCount"] = len(r["tap"])
            page.screenshot(path=str(OUT / f"responsive-{w}.png"), full_page=True)
            page.evaluate("window.scrollTo(0, 0)")
            page.screenshot(path=str(OUT / f"responsive-{w}-top.png"), full_page=False)
            report["widths"][str(w)] = r
            print(w, "scrollsSideways=", r["overflow"]["scrollsSideways"], "outside=", r["overflow"]["outside"],
                  "tap=", r["tapCount"], "below44=", len(small), "picker=", r["picker"]["hitIsPicker"], "errors=", len(errors))
            ctx.close()
        browser.close()
    (OUT / "responsive-report.json").write_text(json.dumps(report, indent=2))
    return report

if __name__ == "__main__":
    run()
