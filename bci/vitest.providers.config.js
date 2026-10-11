import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['test/providers/*.test.js'],environment:'node',fileParallelism:false,testTimeout:30000}});
