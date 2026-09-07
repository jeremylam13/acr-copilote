import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Le service worker se met à jour tout seul en arrière-plan à chaque
      // ouverture avec réseau — pas besoin d'action de l'utilisateur, et il
      // n'utilise jamais une version périmée sans le savoir.
      registerType: 'autoUpdate',
      injectRegister: 'auto',

      // manifest.json déjà présent et lié manuellement dans index.html —
      // on ne laisse pas le plugin en générer un second qui entrerait en conflit.
      manifest: false,
      includeManifestIcons: false,
      includeAssets: ['favicon-32.png', 'apple-touch-icon.png', 'manifest.json'],

      workbox: {
        // Met en cache tout ce qui sort du build (JS, CSS, HTML, icônes) —
        // c'est ce qui permet à l'app de s'ouvrir sans réseau après la
        // première visite.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff,woff2}'],
        // Après un nouveau déploiement, le nouveau service worker prend le
        // relai immédiatement au lieu d'attendre la fermeture de tous les
        // onglets — important pour recevoir les correctifs sans y penser.
        skipWaiting: true,
        clientsClaim: true,
        // Polices Google Fonts (Inter, Archivo, JetBrains Mono) utilisées à
        // l'écran et dans le compte-rendu — mises en cache dès le premier
        // chargement pour rester disponibles hors-ligne ensuite.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-stylesheets',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  build: {
    outDir: 'dist',
    assetsInlineLimit: 4096
  }
})
