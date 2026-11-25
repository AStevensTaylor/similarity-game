#!/usr/bin/env node
// Calibrates the similarity gate used by the game.
//
//   npm run calibrate [-- --date=2026-11-24] [--dry-run]
//
// The phone runs all-MiniLM-L6-v2 as an int8 ExecuTorch program, which cannot
// be executed on a development machine. This tool is the Node stand-in: the
// fp32 ONNX export of the SAME weights (Xenova/all-MiniLM-L6-v2), mean pooled
// over all tokens with the attention mask and L2 normalised, exactly like the
// pooling baked into the .pte. It:
//   1. embeds every word of src/data/nouns.json and src/data/deck.json;
//   2. counts, for each deck word, the dictionary nouns that would be valid
//      clues (not a spelling variant of the word) at a range of raw cosines;
//   3. picks RAW_GATE = the raw cosine at which ~90% of deck words still have
//      at least 8 valid clues (rounded to 2 decimals);
//   4. writes src/similarity/calibration.generated.json;
//   5. removes deck words with fewer than 3 valid clues at that gate from
//      src/data/deck.json, so that every hidden word is playable.
//
// Re-running is idempotent: words removed by an earlier run are recorded in
// the generated JSON and counted back in when the gate is chosen.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Tokenizer } from '@huggingface/tokenizers';

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
const MODEL_DIR = path.join(CACHE, 'all-MiniLM-L6-v2');
const MODEL_FILES = ['onnx/model.onnx', 'tokenizer.json', 'tokenizer_config.json'];
const NOUNS_PATH = path.join(ROOT, 'src/data/nouns.json');
const DECK_PATH = path.join(ROOT, 'src/data/deck.json');
const OUT_PATH = path.join(ROOT, 'src/similarity/calibration.generated.json');

const TARGET_FRACTION = 0.9; // share of deck words that must stay comfortable
const TARGET_CLUES = 8; // "comfortable" = at least this many valid clues
const MIN_CLUES = 3; // deck words with fewer valid clues are removed
const TABLE_HALF_WIDTH = 5; // table rows: gate +/- 0.05 in 0.01 steps
const GOLDEN = [
  ['dog', 'puppy'],
  ['cat', 'kitten'],
  ['ocean', 'sea'],
  ['car', 'automobile'],
  ['sofa', 'couch'],
  ['boat', 'ship'],
  ['doctor', 'nurse'],
  ['king', 'queen'],
  ['apple', 'fruit'],
  ['cat', 'dog'],
  ['cat', 'car'],
  ['apple', 'democracy'],
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dateArg = args.find((a) => a.startsWith('--date='))?.slice('--date='.length);
const generatedAt = dateArg ?? new Date().toISOString();

// ---------------------------------------------------------------- model files
async function ensureModel() {
  for (const rel of MODEL_FILES) {
    const dest = path.join(MODEL_DIR, rel);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    const url = `https://huggingface.co/${MODEL_REPO}/resolve/main/${rel}`;
    console.log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(tmp, dest);
  }
}

// ------------------------------------------------------------------ embedding
const DIM = 384;

async function createEmbedder() {
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(MODEL_DIR, rel), 'utf8'));
  const tokenizer = new Tokenizer(readJson('tokenizer.json'), readJson('tokenizer_config.json'));
  const session = await ort.InferenceSession.create(path.join(MODEL_DIR, 'onnx/model.onnx'), {
    graphOptimizationLevel: 'all',
  });

  /** Embeds words (already lower-case) -> Float32Array(words.length * DIM), rows L2-normalised. */
  async function embedAll(words, label) {
    const out = new Float32Array(words.length * DIM);
    const BATCH = 64;
    for (let start = 0; start < words.length; start += BATCH) {
      const ids = words.slice(start, start + BATCH).map((w) => tokenizer.encode(w).ids);
      const rows = ids.length;
      const len = Math.max(...ids.map((x) => x.length));
      const inputIds = new BigInt64Array(rows * len);
      const mask = new BigInt64Array(rows * len);
      ids.forEach((row, r) =>
        row.forEach((id, t) => {
          inputIds[r * len + t] = BigInt(id);
          mask[r * len + t] = 1n;
        }),
      );
      const dims = [rows, len];
      const feeds = {};
      for (const name of session.inputNames) {
        if (name === 'input_ids') feeds[name] = new ort.Tensor('int64', inputIds, dims);
        else if (name === 'attention_mask') feeds[name] = new ort.Tensor('int64', mask, dims);
        else feeds[name] = new ort.Tensor('int64', new BigInt64Array(rows * len), dims); // token_type_ids
      }
      const res = await session.run(feeds);
      const hidden = res.last_hidden_state ?? res[session.outputNames[0]];
      if (hidden.dims.length !== 3 || hidden.dims[2] !== DIM) {
        throw new Error(`unexpected model output shape ${hidden.dims}`);
      }
      for (let r = 0; r < rows; r++) {
        const o = (start + r) * DIM;
        // Mean pooling over every real token ([CLS] and [SEP] included).
        // Dividing by the token count is skipped: L2 normalisation follows.
        for (let t = 0; t < ids[r].length; t++) {
          const q = (r * len + t) * DIM;
          for (let d = 0; d < DIM; d++) out[o + d] += hidden.data[q + d];
        }
        let norm = 0;
        for (let d = 0; d < DIM; d++) norm += out[o + d] * out[o + d];
        norm = Math.sqrt(norm) || 1;
        for (let d = 0; d < DIM; d++) out[o + d] /= norm;
      }
      if (label && (start / BATCH) % 100 === 0) {
        process.stdout.write(`\r  embedding ${label}: ${start}/${words.length}`);
      }
    }
    if (label) process.stdout.write(`\r  embedding ${label}: ${words.length}/${words.length}\n`);
    return out;
  }
  return { embedAll };
}

/** Embeds with an on-disk cache keyed by the model file and the word list. */
async function embedCached(embedder, words, label) {
  const stat = fs.statSync(path.join(MODEL_DIR, 'onnx/model.onnx'));
  const key = crypto
    .createHash('sha256')
    .update(`v1|${stat.size}|${words.join('\n')}`)
    .digest('hex')
    .slice(0, 16);
  const file = path.join(CACHE, `embeddings-${key}.f32`);
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    if (buf.byteLength === words.length * DIM * 4) {
      console.log(`  ${label}: using cached embeddings (${path.relative(ROOT, file)})`);
      return new Float32Array(buf.buffer, buf.byteOffset, words.length * DIM).slice();
    }
  }
  const emb = await embedder.embedAll(words, label);
  fs.writeFileSync(file, Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength));
  return emb;
}

// ------------------------------------------------- variant exclusion (as game)
// A copy of candidateBases() / isMorphologicalVariant() in src/game/clues.ts
// (this tool is plain .mjs and cannot import the TypeScript). Keep the two in
// step: a clue may not equal, contain, be contained in, or be a single-suffix
// variant (plural / -s / -es / -ing / -ed / -er) of the word it describes.
const SUFFIXES = [
  ['iers', 'y'],
  ['ings', 'verbal'],
  ['ies', 'y'],
  ['ied', 'y'],
  ['ier', 'y'],
  ['ves', 'f'],
  ['ing', 'verbal'],
  ['ers', 'verbal'],
  ['es', 'plain'],
  ['ed', 'verbal'],
  ['er', 'verbal'],
  ['s', 'plain'],
];
const isConsonant = (ch) => ch !== undefined && !/[aeiou]/.test(ch);
const isUsableBase = (base) => base.length >= 3 && /[aeiouy]/.test(base);

function basesForSuffix(word, suffix, kind) {
  const rest = word.slice(0, word.length - suffix.length);
  const last = rest[rest.length - 1];
  let out;
  if (kind === 'plain') out = [rest];
  else if (kind === 'y') out = [`${rest}y`];
  else if (kind === 'f') out = [`${rest}f`, `${rest}fe`];
  else {
    out = [rest];
    if (isConsonant(last) && /[aeiouy]/.test(rest)) out.push(`${rest}e`); // bake / baking
    if (rest.length >= 2 && last === rest[rest.length - 2] && isConsonant(last)) out.push(rest.slice(0, -1)); // swim / swimming
  }
  return out.filter(isUsableBase);
}

function candidateBases(word) {
  const bases = new Set([word]);
  for (const [suffix, kind] of SUFFIXES) {
    if (!word.endsWith(suffix)) continue;
    for (const base of basesForSuffix(word, suffix, kind)) bases.add(base);
  }
  return bases;
}

function isVariant(a, b, basesA, basesB) {
  if (a === b || a.includes(b) || b.includes(a)) return true;
  for (const base of basesA) if (basesB.has(base)) return true;
  return false;
}

// ----------------------------------------------------------------------- main
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const round = (x, digits) => Number(x.toFixed(digits));

async function main() {
  await ensureModel();
  const nouns = JSON.parse(fs.readFileSync(NOUNS_PATH, 'utf8'));
  const deckOnDisk = JSON.parse(fs.readFileSync(DECK_PATH, 'utf8'));

  // Words removed by a previous run still take part in choosing the gate, so
  // that running the tool twice gives the same answer.
  let previouslyRemoved = [];
  if (fs.existsSync(OUT_PATH)) {
    try {
      previouslyRemoved = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')).removedDeckWords ?? [];
    } catch {
      previouslyRemoved = [];
    }
  }
  const deck = [...new Set([...deckOnDisk, ...previouslyRemoved])].sort();
  // Only words a player could actually type as a clue.
  const clueWords = nouns.filter((w) => /^[a-z]{2,20}$/.test(w));
  console.log(
    `dictionary: ${nouns.length} nouns (${clueWords.length} typeable as clues); deck: ${deck.length} words` +
      (previouslyRemoved.length ? ` (${deckOnDisk.length} on disk + ${previouslyRemoved.length} removed earlier)` : ''),
  );

  const embedder = await createEmbedder();
  const nounEmb = await embedCached(embedder, clueWords, 'nouns');
  const deckEmb = await embedCached(embedder, deck, 'deck');

  // Per deck word: histogram of valid-clue cosines in 0.01 steps, and the best
  // TARGET_CLUES cosines. Bin k counts cosines c with round2(c) === k / 100,
  // which is NOT the same as "c >= k/100", so counts are taken on exact
  // integer thresholds: bin = floor(c * 100 + 1e-6) => c >= bin / 100.
  const BINS = 101;
  const nounBases = clueWords.map(candidateBases);
  const hist = new Int32Array(deck.length * BINS);
  const globalHist = new Float64Array(BINS);
  let validPairs = 0;
  const kthBest = new Float32Array(deck.length);
  const topClues = [];
  const row = new Float32Array(clueWords.length);
  for (let i = 0; i < deck.length; i++) {
    const word = deck[i];
    const wordBases = candidateBases(word);
    const oi = i * DIM;
    const valid = [];
    for (let j = 0; j < clueWords.length; j++) {
      if (isVariant(word, clueWords[j], wordBases, nounBases[j])) {
        row[j] = -2;
        continue;
      }
      const oj = j * DIM;
      let dot = 0;
      for (let d = 0; d < DIM; d++) dot += deckEmb[oi + d] * nounEmb[oj + d];
      row[j] = dot;
      const bin = Math.max(0, Math.min(BINS - 1, Math.floor(dot * 100 + 1e-6)));
      hist[i * BINS + bin]++;
      globalHist[bin]++;
      validPairs++;
      if (dot >= 0.3) valid.push(j);
    }
    valid.sort((a, b) => row[b] - row[a]);
    kthBest[i] = valid.length >= TARGET_CLUES ? row[valid[TARGET_CLUES - 1]] : 0;
    topClues.push(valid.slice(0, 12).map((j) => [clueWords[j], row[j]]));
    if (i % 100 === 0) process.stdout.write(`\r  scoring deck words: ${i}/${deck.length}`);
  }
  process.stdout.write(`\r  scoring deck words: ${deck.length}/${deck.length}\n`);

  /** Number of valid clues of deck word i with cosine >= bin / 100. */
  const countAt = (i, bin) => {
    let n = 0;
    for (let b = bin; b < BINS; b++) n += hist[i * BINS + b];
    return n;
  };
  const statsAt = (bin, indices) => {
    const counts = indices.map((i) => countAt(i, bin)).sort((a, b) => a - b);
    let pass = 0;
    for (let b = bin; b < BINS; b++) pass += globalHist[b];
    const share = (min) => counts.filter((c) => c >= min).length / counts.length;
    return {
      raw: bin / 100,
      pctGe1: round(100 * share(1), 2),
      pctGe5: round(100 * share(5), 2),
      pctGe8: round(100 * share(TARGET_CLUES), 2),
      medianClues: counts[Math.floor(counts.length / 2)],
      randomPairPassPct: round((100 * pass) / validPairs, 3),
    };
  };

  // RAW_GATE: the (1 - TARGET_FRACTION) quantile of each word's 8th-best
  // valid cosine, i.e. the raw cosine at which ~90% of deck words have >= 8.
  const sorted = Array.from(kthBest).sort((a, b) => a - b);
  const exactGate = sorted[Math.floor((1 - TARGET_FRACTION) * (sorted.length - 1))];
  const rawGate = round(exactGate, 2);
  const gateBin = Math.round(rawGate * 100);
  const all = deck.map((_, i) => i);

  const printTable = (indices, title) => {
    console.log(`\n${title}`);
    console.log('  raw    >=1 clue  >=5 clues  >=8 clues  median clues  random pairs passing');
    const rows = [];
    for (let bin = gateBin - TABLE_HALF_WIDTH; bin <= gateBin + TABLE_HALF_WIDTH; bin++) {
      const s = statsAt(bin, indices);
      rows.push(s);
      console.log(
        `  ${s.raw.toFixed(2)}${bin === gateBin ? '*' : ' '}` +
          `${s.pctGe1.toFixed(1).padStart(8)}%${s.pctGe5.toFixed(1).padStart(10)}%${s.pctGe8.toFixed(1).padStart(10)}%` +
          `${String(s.medianClues).padStart(14)}${s.randomPairPassPct.toFixed(3).padStart(21)}%`,
      );
    }
    return rows;
  };

  console.log(
    `\n10th percentile of the ${TARGET_CLUES}th-best valid clue cosine = ${exactGate.toFixed(4)}  ->  RAW_GATE = ${rawGate.toFixed(2)}`,
  );
  printTable(all, `Deck as calibrated (${deck.length} words; * = chosen gate)`);

  // Unplayable words at the chosen gate.
  const removed = [];
  const kept = [];
  for (const i of all) {
    const n = countAt(i, gateBin);
    if (n < MIN_CLUES) removed.push({ word: deck[i], clues: n, best: topClues[i].slice(0, 3) });
    else kept.push(i);
  }
  console.log(`\nDeck words with fewer than ${MIN_CLUES} valid clues at raw >= ${rawGate.toFixed(2)}: ${removed.length}`);
  for (const r of removed) {
    const best = r.best.map(([w, c]) => `${w} ${c.toFixed(3)}`).join(', ') || '-';
    console.log(`  ${r.word.padEnd(14)} ${r.clues} clue(s); closest: ${best}`);
  }
  const tableRows = printTable(kept, `Final deck (${kept.length} words; * = chosen gate)`);
  const final = statsAt(gateBin, kept);
  const fewest = kept.map((i) => countAt(i, gateBin)).sort((a, b) => a - b);

  // Golden pairs for the on-device self check.
  const goldenWords = [...new Set(GOLDEN.flat())];
  const goldenEmb = await embedder.embedAll(goldenWords);
  const goldenPairs = GOLDEN.map(([a, b]) => {
    const oa = goldenWords.indexOf(a) * DIM;
    const ob = goldenWords.indexOf(b) * DIM;
    let dot = 0;
    for (let d = 0; d < DIM; d++) dot += goldenEmb[oa + d] * goldenEmb[ob + d];
    return { a, b, raw: round(dot, 4) };
  });
  console.log('\nGolden pairs (fp32 reference raw cosine):');
  for (const p of goldenPairs) {
    console.log(`  ${`${p.a} / ${p.b}`.padEnd(22)} ${p.raw.toFixed(4)}  ${p.raw >= rawGate ? 'passes' : 'fails'}`);
  }

  const removedWords = removed.map((r) => r.word).sort();
  const output = {
    rawGate,
    model: `${MODEL_REPO} onnx/model.onnx (fp32), mean pooling over all tokens, L2 normalised`,
    generatedAt,
    stats: {
      rule: `raw cosine at which ~${Math.round(TARGET_FRACTION * 100)}% of deck words have >= ${TARGET_CLUES} valid dictionary clues`,
      exactGate: round(exactGate, 4),
      dictionarySize: nouns.length,
      clueCandidates: clueWords.length,
      deckSizeCalibrated: deck.length,
      deckSizeFinal: kept.length,
      minCluesToKeepDeckWord: MIN_CLUES,
      atGate: { ...final, fewestClues: fewest[0] },
      table: tableRows,
    },
    removedDeckWords: removedWords,
    goldenPairs,
  };

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`\nwrote ${path.relative(ROOT, OUT_PATH)}`);
  const newDeck = kept.map((i) => deck[i]);
  if (newDeck.length !== deckOnDisk.length || newDeck.some((w, i) => w !== deckOnDisk[i])) {
    fs.writeFileSync(DECK_PATH, JSON.stringify(newDeck));
    console.log(`rewrote ${path.relative(ROOT, DECK_PATH)}: ${deckOnDisk.length} -> ${newDeck.length} words`);
    console.log(`removed: ${deckOnDisk.filter((w) => !newDeck.includes(w)).join(', ') || '(none this run)'}`);
  } else {
    console.log(`${path.relative(ROOT, DECK_PATH)} unchanged (${newDeck.length} words)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
