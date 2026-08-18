# health-dashboard

Personal health dashboard: blood test trends over time, genetic testing, and a
history of clinical evaluations — published to GitHub Pages with the underlying
data **encrypted**. The public site holds only ciphertext; a passphrase entered
in the browser decrypts it locally (Web Crypto, AES-256-GCM, PBKDF2-SHA256 at
600k iterations). Nothing leaves the browser.

## How it works

```
Book1.xlsx (iCloud, never committed)
source/*.json (local only, never committed)
        │
        ▼  npm run build   (prompts for the passphrase)
data/health.enc.json   ← the ONLY data file in git — ciphertext
        │
        ▼  GitHub Pages serves index.html + the encrypted blob
Browser: enter passphrase → decrypt in-memory → render dashboard
```

## Layout

| Path | Purpose |
|---|---|
| `index.html` | The whole dashboard — unlock screen, decryption, SVG charts. No dependencies, no build step. |
| `scripts/build.js` | Reads the Excel workbook + `source/*.json`, encrypts everything into `data/health.enc.json`. |
| `data/health.enc.json` | The encrypted payload — the only committed data. |
| `source/genetics.json` | Gene test *results* (gitignored; panels/genes-covered come from the Excel). |
| `source/evaluations.json` | Procedure/evaluation history (gitignored). |

## Updating data

1. Edit the Excel sheet (the `Lab Work` tab: tests as rows, draw dates as columns,
   units in the test name, the `Select` column marks "featured" tests) and/or the
   `source/*.json` files.
2. Rebuild and re-encrypt:

   ```bash
   HEALTH_XLSX="/Users/collin/Library/Mobile Documents/com~apple~CloudDocs/Medical/Book1.xlsx" npm run build
   ```

   It prompts for the passphrase (or reads `HEALTH_PASSPHRASE`). Values that
   aren't numeric (`NORMAL`, `ND`) are reported and skipped.
3. Commit `data/health.enc.json` and push — Pages redeploys.

## Viewing

Serve the folder over HTTP (Pages does this in production; locally
`python3 -m http.server` works — `fetch` and Web Crypto need http(s), so opening
`index.html` via `file://` won't load the data).

## Security notes

- The strength of this scheme **is the passphrase**. The ciphertext is public, so
  offline brute-force is possible — use a long passphrase (5+ random words). The
  build refuses passphrases under 12 characters.
- Losing the passphrase loses nothing permanently — the plaintext sources stay on
  your machine; just rebuild with a new passphrase.
- A wrong passphrase fails AES-GCM authentication — the page shows an error and
  renders nothing.
