export interface StarterTemplateFile {
  path: string;
  content: string;
}

export interface StarterTemplate {
  id: string;
  title: string;
  target: 'CLIENT' | 'SERVER';
  description: string;
  files: StarterTemplateFile[];
}

export interface CommonFileSeed {
  slug: string;
  title: string;
  description: string;
  path: string;
  target: 'CLIENT' | 'SERVER';
  tags: string[];
  content: string;
}

export const STARTER_TEMPLATES: readonly StarterTemplate[];
export function commonFilesFor(template: StarterTemplate): CommonFileSeed[];
export function commonFileFor(template: StarterTemplate): CommonFileSeed;
