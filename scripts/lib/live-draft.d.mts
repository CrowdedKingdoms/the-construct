import type { Plugin } from 'vite';

export function isRepoPath(filePath: string): boolean;
export function isRepoDir(filePath: string): boolean;
export function isWritableGamePath(filePath: string): boolean;
export function draftFile(root: string, filePath: string): string | null;
export function liveDraftPlugin(root: string): Plugin;
