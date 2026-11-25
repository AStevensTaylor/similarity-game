#!/usr/bin/env node
// Re-downloads the two model assets that are bundled into the app and verifies
// their SHA-256 hashes.
//
//   npm run fetch-model             download (if needed) and verify
//   npm run fetch-model -- --check  only verify the files already on disk
//   npm run fetch-model -- --force  download even if the files verify
//
// Source: https://huggingface.co/software-mansion/react-native-executorch-all-MiniLM-L6-v2
// pinned to the tag below. The tokenizer is tokenizer.json renamed to .tok so
// that Metro ships it as a file asset instead of parsing it as a JS module.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'software-mansion/react-native-executorch-all-MiniLM-L6-v2';
const TAG = 'v0.11.0';
const ASSETS = [
  {
    remote: 'xnnpack/all_minilm_l6_v2_xnnpack_int8.pte',
    local: 'assets/model/minilm_l6_v2_int8.pte',
    sha256: 'a1769173f272a41e4371fa2c078795b66a932efbbc25881749e2571ad44cffb1',
  },
  {
    remote: 'tokenizer.json',
    local: 'assets/model/minilm_tokenizer.tok',
    sha256: '40331223c4665f27200828a9ea3da9f951d4f7bcb19cc02067f10273e2a59bdd',
  },
];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const force = args.includes('--force');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** @returns {'ok' | 'missing' | string} 'ok', 'missing', or the wrong hash found on disk */
function verify(asset) {
  const file = path.join(ROOT, asset.local);
  if (!fs.existsSync(file)) return 'missing';
  const actual = sha256(fs.readFileSync(file));
  return actual === asset.sha256 ? 'ok' : actual;
}

async function download(asset) {
  const url = `https://huggingface.co/${REPO}/resolve/${TAG}/${asset.remote}`;
  console.log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status} ${res.statusText}) for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== asset.sha256) {
    throw new Error(`hash mismatch for ${url}\n  expected ${asset.sha256}\n  received ${actual}\nNothing was written.`);
  }
  const file = path.join(ROOT, asset.local);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  console.log(`  wrote ${asset.local} (${buf.length} bytes)`);
}

async function main() {
  let failed = false;
  for (const asset of ASSETS) {
    const state = verify(asset);
    // --check only ever reports; it never downloads, with or without --force.
    if (checkOnly) {
      if (state === 'ok') console.log(`ok       ${asset.local}  sha256 ${asset.sha256}`);
      else {
        failed = true;
        if (state === 'missing') console.log(`MISSING  ${asset.local}`);
        else console.log(`MISMATCH ${asset.local}\n  expected ${asset.sha256}\n  found    ${state}`);
      }
      continue;
    }
    if (state === 'ok' && !force) {
      console.log(`ok       ${asset.local}  sha256 ${asset.sha256}`);
      continue;
    }
    console.log(`${state === 'ok' ? 'forced' : state === 'missing' ? 'missing' : 'mismatch'}  ${asset.local}`);
    await download(asset);
  }
  if (failed) {
    console.error('\nModel assets are missing or modified. Run `npm run fetch-model` to restore them.');
    process.exit(1);
  }
  console.log(`\nModel assets match ${REPO}@${TAG}.`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
