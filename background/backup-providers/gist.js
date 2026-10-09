import {
  BACKUP_ERRORS,
  computeSha256,
  executeFetchWithTimeout,
  httpStatusToError,
} from './errors.js';

export const PROVIDER_ID = 'gist';

const DEFAULT_FILENAME = 'marks-local-backup.json';
const GITHUB_API_BASE = 'https://api.github.com';
const TRUSTED_RAW_HOSTS = new Set([
  'gist.githubusercontent.com',
  'raw.githubusercontent.com',
  'github.com',
  'gist.github.com',
  'api.github.com',
]);

function sanitize(result, token) {
  if (!result || !token || typeof token !== 'string') return result;
  if (typeof result.message === 'string' && result.message.includes(token)) {
    result.message = result.message.replaceAll(token, '[REDACTED]');
  }
  if (result.details && typeof result.details === 'object') {
    for (const [key, val] of Object.entries(result.details)) {
      if (typeof val === 'string' && val.includes(token)) {
        result.details[key] = val.replaceAll(token, '[REDACTED]');
      }
    }
  }
  return result;
}

function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

export async function testConnection(config, options = {}) {
  const token = config?.token;
  if (!token) {
    return { ok: false, code: BACKUP_ERRORS.AUTH_FAILED, message: 'GitHub personal access token is required' };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? 20000;
  const filename = config.filename || DEFAULT_FILENAME;

  try {
    if (config.gistId) {
      const url = `${GITHUB_API_BASE}/gists/${encodeURIComponent(config.gistId)}`;
      const res = await executeFetchWithTimeout(
        fetchImpl,
        url,
        { method: 'GET', headers: buildHeaders(token) },
        timeoutMs,
        options.signal
      );
      if (!res.ok) return sanitize(res.error, token);
      if (!res.response.ok) {
        return sanitize(httpStatusToError(res.response.status, res.response.statusText), token);
      }

      const data = await res.response.json();
      const fileExists = Boolean(data.files && data.files[filename]);
      return sanitize({
        ok: true,
        details: {
          gistId: config.gistId,
          fileExists,
        },
      }, token);
    }

    const url = `${GITHUB_API_BASE}/user`;
    const res = await executeFetchWithTimeout(
      fetchImpl,
      url,
      { method: 'GET', headers: buildHeaders(token) },
      timeoutMs,
      options.signal
    );
    if (!res.ok) return sanitize(res.error, token);
    if (!res.response.ok) {
      return sanitize(httpStatusToError(res.response.status, res.response.statusText), token);
    }

    return sanitize({ ok: true, details: { tokenValid: true } }, token);
  } catch (err) {
    return sanitize({ ok: false, code: BACKUP_ERRORS.GENERIC, message: err?.message || 'Connection test failed' }, token);
  }
}

export async function readRemote(config, options = {}) {
  const token = config?.token;
  if (!token) {
    return { ok: false, code: BACKUP_ERRORS.AUTH_FAILED, message: 'GitHub personal access token is required' };
  }

  if (!config.gistId) {
    return { ok: true, exists: false };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? 20000;
  const filename = config.filename || DEFAULT_FILENAME;

  try {
    const url = `${GITHUB_API_BASE}/gists/${encodeURIComponent(config.gistId)}`;
    const res = await executeFetchWithTimeout(
      fetchImpl,
      url,
      { method: 'GET', headers: buildHeaders(token) },
      timeoutMs,
      options.signal
    );
    if (!res.ok) return sanitize(res.error, token);
    if (!res.response.ok) {
      return sanitize(httpStatusToError(res.response.status, res.response.statusText), token);
    }

    const data = await res.response.json();
    const file = data.files?.[filename];
    if (!file) {
      return sanitize({ ok: true, exists: false }, token);
    }

    let text;
    if (file.truncated) {
      if (!file.raw_url) {
        return sanitize({
          ok: false,
          code: BACKUP_ERRORS.TRUNCATED,
          message: 'Gist backup content is truncated. Consider using WebDAV for large backups.',
        }, token);
      }

      let parsedRawUrl;
      try {
        parsedRawUrl = new URL(file.raw_url);
      } catch {
        return sanitize({
          ok: false,
          code: BACKUP_ERRORS.TRUNCATED,
          message: 'Gist raw_url is invalid. Consider using WebDAV for large backups.',
        }, token);
      }

      if (!TRUSTED_RAW_HOSTS.has(parsedRawUrl.hostname)) {
        return sanitize({
          ok: false,
          code: BACKUP_ERRORS.TRUNCATED,
          message: 'Gist content is truncated and raw host is not trusted. Consider using WebDAV for large backups.',
        }, token);
      }

      // Raw content download must NOT include the Authorization header to avoid token leakage.
      const rawRes = await executeFetchWithTimeout(
        fetchImpl,
        file.raw_url,
        {
          method: 'GET',
          headers: { Accept: 'text/plain' },
        },
        timeoutMs,
        options.signal
      );
      if (!rawRes.ok) return sanitize(rawRes.error, token);
      if (!rawRes.response.ok) {
        return sanitize(httpStatusToError(rawRes.response.status, rawRes.response.statusText), token);
      }
      text = await rawRes.response.text();
    } else {
      text = file.content;
    }

    const digest = await computeSha256(text);
    return sanitize({
      ok: true,
      exists: true,
      text,
      version: data.updated_at,
      digest,
      updatedAt: data.updated_at,
    }, token);
  } catch (err) {
    return sanitize({ ok: false, code: BACKUP_ERRORS.GENERIC, message: err?.message || 'Failed to read remote Gist' }, token);
  }
}

export async function writeRemote(config, content, options = {}) {
  const token = config?.token;
  if (!token) {
    return { ok: false, code: BACKUP_ERRORS.AUTH_FAILED, message: 'GitHub personal access token is required' };
  }

  if (!content || typeof content.text !== 'string') {
    return { ok: false, code: BACKUP_ERRORS.GENERIC, message: 'Invalid backup content' };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? 20000;
  const force = Boolean(options.force);
  const filename = config.filename || DEFAULT_FILENAME;

  try {
    const digest = await computeSha256(content.text);

    // If no gistId is configured, create a new private gist.
    if (!config.gistId) {
      const url = `${GITHUB_API_BASE}/gists`;
      const body = JSON.stringify({
        description: 'Marks Local backup',
        public: false,
        files: {
          [filename]: {
            content: content.text,
          },
        },
      });

      const res = await executeFetchWithTimeout(
        fetchImpl,
        url,
        {
          method: 'POST',
          headers: buildHeaders(token),
          body,
        },
        timeoutMs,
        options.signal
      );
      if (!res.ok) return sanitize(res.error, token);
      if (!res.response.ok) {
        return sanitize(httpStatusToError(res.response.status, res.response.statusText), token);
      }

      const created = await res.response.json();
      return sanitize({
        ok: true,
        version: created.updated_at,
        digest,
        details: {
          gistId: created.id,
        },
      }, token);
    }

    // Existing gistId: verify version when force is false before sending any PATCH request.
    if (!force) {
      const remote = await readRemote(config, options);
      if (!remote.ok) {
        return sanitize(remote, token);
      }
      if (remote.exists) {
        if (!options.expectedVersion) {
          return sanitize({
            ok: false,
            code: BACKUP_ERRORS.CONFLICT,
            message: 'Remote backup already exists on Gist',
          }, token);
        }
        if (options.expectedVersion !== remote.version) {
          return sanitize({
            ok: false,
            code: BACKUP_ERRORS.CONFLICT,
            message: `Remote version mismatch: expected ${options.expectedVersion}, found ${remote.version}`,
          }, token);
        }
      }
    }

    const patchUrl = `${GITHUB_API_BASE}/gists/${encodeURIComponent(config.gistId)}`;
    const patchBody = JSON.stringify({
      files: {
        [filename]: {
          content: content.text,
        },
      },
    });

    const res = await executeFetchWithTimeout(
      fetchImpl,
      patchUrl,
      {
        method: 'PATCH',
        headers: buildHeaders(token),
        body: patchBody,
      },
      timeoutMs,
      options.signal
    );
    if (!res.ok) return sanitize(res.error, token);
    if (!res.response.ok) {
      return sanitize(httpStatusToError(res.response.status, res.response.statusText), token);
    }

    const updated = await res.response.json();
    return sanitize({
      ok: true,
      version: updated.updated_at,
      digest,
    }, token);
  } catch (err) {
    return sanitize({ ok: false, code: BACKUP_ERRORS.GENERIC, message: err?.message || 'Failed to write remote Gist' }, token);
  }
}
