import moduleBoundaries from './module-boundaries.js';
import noRawHttp from './no-raw-http.js';

export default {
  meta: { name: '@lbgos/eslint-rules' },
  rules: { 'module-boundaries': moduleBoundaries, 'no-raw-http': noRawHttp },
};
