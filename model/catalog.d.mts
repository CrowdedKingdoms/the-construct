export interface ProgramCatalogEntry {
  programId: number;
  sceneId: string;
  name: string;
  description: string;
}

export const PROGRAM_CATALOG: readonly ProgramCatalogEntry[];
