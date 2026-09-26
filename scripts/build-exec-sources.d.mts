import type { ProgramCatalogEntry } from '../model/catalog.mjs';

export const CATALOG_RS: string;
export const EXEC_MODS_MJS: string;
export function renderCatalog(catalog?: readonly ProgramCatalogEntry[]): string;
export function publishedCargo(cargo: string): string;
export function modSources(): Record<string, Record<string, string>>;
export function renderModSources(sources?: Record<string, Record<string, string>>): string;
export function generatedFiles(): Record<string, string>;
export function staleFiles(): string[];
