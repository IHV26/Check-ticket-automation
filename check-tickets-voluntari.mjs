// check-tickets.mjs
//
// Loads the Entertix ticket page, clicks through to the seat map, counts
// seats by color (grey = sold, anything else = available/held), and writes
// the result to Firebase Realtime Database as a new entry under the match
// whose "game" field contains MATCH_QUERY.
//
// Run manually with:   node check-tickets.mjs
// Requires:            npm install playwright && npx playwright install --with-deps chromium

import { chromium } from 'playwright';

const EVENT_URL = 'https://www.entertix.ro/bilete/40954/fc-rapid-voluntari-12-september-2026-stadion-rapid-giulesti-bucuresti.html';
const FIREBASE_URL = 'https://rapid-tickets-sold-832a8-default-rtdb.europe-west1.firebasedatabase.app';
const FIREBASE_API_KEY = 'AIzaSyBfscrmDJH30rMY5yfx26Xi3CHPoOCp-X0';

// Shared admin credentials, supplied as GitHub Actions secrets (see README) —
// never hardcoded here.
const FIREBASE_EMAIL = process.env.FIREBASE_EMAIL;
const FIREBASE_PASSWORD = process.env.FIREBASE_PASSWORD;

// Which tracked match this run belongs to — matched against the "game" field
// stored in Firebase. Change this (or duplicate the workflow) to track a
// different fixture.
const MATCH_QUERY = 'Voluntari';

// Seat data-ids that are structurally never offered for public sale on this
// site. Entertix issues a fresh batch of seat IDs per event listing, so
// these must be re-identified for every match — nothing carries over.
// Confirmed by visual inspection of the live map. Unlike CFR/Dinamo, this
// match's away/buffer cluster is only 4 sectors (no separate away-end block)
// — a smaller allocation, consistent with Voluntari being a lower-demand
// fixture. There's also a distinct third zone: sixteen small ~10-seat
// pockets along one walkway, likely accessibility/camera platforms.
const EXCLUDED_ID_RANGES = [
  { label: 'Away + buffer (4 sectors, combined)', min: 38919905, max: 38921077 },
  { label: 'Small block, separate area', min: 38928507, max: 38928566 },
  { label: 'Walkway pockets (16 small groups, combined)', min: 38929966, max: 38930125 },
];

async function signIn() {
  if (!FIREBASE_EMAIL || !FIREBASE_PASSWORD) {
    throw new Error('FIREBASE_EMAIL / FIREBASE_PASSWORD are not set — add them as repo secrets.');
  }
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: FIREBASE_EMAIL, password: FIREBASE_PASSWORD, returnSecureToken: true }),
    }
  );
  if (!res.ok) throw new Error(`Firebase sign-in failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.idToken;
}

async function findMatchId(query) {
  const res = await fetch(`${FIREBASE_URL}/matches.json`);
  if (!res.ok) throw new Error(`Failed to read matches from Firebase: ${res.status}`);
  const matches = (await res.json()) || {};
  const entry = Object.entries(matches).find(([, m]) =>
    (m.game || '').toLowerCase().includes(query.toLowerCase())
  );
  if (!entry) throw new Error(`No match found in Firebase containing "${query}". Add it via the site first.`);
  return entry[0];
}

async function dismissCookieBanner(page) {
  try {
    // Cookiebot injects its dialog asynchronously, so give it a real chance to appear
    const dialog = page.locator('#CybotCookiebotDialog, [id*="Cookiebot" i]').first();
    await dialog.waitFor({ state: 'visible', timeout: 8000 });
    const allowAll = page.getByRole('button', { name: /permite toate|allow all|accept all/i }).first();
    await allowAll.click({ timeout: 5000 });
    await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  } catch {
    // banner never showed up, or button wasn't found — fine, proceed anyway
  }
}

async function zoomUntilSeatsRender(page, maxAttempts = 12) {
  const zoomInBtn = page.getByText(/^apropie$/i).first();
  for (let i = 0; i < maxAttempts; i++) {
    const seatCount = await page.locator('div.seatingseat').count();
    if (seatCount > 0) return true;
    await zoomInBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(700);
  }
  return (await page.locator('div.seatingseat').count()) > 0;
}

async function scrapeCounts() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

  try {
    await page.goto(EVENT_URL, { waitUntil: 'load', timeout: 60000 });

    await dismissCookieBanner(page);

    // Click the "Planul sălii" tab (diacritic-insensitive match)
    const tab = page.getByText(/planul\s*s[aă]lii/i).first();
    await tab.click({ timeout: 15000 });

    // The map starts zoomed out, showing only sector blocks — zoom in until
    // individual seats actually exist in the DOM
    const seatsRendered = await zoomUntilSeatsRender(page);
    if (!seatsRendered) {
      throw new Error('Zoomed in repeatedly but individual seat elements never appeared — the map behavior may have changed.');
    }

    await page.waitForSelector('div.seatingseat', { timeout: 15000 });
    await page.waitForTimeout(2000); // let any remaining seats finish rendering

    const counts = await page.evaluate((excludedRanges) => {
      const isExcluded = (idStr) => {
        const n = Number(idStr);
        return excludedRanges.some((r) => n >= r.min && n <= r.max);
      };
      const all = document.querySelectorAll('div[class]');
      let sold = 0, active = 0, cart = 0, excluded = 0;
      all.forEach((el) => {
        const c = (el.getAttribute('class') || '').trim();
        const id = el.getAttribute('data-id');
        if (c === 'seatingseat') {
          if (isExcluded(id)) excluded++; else sold++;
        } else if (/\bseatingseatactive\b/.test(c) && /\bseatingseatcart\b/.test(c)) {
          if (isExcluded(id)) excluded++; else cart++;
        } else if (/\bseatingseatactive\b/.test(c)) {
          if (isExcluded(id)) excluded++; else active++;
        }
      });
      return { sold, available: active, cart, excluded, total: sold + active + cart };
    }, EXCLUDED_ID_RANGES);

    console.log(`Excluded ${counts.excluded} seats (away allocation / other non-public zones).`);

    if (counts.total === 0) {
      throw new Error('No seat elements found — page structure may have changed.');
    }

    return counts;
  } catch (err) {
    try {
      await page.screenshot({ path: 'debug.png', fullPage: true });
    } catch {
      // best effort — don't let a screenshot failure mask the real error
    }
    throw err;
  } finally {
    await browser.close();
  }
}

async function saveEntry(matchId, counts, idToken) {
  const res = await fetch(`${FIREBASE_URL}/matches/${matchId}/entries.json?auth=${idToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ts: { '.sv': 'timestamp' }, ...counts }),
  });
  if (!res.ok) {
    throw new Error(`Firebase write failed: ${res.status} ${await res.text()}`);
  }
}

async function run() {
  const idToken = await signIn();
  const matchId = await findMatchId(MATCH_QUERY);
  const counts = await scrapeCounts();
  await saveEntry(matchId, counts, idToken);
  console.log(`Saved for match ${matchId}:`, counts);
}

run().catch((err) => {
  console.error('Ticket check failed:', err.message);
  process.exit(1);
});
