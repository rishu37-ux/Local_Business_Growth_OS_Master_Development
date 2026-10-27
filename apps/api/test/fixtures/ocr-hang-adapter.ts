// Test-only OCR adapter that never returns (busy loop): exercises the worker timeout.
export default {
  name: 'test-hang',
  recognize(): Promise<never> {
    for (;;) {
      // spin
    }
  },
};
