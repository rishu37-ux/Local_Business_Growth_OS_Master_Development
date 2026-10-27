// Test-only OCR adapter whose provider call fails.
export default {
  name: 'test-throw',
  recognize(): Promise<never> {
    return Promise.reject(new Error('provider unavailable'));
  },
};
