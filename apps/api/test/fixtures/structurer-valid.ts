// Test-only structurer: proposes one value present in the document (invoiceNo)
// and one that is not (invoiceDate), which must be dropped.
export default {
  structure(): Promise<unknown> {
    return Promise.resolve({ invoiceNo: 'SD-77', invoiceDate: '2026-01-01' });
  },
};
