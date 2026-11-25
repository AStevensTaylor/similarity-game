/**
 * Minimal helpers on top of `test-renderer` (the React 19 test renderer that
 * jest-expo ships): find host elements, read all visible text, and trigger the
 * nearest onPress / onChangeText handler above a host element.
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root, type TestInstance, type TestNode } from 'test-renderer';

import { RAW_GATE, SCORE_GATE, type Embedder } from '../../similarity';

// A controllable clock. The game ignores taps for a moment after every step
// change (PHASE_TAP_GUARD_MS), so press() moves time forward first, the way a
// person takes a moment before tapping; pressNow() does not, like the second
// tap of a double tap.
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

export function advanceClock(ms: number): void {
  clockOffset += ms;
}

/** Longer than any tap guard in the app. */
export const TAP_PAUSE_MS = 1000;

export interface Rendered {
  root: Root;
  /** Every text string currently rendered, in order. */
  texts(): string[];
  /** All rendered text joined with spaces, lower-cased. */
  allText(): string;
  byTestId(id: string): TestInstance;
  queryByTestId(id: string): TestInstance | null;
  /** Waits TAP_PAUSE_MS on the test clock, then presses. */
  press(id: string): Promise<void>;
  /** Presses without letting any time pass since the previous press. */
  pressNow(id: string): Promise<void>;
  /** The nearest handler above a host element, to call it directly (e.g. twice in one act()). */
  handler(id: string, name: string): (...args: unknown[]) => unknown;
  type(id: string, text: string): Promise<void>;
  unmount(): Promise<void>;
}

function collectText(node: TestNode, out: string[]): void {
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  node.children.forEach((child) => collectText(child, out));
}

/** Walks up the fiber tree from a host element to the closest component that has the handler. */
function findHandler(instance: TestInstance, name: string): ((...args: unknown[]) => unknown) | null {
  let fiber = instance.unstable_fiber;
  while (fiber) {
    const props = fiber.memoizedProps as Record<string, unknown> | null;
    if (props && typeof props[name] === 'function') return props[name] as (...args: unknown[]) => unknown;
    fiber = fiber.return;
  }
  return null;
}

/** Lets pending promises (model scoring, storage) settle inside act(). */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

export async function render(element: ReactElement): Promise<Rendered> {
  const root = createRoot();
  await act(async () => {
    root.render(element);
  });
  await flush();

  const queryByTestId = (id: string): TestInstance | null =>
    root.container.queryAll((i) => i.props.testID === id, { matchDeepestOnly: true })[0] ?? null;
  const byTestId = (id: string): TestInstance => {
    const found = queryByTestId(id);
    if (found === null) throw new Error(`No element with testID "${id}". Rendered text: ${texts().join(' | ')}`);
    return found;
  };
  const texts = (): string[] => {
    const out: string[] = [];
    collectText(root.container, out);
    return out;
  };

  const pressNow = async (id: string): Promise<void> => {
    const handler = findHandler(byTestId(id), 'onPress');
    if (handler === null) throw new Error(`"${id}" is not pressable (or is disabled).`);
    await act(async () => {
      handler();
    });
    await flush();
  };

  return {
    root,
    texts,
    allText: () => texts().join(' ').toLowerCase(),
    byTestId,
    queryByTestId,
    async press(id) {
      advanceClock(TAP_PAUSE_MS);
      await pressNow(id);
    },
    pressNow,
    handler(id, name) {
      const handler = findHandler(byTestId(id), name);
      if (handler === null) throw new Error(`"${id}" has no ${name} handler (or is disabled).`);
      return handler;
    },
    async type(id, text) {
      const handler = findHandler(byTestId(id), 'onChangeText');
      if (handler === null) throw new Error(`"${id}" does not accept text.`);
      await act(async () => {
        handler(text);
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

/**
 * Embedder for UI tests: words starting with "far" point 80 degrees away from
 * everything else, so they score low (0.323); words starting with "mid" land
 * at a calibrated 0.90 against ordinary words (between the lowest threshold
 * and the default one); every other pair scores 1.
 */
export const MID_SCORE = 0.9;

export function createTestEmbedder(options: { failLoad?: boolean; failEmbed?: () => boolean } = {}): Embedder & {
  load(): Promise<void>;
} {
  return {
    async load() {
      if (options.failLoad) throw new Error('model file missing');
    },
    async embed(text: string) {
      if (options.failEmbed?.()) throw new Error('inference failed');
      const v = new Float32Array(4);
      const angle = text.startsWith('far')
        ? (80 * Math.PI) / 180
        : text.startsWith('mid')
          ? Math.acos((MID_SCORE * RAW_GATE) / SCORE_GATE)
          : 0;
      v[0] = Math.cos(angle);
      v[1] = Math.sin(angle);
      return v;
    },
  };
}
