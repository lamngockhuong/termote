// Entry of mermaid-sandbox.html (vite.config.ts builds it into the page as
// one inline script, with the worker's own bundle as a string).
import { relay, workerFromSource } from './utils/mermaid-sandbox'

declare const __MERMAID_WORKER__: string

relay(window, () => workerFromSource(__MERMAID_WORKER__))
