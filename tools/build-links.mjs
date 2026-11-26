#!/usr/bin/env node
// Builds src/data/links.json: dictionary links between the bundled nouns
// ("root is part of a tree", "sofa means the same as couch", "key and lock
// go together") that let a clue pass even when the word model scores it
// below the threshold.
//
//   npm run build-links [-- --dry-run]
//
// Sources (downloaded once into .cache/links/ and checked against pinned hashes):
//   - WordNet 3.1 (Princeton): synonyms, direct kind-of (hypernym), part-of,
//     member-of and made-of (meronym) links, antonyms and noun-to-noun
//     derivations, using only each word's common senses.
//   - ConceptNet 5.7 (CC BY-SA 4.0): crowd-sourced Open Mind Common Sense
//     facts, Verbosity word-association data and Wiktionary links.
//
// Every source edge earns evidence points (see EVIDENCE below); a pair is kept
// when its points reach 1. Weak, noisy sources (a single Wiktionary "related
// term", a single "found at" fact) count half, so they only make a link when
// something else agrees. The app additionally requires the word model's raw
// cosine to reach a floor (LINK_RAW_FLOOR in src/similarity/calibration.ts), which
// filters out links that rely on a rare sense of a word.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache/links');
const NOUNS_PATH = path.join(ROOT, 'src/data/nouns.json');
const OUT_PATH = path.join(ROOT, 'src/data/links.json');

const SOURCES = {
  wordnet: {
    url: 'https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz',
    file: 'wn3.1.dict.tar.gz',
    sha256: '3f7d8be8ef6ecc7167d39b10d66954ec734280b5bdcd57f7d9eafe429d11c22a',
  },
  conceptnet: {
    url: 'https://s3.amazonaws.com/conceptnet/downloads/2019/edges/conceptnet-assertions-5.7.0.csv.gz',
    file: 'conceptnet-assertions-5.7.0.csv.gz',
    sha256: 'accd65fe94038584295574ddc26e1500c1919c8c4532bf771811cafd0948af7e',
  },
};

/**
 * Relation labels, in order of preference when a pair has several. The index
 * is stored in links.json, so only append to this list.
 */
const RELATIONS = [
  'synonym', // x means the same as y
  'opposite', // x is the opposite of y
  'kind', // x is a kind of y
  'part', // x is part of y
  'member', // x is a member of y (tree / forest, bird / flock)
  'material', // x is made of y
  'used-for', // x is used for y
  'cause', // x causes y
  'found-at', // x is found at y
  'associated', // x and y go together
];
const REL = Object.fromEntries(RELATIONS.map((r, i) => [r, i]));
/** Relations that read the same both ways; they are stored without a direction. */
const SYMMETRIC = new Set(['synonym', 'opposite', 'associated']);

const dryRun = process.argv.includes('--dry-run');
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function ensure({ url, file, sha256 }) {
  const dest = path.join(CACHE, file);
  if (!fs.existsSync(dest)) {
    console.log(`downloading ${url}`);
    fs.mkdirSync(CACHE, { recursive: true });
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`);
    const tmp = `${dest}.part`;
    const out = fs.createWriteStream(tmp);
    for await (const chunk of res.body) {
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    fs.renameSync(tmp, dest);
  }
  const got = sha256File(dest);
  if (got !== sha256) {
    throw new Error(`${file}: sha256 ${got} does not match the pinned ${sha256}. Delete it to re-download.`);
  }
  return dest;
}

// -------------------------------------------------------------------- WordNet
function loadWordNet(tarball) {
  const dir = path.join(CACHE, 'wn3.1');
  if (!fs.existsSync(path.join(dir, 'dict/data.noun'))) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['-xzf', tarball, '-C', dir, 'dict/data.noun', 'dict/index.noun', 'dict/index.sense']);
  }
  const read = (f) => fs.readFileSync(path.join(dir, 'dict', f), 'utf8').split('\n');

  const synsets = new Map(); // offset -> { words, ptrs: [{ sym, off, st }] }
  for (const line of read('data.noun')) {
    if (!/^\d{8} /.test(line)) continue;
    const t = line.split(' | ')[0].trim().split(' ');
    const words = [];
    let i = 4;
    for (let k = parseInt(t[3], 16); k > 0; k--, i += 2) words.push(t[i].toLowerCase());
    const ptrs = [];
    for (let k = Number(t[i++]); k > 0; k--, i += 4) {
      if (t[i + 2] === 'n') ptrs.push({ sym: t[i], off: t[i + 1], st: t[i + 3] });
    }
    synsets.set(t[0], { words, ptrs });
  }

  const tagCount = new Map(); // "word offset" -> semantic-concordance tag count
  for (const line of read('index.sense')) {
    const m = /^([^%]+)%1:\S+ (\d{8}) \d+ (\d+)$/.exec(line);
    if (m) tagCount.set(`${m[1]} ${m[2]}`, Number(m[3]));
  }
  /** word -> offsets of its common senses: the first sense, or one tagged in the concordance. */
  const common = new Map();
  for (const line of read('index.noun')) {
    if (line.startsWith(' ')) continue;
    const t = line.trim().split(' ');
    if (t.length < 4) continue;
    const offs = t.slice(t.length - Number(t[2]));
    const keep = offs.filter((off, r) => {
      const count = tagCount.get(`${t[0]} ${off}`) ?? 0;
      return r === 0 || count >= 2 || (count >= 1 && r < 3);
    });
    common.set(t[0], new Set(keep));
  }
  return { synsets, common };
}

// ------------------------------------------------------------------- evidence
/** pairKey -> [{ rel, from, points, source }] */
const evidence = new Map();
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
function addEvidence(a, b, rel, from, points, source) {
  if (a === b) return;
  const key = pairKey(a, b);
  let list = evidence.get(key);
  if (!list) evidence.set(key, (list = []));
  list.push({ rel, from, points, source });
}

function collectWordNet({ synsets, common }, nouns) {
  const members = (off) => synsets.get(off).words.filter((w) => nouns.has(w) && common.get(w)?.has(off));
  const targets = (S, sym) => S.ptrs.filter((p) => p.sym === sym).map((p) => p.off);
  for (const [off, S] of synsets) {
    const A = members(off);
    if (A.length === 0) continue;
    for (const a of A) for (const b of A) if (a < b) addEvidence(a, b, 'synonym', null, 1, 'wordnet');
    for (const T of targets(S, '@')) for (const b of members(T)) for (const a of A) addEvidence(a, b, 'kind', a, 1, 'wordnet');
    for (const T of targets(S, '#p')) for (const b of members(T)) for (const a of A) addEvidence(a, b, 'part', a, 1, 'wordnet');
    for (const T of targets(S, '#m')) for (const b of members(T)) for (const a of A) addEvidence(a, b, 'member', a, 1, 'wordnet');
    // "#s": this synset is a substance of T, so T is made of it.
    for (const T of targets(S, '#s')) for (const b of members(T)) for (const a of A) addEvidence(a, b, 'material', b, 1, 'wordnet');
    for (const p of S.ptrs) {
      if (p.sym !== '!' && p.sym !== '+') continue; // lexical pointers between two specific words
      const a = S.words[parseInt(p.st.slice(0, 2), 16) - 1];
      const b = synsets.get(p.off)?.words[parseInt(p.st.slice(2), 16) - 1];
      if (!a || !b || !nouns.has(a) || !nouns.has(b)) continue;
      if (!common.get(a)?.has(off) || !common.get(b)?.has(p.off)) continue;
      addEvidence(a, b, p.sym === '!' ? 'opposite' : 'associated', null, 1, 'wordnet');
    }
  }
}

/**
 * Points for one ConceptNet edge, or null to ignore it. `w` is the edge weight
 * (for Open Mind Common Sense, roughly the number of people who stated it).
 */
function conceptNetEvidence(rel, dataset, w) {
  if (dataset === 'conceptnet/4/en') {
    switch (rel) {
      case 'PartOf':
        return { rel: 'part', points: 1, forward: true };
      case 'HasA':
        return { rel: 'part', points: 1, forward: false };
      case 'MadeOf':
        return { rel: 'material', points: 1, forward: true };
      case 'IsA':
        return { rel: 'kind', points: 1, forward: true };
      case 'Causes':
        return { rel: 'cause', points: 1, forward: true };
      case 'UsedFor':
        return { rel: 'used-for', points: w >= 2 ? 1 : 0.5, forward: true };
      case 'AtLocation':
        return w >= 2 ? { rel: 'found-at', points: 0.5, forward: true } : null;
      case 'Synonym':
      case 'SimilarTo':
        return { rel: 'synonym', points: 1 };
      case 'Antonym':
        return { rel: 'opposite', points: 1 };
      default:
        return null; // Desires, CapableOf, HasProperty, ...: mostly not noun-noun, or too loose
    }
  }
  if (dataset === 'verbosity') {
    if (rel === 'RelatedTo' || rel === 'DistinctFrom') {
      return w >= 1 ? { rel: 'associated', points: 1 } : w >= 0.25 ? { rel: 'associated', points: 0.5 } : null;
    }
    if (rel === 'Antonym') return { rel: 'opposite', points: w >= 0.5 ? 1 : 0.5 };
    return null;
  }
  if (dataset.startsWith('wiktionary/')) {
    const map = { Synonym: 'synonym', SimilarTo: 'synonym', Antonym: 'opposite', RelatedTo: 'associated', PartOf: 'part', IsA: 'kind' };
    return map[rel] ? { rel: map[rel], points: 0.5, forward: true } : null;
  }
  if (dataset === 'opencyc' && rel === 'IsA') return { rel: 'kind', points: 0.5, forward: true };
  return null; // ConceptNet's own copy of WordNet is skipped: WordNet is read directly
}

async function collectConceptNet(gz, nouns) {
  const term = (uri) => {
    const p = uri.split('/'); // /c/en/<term>[/<pos>[/...]]
    if (p[2] !== 'en' || (p[4] !== undefined && p[4] !== 'n')) return null;
    return nouns.has(p[3]) ? p[3] : null;
  };
  const rl = readline.createInterface({ input: fs.createReadStream(gz).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let edges = 0;
  for await (const line of rl) {
    if (!line.includes('\t/c/en/')) continue;
    const [, relUri, start, end, meta] = line.split('\t');
    const a = term(start);
    const b = term(end);
    if (a === null || b === null || a === b) continue;
    const { dataset, weight } = JSON.parse(meta);
    const e = conceptNetEvidence(relUri.slice(3), dataset.slice(3), weight);
    if (!e) continue;
    const from = SYMMETRIC.has(e.rel) ? null : e.forward ? a : b;
    addEvidence(a, b, e.rel, from, e.points, 'conceptnet');
    edges++;
  }
  return edges;
}

// ----------------------------------------------------------------------- main
/** True when one word contains the other: such pairs are blocked as clues anyway. */
const overlaps = (a, b) => a.includes(b) || b.includes(a);

async function main() {
  const nounList = JSON.parse(fs.readFileSync(NOUNS_PATH, 'utf8'));
  const nouns = new Set(nounList);
  const index = new Map(nounList.map((w, i) => [w, i]));

  const wn = loadWordNet(await ensure(SOURCES.wordnet));
  collectWordNet(wn, nouns);
  const cnEdges = await collectConceptNet(await ensure(SOURCES.conceptnet), nouns);

  const rows = [];
  const byRel = Object.fromEntries(RELATIONS.map((r) => [r, 0]));
  for (const [key, list] of evidence) {
    const [a, b] = key.split('|');
    if (overlaps(a, b)) continue;
    const points = list.reduce((s, e) => s + e.points, 0);
    if (points < 1) continue;
    // Label: the most specific relation, preferring full-point evidence.
    const best = [...list].sort((x, y) => (y.points >= 1) - (x.points >= 1) || REL[x.rel] - REL[y.rel])[0];
    let i = index.get(a);
    let j = index.get(b);
    let from = best.from;
    if (i > j) [i, j] = [j, i];
    const dir = from === null || SYMMETRIC.has(best.rel) ? 0 : from === nounList[i] ? 1 : 2;
    const src = (list.some((e) => e.source === 'wordnet') ? 1 : 0) | (list.some((e) => e.source === 'conceptnet') ? 2 : 0);
    rows.push([i, j, (REL[best.rel] << 4) | (dir << 2) | src]);
    byRel[best.rel]++;
  }
  rows.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  const output = {
    format: 1,
    note: 'Generated by tools/build-links.mjs. Do not edit. Pairs are [i, j, code] triples of nouns.json indexes (i < j); code = relation << 4 | direction << 2 | sources (1 WordNet, 2 ConceptNet); direction 0 = symmetric, 1 = i REL j, 2 = j REL i.',
    sources: ['WordNet 3.1 (Princeton University)', 'ConceptNet 5.7 (CC BY-SA 4.0)'],
    relations: RELATIONS,
    pairs: rows.flat(),
  };
  console.log(`ConceptNet edges used: ${cnEdges}`);
  console.log(`links: ${rows.length}`, byRel);
  if (dryRun) return;
  const text = `${JSON.stringify(output)}\n`;
  fs.writeFileSync(OUT_PATH, text);
  console.log(`wrote ${path.relative(ROOT, OUT_PATH)} (${(text.length / 1024).toFixed(0)} KiB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
