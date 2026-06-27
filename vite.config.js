import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'UI',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  base: './',
})
