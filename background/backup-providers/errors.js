export const BACKUP_ERRORS = {
  NOT_CONFIGURED: 'backup_not_configured',
  NO_RECOVERY_CODE: 'backup_no_recovery_code',
  AUTH_FAILED: 'backup_auth_failed',
  FORBIDDEN: 'backup_forbidden',
  NOT_FOUND: 'backup_not_found',
  CONFLICT: 'backup_conflict',
  CONFIRM_REQUIRED: 'backup_confirm_required',
  DIRECTORY_MISSING: 'backup_directory_missing',
  TOO_LARGE: 'backup_too_large',
  RATE_LIMITED: 'backup_rate_limited',
  SERVER_ERROR: 'backup_server_error',
  NETWORK: 'backup_network',
  TIMEOUT: 'backup_timeout',
  TLS: 'backup_tls',
  INSECURE_TRANSPORT: 'backup_insecure_transport',
  CROSS_HOST_REDIRECT: 'backup_cross_host_redirect',
  TRUNCATED: 'backup_truncated',
  DECRYPT_FAILED: 'backup_decrypt_failed',
  INVALID_FORMAT: 'backup_invalid_format',
  UNSUPPORTED_VERSION: 'backup_unsupported_version',
  INSECURE_HTTP_BLOCKED: 'backup_insecure_http_blocked',
  DOWNLOAD_FAILED: 'backup_download_failed',
  SAFETY_SNAPSHOT_FAILED: 'backup_safety_snapshot_failed',
  STORAGE_ERROR: 'backup_storage_error',
  GENERIC: 'backup_generic',
};

export function httpStatusToError(status, statusText) {
  if (status === 401) {
    return { ok: false, code: BACKUP_ERRORS.AUTH_FAILED, message: 'Authentication failed' };
  }
  if (status === 403) {
    return { ok: false, code: BACKUP_ERRORS.FORBIDDEN, message: 'Access forbidden' };
  }
  if (status === 404) {
    return { ok: false, code: BACKUP_ERRORS.NOT_FOUND, message: 'Remote resource not found' };
  }
  if (status === 409) {
    return {
      ok: false,
      code: BACKUP_ERRORS.DIRECTORY_MISSING,
      message: 'Parent directory does not exist. Please create the folder on the server.',
    };
  }
  if (status === 412) {
    return { ok: false, code: BACKUP_ERRORS.CONFLICT, message: 'Remote backup conflict' };
  }
  if (status === 413 || status === 507) {
    return { ok: false, code: BACKUP_ERRORS.TOO_LARGE, message: 'Backup payload is too large for the remote server' };
  }
  if (status === 429) {
    return { ok: false, code: BACKUP_ERRORS.RATE_LIMITED, message: 'Rate limit exceeded' };
  }
  if (status >= 500 && status <= 599) {
    return { ok: false, code: BACKUP_ERRORS.SERVER_ERROR, message: `Remote server error (${status})` };
  }
  return { ok: false, code: BACKUP_ERRORS.GENERIC, message: statusText || `HTTP request failed (${status})` };
}

export function isTlsError(error) {
  if (!error) return false;
  const combined = [
    error.message,
    error.code,
    error.name,
    error.cause?.code,
    error.cause?.message,
  ].filter(Boolean).join(' ');
  return /certificate|cert_|self[ -]?signed|tls|ssl|handshake|depth_zero|unable_to_verify/i.test(combined);
}

export function isTimeoutOrAbortError(error) {
  if (!error) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const msg = error.message || '';
  return /abort|timeout|timed out/i.test(msg);
}

export function networkErrorToBackupError(error) {
  if (isTimeoutOrAbortError(error)) {
    return { ok: false, code: BACKUP_ERRORS.TIMEOUT, message: 'Request timed out' };
  }
  if (isTlsError(error)) {
    return { ok: false, code: BACKUP_ERRORS.TLS, message: 'TLS/SSL certificate verification failed' };
  }
  return { ok: false, code: BACKUP_ERRORS.NETWORK, message: error?.message || 'Network request failed' };
}

export async function computeSha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function executeFetchWithTimeout(fetchImpl, url, fetchOptions, timeoutMs = 20000, callerSignal) {
  const controller = new AbortController();
  let timeoutId = null;
  let didTimeout = false;

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
    }, timeoutMs);
  }

  let callerAbortHandler = null;
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerAbortHandler = () => controller.abort(callerSignal.reason);
      callerSignal.addEventListener('abort', callerAbortHandler, { once: true });
    }
  }

  try {
    const res = await fetchImpl(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return { ok: true, response: res };
  } catch (err) {
    if (didTimeout) {
      return { ok: false, error: { ok: false, code: BACKUP_ERRORS.TIMEOUT, message: 'Request timed out' } };
    }
    return { ok: false, error: networkErrorToBackupError(err) };
  } finally {
    clearTimeout(timeoutId);
    if (callerSignal && callerAbortHandler) {
      callerSignal.removeEventListener('abort', callerAbortHandler);
    }
  }
}
