export {
  DEFAULT_ADAPTER_URL,
  runIsolated,
  TESSERACT_ADAPTER_URL,
  type IsolatedResult,
  type IsolationOptions,
} from './isolate.ts';
export {
  createDraftFromScan,
  discardScan,
  getScan,
  getScanFile,
  getUploadFile,
  listScans,
  MAX_RETRIES,
  OcrError,
  processNextOcrJob,
  productDraftFromScan,
  scanLookup,
  retryScan,
  storeUpload,
  uploadScan,
  type Extraction,
  type LookupResult,
  type LookupUnit,
  type ProductDraft,
  type MatchProposal,
  type OcrConfig,
  type ScanStatus,
  type ScanSummary,
  type ScanType,
  type ScanView,
} from './jobs.ts';
export { mockOcrAdapter, type OcrAdapter, type OcrResult } from './mock-adapter.ts';
export { LocalFileStorage, MemoryStorage, type StorageAdapter } from './storage.ts';
export { applyStructured, type StructuringOutcome } from './structuring.ts';
export { linesFromTsv, OcrEngineError } from './tesseract-adapter.ts';
