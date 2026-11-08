#!/usr/bin/env node
/**
 * @fileoverview Build the encrypted data payload for the dashboard.
 *
 * Everything is sourced from the JSON files in source/ (all gitignored),
 * assembled into one payload object, encrypted with AES-256-GCM under a key
 * derived from a passphrase with Argon2id (memory-hard), and written to
 * data/health.enc.json — the only data file that gets committed/published.
 * Nothing rendered on the page is hardcoded there; it all comes from these
 * sources through this build.
 *
 * Usage:
 *   npm run build                              # prompts for the passphrase
 *   HEALTH_PASSPHRASE=... npm run build
 *   npm run build:local                        # self-contained local.html, phrase "test"
 *   npm run build:localcopy                    # data/health.local.enc.json only, phrase "password"
 *
 * Sources:
 *   source/results.json     # THE data, keyed by visit date:
 *                           #   { "2026-09-01": { "Hemoglobin": 14.2, ... }, ... }
 *   source/tests.json       # catalog, keyed by test name:
 *                           #   { "Hemoglobin": { unit, group, featured, range: [lo, hi] }, ... }
 *   source/genetics.json    # { findings: [...gene result cards], panels: [{panel, genes, positive}] }
 *   source/profile.json     # { name }
 *   source/evaluations.json # evaluation history (rendered on the History page)
 *   source/recommendations.json # only `conditions` + `treatment` are used (Overview clinical picture)
 *   source/family-history.json # relatives relevant to the hereditary conditions
 *   source/providers.json   # care team, current and prior
 *   source/draws.json       # optional: which lab ran each draw ({ "YYYY-MM-DD": { lab, note } })
 *   source/genome.json      # optional: annotated 23andMe data from `npm run genome` (Genetics PDF)
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const ROOT = path.join(__dirname, "..");
/* Key derivation: Argon2id (RFC 9106), memory-hard, so every passphrase guess
   costs real memory as well as time, which is what defeats GPU/ASIC cracking.
   Run as a short chain (each round's 32-byte output is the next round's input,
   salted with salt‖round) so the browser can report real progress per round.
   Bundles record their own parameters, so older (PBKDF2) files still open. */
const { argon2id } = require("hash-wasm");
const KDF = {
  rounds: 18,           // chained Argon2id calls (~5 s unlock on an M-series Mac)
  memoryKiB: 131072,    // 128 MiB per call
  passes: 3,            // Argon2 time cost (t) per call
  parallelism: 1,
};

/** Fixed passphrase for the local-only copy served on localhost (gitignored). */
const LOCAL_PASSPHRASE = "password";
/** Fixed passphrase for the fully self-contained local.html preview build. */
const PREVIEW_PASSPHRASE = "test";

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
  const qualitative = []; // non-numeric results ("ND", "Non Reactive", "NORMAL") kept as text
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
        if (String(rawValue).trim()) qualitative.push({ date, test, unit: catalog[test]?.unit || "", text: String(rawValue).trim() });
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
  qualitative.sort((a, b) => a.date.localeCompare(b.date) || a.test.localeCompare(b.test));
  return { rows, skipped, qualitative, uncataloged: [...uncataloged], resolved };
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

async function deriveKey(passphrase, salt) {
  let material = new Uint8Array(Buffer.from(passphrase, "utf8"));
  for (let r = 0; r < KDF.rounds; r++) {
    material = await argon2id({
      password: material,
      salt: new Uint8Array(Buffer.concat([salt, Buffer.from([r])])),
      parallelism: KDF.parallelism,
      iterations: KDF.passes,
      memorySize: KDF.memoryKiB,
      hashLength: 32,
      outputType: "binary",
    });
  }
  return Buffer.from(material);
}

async function encrypt(payloadObj, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payloadObj), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return {
    v: 3,
    kdf: "argon2id-chained",
    rounds: KDF.rounds,
    memoryKiB: KDF.memoryKiB,
    passes: KDF.passes,
    parallelism: KDF.parallelism,
    cipher: "AES-256-GCM",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    data: ciphertext.toString("base64"),
  };
}

/* ---------- Main ---------- */

/** Assemble the full payload from source/, plus the build diagnostics. */
function buildPayload() {
  const catalog = readJson("tests.json", {});
  const visits = readJson("results.json", {});
  const genetics = readJson("genetics.json", { findings: [], panels: [] });
  const panelCfg = readJson("panels.json", {});
  delete panelCfg._comment;
  // Only the clinical picture is published; the suggestion items are not.
  const recs = readJson("recommendations.json", { conditions: [] });
  const familyHistory = readJson("family-history.json", { relatives: [] });
  delete familyHistory._comment;
  const providers = readJson("providers.json", { current: [], prior: [] });
  delete providers._comment;

  const { index: aliasIndex, collisions } = buildAliasIndex(catalog);
  const { rows: bloodwork, skipped, qualitative, uncataloged, resolved } = buildBloodwork(visits, catalog, aliasIndex);
  if (!bloodwork.length) {
    console.error("No results found in source/results.json — nothing to build.");
    process.exit(1);
  }

  const ranges = {};
  const aliases = {};
  /* Ranges were seeded from typical adult ranges rather than copied off the
     lab reports. Any test may be confirmed individually by adding
     "rangeVerified": true in tests.json; the page marks the rest as
     provisional so nothing is over-claimed to a clinician. */
  const rangesVerified = {};
  const rangeInfo = {}; // { source, note } per test, shown beside the normal window
  for (const [name, c] of Object.entries(catalog)) {
    if (c.rangeSource || c.rangeNote) rangeInfo[name] = { source: c.rangeSource || "", note: c.rangeNote || "" };
    const [lo, hi] = Array.isArray(c.range) ? c.range : [null, null];
    if (lo != null || hi != null) ranges[name] = [lo, hi];
    if (c.rangeVerified) rangesVerified[name] = true;
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
    qualitative,
    // Per-draw provenance ({ "YYYY-MM-DD": { lab, note } }) for the printable lab report.
    drawInfo: readJson("draws.json", {}),
    ranges,
    rangesVerified,
    rangeInfo,
    aliases,
    panels,
    geneticsPanels: genetics.panels || [],
    geneticsResults: genetics.findings || [],
    evaluations: readJson("evaluations.json", []),
    conditions: recs.conditions || [],
    treatment: recs.treatment || null,
    familyHistory,
    providers,
    // Annotated 23andMe markers + ClinVar call-outs, for the Genetics PDF. Absent until `npm run genome` has run.
    genome: readJson("genome.json", null),
  };

  return { payload, skipped, uncataloged, resolved, collisions, genetics, bloodwork };
}

/** Console summary shared by both build modes. */
function reportBuild({ bloodwork, payload, skipped, uncataloged, resolved, collisions, genetics }) {
  const tests = new Set(bloodwork.map((r) => r.test)).size;
  const dates = new Set(bloodwork.map((r) => r.date)).size;
  console.log(`${bloodwork.length} results · ${tests} tests · ${dates} visits`);
  console.log(`Panels: ${Object.keys(payload.panels).join(", ")}`);
  const nVerified = Object.keys(payload.rangesVerified || {}).length;
  console.log(`Reference ranges: ${nVerified} of ${Object.keys(payload.ranges || {}).length} verified against a lab report`);
  console.log(`Conditions: ${payload.conditions.length} active`);
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
  if (payload.genome) {
    const gm = payload.genome;
    console.log(`Genome: ${gm.genes.length} genes of interest, ${gm.callouts.length} ClinVar call-outs (ClinVar ${gm.source.clinvarDate})`);
  }
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} non-numeric/bad entr(ies):`);
    for (const s of skipped) console.log("  -", s);
  }
}

/**
 * Local-only build: inline the encrypted bundle into a copy of index.html so
 * the result opens straight from disk (file://) with no server and no
 * separate data file. Encrypted for real under the fixed phrase "test" — the
 * page runs the same KDF/decrypt path the published site does.
 */
async function buildLocal(built) {
  const bundle = await encrypt(built.payload, PREVIEW_PASSPHRASE);
  const template = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  if (!template.includes("<!-- EMBEDDED_DATA -->")) {
    console.error("index.html is missing the <!-- EMBEDDED_DATA --> marker.");
    process.exit(1);
  }
  // "<" is escaped so no substring of the JSON can close the script element.
  const json = JSON.stringify(bundle).replace(/</g, "\\u003c");
  const html = template
    .replace(
      "<!-- EMBEDDED_DATA -->",
      `<script type="application/json" id="embedded-data">${json}</script>`
    )
    .replace(
      "An incorrect phrase fails authentication and reveals nothing.",
      `Local preview build: the access phrase is <strong>${PREVIEW_PASSPHRASE}</strong>.`
    );
  const outPath = path.join(ROOT, "local.html");
  fs.writeFileSync(outPath, html);
  reportBuild(built);
  console.log(
    `Self-contained preview (phrase "${PREVIEW_PASSPHRASE}", gitignored) → ${path.relative(ROOT, outPath)}`
  );
  console.log(`Open it directly: open ${path.relative(ROOT, outPath)}`);
}

/**
 * Design-iteration build: the payload as plaintext JSON (gitignored). Served
 * on localhost, index.html loads it and renders with no unlock, so design
 * edits to index.html need only a refresh.
 */
function buildDev(built) {
  const outPath = path.join(ROOT, "data", "health.dev.json");
  fs.writeFileSync(outPath, JSON.stringify(built.payload));
  reportBuild(built);
  console.log(`Plaintext dev payload (gitignored) → ${path.relative(ROOT, outPath)}`);
  console.log("Serve it: npm run dev → http://localhost:8000");
}

/** Refresh only the localhost test copy (phrase "password") — no real passphrase needed. */
async function buildLocalCopy(built) {
  const localPath = path.join(ROOT, "data", "health.local.enc.json");
  fs.writeFileSync(localPath, JSON.stringify(await encrypt(built.payload, LOCAL_PASSPHRASE)));
  reportBuild(built);
  console.log(`Local copy (passphrase "${LOCAL_PASSPHRASE}", gitignored) → ${path.relative(ROOT, localPath)}`);
}

async function main() {
  const built = buildPayload();
  if (process.argv.includes("--local")) return buildLocal(built);
  if (process.argv.includes("--dev")) return buildDev(built);
  if (process.argv.includes("--local-copy")) return buildLocalCopy(built);
  const { payload } = built;

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
  fs.writeFileSync(outPath, JSON.stringify(await encrypt(payload, passphrase)));

  const localPath = path.join(ROOT, "data", "health.local.enc.json");
  fs.writeFileSync(localPath, JSON.stringify(await encrypt(payload, LOCAL_PASSPHRASE)));

  reportBuild(built);
  console.log(`Encrypted → ${path.relative(ROOT, outPath)}`);
  console.log(`Local copy (passphrase "${LOCAL_PASSPHRASE}", gitignored) → ${path.relative(ROOT, localPath)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
