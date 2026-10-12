import { expect, it } from 'vitest';
import { fileBatches } from '../electron/services/files';

it('bounds parallel I/O and waits for in-flight work before propagating an error', async () => {
  let running = 0,
    peak = 0,
    completed = 0;
  const failure = new Error('fixture file verification failure');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const task = fileBatches(
    Array.from({ length: 32 }, (_, index) => index),
    async (index) => {
      running++;
      peak = Math.max(peak, running);
      try {
        if (index === 0) throw failure;
        await gate;
        return index;
      } finally {
        running--;
        completed++;
      }
    },
  );
  let finished = false;
  const result = task.catch((error) => {
    finished = true;
    return error;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
  expect(finished).toBe(false);
  release();
  expect(await result).toBe(failure);
  expect(running).toBe(0);
  expect(completed).toBe(8);
});
