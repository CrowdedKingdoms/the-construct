/** Dev-server draft working copy. The Vite middleware owns the files. */

export async function writeGameDraft(path: string, content: string): Promise<void> {
  const response = await fetch('/__live-draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  if (!response.ok) {
    throw new Error((await response.text()) || `Draft write failed (${response.status})`);
  }
}

export async function readGameDraft(path: string): Promise<string> {
  const response = await fetch(`/__live-draft?path=${encodeURIComponent(path)}`);
  if (!response.ok) {
    throw new Error((await response.text()) || `Draft read failed (${response.status})`);
  }
  const body = (await response.json()) as { content?: unknown };
  if (typeof body.content !== 'string') throw new Error('Draft read returned no content.');
  return body.content;
}

export async function listGameDraft(
  dir: string,
): Promise<Array<{ name: string; type: 'file' | 'directory' }>> {
  const response = await fetch(`/__live-draft?dir=${encodeURIComponent(dir)}`);
  if (!response.ok) {
    throw new Error((await response.text()) || `Draft list failed (${response.status})`);
  }
  const body = (await response.json()) as { entries?: unknown };
  if (!Array.isArray(body.entries)) throw new Error('Draft list returned no entries.');
  return body.entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const name = (entry as { name?: unknown }).name;
    const type = (entry as { type?: unknown }).type;
    if (typeof name !== 'string' || (type !== 'file' && type !== 'directory')) return [];
    return [{ name, type }];
  });
}

export async function dirtyGameDraft(): Promise<string[]> {
  const response = await fetch('/__live-draft?dirty=1');
  if (!response.ok) {
    throw new Error((await response.text()) || `Draft dirty list failed (${response.status})`);
  }
  const body = (await response.json()) as { paths?: unknown };
  if (!Array.isArray(body.paths)) throw new Error('Draft dirty list returned no paths.');
  return body.paths.filter((path): path is string => typeof path === 'string');
}
