# Browser check for VR ShortsDrop v2 (not part of npm test). Needs: pip install playwright; playwright install chromium;
# two short clips at /tmp/vr-short.mp4 and /tmp/vr-wide.mp4 (ffmpeg testsrc). Google endpoints are mocked at the network layer.
import json, pathlib, re, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "qa"; OUT.mkdir(parents=True, exist_ok=True)
state = {"sessions": 0, "puts": [], "quota_after": 1, "tokens": 0, "meta": []}
CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS", "Access-Control-Expose-Headers": "Location, Range"}

def handle(route, req):
    url = req.url
    if req.method == "OPTIONS":
        return route.fulfill(status=204, headers=CORS)
    if url.startswith("https://oauth2.googleapis.com/token"):
        state["tokens"] += 1
        return route.fulfill(status=200, headers={**CORS, "content-type": "application/json"}, body=json.dumps({"access_token": "tok"}))
    if url.startswith("https://www.googleapis.com/upload/youtube/v3/videos"):
        if state["quota_after"] is not None and state["sessions"] >= state["quota_after"]:
            return route.fulfill(status=403, headers={**CORS, "content-type": "application/json"}, body=json.dumps({"error": {"errors": [{"reason": "quotaExceeded"}]}}))
        state["sessions"] += 1
        state["meta"].append(json.loads(req.post_data))
        return route.fulfill(status=200, headers={**CORS, "location": f"https://upload.example/session/s{state['sessions']}"}, body="")
    if url.startswith("https://upload.example/session/"):
        sid = url.rsplit("/", 1)[1]
        m = re.search(r"bytes (\d+)-(\d+)/(\d+)", req.headers.get("content-range", ""))
        state["puts"].append(req.headers.get("content-range", ""))
        if m:
            end, total = int(m.group(2)), int(m.group(3))
            if end + 1 >= total:
                return route.fulfill(status=200, headers={**CORS, "content-type": "application/json"}, body=json.dumps({"id": "vid_" + sid}))
            return route.fulfill(status=308, headers={**CORS, "range": f"bytes=0-{end}"}, body="")
    return route.fulfill(status=404, headers=CORS, body="")

results = {}
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" and "403" not in m.text else None)
    page.route(re.compile(r"https://(oauth2\.googleapis\.com|www\.googleapis\.com|upload\.example)/.*"), handle)
    page.goto((ROOT / "index.html").as_uri())
    # stage 4: make the account on this device
    page.fill("#gate-create input[name=email]", "rakshith@example.com")
    page.fill("#gate-create input[name=password]", "long-enough-pass")
    page.fill("#gate-create input[name=password2]", "long-enough-pass")
    page.click("#gate-create button[type=submit]")
    page.wait_for_timeout(600)
    results["signed_in_after_make"] = page.is_visible("#step-channel")
    # channel box
    page.fill("input[name=channelName]", "VR test")
    page.fill("input[name=clientId]", "fake-client")
    page.fill("input[name=clientSecret]", "fake-secret")
    page.fill("input[name=refreshToken]", "fake-refresh")
    page.click("#channel-form button[type=submit]")
    stored = page.evaluate("localStorage.getItem('shortsdrop.channel.v1')")
    results["channel_keys"] = sorted(json.loads(stored).keys())
    # files
    page.set_input_files("#file-input", ["/tmp/vr-short.mp4", "/tmp/vr-wide.mp4", "/tmp/vr-short.mp4"])
    page.wait_for_timeout(900)
    page.fill("#mix", "Title: Coffee at 3am #Shorts\nDescription: quick look\nInstagram: hi #reels\n---\nNight drive, long title\nDescription: wide one\nIG: night drive\n---\nRain on glass #Shorts\nDescription: third one\nTags: rain, city")
    page.click("#split")
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / "e2e-review.png"), full_page=True)
    checks = page.eval_on_selector_all("#review input[type=checkbox]", "els => els.map(e => e.checked)")
    results["include_defaults"] = checks
    page.click("#start")
    page.wait_for_function("document.getElementById('queue-message').textContent.includes('quota')", timeout=60000)
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / "e2e-done.png"), full_page=True)
    results["queue_message"] = page.text_content("#queue-message")
    results["log_state"] = page.text_content("#log-state")
    results["log_items"] = page.eval_on_selector_all("#log-list li", "els => els.map(e => e.innerText.split('\\n')[0] + ' | ' + e.innerText.split('\\n').filter(t => t.startsWith('reason')).join(''))")
    page.locator("#step-log").scroll_into_view_if_needed()
    page.screenshot(path=str(OUT / "log-done.png"), full_page=True)
    with page.expect_download() as dl:
        page.click("#log-download")
    d = dl.value
    dest = OUT / "last-run-log.txt"
    d.save_as(str(dest))
    results["download_name"] = d.suggested_filename
    results["log_file_head"] = dest.read_text().splitlines()[:4]
    # the page is signed in; sign out, then the gate comes back and the old password opens it
    page.click("#signout")
    page.wait_for_timeout(200)
    results["gate_after_signout"] = page.is_visible("#gate")
    page.fill("#gate-signin input[name=password]", "wrong-pass-here")
    page.click("#gate-signin button[type=submit]")
    page.wait_for_timeout(400)
    results["wrong_pw"] = page.text_content("#gate-message")
    page.fill("#gate-signin input[name=password]", "long-enough-pass")
    page.click("#gate-signin button[type=submit]")
    page.wait_for_timeout(400)
    results["back_in"] = page.is_visible("#step-channel")
    results["meta_titles"] = [m["snippet"]["title"] for m in state["meta"]]
    results["puts"] = len(state["puts"]); results["tokens"] = state["tokens"]
    results["errors"] = errs
    # phone-size check of the gate and the log
    ph = b.new_context(viewport={"width": 390, "height": 844})
    pp = ph.new_page(); pp.goto((ROOT / "index.html").as_uri())
    pp.screenshot(path=str(OUT / "gate-phone.png"), full_page=True)
    overflow = pp.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
    results["phone_overflow"] = overflow
    b.close()
for k, v in results.items():
    print(k, "=", v)
