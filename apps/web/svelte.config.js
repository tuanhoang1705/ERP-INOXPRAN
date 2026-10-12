import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ fallback: '200.html' }),
    // Mã TypeScript thuần dùng chung với API (tính tiền phiếu). Nạp thẳng từ nguồn vì gói contracts build ra CommonJS.
    alias: { $shared: '../../packages/contracts/src/shared' },
  },
};

export default config;
