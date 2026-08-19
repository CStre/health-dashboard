#!/usr/bin/env node
/**
 * @fileoverview Build the encrypted data payload for the dashboard.
 *
 * Everything is sourced from the JSON files in source/ (all gitignored),
 * assembled into one payload object, encrypted with AES-256-GCM under a key
 * derived from a passphrase (PBKDF2-SHA256, 600k iterations), and written to
 * data/health.enc.json — the only data file that gets committed/published.
 * Nothing rendered on the page is hardcoded there; it all comes from these
 * sources through this build.
 *
 * Usage:
 *   npm run build                              # prompts for the passphrase
 *   HEALTH_PASSPHRASE=... npm run build
 *
 * Sources:
 *   source/results.json     # THE data, keyed by visit date:
 *                           #   { "2026-09-01": { "Hemoglobin": 14.2, ... }, ... }
 *   source/tests.json       # catalog, keyed by test name:
 *                           #   { "Hemoglobin": { unit, group, featured, range: [lo, hi] }, ... }
 *   source/genetics.json    # { findings: [...gene result cards], panels: [{panel, genes, positive}] }
 *   source/profile.json     # { name }
 *   source/evaluations.json # evaluation history (not currently rendered)
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const ROOT = path.join(__dirname, "..");
/* Key derivation: 20 chained PBKDF2-SHA256 rounds × 30k iterations = 600k
   total. Chunked so the browser can report real progress per round. */
const KDF_ROUNDS = 20;
const KDF_ITER_PER_ROUND = 30000;

/** Fixed passphrase for the local-only copy served on localhost (gitignored). */
const LOCAL_PASSPHRASE = "password";

/* ---------- Sources ---------- */

function readJson(rel, fallback) {
  const p = path.join(ROOT, "source", rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fallback;
}

function parseDate(s) {
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (!m) return null;
  const y = m[3].length === 2 ? "20" + m[3] : m[3];
  return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** Loose key for name matching: case/punctuation/spacing insensitive. */
const normalizeName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Build canonical-name lookup from the catalog: every test's own name plus
 * each of its aliases maps to the canonical name. This is what lets a result
 * logged as "A1c", "HbA1c", or "hemoglobin a1c" all land on one test.
 */
function buildAliasIndex(catalog) {
  const index = new Map();
  const collisions = [];
  for (const [name, cfg] of Object.entries(catalog)) {
    const keys = [name, ...(cfg.aliases || [])];
    for (const k of keys) {
      const norm = normalizeName(k);
      if (index.has(norm) && index.get(norm) !== name) {
        collisions.push(`"${k}" → ${index.get(norm)} vs ${name}`);
        continue;
      }
      index.set(norm, name);
    }
  }
  return { index, collisions };
}

/** results.json (visits keyed by date) + tests.json (catalog) → flat rows */
function buildBloodwork(visits, catalog, aliasIndex) {
  const rows = [];
  const skipped = [];
  const uncataloged = new Set();
  const resolved = [];
  for (const [rawDate, tests] of Object.entries(visits)) {
    const date = parseDate(rawDate);
    if (!date) {
      skipped.push(`bad visit date: "${rawDate}"`);
      continue;
    }
    for (const [rawTest, rawValue] of Object.entries(tests)) {
      // Canonicalize the name through the alias index so near-miss spellings
      // merge into the parent test instead of creating a duplicate series.
      const test = aliasIndex.get(normalizeName(rawTest)) || rawTest;
      if (test !== rawTest) resolved.push(`"${rawTest}" → "${test}"`);

      const value =
        typeof rawValue === "number"
          ? rawValue
          : Number(String(rawValue).replace(/[<>,]/g, "").trim());
      if (!Number.isFinite(value) || String(rawValue).trim() === "") {
        skipped.push(`${test} @ ${date}: ${JSON.stringify(rawValue)}`);
        continue;
      }
      const cat = catalog[test];
      if (!cat) uncataloged.add(test);
      rows.push({
        date,
        test,
        unit: cat?.unit || "",
        value,
        featured: cat?.featured ?? false,
        group: cat?.group || "",
      });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.test.localeCompare(b.test));
  return { rows, skipped, uncataloged: [...uncataloged], resolved };
}

/* ---------- Passphrase + encryption ---------- */

function promptPassphrase() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
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

function deriveKey(passphrase, salt) {
  let material = Buffer.from(passphrase, "utf8");
  for (let r = 0; r < KDF_ROUNDS; r++) {
    const roundSalt = Buffer.concat([salt, Buffer.from([r])]);
    material = crypto.pbkdf2Sync(material, roundSalt, KDF_ITER_PER_ROUND, 32, "sha256");
  }
  return material;
}

function encrypt(payloadObj, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payloadObj), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return {
    v: 2,
    kdf: "PBKDF2-SHA256-chained",
    rounds: KDF_ROUNDS,
    iterations: KDF_ITER_PER_ROUND,
    cipher: "AES-256-GCM",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    data: ciphertext.toString("base64"),
  };
}

/* ---------- Main ---------- */

async function main() {
  const catalog = readJson("tests.json", {});
  const visits = readJson("results.json", {});
  const genetics = readJson("genetics.json", { findings: [], panels: [] });
  const panelCfg = readJson("panels.json", {});
  delete panelCfg._comment;

  const { index: aliasIndex, collisions } = buildAliasIndex(catalog);
  const { rows: bloodwork, skipped, uncataloged, resolved } = buildBloodwork(visits, catalog, aliasIndex);
  if (!bloodwork.length) {
    console.error("No results found in source/results.json — nothing to build.");
    process.exit(1);
  }

  const ranges = {};
  const aliases = {};
  for (const [name, c] of Object.entries(catalog)) {
    const [lo, hi] = Array.isArray(c.range) ? c.range : [null, null];
    if (lo != null || hi != null) ranges[name] = [lo, hi];
    if (c.aliases && c.aliases.length) aliases[name] = c.aliases;
  }

  /* Panels: explicit config first, then any catalog `group` as its own panel.
     A config entry is either ["Test", …] or { view, tests } — view "table"
     means that panel is shown tabulated only, no chart. */
  const present = new Set(bloodwork.map((r) => r.test));
  const panels = {};
  for (const [label, cfg] of Object.entries(panelCfg)) {
    const members = Array.isArray(cfg) ? cfg : cfg.tests || [];
    const view = Array.isArray(cfg) ? "both" : cfg.view || "both";
    const hit = members.filter((m) => present.has(m));
    if (hit.length >= 2) panels[label] = { view, tests: hit };
  }
  const byGroup = {};
  for (const r of bloodwork) {
    if (!r.group) continue;
    (byGroup[r.group] = byGroup[r.group] || new Set()).add(r.test);
  }
  for (const [label, set] of Object.entries(byGroup)) {
    if (!panels[label] && set.size >= 2) panels[label] = { view: "both", tests: [...set] };
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    profile: readJson("profile.json", {}),
    bloodwork,
    ranges,
    aliases,
    panels,
    geneticsPanels: genetics.panels || [],
    geneticsResults: genetics.findings || [],
    evaluations: readJson("evaluations.json", []),
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

  const localPath = path.join(ROOT, "data", "health.local.enc.json");
  fs.writeFileSync(localPath, JSON.stringify(encrypt(payload, LOCAL_PASSPHRASE)));

  const tests = new Set(bloodwork.map((r) => r.test)).size;
  const dates = new Set(bloodwork.map((r) => r.date)).size;
  console.log(`Encrypted ${bloodwork.length} results · ${tests} tests · ${dates} visits → ${path.relative(ROOT, outPath)}`);
  console.log(`Local copy (passphrase "${LOCAL_PASSPHRASE}", gitignored) → ${path.relative(ROOT, localPath)}`);
  console.log(`Panels: ${Object.keys(payload.panels).join(", ")}`);
  if (resolved.length) {
    const uniq = [...new Set(resolved)];
    console.log(`Alias-resolved names: ${uniq.join(", ")}`);
  }
  if (collisions.length) {
    console.log(`ALIAS COLLISIONS (ignored, first wins): ${collisions.join("; ")}`);
  }
  if (uncataloged.length) {
    console.log(`NOT in source/tests.json (add entries for unit/group/range/aliases): ${uncataloged.join(", ")}`);
  }
  const positives = (genetics.panels || []).flatMap((p) => (p.positive || []).map((g) => `${g} [${p.panel}]`));
  if (positives.length) console.log("Detected genes:", positives.join(", "));
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} non-numeric/bad entr(ies):`);
    for (const s of skipped) console.log("  -", s);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
