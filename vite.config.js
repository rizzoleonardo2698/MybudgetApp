import { defineConfig } from 'vite';

function escapeSafariUnicode() {
  return {
    name: 'escape-safari-unicode',
    generateBundle(_options, bundle) {
      Object.values(bundle).forEach((asset) => {
        if (asset.type === 'chunk') {
          asset.code = asset.code.replaceAll('…', '\\u2026');
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [escapeSafariUnicode()],
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  server: { port: 4173 },
  preview: { port: 4173 },
});
