/**
 * Game-mode fields this page passes into the Studio embed.
 *
 * They ship with the CrowdyJS release this template consumes. Declaring them
 * here lets the page typecheck against a pin that has not published them yet.
 * Once that pin includes the same fields, these declarations merge with it.
 */
declare module '@crowdedkingdoms/crowdyjs/crowdy-studio' {
  interface MountCrowdyStudioDshOptions {
    studioMode?: 'mod' | 'game';
  }

  interface CrowdyStudioControllerOptions {
    gameFiles?: {
      writeDraft(path: string, content: string): Promise<void>;
      readDraft(path: string): Promise<string>;
      listDraft(dir: string): Promise<Array<{ name: string; type: 'file' | 'directory' }>>;
      dirtyDraft(): Promise<string[]>;
    };
  }
}

export {};
