import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative base, so the build works wherever it is mounted
  base: './',
  plugins: [react()]
})
