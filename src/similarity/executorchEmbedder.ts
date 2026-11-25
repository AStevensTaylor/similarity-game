// The ONLY file that may import react-native-executorch or expo-asset.
// Everything else (and every test) talks to the Embedder interface.
import { Asset } from 'expo-asset';
import { createTextEmbedder, setTelemetryEnabled, type TextEmbedder } from 'react-native-executorch';

import type { LoadableEmbedder } from './types';

// The model is bundled, so nothing is downloaded and there is nothing to
// report; opt out of the library's anonymous download analytics regardless.
setTelemetryEnabled(false);

/** Resolves a bundled asset to a plain absolute file path. */
async function assetPath(moduleId: number): Promise<string> {
  const asset = Asset.fromModule(moduleId);
  // Release builds: copies the file out of the APK / resolves it in the iOS
  // bundle. Development builds: fetches it from Metro into the cache directory.
  await asset.downloadAsync();
  const uri = asset.localUri;
  if (!uri || !uri.startsWith('file://')) {
    throw new Error(`Model asset did not resolve to a local file: ${String(uri)}`);
  }
  // The ExecuTorch loaders take plain paths, not file:// URIs.
  return decodeURIComponent(uri.slice('file://'.length));
}

/**
 * all-MiniLM-L6-v2 (int8, XNNPACK) running on-device through ExecuTorch.
 * Tokenisation, mean pooling and L2 normalisation happen inside the runner /
 * the exported program; embed() returns the 384-dimensional sentence vector.
 */
export function createExecutorchEmbedder(): LoadableEmbedder {
  let runner: Promise<TextEmbedder> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  function loadRunner(): Promise<TextEmbedder> {
    runner ??= (async () => {
      const [modelPath, tokenizerPath] = await Promise.all([
        assetPath(require('../../assets/model/minilm_l6_v2_int8.pte')),
        assetPath(require('../../assets/model/minilm_tokenizer.tok')),
      ]);
      return createTextEmbedder({ modelPath, tokenizerPath });
    })().catch((error: unknown) => {
      runner = null; // allow a retry
      throw error;
    });
    return runner;
  }

  return {
    async load(): Promise<void> {
      await loadRunner();
    },
    embed(text: string): Promise<Float32Array> {
      // embed() rejects with RESOURCE_BUSY while another run is in flight, so
      // calls are serialised here as well as in the similarity service.
      const run = queue.then(async () => (await loadRunner()).embed(text));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
