// Vite inlines `?raw` imports at build time; keep the bundled phone page in a
// single real HTML file that Capacitor can also reuse.
declare module '*?raw' {
  const content: string
  export default content
}
