import { createHash, randomBytes } from 'node:crypto';

export function authorization(clientId, origin, manageBookmarks = false) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: origin + '/auth/callback',
    scope: 'tweet.read users.read bookmark.read' + (manageBookmarks ? ' bookmark.write' : ''), state,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url')
  });
  return { state, verifier, url: 'https://x.com/i/oauth2/authorize?' + query };
}

async function request(path, options, transport) {
  const response = await transport('https://api.x.com' + path, { ...options, signal: AbortSignal.timeout(25000) });
  if (!response.ok) {
    const hints = { 401: 'Reconnect your X account.', 402: 'Check your X API credit balance.',
      403: 'Check the permissions granted to Margin.', 429: 'X rate limit reached. Try again later.' };
    throw new Error('X returned HTTP ' + response.status + '. ' + (hints[response.status] || 'Try again or check your X app settings.'));
  }
  return response.json();
}

export async function exchange(code, verifier, config, transport = fetch) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier,
    redirect_uri: config.origin + '/auth/callback', client_id: config.clientId });
  const headers = {};
  if (config.secret) headers.Authorization = 'Basic ' + Buffer.from(config.clientId + ':' + config.secret).toString('base64');
  const token = await request('/2/oauth2/token', { method: 'POST', headers, body }, transport);
  if (!token.access_token) throw new Error('X did not return an access token.');
  const user = await request('/2/users/me', { headers: { Authorization: 'Bearer ' + token.access_token } }, transport);
  if (!/^\d+$/.test(user.data?.id)) throw new Error('X did not return an account ID.');
  return { account: user.data.id, name: user.data.username, token: token.access_token, canRemove: (token.scope || '').split(' ').includes('bookmark.write') };
}
