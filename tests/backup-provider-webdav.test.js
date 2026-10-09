import { jest } from '@jest/globals';
import {
  PROVIDER_ID,
  testConnection,
  readRemote,
  writeRemote,
} from '../background/backup-providers/webdav.js';
import { BACKUP_ERRORS, computeSha256 } from '../background/backup-providers/errors.js';

function createMockResponse({ status = 200, statusText = 'OK', body = '', headers = {} }) {
  const headerMap = new Map();
  for (const [key, value] of Object.entries(headers)) {
    headerMap.set(key.toLowerCase(), value);
  }
  return {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => headerMap.get(name.toLowerCase()) ?? null,
      has: (name) => headerMap.has(name.toLowerCase()),
    },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('backup-provider-webdav', () => {
  const targetHttpsUrl = 'https://dav.example.com/remote.php/webdav/backups/backup.json';
  const sampleText = JSON.stringify({
    format: 'marks-local-backup',
    version: 1,
    createdAt: '2026-10-09T00:00:00.000Z',
    ciphertext: 'encryptedDataPayload',
  });

  it('exports PROVIDER_ID as webdav', () => {
    expect(PROVIDER_ID).toBe('webdav');
  });

  describe('transport security & URL validation', () => {
    it('refuses insecure http: URLs when allowInsecureHttp is not set', async () => {
      const res = await testConnection({ url: 'http://dav.example.com/backup.json' });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.INSECURE_HTTP_BLOCKED);
    });

    it('refuses http://localhost, 127.0.0.1 and [::1] when allowInsecureHttp is false', async () => {
      const hosts = ['http://localhost/backup.json', 'http://127.0.0.1:8080/backup.json', 'http://[::1]/backup.json'];
      for (const url of hosts) {
        const res = await testConnection({ url, allowInsecureHttp: false });
        expect(res.ok).toBe(false);
        expect(res.code).toBe(BACKUP_ERRORS.INSECURE_HTTP_BLOCKED);
      }
    });

    it('allows http: URLs when allowInsecureHttp is true', async () => {
      const fetchImpl = async () => createMockResponse({ status: 200 });
      const res = await testConnection(
        { url: 'http://localhost:8080/backup.json', allowInsecureHttp: true },
        { fetchImpl }
      );
      expect(res.ok).toBe(true);
    });

    it('rejects invalid URL format', async () => {
      const res = await testConnection({ url: 'not-a-valid-url' });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.INVALID_FORMAT);
    });

    it('rejects missing URL as not configured', async () => {
      const res = await testConnection({});
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.NOT_CONFIGURED);
    });
  });

  describe('authentication & basic auth header', () => {
    it('builds Authorization: Basic header when username and password are provided', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        return createMockResponse({ status: 200 });
      };

      await testConnection(
        { url: targetHttpsUrl, username: 'alice', password: 'secret:password' },
        { fetchImpl }
      );

      expect(calls).toHaveLength(1);
      const expectedBasic = Buffer.from('alice:secret:password').toString('base64');
      expect(calls[0].opts.headers.Authorization).toBe(`Basic ${expectedBasic}`);
    });

    it('omits Authorization header entirely when both username and password are empty', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        return createMockResponse({ status: 200 });
      };

      await testConnection({ url: targetHttpsUrl, username: '', password: '' }, { fetchImpl });
      expect(calls).toHaveLength(1);
      expect(calls[0].opts.headers.Authorization).toBeUndefined();
    });
  });

  describe('redirect handling & cross-host credential protection', () => {
    it('stops cross-host redirect returning backup_cross_host_redirect without leaking credentials', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        return createMockResponse({
          status: 302,
          headers: { location: 'https://attacker.evil.com/dav/backup.json' },
        });
      };

      const res = await testConnection(
        { url: targetHttpsUrl, username: 'alice', password: 'secretpassword' },
        { fetchImpl }
      );

      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.CROSS_HOST_REDIRECT);
      // Execution stopped before re-sending: attacker host never contacted, credentials never leaked
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(targetHttpsUrl);
    });

    it('follows same-origin redirect and keeps Authorization header on the second request', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        if (calls.length === 1) {
          return createMockResponse({
            status: 302,
            headers: { location: 'https://dav.example.com/new-path/backup.json' },
          });
        }
        return createMockResponse({ status: 200, headers: { etag: '"etag-123"' } });
      };

      const res = await testConnection(
        { url: targetHttpsUrl, username: 'alice', password: 'secretpassword' },
        { fetchImpl }
      );

      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0].url).toBe(targetHttpsUrl);
      expect(calls[1].url).toBe('https://dav.example.com/new-path/backup.json');
      expect(calls[1].opts.headers.Authorization).toBeDefined();
      expect(calls[1].opts.headers.Authorization).toBe(calls[0].opts.headers.Authorization);
    });
  });

  describe('testConnection status mapping', () => {
    it('treats 404 as success with details.exists: false', async () => {
      const fetchImpl = async () => createMockResponse({ status: 404 });
      const res = await testConnection({ url: targetHttpsUrl }, { fetchImpl });
      expect(res.ok).toBe(true);
      expect(res.details).toEqual({ exists: false });
    });

    it('treats 2xx as success with details.exists: true', async () => {
      const fetchImpl = async () => createMockResponse({ status: 200 });
      const res = await testConnection({ url: targetHttpsUrl }, { fetchImpl });
      expect(res.ok).toBe(true);
      expect(res.details).toEqual({ exists: true });
    });

    it('maps 409 to backup_directory_missing with message advising folder creation', async () => {
      const fetchImpl = async () => createMockResponse({ status: 409 });
      const res = await testConnection({ url: targetHttpsUrl }, { fetchImpl });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.DIRECTORY_MISSING);
      expect(res.message).toMatch(/folder/i);
    });

    it('maps 401 to backup_auth_failed', async () => {
      const fetchImpl = async () => createMockResponse({ status: 401 });
      const res = await testConnection({ url: targetHttpsUrl }, { fetchImpl });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.AUTH_FAILED);
    });
  });

  describe('readRemote', () => {
    it('sends HEAD first and falls back to GET when server rejects HEAD with 405', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        if (opts.method === 'HEAD') {
          return createMockResponse({ status: 405, statusText: 'Method Not Allowed' });
        }
        return createMockResponse({
          status: 200,
          body: sampleText,
          headers: {
            etag: '"etag-webdav-123"',
            'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
          },
        });
      };

      const res = await readRemote({ url: targetHttpsUrl }, { fetchImpl });
      expect(res.ok).toBe(true);
      expect(res.exists).toBe(true);
      expect(res.text).toBe(sampleText);
      expect(res.version).toBe('"etag-webdav-123"');
      expect(res.updatedAt).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
      expect(res.digest).toBe(await computeSha256(sampleText));

      expect(calls).toHaveLength(2);
      expect(calls[0].opts.method).toBe('HEAD');
      expect(calls[1].opts.method).toBe('GET');
    });

    it('returns exists: false on 404 without downloading body', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        return createMockResponse({ status: 404 });
      };

      const res = await readRemote({ url: targetHttpsUrl }, { fetchImpl });
      expect(res.ok).toBe(true);
      expect(res.exists).toBe(false);
      // HEAD returned 404 directly, no need for second request
      expect(calls).toHaveLength(1);
      expect(calls[0].opts.method).toBe('HEAD');
    });

    it('maps 409 to backup_directory_missing', async () => {
      const fetchImpl = async () => createMockResponse({ status: 409 });
      const res = await readRemote({ url: targetHttpsUrl }, { fetchImpl });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.DIRECTORY_MISSING);
    });
  });

  describe('writeRemote', () => {
    it('sends PUT with Content-Type application/json; charset=utf-8', async () => {
      const calls = [];
      let uploaded = false;
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        if (opts.method === 'HEAD') {
          return uploaded
            ? createMockResponse({ status: 200, headers: { etag: '"etag-put-1"' } })
            : createMockResponse({ status: 404 });
        }
        if (opts.method === 'PUT') {
          uploaded = true;
          return createMockResponse({ status: 201, headers: { etag: '"etag-put-1"' } });
        }
        if (opts.method === 'GET') {
          return createMockResponse({
            status: 200,
            body: sampleText,
            headers: { etag: '"etag-put-1"' },
          });
        }
        return createMockResponse({ status: 200 });
      };

      const res = await writeRemote(
        { url: targetHttpsUrl },
        { text: sampleText },
        { fetchImpl }
      );

      expect(res.ok).toBe(true);
      expect(res.version).toBe('"etag-put-1"');
      expect(res.digest).toBe(await computeSha256(sampleText));

      const putCall = calls.find((c) => c.opts.method === 'PUT');
      expect(putCall).toBeDefined();
      expect(putCall.opts.headers['Content-Type']).toBe('application/json; charset=utf-8');
      expect(putCall.opts.body).toBe(sampleText);
    });

    it('detects version mismatch when force is false and asserts NO PUT request was made', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        if (opts.method === 'HEAD') {
          return createMockResponse({ status: 200, headers: { etag: '"remote-etag-v2"' } });
        }
        if (opts.method === 'GET') {
          return createMockResponse({
            status: 200,
            body: 'current-content',
            headers: { etag: '"remote-etag-v2"' },
          });
        }
        return createMockResponse({ status: 200 });
      };

      const res = await writeRemote(
        { url: targetHttpsUrl },
        { text: sampleText },
        { fetchImpl, expectedVersion: '"stale-local-etag-v1"', force: false }
      );

      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.CONFLICT);

      // Crucial requirement: assert NO PUT write request was made
      const putCalls = calls.filter((c) => c.opts.method === 'PUT');
      expect(putCalls).toHaveLength(0);
    });

    it('returns backup_conflict when remote exists and expectedVersion is absent without force', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        if (opts.method === 'HEAD') {
          return createMockResponse({ status: 200, headers: { etag: '"v1"' } });
        }
        if (opts.method === 'GET') {
          return createMockResponse({ status: 200, body: 'existing', headers: { etag: '"v1"' } });
        }
        return createMockResponse({ status: 200 });
      };

      const res = await writeRemote(
        { url: targetHttpsUrl },
        { text: sampleText },
        { fetchImpl, force: false }
      );

      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.CONFLICT);
      expect(calls.filter((c) => c.opts.method === 'PUT')).toHaveLength(0);
    });

    it('sends If-Match header when expectedVersion is provided', async () => {
      const calls = [];
      let updated = false;
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        if (opts.method === 'HEAD') {
          return createMockResponse({ status: 200, headers: { etag: updated ? '"v2"' : '"v1"' } });
        }
        if (opts.method === 'GET') {
          return createMockResponse({ status: 200, body: sampleText, headers: { etag: updated ? '"v2"' : '"v1"' } });
        }
        if (opts.method === 'PUT') {
          updated = true;
          return createMockResponse({ status: 204, headers: { etag: '"v2"' } });
        }
        return createMockResponse({ status: 200 });
      };

      const res = await writeRemote(
        { url: targetHttpsUrl },
        { text: sampleText },
        { fetchImpl, expectedVersion: '"v1"' }
      );

      expect(res.ok).toBe(true);
      const putCall = calls.find((c) => c.opts.method === 'PUT');
      expect(putCall.opts.headers['If-Match']).toBe('"v1"');
    });

    it('maps PUT 412 pre-condition failed to backup_conflict', async () => {
      const fetchImpl = async (url, opts) => {
        if (opts.method === 'HEAD') {
          return createMockResponse({ status: 200, headers: { etag: '"v1"' } });
        }
        if (opts.method === 'GET') {
          return createMockResponse({ status: 200, body: 'content', headers: { etag: '"v1"' } });
        }
        if (opts.method === 'PUT') {
          return createMockResponse({ status: 412, statusText: 'Precondition Failed' });
        }
        return createMockResponse({ status: 200 });
      };

      const res = await writeRemote(
        { url: targetHttpsUrl },
        { text: sampleText },
        { fetchImpl, expectedVersion: '"v1"' }
      );

      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.CONFLICT);
    });

    it('fails when follow-up read after successful PUT disagrees with written digest', async () => {
      const fetchImpl = async (url, opts) => {
        if (opts.method === 'HEAD') {
          return createMockResponse({ status: 404 });
        }
        if (opts.method === 'PUT') {
          return createMockResponse({ status: 200 });
        }
        if (opts.method === 'GET') {
          // Disagreeing text returned by the server
          return createMockResponse({ status: 200, body: 'corrupted-or-partial-content', headers: { etag: '"v1"' } });
        }
        return createMockResponse({ status: 200 });
      };

      const res = await writeRemote(
        { url: targetHttpsUrl },
        { text: sampleText },
        { fetchImpl }
      );

      // Must fail, not succeed, because 2xx alone is not proof the backup is restorable
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.GENERIC);
      expect(res.message).toBe('Upload could not be verified');
    });

    it('fails when follow-up read ETag disagrees with ETag returned by PUT response', async () => {
      const fetchImpl = async (url, opts) => {
        if (opts.method === 'HEAD') {
          return createMockResponse({ status: 404 });
        }
        if (opts.method === 'PUT') {
          return createMockResponse({ status: 200, headers: { etag: '"server-etag-put"' } });
        }
        if (opts.method === 'GET') {
          return createMockResponse({ status: 200, body: sampleText, headers: { etag: '"different-etag-get"' } });
        }
        return createMockResponse({ status: 200 });
      };

      const res = await writeRemote(
        { url: targetHttpsUrl },
        { text: sampleText },
        { fetchImpl }
      );

      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.GENERIC);
      expect(res.message).toBe('Upload could not be verified');
    });
  });

  describe('network, timeout and TLS failures', () => {
    it('maps fetch rejection to backup_network', async () => {
      const fetchImpl = async () => {
        throw new Error('Connection refused');
      };
      const res = await testConnection({ url: targetHttpsUrl }, { fetchImpl });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.NETWORK);
    });

    it('maps aborted fetch to backup_timeout', async () => {
      const fetchImpl = async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      };
      const res = await testConnection({ url: targetHttpsUrl }, { fetchImpl });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.TIMEOUT);
    });

    it('maps TLS certificate failure to backup_tls', async () => {
      const fetchImpl = async () => {
        const err = new Error('DEPTH_ZERO_SELF_SIGNED_CERT: self signed certificate');
        err.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
        throw err;
      };
      const res = await testConnection({ url: targetHttpsUrl }, { fetchImpl });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.TLS);
    });
  });
});
