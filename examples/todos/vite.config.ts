import react from "@vitejs/plugin-react"
import { lyn } from "lyn/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [lyn(), react()],
})
