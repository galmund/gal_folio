// Vercel serverless entry point.
//
// vercel.json rewrites every path here, so this one function serves the whole
// app — UI, login and API alike. Routing everything through it (rather than
// letting Vercel serve the UI as static files) is deliberate: static files are
// matched before rewrites, so a statically served index.html would sail past
// the password gate in server.js.
export { default } from '../server.js';
