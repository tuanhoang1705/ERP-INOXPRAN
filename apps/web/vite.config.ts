import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // Đa ngôn ngữ: tiếng Việt (gốc) và tiếng Trung giản thể. Ngôn ngữ chọn được lưu ở localStorage;
    // lần đầu dùng ngôn ngữ trình duyệt nếu khớp, không thì tiếng Việt.
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/lib/paraglide',
      strategy: ['localStorage', 'preferredLanguage', 'baseLocale'],
    }),
    sveltekit(),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
