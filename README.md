# VR ShortsDrop v2, by VR Developments

Drop your videos, paste one text block, check each title and caption, and upload to your own YouTube channel one video at a time. A static page: open it in Chrome, no install, no server.

## How to run

1. Open `index.html` in Chrome (double-click it, or drag it into a Chrome window).
2. Make the account for this device: pick an email and a password (8 characters or more). It is stored only in this browser. The password is never kept as text. Another phone needs its own account.
3. Step 01: fill in the channel details from the Google setup below and press **Save in this browser**.
4. Step 02: drop your mp4 or mov files in.
5. Step 03: paste your text. One block per video, blocks separated by a line of `---`. Labels are optional: `Title:`, `Description:`, `Tags:`, `Instagram:`, `YouTube captions:`. Without labels, the first line is the title and the rest is the description.
6. Step 04: check each video. Shorts (vertical and 60 seconds or less) are ticked by default. Anything else is unticked: tick it to upload it as a normal video. Edit any title, description or tag here before you upload.
7. Step 05: press **Start upload queue**. Keep the tab open. Uploads run one at a time.
8. Step 06: the log of the last run. Every video with the title, description and tags actually sent, and whether it was uploaded, failed or not uploaded (with the reason). Download it as a text file.

Tests (optional, needs Node 18 or newer, no packages to install):

    npm test

## What is in the folder

- `index.html`, `styles.css`, `src/app.js`: the page
- `src/login.js`: the account on this device (email and password, hashed with WebCrypto)
- `src/parser.js`: splits the pasted text into title, description, hashtags, Instagram caption, YouTube captions and tags
- `src/uploader.js`: refreshes the Google access token, uploads with the resumable protocol in 8 MiB chunks, runs the queue, stops on quota
- `src/storage.js`: keeps the channel details in this browser's localStorage only
- `src/runlog.js`: the per-run log (what was sent, what was uploaded, failed or not, and why)
- `test/`: tests for the parser, the upload core (mocked YouTube), the login, the log, and the page; plus `e2e-browser.py` (a headless Chrome run with the Google endpoints mocked; needs Python with playwright, not part of `npm test`)
- `qa/`: screenshots and the log file from the browser run
- `PROGRESS.txt`: one line per build stage

## Sign-in on this device (stage 4)

- The account lives in this browser's localStorage. The password is hashed with PBKDF2-SHA-256 (210,000 rounds) and a random salt made on this device. The stored record has no password in it.
- **Another phone needs its own account.** A login made on one device does not exist on another.
- Closing the tab signs you out. Reloading asks for the password again.
- **Honest note:** a static page cannot fully protect your keys from someone who has this same phone and can open this browser. This login is a lock on the page, not a vault. Use a browser profile you trust.
- "erase this device" removes the login, the saved channel details and the saved logs from this browser. It cannot be undone.

## Privacy of the channel details

The channel details are stored in this browser only (localStorage, key `shortsdrop.channel.v1`). They are sent in exactly two places: Google's sign-in endpoint (to swap the refresh token for an access token) and the YouTube upload endpoint. Nothing goes to VR Developments, to Tab, or anywhere else. The log never contains the client secret or the refresh token.

## Google Cloud setup VR must do (once)

1. Go to Google Cloud Console and create a project.
2. Enable the **YouTube Data API v3** for that project.
3. Set up the OAuth consent screen (External). Add the YouTube channel's Google account as a test user.
4. Create an OAuth client ID of type **Web application**. Add `https://developers.google.com/oauthplayground` as an authorised redirect URI, and the page's own address if you want.
5. Get a refresh token: in the OAuth 2.0 Playground, set your own client ID and secret, pick the scope `https://www.googleapis.com/auth/youtube.upload`, authorise, and exchange for tokens. Copy the **refresh token**.
6. Paste the client ID, client secret and refresh token into step 01 and save.

Known limits of this setup: while the consent screen is in "Testing", refresh tokens expire after a set number of days (the earlier build's note says about 7; not re-read on Google's OAuth page for this build), so the token may have to be redone. A Google app that is not verified can only be used by its listed test users. Letting strangers connect their own channels needs Google's app verification, which is not in this version.

## Quota facts (from Google's quota page)

Read on Google's "Quota costs for API requests" page on 2026-11-09 (the page at developers.google.com/youtube/v3/determine_quota_cost):

- Projects that enable the YouTube Data API get **10,000 units a day** for all endpoints combined, and a **separate bucket of 100 videos.insert calls a day**.
- The page says the videos.insert bucket has a default limit of 100 per day, and the quota cost is 1 per call in that bucket.
- So **10 Shorts a day, and 12 to 15 a day, are inside the 100-uploads-a-day default** that the page states.
- The per-upload cost of **1,600 units** that other sites quote is **not on Google's page**. It is not used here and is not confirmed.
- When the daily quota is hit, the page stops the queue and shows "daily quota reached, resume tomorrow". Nothing else is attempted that day.
- Quota resets at midnight Pacific Time.
- Google's quota page is the source for these numbers. Check it before you rely on them: Google can change them.

## Limits, in plain words

- Uploads run only while this page is open. Close the tab and the queue stops.
- One video at a time. Each upload is one YouTube upload call against the daily 100.
- Quota reached: the queue stops, the rest waits, and it resumes tomorrow.
- No Instagram posting in this version. The Instagram caption is shown for copying.
- No YouTube collaborators in this version. YouTube captions text is shown for copying; caption tracks are not uploaded.
- Category is fixed to People & Blogs (id 22). Privacy defaults to private; the review step lets you change it.
- GitHub Pages (or any static host) cannot keep secrets safe. The keys stay in each user's own browser.
- Uploads are not resumed across a page reload or a closed tab. A failed video can be started again from the page.
- The login is a page lock, not a vault (see above).

## What is tested

- Parser: 3 realistic samples (labelled, unlabelled, two blocks with a long bracketed title) plus empty input. 4 tests.
- Upload core, against a mocked YouTube endpoint (token refresh, resumable session, chunked PUTs): one token for a whole run, chunk ranges correct, metadata reaches the session, progress reported, links produced, a dropped chunk (503) is asked about and continued rather than restarted, quota stops the queue and leaves the rest waiting (not started), skipped videos never upload, a bad refresh token reports a setup error with no upload started. 7 tests.
- Login: account made on the device, the password not stored as text, a salt per device, right password opens it, wrong password refused with the same message as a wrong email, another device with no account cannot open it, a second account cannot be made over the first, short passwords and bad emails refused, erase removes the account, a damaged record is treated as no account. 7 tests.
- Log: one entry per video, the title, description and tags as sent (a Short gets #Shorts), the reason for each video not uploaded, a quota stop, a cancelled run, a failed upload, the text file contents with no channel secrets, storage of the last 20 runs. 8 tests.
- Page: landmarks, the honest copy (uploads only while open, browser storage is not a vault, the same-phone note, another phone needs its own account), the six numbered steps in order, the login gate, branding (VR ShortsDrop, by VR Developments), every local file it names exists, no remote assets, no real key patterns in any file, network calls only to the two Google hosts, no Instagram or collaborator code, the log download, mobile layout rules. 13 tests.
- Browser run (headless Chromium, Google endpoints mocked at the network layer): account made, channel details saved to localStorage, three files dropped, the landscape clip unticked by default, one Short uploaded with its #Shorts title and private status, one token refresh, the second upload hit the mocked quota answer and the queue stopped with "stopped: daily quota reached. resume tomorrow.", the log showed one uploaded and two not uploaded with reasons, the log downloaded as a text file, sign-out then a wrong password refused, the right password signed back in, a 390 px phone render with no sideways overflow.

Total: 39 node tests (`npm test`) pass, and the browser run passes as described above.

## What is NOT tested

- Real Google sign-in and a real upload. Nothing here has touched a live YouTube channel. The refresh-token exchange from a browser page (CORS on the token endpoint) is assumed and not checked live.
- Real YouTube quota behaviour (the mock answers quotaExceeded when told to).
- Large files: only small clips were used. The chunk logic is tested with a 600 KB file in 256 KB chunks.
- Network drops mid-upload, and resuming after a closed tab or reload.
- Whether YouTube classifies a clip as a Short from the vertical 60-second rule and the #Shorts tag; the page only sets the tag.
- Other browsers (Safari, Firefox) and real phones. The layout was checked at 1440 px and 390 px in headless Chromium only.
- The login on a real phone (keyboard, password managers, private browsing, storage being cleared by the phone).
- Google's rule for uploads from projects that have not been through Google's audit (the quota page does not state it; check Google's audit guide before you rely on private-only defaults).

## Honest copy the page shows

- uploads only run while this page is open.
- browser storage is not a vault. anyone with access to this browser can read these values.
- another phone needs its own account.
- a static page cannot fully protect your keys from someone who has this same phone.
