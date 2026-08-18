# health-dashboard

Personal health dashboard: blood test trends, genetic testing, and reference
ranges — published to GitHub Pages with the underlying data **encrypted**. The
public site holds only ciphertext; a passphrase entered in the browser decrypts
it locally (Web Crypto, AES-256-GCM, PBKDF2-SHA256 at 600k iterations). Nothing
leaves the browser, and nothing rendered on the page is hardcoded — it is all
built from the source files below.

## How it works

```
source/*.csv + source/*.json   (local only, never committed)
        │
        ▼  npm run build   (prompts for the passphrase)
data/health.enc.json   ← the ONLY data file in git — ciphertext
        │
        ▼  GitHub Pages serves index.html + the encrypted blob
Browser: enter passphrase → decrypt in-memory → render dashboard
```

On `localhost` the page instead loads `data/health.local.enc.json` (gitignored,
fixed passphrase `password`) and **auto-unlocks**. The deployed site never has
that file, so the real passphrase is always required in production.

## Adding new results — the normal workflow

Results live in **`source/results.json`**, keyed by visit date — a new lab
visit is one new block with that day's values:

```json
"2026-09-01": {
  "Hemoglobin": 14.2,
  "Ferritin": 85
}
```

Then:

```bash
npm run build
```

A new date automatically becomes a new visit on the chart. Non-numeric values
(`"NORMAL"`, `"ND"`) may be recorded as strings; the build reports and skips
them for charting. Then commit `data/health.enc.json` and push — Pages
redeploys.

## Source files (all JSON, all gitignored)

| Path | Purpose |
|---|---|
| `source/results.json` | **The measurements** — `{ "YYYY-MM-DD": { "Test Name": value, … }, … }`. |
| `source/tests.json` | **The test catalog** — `{ "Test Name": { "unit", "group", "featured", "range": [low, high] } }`. Controls unit, grouping (groups become preset buttons, e.g. PFAS Exposure), the featured flag, and the reference range shaded on single-test charts. `null` in `range` = unbounded on that side. |
| `source/genetics.json` | `{ "findings": […gene result cards], "panels": [{ "panel", "genes": […], "positive": […] }] }` — genes in `positive` render highlighted/flashing. |
| `source/profile.json` | `{ "name": … }` — drives the hero title and topbar. |
| `source/evaluations.json` | Procedure/evaluation history (not currently rendered). |

New test entirely? Add its entry to `tests.json` (unit, group, range), then
start logging it in `results.json`. The build warns about any result whose test
is missing from the catalog.

## The chart

One line chart with filterable overlays: pick up to 8 tests from the chip cloud
(searchable), or use a preset — hand-curated panels (Iron, Lipids, CBC, Liver,
Kidney, Electrolytes, Vitamins, Glucose) plus one per catalog `group`. Presets
toggle and uncheck automatically when the selection diverges. Same-unit
selections get a real y-axis (and, for a single test, the shaded reference
band); mixed units are min–max scaled per line. Dashed segments span visits
where that test was not run. Hovering a point lists every selected test's value
at that visit. Visits are equally spaced regardless of elapsed time.

## Reference-range caveats

Ranges were seeded from typical US adult lab ranges — verify against the ranges
printed on the actual lab reports and edit `tests.csv`. PFAS: individual
analytes have no established clinical ranges; the seeded `< 2 ng/mL` bound is
the NASEM 2022 threshold, which formally applies to the *sum* of seven PFAS,
used here as a per-analyte visual guide only.

## Security notes

- The strength of this scheme **is the passphrase**. The ciphertext is public,
  so offline brute-force is possible — use a long passphrase (5+ random words).
  The build refuses passphrases under 12 characters.
- Losing the passphrase loses nothing — the plaintext sources stay on your
  machine; rebuild with a new passphrase.
- A wrong passphrase fails AES-GCM authentication — nothing partial renders.
  The unlock runs as visible steps (fetch → 20 key-derivation rounds → import →
  authenticate → decrypt → parse → render, ~4.5s). Percentages track real
  completed work; each step is held ~400ms so the sequence is readable. A wrong
  phrase stops at **Authenticating phrase** and the bar freezes red there —
  that is genuinely where AES-GCM detects the bad key.
- The **Unlocked** pill (top right) doubles as a lock button: clicking it
  discards the decrypted data (it only ever lives in page memory) and returns
  to the phrase prompt. On localhost, locking also suppresses the auto-unlock
  until the phrase is entered again.
- `data/health.local.enc.json` is weakly encrypted by design; it must stay
  gitignored.
