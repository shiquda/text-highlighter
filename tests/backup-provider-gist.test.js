import { jest } from '@jest/globals';
import {
  PROVIDER_ID,
  testConnection,
  readRemote,
  writeRemote,
} from '../background/backup-providers/gist.js';
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

describe('backup-provider-gist', () => {
  const sampleToken = 'ghp_secretToken1234567890abcdef';
  const sampleText = JSON.stringify({
    format: 'marks-local-backup',
    version: 1,
    createdAt: '2026-10-09T00:00:00.000Z',
    ciphertext: 'encryptedDataPayload',
  });

  it('exports PROVIDER_ID as gist', () => {
    expect(PROVIDER_ID).toBe('gist');
  });

  describe('configuration & security guards', () => {
    it('returns backup_auth_failed when token is missing', async () => {
      const res = await testConnection({ gistId: 'g123' });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.AUTH_FAILED);
    });

    it('never leaks token in message or details', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        return createMockResponse({
          status: 401,
          statusText: `Unauthorized for token ${sampleToken}`,
          body: { message: `Bad credentials with token ${sampleToken}` },
        });
      };

      const res = await testConnection({ token: sampleToken, gistId: 'g123' }, { fetchImpl });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.AUTH_FAILED);
      expect(res.message).not.toContain(sampleToken);
      if (res.details) {
        expect(JSON.stringify(res.details)).not.toContain(sampleToken);
      }
    });
  });

  describe('testConnection', () => {
    it('validates token via /user when gistId is not provided', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        return createMockResponse({ status: 200, body: { login: 'octocat' } });
      };

      const res = await testConnection({ token: sampleToken }, { fetchImpl });
      expect(res.ok).toBe(true);
      expect(res.details).toEqual({ tokenValid: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.github.com/user');
      expect(calls[0].opts.headers.Authorization).toBe(`Bearer ${sampleToken}`);
      expect(calls[0].opts.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    });

    it('checks gist existence and backup file presence when gistId is provided', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        return createMockResponse({
          status: 200,
          body: {
            id: 'g123',
            files: {
              'marks-local-backup.json': { content: sampleText },
            },
          },
        });
      };

      const res = await testConnection({ token: sampleToken, gistId: 'g123' }, { fetchImpl });
      expect(res.ok).toBe(true);
      expect(res.details).toEqual({ gistId: 'g123', fileExists: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.github.com/gists/g123');
    });

    it('maps 401 to backup_auth_failed', async () => {
      const fetchImpl = async () => createMockResponse({ status: 401 });
      const res = await testConnection({ token: sampleToken }, { fetchImpl });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.AUTH_FAILED);
    });

    it('maps 404 on gist to backup_not_found', async () => {
      const fetchImpl = async () => createMockResponse({ status: 404 });
      const res = await testConnection({ token: sampleToken, gistId: 'nonexistent' }, { fetchImpl });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.NOT_FOUND);
    });
  });

  describe('readRemote', () => {
    it('returns exists: false when gistId is not set', async () => {
      const res = await readRemote({ token: sampleToken });
      expect(res.ok).toBe(true);
      expect(res.exists).toBe(false);
    });

    it('reads non-truncated gist and returns SHA-256 digest', async () => {
      const expectedDigest = await computeSha256(sampleText);
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        return createMockResponse({
          status: 200,
          body: {
            id: 'g123',
            updated_at: '2026-10-09T01:00:00Z',
            files: {
              'marks-local-backup.json': {
                filename: 'marks-local-backup.json',
                truncated: false,
                content: sampleText,
              },
            },
          },
        });
      };

      const res = await readRemote({ token: sampleToken, gistId: 'g123' }, { fetchImpl });
      expect(res.ok).toBe(true);
      expect(res.exists).toBe(true);
      expect(res.text).toBe(sampleText);
      expect(res.version).toBe('2026-10-09T01:00:00Z');
      expect(res.updatedAt).toBe('2026-10-09T01:00:00Z');
      expect(res.digest).toBe(expectedDigest);
      expect(calls).toHaveLength(1);
    });

    it('returns exists: false when file is absent from gist files', async () => {
      const fetchImpl = async () => createMockResponse({
        status: 200,
        body: {
          id: 'g123',
          updated_at: '2026-10-09T01:00:00Z',
          files: {
            'other-file.txt': { content: 'other' },
          },
        },
      });

      const res = await readRemote({ token: sampleToken, gistId: 'g123' }, { fetchImpl });
      expect(res.ok).toBe(true);
      expect(res.exists).toBe(false);
    });

    it('handles truncated: true by fetching raw_url without Authorization header from trusted host', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        if (calls.length === 1) {
          return createMockResponse({
            status: 200,
            body: {
              id: 'g123',
              updated_at: '2026-10-09T01:00:00Z',
              files: {
                'marks-local-backup.json': {
                  filename: 'marks-local-backup.json',
                  truncated: true,
                  raw_url: 'https://gist.githubusercontent.com/user/g123/raw/marks-local-backup.json',
                },
              },
            },
          });
        }
        return createMockResponse({
          status: 200,
          body: sampleText,
        });
      };

      const res = await readRemote({ token: sampleToken, gistId: 'g123' }, { fetchImpl });
      expect(res.ok).toBe(true);
      expect(res.exists).toBe(true);
      expect(res.text).toBe(sampleText);
      expect(calls).toHaveLength(2);
      expect(calls[0].opts.headers.Authorization).toBe(`Bearer ${sampleToken}`);
      // The second request to the raw URL MUST NOT carry the Authorization header
      expect(calls[1].opts.headers.Authorization).toBeUndefined();
    });

    it('returns backup_truncated when raw_url host is not trusted', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        return createMockResponse({
          status: 200,
          body: {
            id: 'g123',
            updated_at: '2026-10-09T01:00:00Z',
            files: {
              'marks-local-backup.json': {
                filename: 'marks-local-backup.json',
                truncated: true,
                raw_url: 'https://evil-untrusted-server.com/raw/backup.json',
              },
            },
          },
        });
      };

      const res = await readRemote({ token: sampleToken, gistId: 'g123' }, { fetchImpl });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.TRUNCATED);
      expect(res.message).toMatch(/WebDAV/i);
      // Ensure the untrusted host was NOT contacted
      expect(calls).toHaveLength(1);
    });

    it('returns backup_truncated when truncated is true but raw_url is missing', async () => {
      const fetchImpl = async () => createMockResponse({
        status: 200,
        body: {
          id: 'g123',
          updated_at: '2026-10-09T01:00:00Z',
          files: {
            'marks-local-backup.json': {
              truncated: true,
            },
          },
        },
      });

      const res = await readRemote({ token: sampleToken, gistId: 'g123' }, { fetchImpl });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.TRUNCATED);
    });
  });

  describe('writeRemote', () => {
    it('creates new gist via POST when gistId is not provided', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        return createMockResponse({
          status: 201,
          body: {
            id: 'new-gist-456',
            updated_at: '2026-10-09T02:00:00Z',
          },
        });
      };

      const res = await writeRemote(
        { token: sampleToken },
        { text: sampleText },
        { fetchImpl }
      );

      expect(res.ok).toBe(true);
      expect(res.details).toEqual({ gistId: 'new-gist-456' });
      expect(res.version).toBe('2026-10-09T02:00:00Z');
      expect(res.digest).toBe(await computeSha256(sampleText));
      expect(calls).toHaveLength(1);
      expect(calls[0].opts.method).toBe('POST');
      expect(calls[0].url).toBe('https://api.github.com/gists');

      const parsedBody = JSON.parse(calls[0].opts.body);
      expect(parsedBody.public).toBe(false);
      expect(parsedBody.description).toBe('Marks Local backup');
      expect(parsedBody.files['marks-local-backup.json'].content).toBe(sampleText);
    });

    it('updates existing gist via PATCH touching only the one file', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        if (opts.method === 'GET') {
          return createMockResponse({
            status: 200,
            body: {
              id: 'g123',
              updated_at: 'v1',
              files: {
                'marks-local-backup.json': { content: 'old' },
                'unrelated-notes.txt': { content: 'keep this untouched' },
              },
            },
          });
        }
        return createMockResponse({
          status: 200,
          body: {
            id: 'g123',
            updated_at: 'v2',
          },
        });
      };

      const res = await writeRemote(
        { token: sampleToken, gistId: 'g123' },
        { text: sampleText },
        { fetchImpl, expectedVersion: 'v1' }
      );

      expect(res.ok).toBe(true);
      expect(res.version).toBe('v2');
      expect(calls).toHaveLength(2);
      expect(calls[0].opts.method).toBe('GET');
      expect(calls[1].opts.method).toBe('PATCH');

      const patchBody = JSON.parse(calls[1].opts.body);
      expect(Object.keys(patchBody.files)).toEqual(['marks-local-backup.json']);
      expect(patchBody.files['marks-local-backup.json'].content).toBe(sampleText);
    });

    it('detects version mismatch when force is false and asserts NO write request was made', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        return createMockResponse({
          status: 200,
          body: {
            id: 'g123',
            updated_at: 'v-actual-remote',
            files: {
              'marks-local-backup.json': { content: 'old' },
            },
          },
        });
      };

      const res = await writeRemote(
        { token: sampleToken, gistId: 'g123' },
        { text: sampleText },
        { fetchImpl, expectedVersion: 'v-stale-local', force: false }
      );

      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.CONFLICT);

      // Crucial requirement: assert NO write request (PATCH/POST) was made
      const writeCalls = calls.filter((c) => c.opts.method === 'PATCH' || c.opts.method === 'POST');
      expect(writeCalls).toHaveLength(0);
    });

    it('returns backup_conflict when remote exists and expectedVersion is absent without force', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        return createMockResponse({
          status: 200,
          body: {
            id: 'g123',
            updated_at: 'v1',
            files: {
              'marks-local-backup.json': { content: 'existing' },
            },
          },
        });
      };

      const res = await writeRemote(
        { token: sampleToken, gistId: 'g123' },
        { text: sampleText },
        { fetchImpl, force: false }
      );

      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.CONFLICT);
      expect(calls.filter((c) => c.opts.method === 'PATCH')).toHaveLength(0);
    });

    it('overwrites remote when force is true even on version mismatch', async () => {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        return createMockResponse({
          status: 200,
          body: {
            id: 'g123',
            updated_at: 'v-forced',
          },
        });
      };

      const res = await writeRemote(
        { token: sampleToken, gistId: 'g123' },
        { text: sampleText },
        { fetchImpl, expectedVersion: 'v-mismatch', force: true }
      );

      expect(res.ok).toBe(true);
      expect(res.version).toBe('v-forced');
      expect(calls).toHaveLength(1);
      expect(calls[0].opts.method).toBe('PATCH');
    });
  });

  describe('network & timeout handling', () => {
    it('maps network fetch rejection to backup_network', async () => {
      const fetchImpl = async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com');
      };
      const res = await testConnection({ token: sampleToken }, { fetchImpl });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.NETWORK);
    });

    it('maps aborted fetch to backup_timeout', async () => {
      const fetchImpl = async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      };
      const res = await testConnection({ token: sampleToken }, { fetchImpl });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(BACKUP_ERRORS.TIMEOUT);
    });
  });
});
