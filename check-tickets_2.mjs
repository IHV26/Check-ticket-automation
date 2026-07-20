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

const EVENT_URL = 'https://www.entertix.ro/bilete/40037/fc-rapid-1923-sepsi-20-iulie-2026-stadion-rapid-giulesti-bucuresti.html';
const FIREBASE_URL = 'https://rapid-tickets-sold-832a8-default-rtdb.europe-west1.firebasedatabase.app';

// Which tracked match this run belongs to — matched against the "game" field
// stored in Firebase. Change this (or duplicate the workflow) to track a
// different fixture.
const MATCH_QUERY = 'Sepsi';

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
  const candidates = [/accept/i, /sunt de acord/i, /^ok$/i, /agree/i, /accept all/i];
  for (const pattern of candidates) {
    try {
      const btn = page.getByRole('button', { name: pattern }).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click({ timeout: 2000 });
        return;
      }
    } catch {
      // not found with this pattern, try the next one
    }
  }
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

    // Wait for the seat map to actually populate
    await page.waitForSelector('div.seatingseat', { timeout: 30000 });
    await page.waitForTimeout(1500); // let any remaining seats finish rendering

    const counts = await page.evaluate(() => {
      const all = document.querySelectorAll('div[class]');
      let sold = 0, active = 0, cart = 0;
      all.forEach((el) => {
        const c = (el.getAttribute('class') || '').trim();
        if (c === 'seatingseat') sold++;
        else if (/\bseatingseatactive\b/.test(c) && /\bseatingseatcart\b/.test(c)) cart++;
        else if (/\bseatingseatactive\b/.test(c)) active++;
      });
      return { sold, available: active, cart, total: sold + active + cart };
    });

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

async function saveEntry(matchId, counts) {
  const res = await fetch(`${FIREBASE_URL}/matches/${matchId}/entries.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ts: { '.sv': 'timestamp' }, ...counts }),
  });
  if (!res.ok) {
    throw new Error(`Firebase write failed: ${res.status} ${await res.text()}`);
  }
}

async function run() {
  const matchId = await findMatchId(MATCH_QUERY);
  const counts = await scrapeCounts();
  await saveEntry(matchId, counts);
  console.log(`Saved for match ${matchId}:`, counts);
}

run().catch((err) => {
  console.error('Ticket check failed:', err.message);
  process.exit(1);
});
