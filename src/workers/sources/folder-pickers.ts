// folder-pickers.ts · Wave C3 (2026-06-15) · scoped-source pickers for the non-GitHub providers.
//
// GitHub already has a repo picker (listUserRepos → GET /sources/:id/repos). This adds the equivalent
// FOLDER picker for Google Drive + Dropbox so the operator can bind ONE folder instead of the whole
// account — the "pick what to sync" half of the unified connector journey (C3/C4). Metadata-only
// (folder id + name), consistent with the contract-enforced read policy; no file content is fetched.

export interface FolderItem {
  id: string;
  name: string;
  path?: string;
}

type FolderError = Error & { code?: string };

function err(message: string, code: string): FolderError {
  const e = new Error(message) as FolderError;
  e.code = code;
  return e;
}

// Google Drive: list the user's folders (metadata only). drive.metadata.readonly scope.
async function listDriveFolders(token: string): Promise<FolderItem[]> {
  const q = encodeURIComponent("mimeType='application/vnd.google-apps.folder' and trashed=false");
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=100&orderBy=name`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (res.status === 401) throw err('Google Drive token unauthorized — reconnect the source', 'drive_api_unauthorized');
  if (res.status === 429) throw err('Google Drive rate limited — try again shortly', 'drive_api_rate_limited');
  if (!res.ok) throw err(`Google Drive API ${res.status}`, 'drive_api_error');
  const body = (await res.json().catch(() => ({}))) as { files?: Array<{ id?: string; name?: string }> };
  return (body.files || [])
    .filter((f) => f && f.id)
    .map((f) => ({ id: String(f.id), name: String(f.name || f.id) }));
}

// Dropbox: list top-level folders (metadata only). files.metadata.read scope.
async function listDropboxFolders(token: string): Promise<FolderItem[]> {
  const res = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '', recursive: false, limit: 100 }),
  });
  if (res.status === 401) throw err('Dropbox token unauthorized — reconnect the source', 'dropbox_api_unauthorized');
  if (res.status === 429) throw err('Dropbox rate limited — try again shortly', 'dropbox_api_rate_limited');
  if (!res.ok) throw err(`Dropbox API ${res.status}`, 'dropbox_api_error');
  const body = (await res.json().catch(() => ({}))) as { entries?: Array<{ '.tag'?: string; id?: string; name?: string; path_lower?: string }> };
  return (body.entries || [])
    .filter((e) => e && e['.tag'] === 'folder' && e.id)
    .map((e) => ({ id: String(e.id), name: String(e.name || e.id), path: e.path_lower || undefined }));
}

/** Dispatch folder listing by provider. Throws (with `code`) for unsupported providers + API errors. */
export async function listProviderFolders(provider: string, token: string): Promise<FolderItem[]> {
  if (provider === 'google_drive') return listDriveFolders(token);
  if (provider === 'dropbox') return listDropboxFolders(token);
  throw err(`folder listing is not supported for ${provider}`, 'unsupported_provider');
}

/** The OAuth provider key the adapter needs a token for, given the source provider. */
export const FOLDER_PROVIDERS: ReadonlySet<string> = new Set(['google_drive', 'dropbox']);
