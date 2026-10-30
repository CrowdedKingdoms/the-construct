/** The lazy host-module registry `constructDraftPlugin` writes at build time (see draftLoader.ts). */
declare module 'virtual:construct-draft-host' {
  const modules: Readonly<Record<string, () => Promise<unknown>>>;
  export default modules;
}
