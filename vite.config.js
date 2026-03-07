import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/animeschedule': {
        target: 'https://animeschedule.net',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/animeschedule/, '/api/v3'),
      },
      '/api/anilist': {
        target: 'https://graphql.anilist.co',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/anilist/, ''),
      }
    }
  }
})
