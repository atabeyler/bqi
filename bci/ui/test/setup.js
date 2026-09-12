import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// @testing-library/react only auto-registers its afterEach(cleanup) when it
// finds a global `afterEach` -- this project imports test functions
// explicitly from 'vitest' rather than enabling test.globals, so that
// auto-detection never fires and the DOM from one test leaks into the
// next (duplicate elements) without this.
afterEach(cleanup);
