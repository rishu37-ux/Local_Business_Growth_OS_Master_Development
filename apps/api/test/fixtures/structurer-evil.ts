// Test-only structurer that behaves like a model obeying injected text: its
// output carries an action, so it fails the strict schema and is discarded.
export default {
  structure(): Promise<unknown> {
    return Promise.resolve({ invoiceNo: 'INJ-1', action: 'post_purchase', approve: true });
  },
};
