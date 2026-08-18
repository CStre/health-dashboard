#!/usr/bin/env node
/**
 * @fileoverview Verify data/health.enc.json opens with a given phrase.
 *
 * Run this before committing: the local dashboard always reads the
 * `password`-encrypted local copy, so it never exercises the real phrase.
 * This does, against the exact file that gets published.
 *
 *   npm run verify            # prompts for the phrase
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const FILE = path.join(__dirname, "..", "data", "health.enc.json");

function promptPassphrase() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => write(/[\r\n]/.test(s) ? s : "*");
    process.stderr.write("Phrase: ");
    rl.question("", (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`Not found: ${FILE} — run npm run build first.`);
    process.exit(1);
  }
  const bundle = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const salt = Buffer.from(bundle.salt, "base64");
  const iv = Buffer.from(bundle.iv, "base64");
  const data = Buffer.from(bundle.data, "base64");

  const phrase = process.env.HEALTH_PASSPHRASE || (await promptPassphrase());

  let key = Buffer.from(phrase, "utf8");
  for (let r = 0; r < (bundle.rounds || 1); r++) {
    key = crypto.pbkdf2Sync(key, Buffer.concat([salt, Buffer.from([r])]), bundle.iterations, 32, "sha256");
  }

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(data.subarray(data.length - 16));
    const plaintext = Buffer.concat([
      decipher.update(data.subarray(0, data.length - 16)),
      decipher.final(),
    ]);
    const payload = JSON.parse(plaintext.toString("utf8"));
    const dates = [...new Set(payload.bloodwork.map((r) => r.date))].sort();
    console.log("OK — the published file opens with that phrase.");
    console.log(
      `   ${payload.bloodwork.length} results · ` +
        `${new Set(payload.bloodwork.map((r) => r.test)).size} tests · ` +
        `${dates.length} visits (${dates[0]} → ${dates[dates.length - 1]})`
    );
    console.log(`   profile: ${payload.profile?.name || "(none)"}`);
  } catch {
    console.error("FAILED — that phrase does not open data/health.enc.json.");
    process.exit(1);
  }
}

main();
