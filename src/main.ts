/// <reference types="vite/client" />
import { App } from './ui/app';

const root = document.getElementById('app') ?? document.body;
const app = new App(root);
app.start();

// `window.__app` is a test hook for the browser smoke script: exposed in dev builds, and in any
// build (including `vite preview` of a production build) when the URL contains `?test`.
if (import.meta.env.DEV || new URLSearchParams(location.search).has('test')) {
  (window as unknown as { __app: App }).__app = app;
}
