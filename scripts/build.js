#!/usr/bin/env node
/**
 * @fileoverview Build the encrypted data payload for the dashboard.
 *
 * Reads the source Excel workbook + local JSON source files (all of which stay
 * OUT of git), assembles one payload object, encrypts it with AES-256-GCM under
 * a key derived from a passphrase (PBKDF2-SHA256, 600k iterations), and writes
 * data/health.enc.json — the only data file that gets committed/published.
 *
 * Usage:
 *   node scripts/build.js                      # prompts for the passphrase
 *   HEALTH_PASSPHRASE=... node scripts/build.js
 *
 * Source locations (see also .gitignore):
 *   $HEALTH_XLSX or source/Book1.xlsx          # the lab-work workbook
 *   source/genetics.json                       # gene results (optional)
 *   source/evaluations.json                    # evaluation history (optional)
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const XLSX = require("xlsx");

const ROOT = path.join(__dirname, "..");
const DEFAULT_XLSX =
  process.env.HEALTH_XLSX || path.join(ROOT, "source", "Book1.xlsx");

const PBKDF2_ITERATIONS = 600000;

/* ---------- Excel → bloodwork rows ---------- */

function parseHeaderDate(s) {
  // "12/24/20" → "2020-12-24"
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(s).trim());
  if (!m) return null;
  const [, mo, d, yRaw] = m;
  const y = yRaw.length === 2 ? "20" + yRaw : yRaw;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function splitTestName(raw) {
  // "Creatinine (mg/dL)" → { test: "Creatinine", unit: "mg/dL" }
  const m = /^(.*)\s\(([^()]*)\)$/.exec(raw.trim());
  if (m) return { test: m[1].trim(), unit: m[2].trim() };
  return { test: raw.trim(), unit: "" };
}

function readBloodwork(xlsxPath) {
  const wb = XLSX.readFile(xlsxPath);
  const sheet = wb.Sheets["Lab Work"];
  if (!sheet) throw new Error(`No "Lab Work" sheet in ${xlsxPath}`);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });

  // Find the header row: the one whose 2nd cell is "Lab Tests".
  const headerIdx = rows.findIndex((r) => r && r[1] === "Lab Tests");
  if (headerIdx === -1) throw new Error('Header row with "Lab Tests" not found');
  const header = rows[headerIdx];
  const dates = header.slice(2).map(parseHeaderDate);

  const out = [];
  const skipped = [];
  for (const row of rows.slice(headerIdx + 1)) {
    if (!row || !row[1]) continue;
    const { test, unit } = splitTestName(String(row[1]));
    const featured = String(row[0]).toUpperCase() === "TRUE";
    for (let c = 0; c < dates.length; c++) {
      const cell = row[c + 2];
      if (cell == null || String(cell).trim() === "" || !dates[c]) continue;
      const value = Number(String(cell).replace(/[<>,]/g, "").trim());
      if (!Number.isFinite(value)) {
        skipped.push(`${test} @ ${dates[c]}: "${cell}"`);
        continue;
      }
      out.push({ date: dates[c], test, unit, value, featured });
    }
  }
  return { rows: out, skipped };
}

function readGeneticsPanels(xlsxPath) {
  const wb = XLSX.readFile(xlsxPath);
  const sheet = wb.Sheets["Hereditary Testing"];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
  return rows
    .filter((r) => r && r[0])
    .map((r) => ({ panel: String(r[0]), genes: r.slice(1).map(String) }));
}

function readOptionalJson(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : [];
}

/* ---------- Passphrase + encryption ---------- */

function promptPassphrase() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    // Mask input: overwrite echoed chars.
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => write(/[\r\n]/.test(s) ? s : "*");
    process.stderr.write("Passphrase: ");
    rl.question("", (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}

function encrypt(payloadObj, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payloadObj), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return {
    v: 1,
    kdf: "PBKDF2-SHA256",
    iterations: PBKDF2_ITERATIONS,
    cipher: "AES-256-GCM",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    data: ciphertext.toString("base64"),
  };
}

/* ---------- Main ---------- */

async function main() {
  if (!fs.existsSync(DEFAULT_XLSX)) {
    console.error(
      `Workbook not found: ${DEFAULT_XLSX}\n` +
        `Set HEALTH_XLSX to its path, or place it at source/Book1.xlsx`
    );
    process.exit(1);
  }

  const { rows: bloodwork, skipped } = readBloodwork(DEFAULT_XLSX);
  const payload = {
    generatedAt: new Date().toISOString(),
    bloodwork,
    geneticsPanels: readGeneticsPanels(DEFAULT_XLSX),
    geneticsResults: readOptionalJson("source/genetics.json"),
    evaluations: readOptionalJson("source/evaluations.json"),
  };

  const passphrase = process.env.HEALTH_PASSPHRASE || (await promptPassphrase());
  if (passphrase.length < 12) {
    console.error(
      "Refusing: passphrase under 12 characters. The encrypted file is public —\n" +
        "use a long passphrase (e.g. 5+ random words)."
    );
    process.exit(1);
  }

  const outPath = path.join(ROOT, "data", "health.enc.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(encrypt(payload, passphrase)));

  const tests = new Set(bloodwork.map((r) => r.test)).size;
  console.log(`Encrypted ${bloodwork.length} results across ${tests} tests → ${path.relative(ROOT, outPath)}`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} non-numeric value(s):`);
    for (const s of skipped) console.log("  -", s);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
