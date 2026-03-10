import { defineConfig } from 'vite';

export default defineConfig({
    base: './',
    build: {
        outDir: 'dist',
        assetsInlineLimit: 0,
    },
    resolve: {
        // CRITICAL: Force @magenta/music to share the same TF.js instance
        // as the YOLO detector. Without this, Vite pre-bundles separate copies
        // of TF.js for each, and they corrupt each other's WebGL state.
        dedupe: [
            '@tensorflow/tfjs',
            '@tensorflow/tfjs-core',
            '@tensorflow/tfjs-backend-webgl',
            '@tensorflow/tfjs-backend-cpu',
            '@tensorflow/tfjs-converter',
            '@tensorflow/tfjs-layers',
        ],
    },
    server: {
        port: 5173,
        open: true,
    },
});
