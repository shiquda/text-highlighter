import {
  BACKUP_ERRORS,
  computeSha256,
  executeFetchWithTimeout,
  httpStatusToError,
  networkErrorToBackupError,
} from './errors.js';

export const PROVIDER_ID = 'webdav';

function validateWebdavUrl(config) {
  if (!config?.url) {
    return { ok: false, code: BACKUP_ERRORS.NOT_CONFIGURED, message: 'WebDAV URL is required' };
  }
  let parsed;
  try {
    parsed = new URL(config.url);
  } catch {
    return { ok: false, code: BACKUP_ERRORS.INVALID_FORMAT, message: 'Invalid WebDAV URL' };
  }
  if (parsed.protocol === 'http:') {
    if (!config.allowInsecureHttp) {
      return {
        ok: false,
        code: BACKUP_ERRORS.INSECURE_HTTP_BLOCKED,
        message: 'Insecure HTTP WebDAV URLs are blocked',
      };
    }
  } else if (parsed.protocol !== 'https:') {
    return { ok: false, code: BACKUP_ERRORS.INVALID_FORMAT, message: 'Unsupported URL protocol' };
  }
  return { ok: true, url: parsed };
}

function buildBasicAuth(username, password) {
  if (!username && !password) return null;
  const user = username || '';
  const pass = password || '';
  if (typeof Buffer !== 'undefined') {
    return `Basic ${Buffer.from(`${user}:${pass}`, 'utf-8').toString('base64')}`;
  }
  return `Basic ${btoa(unescape(encodeURIComponent(`${user}:${pass}`)))}`;
}

async function executeWebdavRequest(initialUrl, config, options, initialMethod, body, extraHeaders = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? 20000;
  let currentUrl = initialUrl;
  let method = initialMethod;

  const authHeader = buildBasicAuth(config.username, config.password);

  let redirectCount = 0;
  const maxRedirects = 5;

  while (true) {
    const headers = { ...extraHeaders };
    if (authHeader) {
      headers.Authorization = authHeader;
    }

    const fetchOpts = {
      method,
      headers,
      redirect: 'manual',
    };
    if (body !== undefined && body !== null) {
      fetchOpts.body = body;
    }

    let execResult;
    try {
      execResult = await executeFetchWithTimeout(fetchImpl, currentUrl, fetchOpts, timeoutMs, options.signal);
    } catch (err) {
      return networkErrorToBackupError(err);
    }
    if (!execResult.ok) {
      return execResult.error;
    }

    const res = execResult.response;

    // Follow redirects manually to protect credentials from cross-host leaks.
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) {
        return { ok: false, code: BACKUP_ERRORS.GENERIC, message: 'Redirect missing Location header' };
      }

      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        return { ok: false, code: BACKUP_ERRORS.GENERIC, message: 'Invalid redirect Location header' };
      }

      redirectCount++;
      if (redirectCount > maxRedirects) {
        return { ok: false, code: BACKUP_ERRORS.GENERIC, message: 'Too many redirects' };
      }

      const currentUrlObj = new URL(currentUrl);
      if (
        nextUrl.protocol !== currentUrlObj.protocol ||
        nextUrl.hostname !== currentUrlObj.hostname ||
        nextUrl.port !== currentUrlObj.port
      ) {
        return {
          ok: false,
          code: BACKUP_ERRORS.CROSS_HOST_REDIRECT,
          message: 'Cross-host redirect blocked to protect credentials',
        };
      }

      // 303 See Other changes method to GET.
      if (res.status === 303) {
        method = 'GET';
        body = undefined;
        delete extraHeaders['Content-Type'];
      }

      currentUrl = nextUrl.href;
      continue;
    }

    return { ok: true, response: res };
  }
}

export async function testConnection(config, options = {}) {
  const urlCheck = validateWebdavUrl(config);
  if (!urlCheck.ok) return urlCheck;

  try {
    let res = await executeWebdavRequest(config.url, config, options, 'HEAD');
    if (!res.ok) return res;

    // Fall back to GET if the server does not support HEAD.
    if (res.response.status === 405 || res.response.status === 501) {
      res = await executeWebdavRequest(config.url, config, options, 'GET');
      if (!res.ok) return res;
    }

    const status = res.response.status;
    if (status === 404) {
      return { ok: true, details: { exists: false } };
    }
    if (status === 409) {
      return {
        ok: false,
        code: BACKUP_ERRORS.DIRECTORY_MISSING,
        message: 'Parent directory does not exist. Please create the folder on your WebDAV server.',
      };
    }
    if (status >= 200 && status < 300) {
      return { ok: true, details: { exists: true } };
    }

    return httpStatusToError(status, res.response.statusText);
  } catch (err) {
    return { ok: false, code: BACKUP_ERRORS.GENERIC, message: err?.message || 'Connection test failed' };
  }
}

export async function readRemote(config, options = {}) {
  const urlCheck = validateWebdavUrl(config);
  if (!urlCheck.ok) return urlCheck;

  try {
    // Send HEAD first for ETag and fast 404 detection.
    let headRes = await executeWebdavRequest(config.url, config, options, 'HEAD');
    if (!headRes.ok) return headRes;

    const headStatus = headRes.response.status;
    if (headStatus === 404) {
      return { ok: true, exists: false };
    }
    if (headStatus === 409) {
      return {
        ok: false,
        code: BACKUP_ERRORS.DIRECTORY_MISSING,
        message: 'Parent directory does not exist. Please create the folder on your WebDAV server.',
      };
    }
    if (headStatus !== 405 && headStatus !== 501 && (headStatus < 200 || headStatus >= 300)) {
      return httpStatusToError(headStatus, headRes.response.statusText);
    }

    // Fall back or proceed to GET for the file content.
    const getRes = await executeWebdavRequest(config.url, config, options, 'GET');
    if (!getRes.ok) return getRes;

    const getStatus = getRes.response.status;
    if (getStatus === 404) {
      return { ok: true, exists: false };
    }
    if (getStatus === 409) {
      return {
        ok: false,
        code: BACKUP_ERRORS.DIRECTORY_MISSING,
        message: 'Parent directory does not exist. Please create the folder on your WebDAV server.',
      };
    }
    if (getStatus < 200 || getStatus >= 300) {
      return httpStatusToError(getStatus, getRes.response.statusText);
    }

    const text = await getRes.response.text();
    const digest = await computeSha256(text);
    const version = getRes.response.headers.get('etag') || (headStatus >= 200 && headStatus < 300 ? headRes.response.headers.get('etag') : '') || '';
    const updatedAt = getRes.response.headers.get('last-modified') || (headStatus >= 200 && headStatus < 300 ? headRes.response.headers.get('last-modified') : '') || '';

    return {
      ok: true,
      exists: true,
      text,
      version,
      digest,
      updatedAt,
    };
  } catch (err) {
    return { ok: false, code: BACKUP_ERRORS.GENERIC, message: err?.message || 'Failed to read remote WebDAV' };
  }
}

export async function writeRemote(config, content, options = {}) {
  const urlCheck = validateWebdavUrl(config);
  if (!urlCheck.ok) return urlCheck;

  if (!content || typeof content.text !== 'string') {
    return { ok: false, code: BACKUP_ERRORS.GENERIC, message: 'Invalid backup content' };
  }

  const force = Boolean(options.force);

  try {
    const digest = await computeSha256(content.text);
    let remoteVersion = null;

    // Verify remote version before sending any PUT request when force is false.
    if (!force) {
      const remote = await readRemote(config, options);
      if (!remote.ok) {
        return remote;
      }
      if (remote.exists) {
        if (!options.expectedVersion) {
          return {
            ok: false,
            code: BACKUP_ERRORS.CONFLICT,
            message: 'Remote backup already exists on WebDAV server',
          };
        }
        if (options.expectedVersion !== remote.version) {
          return {
            ok: false,
            code: BACKUP_ERRORS.CONFLICT,
            message: `Remote version mismatch: expected ${options.expectedVersion}, found ${remote.version}`,
          };
        }
        remoteVersion = remote.version;
      }
    }

    const putHeaders = {
      'Content-Type': 'application/json; charset=utf-8',
    };
    const matchEtag = options.expectedVersion || remoteVersion;
    if (matchEtag && !force) {
      putHeaders['If-Match'] = matchEtag;
    }

    const putResult = await executeWebdavRequest(
      config.url,
      config,
      options,
      'PUT',
      content.text,
      putHeaders
    );
    if (!putResult.ok) return putResult;

    const putStatus = putResult.response.status;
    if (putStatus === 412) {
      return { ok: false, code: BACKUP_ERRORS.CONFLICT, message: 'Remote conflict: pre-condition failed (412)' };
    }
    if (putStatus < 200 || putStatus >= 300) {
      return httpStatusToError(putStatus, putResult.response.statusText);
    }

    const putEtag = putResult.response.headers.get('etag');

    // A 2xx alone is not proof of durability; re-read and compare digest to ensure restorable backup.
    const verifyResult = await readRemote(config, options);
    if (!verifyResult.ok || !verifyResult.exists) {
      return { ok: false, code: BACKUP_ERRORS.GENERIC, message: 'Upload could not be verified' };
    }

    if (verifyResult.digest !== digest) {
      return { ok: false, code: BACKUP_ERRORS.GENERIC, message: 'Upload could not be verified' };
    }

    if (putEtag && verifyResult.version && putEtag !== verifyResult.version) {
      return { ok: false, code: BACKUP_ERRORS.GENERIC, message: 'Upload could not be verified' };
    }

    return {
      ok: true,
      version: verifyResult.version || putEtag || '',
      digest,
    };
  } catch (err) {
    return { ok: false, code: BACKUP_ERRORS.GENERIC, message: err?.message || 'Failed to write remote WebDAV' };
  }
}
