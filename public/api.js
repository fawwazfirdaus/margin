// This module runs directly in browsers. TypeScript checks it against the server's wire formats.
/** @import { AuthorizationResponse, BookmarkEdit, LibraryResponse, SuccessResponse, SyncResponse } from '../shared/contracts.ts' */

/**
 * @template T
 * @param {string} path
 * @param {string} [method]
 * @param {BookmarkEdit} [body]
 * @returns {Promise<T>}
 */
async function request(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body && JSON.stringify(body)
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || 'Request failed.');
  return result;
}

/** @returns {Promise<LibraryResponse>} */
export function getLibrary() {
  return request('/api/library');
}

/** @param {'/auth/start' | '/auth/manage'} path @returns {Promise<AuthorizationResponse>} */
export function authorize(path) {
  return request(path, 'POST');
}

/** @returns {Promise<SyncResponse>} */
export function importPage() {
  return request('/api/sync', 'POST');
}

/** @param {string} id @param {BookmarkEdit} edit @returns {Promise<SuccessResponse>} */
export function editBookmark(id, edit) {
  return request('/api/posts/' + encodeURIComponent(id), 'PATCH', edit);
}

/** @param {string} id @returns {Promise<SuccessResponse>} */
export function removeBookmark(id) {
  return request('/api/posts/' + encodeURIComponent(id), 'DELETE');
}

/** @param {string} id @returns {Promise<SuccessResponse>} */
export function refreshMedia(id) {
  return request('/api/posts/' + encodeURIComponent(id) + '/media', 'POST');
}

/** @returns {Promise<SuccessResponse>} */
export function signOut() {
  return request('/auth/signout', 'POST');
}
