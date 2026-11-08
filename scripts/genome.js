#!/usr/bin/env node
/**
 * @fileoverview Annotate a 23andMe raw-data file and merge it with the clinical
 * genetic results in source/genetics.json.
 *
 * Inputs (all under source/, all gitignored):
 *   source/genome/23andme.txt        23andMe raw data (GRCh37, plus strand)
 *   source/genome/refGene.txt.gz     UCSC hg19 refGene table (gene coordinates)
 *   source/genome/clinvar.vcf.gz     NCBI ClinVar, GRCh37 VCF
 *   source/genetics.json             clinical genetic results (panels + findings)
 *   source/genome-config.json        optional: extra genes of interest + known chip gaps
 *
 * Outputs:
 *   source/genome.json               focused dataset: genes of interest, every
 *                                    chip marker inside them, ClinVar call-outs.
 *                                    build.js puts it in the encrypted payload,
 *                                    where the Genetics page turns it into a PDF.
 *   source/genome/23andme-annotated.csv
 *                                    every marker on the chip with its gene,
 *                                    region and best ClinVar match. Local only;
 *                                    too large for the payload.
 *
 * Usage:
 *   node scripts/genome.js [path/to/23andme.txt] [--include-alzheimers]
 *
 * Alzheimer's-risk interpretation (APOE and any ClinVar record naming
 * Alzheimer disease) is withheld by default — 23andMe itself gates it behind an
 * opt-in. Pass --include-alzheimers to include it.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const readline = require("node:readline");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "source");
const GDIR = path.join(SRC, "genome");
const args = process.argv.slice(2);
const RAW = args.find((a) => !a.startsWith("--")) || path.join(GDIR, "23andme.txt");
const INCLUDE_ALZ = args.includes("--include-alzheimers");
const WITHHELD_GENES = INCLUDE_ALZ ? new Set() : new Set(["APOE"]);
const isWithheldRecord = (r) => !INCLUDE_ALZ && (WITHHELD_GENES.has(r.gene) || /alzheimer/i.test(r.condition));

/* Genes added beyond the tested panels because they bear on open questions in
   the record. Each carries the reason it is listed. Genes marked notOnChip are
   ones that cannot be assessed from SNP-array data at all. */
/* Extra genes to cover beyond the tested panels, and known gaps the chip cannot
   assess, live in source/genome-config.json (gitignored) because the reasons
   for including them describe personal medical history:
     { "extraGenes": [["GENE", "why it is listed"], …],
       "notOnChip":  [["What", "why the chip cannot assess it"], …] } */
const CONFIG = (() => {
  const p = path.join(SRC, "genome-config.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
})();
const EXTRA_GENES = CONFIG.extraGenes || [];

/* Markers read directly because ClinVar does not cover them usefully, from
   source/genome-config.json "curated": [{ id, gene, trait, risk, readings }].
   readings maps a count of the risk allele ("0", "1", "2", or "1+" for any) to
   text; indel probes set "indel": true and use readings.het / readings.hom,
   since the chip's D/I letters do not say which allele is the insertion.
   Alleles are on the plus strand (GRCh37), matching the raw file. */
const CURATED = CONFIG.curated || [];
function readCurated(c, m) {
  const r = c.readings || {};
  if (!m) return "Not on chip";
  if (m.gt === "--") return r.nocall || "No call";
  if (c.indel) return m.gt.length === 2 && m.gt[0] !== m.gt[1] ? r.het : r.hom;
  const n = [...m.gt].filter((a) => a === c.risk).length;
  return r[String(n)] ?? (n >= 1 ? r["1+"] : r["0"]) ?? "";
}

/* ---------- helpers ---------- */

function lines(file) {
  const input = file.endsWith(".gz") ? fs.createReadStream(file).pipe(zlib.createGunzip()) : fs.createReadStream(file);
  return readline.createInterface({ input, crlfDelay: Infinity });
}
const chromKey = (c) => String(c).replace(/^chr/, "").replace(/^M$/, "MT");
const keyOf = (c, p) => `${chromKey(c)}:${p}`;
const isIndelGt = (gt) => /[DI]/.test(gt);
function mergeIntervals(iv) {
  iv.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of iv) {
    if (out.length && s <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
    else out.push([s, e]);
  }
  return out;
}
const inIntervals = (iv, p) => {
  let lo = 0, hi = iv.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (p < iv[m][0]) hi = m - 1; else if (p > iv[m][1]) lo = m + 1; else return true;
  }
  return false;
};

/* ---------- 1. 23andMe raw data ---------- */

async function readChip() {
  const markers = [];
  let fileHeader = "";
  for await (const raw of lines(RAW)) {
    if (raw.startsWith("#")) { if (/timestamp|file_id/.test(raw)) fileHeader += raw.replace(/^#\s*/, "") + "; "; continue; }
    const [id, chrom, pos, gt] = raw.trim().split("\t");
    if (!id || !pos) continue;
    markers.push({ id, chrom: chromKey(chrom), pos: +pos, gt: gt || "--" });
  }
  return { markers, fileHeader };
}

/* ---------- 2. Gene coordinates (UCSC refGene, 0-based half-open) ---------- */

async function readGenes() {
  const byKey = new Map(); // gene|chrom -> { gene, chrom, start, end, exons[], cds[] }
  for await (const l of lines(path.join(GDIR, "refGene.txt.gz"))) {
    const f = l.split("\t");
    const chrom = f[2];
    if (!chrom || chrom.includes("_")) continue;
    const gene = f[12];
    const txS = +f[4] + 1, txE = +f[5], cdsS = +f[6] + 1, cdsE = +f[7];
    const exS = f[9].split(",").filter(Boolean).map(Number), exE = f[10].split(",").filter(Boolean).map(Number);
    const k = `${gene}|${chromKey(chrom)}`;
    let g = byKey.get(k);
    if (!g) byKey.set(k, (g = { gene, chrom: chromKey(chrom), start: txS, end: txE, exons: [], cds: [] }));
    g.start = Math.min(g.start, txS); g.end = Math.max(g.end, txE);
    exS.forEach((s, i) => {
      const a = s + 1, b = exE[i];
      g.exons.push([a, b]);
      if (cdsE >= cdsS) { const cs = Math.max(a, cdsS), ce = Math.min(b, cdsE); if (cs <= ce) g.cds.push([cs, ce]); }
    });
  }
  const byChrom = new Map();
  for (const g of byKey.values()) {
    g.exons = mergeIntervals(g.exons); g.cds = mergeIntervals(g.cds);
    if (!byChrom.has(g.chrom)) byChrom.set(g.chrom, []);
    byChrom.get(g.chrom).push(g);
  }
  const maxLen = new Map();
  for (const [c, arr] of byChrom) { arr.sort((a, b) => a.start - b.start); maxLen.set(c, Math.max(...arr.map((g) => g.end - g.start))); }
  const lookup = (chrom, pos) => {
    const arr = byChrom.get(chrom); if (!arr) return [];
    let lo = 0, hi = arr.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].start <= pos) { idx = m; lo = m + 1; } else hi = m - 1; }
    const hits = [], floor = pos - maxLen.get(chrom);
    for (let i = idx; i >= 0 && arr[i].start >= floor; i--) if (arr[i].end >= pos) hits.push(arr[i]);
    return hits;
  };
  const region = (g, pos) => (inIntervals(g.cds, pos) ? "coding" : inIntervals(g.exons, pos) ? "UTR/exon" : "intron");
  const bySymbol = new Map();
  for (const g of byKey.values()) if (!bySymbol.has(g.gene) || g.chrom.length < bySymbol.get(g.gene).chrom.length) bySymbol.set(g.gene, g);
  return { lookup, region, bySymbol };
}

/* ---------- 3. ClinVar ---------- */

const STARS = {
  practice_guideline: 4, reviewed_by_expert_panel: 3,
  "criteria_provided,_multiple_submitters,_no_conflicts": 2,
  "criteria_provided,_single_submitter": 1, "criteria_provided,_conflicting_classifications": 1,
};
function classify(sig, conf) {
  const s = sig || "";
  const tags = [];
  if (/(^|[|/_ ])(Pathogenic|Likely_pathogenic)/.test(s) && !/Conflicting/.test(s)) tags.push("P/LP");
  // Conflicting records are called out only when pathogenic submissions outnumber
  // benign ones (e.g. F5 rs6025 T>C is "Pathogenic(2)|Benign(3)" because the
  // GRCh37 reference carries the Leiden allele, so the C "variant" is normal).
  const n = (re) => [...String(conf || "").matchAll(re)].reduce((a, m) => a + +m[1], 0);
  if (/Conflicting/.test(s) && n(/athogenic[^|(]*\((\d+)\)/g) > n(/[Bb]enign[^|(]*\((\d+)\)/g)) tags.push("Conflicting (incl. P/LP)");
  if (/risk_factor/i.test(s)) tags.push("Risk factor");
  if (/association/i.test(s)) tags.push("Association");
  if (/protective/i.test(s)) tags.push("Protective");
  if (/drug_response/i.test(s)) tags.push("Drug response");
  if (/Affects/i.test(s)) tags.push("Affects");
  if (/Uncertain_significance/.test(s) && !tags.length) tags.push("VUS");
  if (/Conflicting/.test(s) && !tags.length) tags.push("Conflicting");
  if (/[Bb]enign/.test(s) && !tags.length) tags.push("Benign/LB");
  return tags.length ? tags : ["Other"];
}
const SEVERITY = ["P/LP", "Conflicting (incl. P/LP)", "Risk factor", "Drug response", "Association", "Protective", "Affects", "VUS", "Conflicting", "Other", "Benign/LB"];
const sevRank = (r) => Math.min(...r.tags.map((t) => SEVERITY.indexOf(t)));

async function readClinVar(chipByPos, chipByRs) {
  const records = [];
  let date = "";
  const knownIds = new Map(); // ClinVar Variation ID -> record (for clinically reported variants)
  for await (const l of lines(path.join(GDIR, "clinvar.vcf.gz"))) {
    if (l.startsWith("#")) { const m = /^##fileDate=(.+)/.exec(l); if (m) date = m[1]; continue; }
    const t1 = l.indexOf("\t"), t2 = l.indexOf("\t", t1 + 1), t3 = l.indexOf("\t", t2 + 1);
    const chrom = chromKey(l.slice(0, t1)), pos = +l.slice(t1 + 1, t2), vid = l.slice(t2 + 1, t3);
    const f = l.split("\t");
    const ref = f[3], alt = f[4];
    const wanted = WANTED_IDS.has(vid);
    // Candidate chip markers: the same rsID, or the same position. VCF indels are
    // left-padded, so an indel probe may sit at pos or pos+1 — and only chip
    // markers that are themselves indel probes (D/I calls) may match an indel.
    const rsM = /(?:^|;)RS=(\d+)/.exec(f[7]);
    const indel = ref.length !== alt.length;
    let markers = [];
    for (const p of indel ? [pos, pos + 1] : [pos]) {
      for (const m of chipByPos.get(`${chrom}:${p}`) || []) if (!indel || isIndelGt(m.gt) || m.gt === "--") markers.push(m);
    }
    if (rsM && chipByRs.has("rs" + rsM[1])) markers.push(chipByRs.get("rs" + rsM[1]));
    markers = [...new Set(markers)];
    if (!markers.length && !wanted) continue;
    const info = Object.fromEntries(f[7].split(";").map((kv) => { const i = kv.indexOf("="); return i < 0 ? [kv, true] : [kv.slice(0, i), kv.slice(i + 1)]; }));
    const afs = ["AF_EXAC", "AF_TGP", "AF_ESP"].map((k) => info[k]).filter((v) => v != null).map(Number);
    const rec = {
      vid, chrom, pos, ref, alt,
      gene: String(info.GENEINFO || "").split("|")[0].split(":")[0],
      sig: String(info.CLNSIG || "").replace(/_/g, " "),
      tags: classify(info.CLNSIG, info.CLNSIGCONF),
      stars: STARS[info.CLNREVSTAT] ?? 0,
      condition: String(info.CLNDN || "").split("|").filter((x) => x && !/^not_(specified|provided)$/.test(x)).map((x) => x.replace(/_/g, " ")).slice(0, 3).join("; "),
      hgvs: String(info.CLNHGVS || ""),
      consequence: String(info.MC || "").split(",").map((x) => x.split("|")[1]).filter(Boolean).join(", "),
      vc: String(info.CLNVC || ""),
      af: afs.length ? Math.max(...afs) : null,
      rs: rsM ? "rs" + rsM[1] : "",
    };
    if (wanted) knownIds.set(vid, { rec, markers });
    for (const m of markers) records.push({ rec, m });
  }
  return { records, date, knownIds };
}

/** How many copies of the ClinVar ALT allele the chip genotype carries (null = cannot tell). */
function altCopies(rec, m) {
  const gt = m.gt;
  if (!gt || gt === "--") return null;
  if (isIndelGt(gt)) {
    // 23andMe's D/I letters do not say which allele is the reference (for an
    // insertion probe, "DD" is the reference), so only a heterozygous "DI" is
    // unambiguous: one copy of the variant either way. Homozygous calls are
    // reported as unknown rather than guessed.
    if (rec.ref.length === rec.alt.length) return null;
    return gt.length === 2 && gt[0] !== gt[1] ? 1 : null;
  }
  if (m.pos !== rec.pos) return null;
  const al = [...gt];
  // ALT "." means the reference allele itself is the variant (GRCh37 carries a
  // few, such as factor V Leiden): count copies of REF instead.
  if (rec.alt === "." && rec.ref.length === 1) return al.every((a) => /[ACGT]/.test(a)) ? al.filter((a) => a === rec.ref).length : null;
  if (rec.ref.length !== 1 || rec.alt.length !== 1) return null;
  if (!al.every((a) => a === rec.ref || a === rec.alt)) return null; // other allele or strand mismatch
  return al.filter((a) => a === rec.alt).length;
}

/* ---------- 4. Clinical results (source/genetics.json) ---------- */

const genetics = JSON.parse(fs.readFileSync(path.join(SRC, "genetics.json"), "utf8"));
const WANTED_IDS = new Set();
const knownFindings = (genetics.findings || []).map((f) => {
  const m = /ClinVar Variation ID (\d+)/i.exec(f.notes || "");
  if (m) WANTED_IDS.add(m[1]);
  return { ...f, clinvarId: m ? m[1] : null };
});

/* ---------- main ---------- */

async function main() {
  for (const f of [RAW, path.join(GDIR, "refGene.txt.gz"), path.join(GDIR, "clinvar.vcf.gz")]) {
    if (!fs.existsSync(f)) { console.error(`Missing input: ${path.relative(ROOT, f)}`); process.exit(1); }
  }
  console.log("Reading 23andMe file…");
  const { markers, fileHeader } = await readChip();
  const nocalls = markers.filter((m) => m.gt === "--").length;
  const chipByPos = new Map(), chipByRs = new Map();
  for (const m of markers) {
    const k = `${m.chrom}:${m.pos}`;
    if (!chipByPos.has(k)) chipByPos.set(k, []);
    chipByPos.get(k).push(m);
    if (m.id.startsWith("rs")) chipByRs.set(m.id, m);
  }
  console.log(`  ${markers.length.toLocaleString()} markers, ${nocalls.toLocaleString()} no-calls`);

  console.log("Reading gene coordinates…");
  const genes = await readGenes();
  for (const m of markers) {
    const hits = genes.lookup(m.chrom, m.pos);
    m.genes = [...new Set(hits.map((g) => g.gene))];
    m.region = hits.length ? (hits.some((g) => genes.region(g, m.pos) === "coding") ? "coding" : hits.some((g) => genes.region(g, m.pos) === "UTR/exon") ? "UTR/exon" : "intron") : "intergenic";
  }

  console.log("Matching ClinVar (this takes a minute)…");
  const { records, date: clinvarDate, knownIds } = await readClinVar(chipByPos, chipByRs);
  // Attach the most relevant ClinVar record to each marker: carried first, then by severity.
  for (const { rec, m } of records) {
    const copies = altCopies(rec, m);
    const cand = { rec, copies, indel: isIndelGt(m.gt) };
    const better = (a, b) => {
      const ca = a.copies > 0 ? 0 : 1, cb = b.copies > 0 ? 0 : 1;
      return ca - cb || sevRank(a.rec) - sevRank(b.rec) || b.rec.stars - a.rec.stars;
    };
    (m.cv = m.cv || []).push(cand);
    m.cv.sort(better);
  }
  console.log(`  ClinVar ${clinvarDate}: ${records.length.toLocaleString()} record/marker matches`);

  /* Genes of interest: every gene on a tested panel, plus EXTRA_GENES. */
  const panelOf = new Map(); // gene -> [{ panel, method, positive }]
  const SNP_TO_GENE = CONFIG.variantGenes || {}; // panel entries naming a variant rather than a gene
  for (const p of genetics.panels || []) {
    // A panel may state its method; otherwise infer it from the name.
    const method = ["sequencing", "chip", "targeted"].includes(p.method) ? p.method : (/23andme|genotyping|carrier status/i.test(p.panel) ? "chip" : /panel|sequenc|exome|genome/i.test(p.panel) ? "sequencing" : "targeted");
    for (const raw of p.genes || []) {
      const gene = SNP_TO_GENE[raw] || raw;
      if (!panelOf.has(gene)) panelOf.set(gene, []);
      const prev = panelOf.get(gene).find((x) => x.panel === p.panel);
      const pos = (p.positive || []).includes(raw);
      if (prev) prev.positive = prev.positive || pos;
      else panelOf.get(gene).push({ panel: p.panel, method, positive: pos, variant: pos && SNP_TO_GENE[raw] ? raw : "" });
      if (pos && SNP_TO_GENE[raw]) { const e = panelOf.get(gene).find((x) => x.panel === p.panel); e.variant = [e.variant, raw].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", "); }
    }
  }
  const extraWhy = new Map(EXTRA_GENES);
  const geneNames = [...new Set([...panelOf.keys(), ...extraWhy.keys()])].filter((g) => !WITHHELD_GENES.has(g));

  const markersByGene = new Map();
  for (const m of markers) for (const g of m.genes) {
    if (!markersByGene.has(g)) markersByGene.set(g, []);
    markersByGene.get(g).push(m);
  }

  const clinvarOut = []; // deduplicated records referenced by index
  const cvIndex = new Map();
  const refCv = (cand, m) => {
    const k = `${cand.rec.vid}|${m.id}`;
    if (!cvIndex.has(k)) {
      cvIndex.set(k, clinvarOut.length);
      const r = cand.rec;
      clinvarOut.push({
        vid: r.vid, gene: r.gene, chrom: r.chrom, pos: r.pos, ref: r.ref, alt: r.alt, sig: r.sig, tags: r.tags, stars: r.stars,
        condition: r.condition, hgvs: r.hgvs, consequence: r.consequence, af: r.af,
        marker: m.id, gt: m.gt, copies: cand.copies, indel: cand.indel,
      });
    }
    return cvIndex.get(k);
  };
  const usable = (cand) => cand && !isWithheldRecord(cand.rec);

  const findingByGene = new Map();
  for (const f of knownFindings) {
    const g = f.gene.split(/\s/)[0];
    findingByGene.set(g, f);
  }

  const geneRows = geneNames.map((gene) => {
    const loc = genes.bySymbol.get(gene);
    const ms = (markersByGene.get(gene) || []).slice().sort((a, b) => a.pos - b.pos);
    const tests = panelOf.get(gene) || [];
    const sequenced = tests.filter((t) => t.method === "sequencing");
    const rows = ms.map((m) => {
      const best = (m.cv || []).find(usable);
      return [m.id, m.pos, m.gt, m.region, best ? refCv(best, m) : -1];
    });
    // Carried, non-benign ClinVar alleles (benign ones are everywhere and say nothing).
    const carried = ms.flatMap((m) => (m.cv || []).filter((c) => usable(c) && c.copies > 0 && !c.rec.tags.includes("Benign/LB")).map((c) => ({ c, m })));
    const plp = carried.filter(({ c }) => c.rec.tags.some((t) => t === "P/LP" || t === "Conflicting (incl. P/LP)"));
    const why = [...tests.map((t) => t.panel), ...(extraWhy.has(gene) ? [extraWhy.get(gene)] : [])];
    const posTests = tests.filter((t) => t.positive);
    const finding = findingByGene.get(gene);

    // One combined verdict per gene.
    let verdict, level;
    if (posTests.length) {
      level = "positive";
      verdict = finding ? `${finding.result} (${posTests.map((t) => t.panel.split(" — ")[0].split(" (")[0]).join("; ")})` : `Variant detected on ${posTests.map((t) => t.panel).join("; ")}`;
    } else if (plp.length && sequenced.length) {
      level = "conflict";
      verdict = `23andMe reports ${plp.length} ClinVar pathogenic/likely-pathogenic call(s), but clinical sequencing of this gene was negative - most likely a chip genotyping error.`;
    } else if (plp.length) {
      level = "flag";
      verdict = `23andMe reports ${plp.length} ClinVar pathogenic/likely-pathogenic call(s). Unconfirmed - needs clinical confirmation.`;
    } else if (sequenced.length) {
      level = "negative";
      verdict = `Negative on clinical sequencing (${sequenced.map((t) => t.panel.split(" — ")[0].split(" (")[0]).join("; ")}). No pathogenic call among ${ms.length} chip markers.`;
    } else if (ms.length) {
      level = carried.length ? "note" : "chip-negative";
      verdict = carried.length
        ? `Not clinically sequenced. No pathogenic call; chip carries ${carried.length} allele(s) ClinVar lists as uncertain, conflicting, risk/association or drug response (see markers).`
        : `Not clinically sequenced. No ClinVar-flagged alleles among ${ms.length} chip markers (chip checks selected positions only).`;
    } else {
      level = "untested";
      verdict = "Not clinically sequenced and no markers on the 23andMe chip - untested.";
    }
    return {
      gene, chrom: loc ? loc.chrom : "", start: loc ? loc.start : null, end: loc ? loc.end : null,
      why, tests: tests.map((t) => ({ panel: t.panel, method: t.method, positive: t.positive, variant: t.variant || "" })),
      markers: rows, nocall: ms.filter((m) => m.gt === "--").length,
      carried: carried.length, plp: plp.length, level, verdict,
    };
  }).sort((a, b) => a.gene.localeCompare(b.gene));

  /* Genome-wide call-outs: any carried ClinVar allele that is not benign/VUS. */
  const callouts = [];
  let vusCarried = 0, withheldN = 0;
  const seen = new Set();
  for (const m of markers) for (const c of m.cv || []) {
    if (!(c.copies > 0)) continue;
    if (isWithheldRecord(c.rec)) { withheldN++; continue; }
    const top = c.rec.tags.filter((t) => !["VUS", "Conflicting", "Benign/LB", "Other"].includes(t));
    if (!top.length) { if (c.rec.tags.includes("VUS")) vusCarried++; continue; }
    const k = `${c.rec.vid}|${m.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    callouts.push(refCv(c, m));
  }

  /* Clinically reported variants: is the exact variant on the chip? */
  const verdictOverrides = new Map();
  const known = knownFindings.map((f) => {
    const out = { gene: f.gene, result: f.result, condition: f.condition || "", dateTested: f.dateTested || "", positive: !!f.positive, clinvarId: f.clinvarId };
    if (f.clinvarId) {
      const k = knownIds.get(f.clinvarId);
      if (!k || !k.markers.length) out.chip = "This exact variant is not on the 23andMe chip - only clinical sequencing could find it.";
      else out.chip = k.markers.map((m) => `Chip marker ${m.id} genotype ${m.gt}`).join("; ");
      if (k) out.position = `chr${k.rec.chrom}:${k.rec.pos} ${k.rec.ref}>${k.rec.alt}`;
    }
    // Zygosity read from the chip for findings whose report did not state it
    // (source/genome-config.json "zygosity").
    for (const z of CONFIG.zygosity || []) {
      if (!new RegExp(z.finding).test(f.gene)) continue;
      const word = (x) => (x == null ? "no call" : x === 0 ? "not carried" : x === 1 ? "1 copy (heterozygous)" : "2 copies (homozygous)");
      const calls = z.markers.map((mk) => {
        const m = chipByRs.get(mk.rs);
        return { mk, m, n: !m || m.gt === "--" ? null : [...m.gt].filter((a) => a === mk.alt).length };
      });
      out.chip = "23andMe: " + calls.map(({ mk, m, n }) => `${mk.name} ${word(n)} [${mk.rs} ${m?.gt || "--"}]`).join("; ") + ".";
      if (z.compoundNote && calls.filter((c) => c.n === 1).length >= 2 && calls.every((c) => c.n == null || c.n <= 1)) {
        out.chip += " " + z.compoundNote;
        if (z.geneVerdict) verdictOverrides.set(z.gene, z.geneVerdict);
      }
    }
    return out;
  });

  for (const [gene, v] of verdictOverrides) { const row = geneRows.find((g) => g.gene === gene); if (row) row.verdict = v; }

  const curated = CURATED.map((c) => {
    const m = chipByRs.get(c.id);
    return { id: c.id, gene: c.gene, trait: c.trait, gt: m ? m.gt : "not on chip", result: readCurated(c, m) };
  });

  const NOT_ON_CHIP = CONFIG.notOnChip || [];

  const out = {
    generatedAt: new Date().toISOString(),
    source: {
      file: path.basename(RAW), header: fileHeader.trim(), build: "GRCh37", markers: markers.length, nocalls,
      callRate: +(100 * (1 - nocalls / markers.length)).toFixed(2), clinvarDate, genes: "UCSC hg19 refGene",
    },
    withheld: INCLUDE_ALZ ? null : { genes: [...WITHHELD_GENES], records: withheldN, note: "Alzheimer's-disease risk interpretation (APOE and any ClinVar record naming Alzheimer disease) is withheld by default, as 23andMe does. Rebuild with --include-alzheimers to include it." },
    known, curated, genes: geneRows, clinvar: clinvarOut, callouts, vusCarried, notOnChip: NOT_ON_CHIP,
  };
  fs.writeFileSync(path.join(SRC, "genome.json"), JSON.stringify(out));

  /* Full CSV of every marker. */
  const csvPath = path.join(GDIR, "23andme-annotated.csv");
  const ws = fs.createWriteStream(csvPath);
  const q = (s) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  ws.write("rsid,chromosome,position,genotype,genes,region,clinvar_significance,clinvar_condition,clinvar_ref,clinvar_alt,alt_copies,review_stars,clinvar_variation_id\n");
  for (const m of markers) {
    const c = (m.cv || []).find(usable);
    const r = c ? c.rec : null;
    ws.write([m.id, m.chrom, m.pos, m.gt, m.genes.join(" "), m.region, r ? r.sig : "", r ? r.condition : "", r ? r.ref : "", r ? r.alt : "", c && c.copies != null ? c.copies : "", r ? r.stars : "", r ? r.vid : ""].map(q).join(",") + "\n");
  }
  await new Promise((ok) => ws.end(ok));

  const nMarkers = geneRows.reduce((s, g) => s + g.markers.length, 0);
  console.log(`Genes of interest: ${geneRows.length} (${nMarkers.toLocaleString()} chip markers inside them)`);
  console.log(`Genome-wide call-outs (carried, non-benign, non-VUS): ${callouts.length}; carried VUS not itemised: ${vusCarried}`);
  for (const lvl of ["positive", "flag", "conflict"]) {
    const g = geneRows.filter((x) => x.level === lvl).map((x) => x.gene);
    if (g.length) console.log(`  ${lvl}: ${g.join(", ")}`);
  }
  console.log(`→ ${path.relative(ROOT, path.join(SRC, "genome.json"))} (${(fs.statSync(path.join(SRC, "genome.json")).size / 1024).toFixed(0)} KB)`);
  console.log(`→ ${path.relative(ROOT, csvPath)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
