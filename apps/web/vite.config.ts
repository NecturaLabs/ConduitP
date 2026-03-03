import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

const isMobile = process.env['VITE_MOBILE'] === 'true';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Mobile (Capacitor): use relative paths so assets load from the embedded WebView.
  // Web (Netlify): use /app/ so the SPA is served under the /app/ subpath.
  base: isMobile ? './' : '/app/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3443',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // disabled in production to prevent source code exposure
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-query': ['@tanstack/react-query'],
          'vendor-zustand': ['zustand'],
          'vendor-codemirror': ['codemirror', '@codemirror/lang-json', '@codemirror/language', '@codemirror/state'],
          'vendor-recharts': ['recharts'],
          'vendor-markdown': ['react-markdown', 'remark-gfm'],
        },
      },
    },
  },
});
