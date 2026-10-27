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
