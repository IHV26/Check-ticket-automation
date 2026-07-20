# Rapid Ticket Watch — automation

Runs every hour, loads the Entertix ticket page, clicks through to the seat
map, counts sold vs. available seats, and writes the result straight into
the same Firebase database the public site reads from. No manual pasting
needed once this is running.

## Setup (about 10 minutes, free)

0. **Firebase Auth must be set up first** (see the main project notes) — this
   script signs in with a shared admin account before writing, since the
   database now requires authentication for writes. You'll need that
   account's email and password for step 2 below.

1. **Create a new GitHub repository.** Make it **public** — GitHub Actions
   minutes are unlimited on public repos, and this job (browser install +
   run) uses more minutes than a private repo's free tier comfortably
   covers if run hourly.

2. **Add these four files**, keeping the folder structure exactly as-is
   (the workflow only gets picked up by GitHub if it's at
   `.github/workflows/check-tickets.yml`):
   - `check-tickets.mjs`
   - `package.json`
   - `.gitignore`
   - `.github/workflows/check-tickets.yml`

   Easiest way: on GitHub, use **Add file → Upload files** and drag all
   four in (GitHub will recreate the folder structure automatically from
   the paths).

3. **Add two repository secrets** (Settings → Secrets and variables →
   Actions → New repository secret):
   - `FIREBASE_EMAIL` — the admin account's email
   - `FIREBASE_PASSWORD` — its password

   These are encrypted by GitHub and never appear in logs or to anyone
   browsing the repo — that's the whole point of using secrets instead of
   putting them in the script itself.

5. **Test it manually first**, before waiting for the hourly trigger:
   - Go to the **Actions** tab of your repo
   - Click **"Check Rapid ticket sales"** in the left sidebar
   - Click **Run workflow** → **Run workflow** (green button)
   - Wait ~1–2 minutes, then click into the run to watch the logs

6. **Check it worked**: open the public tracker site (or the Firebase
   console → Realtime Database) and confirm a new entry showed up with
   today's timestamp.

If the run fails, open the failed run in the Actions tab — there's a
`debug-screenshot` artifact attached showing exactly what the page looked
like when it broke (usually a cookie banner or a layout change on
Entertix's end).

## After that

It runs automatically at 5 minutes past every hour. GitHub may occasionally
delay a scheduled run by a few minutes under load; that's normal for free
scheduled Actions and not worth worrying about here.

## It auto-pauses when there's nothing to check

The workflow only does real work (installs a browser, loads the page) in
the roughly 9 days before kickoff, set by `MATCH_DATE` in
`check-tickets.yml`. Outside that window — including all the months before
Entertix has even published the ticket link — it exits in a couple of
seconds with a green checkmark instead of trying and failing. No wasted
Actions minutes, no failure-email spam, nothing for you to babysit.

Once kickoff passes, it stops entirely on its own (there's nothing left to
sell). For the next home game, duplicate the files as described below and
set the new `MATCH_DATE` — that's the only thing to remember.

## Stopping it

- **Pause everything, anytime:** repo → **Actions** tab → click the
  workflow name in the sidebar → **`...`** menu → **Disable workflow**.
  **Enable workflow** turns it back on later. Nothing to edit.
- **Force a run outside the normal window** (e.g. to test): **Actions** tab
  → the workflow → **Run workflow** → tick **force** → **Run workflow**.
- **Stop for good:** delete `.github/workflows/check-tickets.yml` (or the
  whole repo).

## Tracking a different match

The script finds the right match in Firebase by searching for the text in
`MATCH_QUERY` (currently `"Sepsi"`) inside each match's `game` field. For a
future fixture:

1. Add the new match on the public site first (so it exists in Firebase)
2. Duplicate `check-tickets.mjs` and `check-tickets.yml`, giving them new
   names (e.g. `check-tickets-craiova.mjs` / `check-tickets-craiova.yml`)
3. In the new script: update `MATCH_QUERY` and `EVENT_URL`
4. In the new workflow file: update `MATCH_DATE` to the new kickoff time

Each workflow runs on its own schedule and pauses itself independently, so
tracking several upcoming home games at once just means a few of these
file pairs sitting in the repo, each quietly waiting for its own window.
