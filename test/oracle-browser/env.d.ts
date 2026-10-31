/** Vite's `?url` suffix: the import is the served URL of the file. */
declare module '*?url' {
  const url: string;
  export default url;
}
