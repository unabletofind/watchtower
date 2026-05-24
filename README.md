# watchtower

A private job board for cybersecurity job hunting. Aggregates from company career pages (Greenhouse, Lever, Ashby, SmartRecruiters) and Adzuna India twice daily, filters for `cybersecurity`, `information security`, or `security` in the JD body, scores each job against your resume locally (no API key needed), and tracks every application.

LinkedIn / Naukri / Indeed jobs are added via a one-tap bookmarklet because their TOS blocks scraping.

---

## What's in here

```
watchtower/
├── index.html              ← the dashboard (open in browser)
├── assets/
│   ├── style.css
│   └── app.js
├── data/
│   ├── config.json         ← which companies to track, search settings
│   ├── resume.json         ← structured resume (used for scoring)
│   ├── jobs.json           ← fetched jobs (auto-updated by GitHub Action)
│   └── trash.json          ← jobs you trashed, never re-shown
├── scripts/
│   └── fetch_jobs.py       ← the fetcher (runs in GitHub Actions)
└── .github/workflows/
    └── fetch.yml           ← cron schedule: 4am + 4pm IST
```

---

## Setup (one-time)

### 1. Create the repo

1. Create a new **public** GitHub repo. Call it whatever you want — say `watchtower`.
2. Upload everything in this folder to the root of the repo.

### 2. Turn on GitHub Pages

Settings → Pages → Source: `Deploy from a branch` → Branch: `main` → Folder: `/ (root)` → Save.

Your board will be live at `https://<your-github-username>.github.io/watchtower/` in ~1 minute.

### 3. Get an Adzuna API key (free, takes 2 min)

1. Sign up at https://developer.adzuna.com/
2. Copy your `App ID` and `App Key`
3. In your repo: Settings → Secrets and variables → Actions → New repository secret
   - Add `ADZUNA_APP_ID`
   - Add `ADZUNA_APP_KEY`

(Skip this and you'll still get all the Greenhouse/Lever/Ashby/SmartRecruiters jobs — just no Adzuna aggregation. JSearch is similar — only set up `RAPIDAPI_KEY` if you want LinkedIn/Indeed/Glassdoor coverage too. Set `use_jsearch: true` in `config.json` to enable it.)

### 4. Trigger the first fetch

GitHub repo → Actions tab → "Fetch Jobs Twice Daily" → Run workflow.

Wait ~3 minutes, refresh your watchtower URL, and the new tab will have jobs.

### 5. Set up the bookmarklet (for LinkedIn / Naukri / Indeed)

Open your watchtower URL → tap the `⚙` button (bottom right) → bookmarklet section.

**On desktop:** drag the orange "save to watchtower" link to your bookmarks bar.

**On mobile (the way you'll actually use it):**

**Option A — Android share target (recommended):**
1. Open your watchtower URL in Chrome on Android
2. Chrome menu ⋮ → "Add to Home Screen" → "Install" (this installs it as a PWA)
3. Now in any app (LinkedIn, Naukri, Chrome on any job page), tap the **share** button → "watchtower" appears in the share sheet → tap it → the add-job form opens with the URL pre-filled → fill in title/company/JD → save

**Option B — Manual + button:**
1. Open watchtower
2. Tap the orange **+** button at the bottom-right
3. Tap "📋 paste URL from clipboard" if you have a URL copied
4. Fill in title, company, JD text from the job page
5. Tap "add to board"

**Why not bookmarklet on Android:** Chrome on Android blocks `javascript:` URLs in bookmarks for security. Use the share target or + button instead. Desktop browsers (Chrome / Edge / Firefox on Windows / Mac) still support the bookmarklet — drag from the settings screen to your bookmarks bar.

---

## How the scoring works (honestly)

Two numbers per job:

- **Fit score (alignment)** — how much of what the JD repeatedly asks for is documented somewhere in your resume. Weighted by term frequency in the JD.
- **Competitiveness** — alignment minus penalties for (a) experience-year gaps (JD asks for 5+ years, you have 1.5), (b) senior/lead/principal titles.

Both are 0–99. Neither is a "selection probability" — no algorithm can produce that honestly. They're a useful signal for triage: spend your application energy on the 80+ jobs first.

Below 80, the job detail view tells you exactly which JD terms repeat that your resume doesn't have. Useful for deciding (a) skip this job, (b) address the gap in your cover letter, or (c) add real experience to your resume.

---

## Tailored resumes (optional LLM mode)

Settings → paste an Anthropic API key (stored only in your browser, never sent anywhere except api.anthropic.com).

In any job detail view, the "tailor resume" button generates a JD-specific version of your resume. The prompt forces honesty: it can re-order and re-weight what's in your `resume.json`, but it can't invent skills you don't have.

Cost: ~$0.005 per tailored resume on Sonnet 4. Roughly ₹0.40.

---

## Day-to-day flow

1. Wake up at 8am → open the URL on your phone → new tab shows everything fetched at 4am
2. Tap each job:
   - **High fit (80+)** → tap "view" → read JD → tap "open application" → apply → come back, tap "applied"
   - **Low fit (<50)** → tap "trash". It never shows up again.
   - **Maybe / want to think** → tap "save". Lives in the saved tab.
3. Same again at 8pm.
4. When you get an interview: open job → "got interview". When you hear back: "offer" or "rejected" or "ghosted".
5. Once a week: settings → export backup → save the JSON somewhere safe.

---

## Adding more companies

Edit `data/config.json`. The slug is whatever appears in the company's careers URL.

- Greenhouse: `https://boards.greenhouse.io/SLUG` → add `"SLUG"` to `greenhouse_companies`
- Lever: `https://jobs.lever.co/SLUG` → add to `lever_companies`
- Ashby: `https://jobs.ashbyhq.com/SLUG` → add to `ashby_companies`
- SmartRecruiters: `https://careers.smartrecruiters.com/SLUG` → add to `smartrecruiters_companies`

Commit the change. The next 4am/4pm fetch picks it up.

If a company uses Workday or iCIMS (Microsoft, Cisco, IBM, TCS, etc.), they don't have clean APIs — you'll need to either use the bookmarklet on their careers page or ask me to add a Workday-specific scraper later.

---

## Privacy

- **Public in repo:** code, resume JSON, fetched jobs list, trashed IDs
- **Private (browser only, never committed):** application statuses, dates applied, notes, manually added jobs, LLM API key

If you switch phones, restore from the export backup.

---

## Troubleshooting

**Empty board after first fetch:** Check Actions tab → click the latest run → see if any source errored. Most often it's a typo in a company slug.

**A specific company has no jobs:** That ATS may not be a public one, or the company has no current openings matching the cybersecurity keywords. Try `https://boards-api.greenhouse.io/v1/boards/SLUG/jobs` directly in your browser to confirm the slug is right.

**Bookmarklet doesn't work on iOS Safari:** iOS blocks `javascript:` bookmarks if you launch them from the bookmarks bar. Workaround: type your watchtower URL in the address bar first, then tap the bookmarklet from the bookmarks dropdown that appears.
