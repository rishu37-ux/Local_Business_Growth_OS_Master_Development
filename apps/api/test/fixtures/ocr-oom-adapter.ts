// Test-only OCR adapter that allocates until the worker's heap limit is hit.
export default {
  name: 'test-oom',
  recognize(): Promise<never> {
    const hog: string[][] = [];
    for (;;) hog.push(Array.from({ length: 100_000 }, (_, i) => `x${String(i)}`));
  },
};
