// The interactive demo (`vite build --mode demo`, published at /demo/ of the
// website): the PWA answers its own /api/mux requests from fixtures in the
// browser (src/demo). Vite replaces MODE at build time, so the release build
// keeps none of what this gates.
export const isDemo = import.meta.env.MODE === 'demo'
