import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: ['.wolfheluo.com'],
    // dev：/api 與 /s/ 轉發給本地 Hono server（tsx watch server/index.ts，port 3001）
    proxy: {
      '/api': 'http://localhost:3001',
      '/s/': 'http://localhost:3001',
    },
  },
})
