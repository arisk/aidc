import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureGcpSnapshot } from './gcp-snapshot.ts';

const body = '{"GCPPrefixFormatList":{"entry":[{"prefix":"9506000","gcpLength":7}]}}';
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const url = 'https://example.test/gcpprefixformatlist.json';

const fetchReturning = (text: string, status = 200) =>
  vi.fn<(url: string) => Promise<Response>>(() => Promise.resolve(new Response(text, { status })));

describe('ensureGcpSnapshot', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aidc-gcp-'));
    path = join(dir, 'nested', 'snapshot.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('downloads the file when it is missing and keeps it when the hash matches', async () => {
    const fetch = fetchReturning(body);
    await expect(ensureGcpSnapshot({ path, url, sha256: sha256(body), fetch })).resolves.toBe(
      'downloaded',
    );
    expect(fetch).toHaveBeenCalledWith(url);
    expect(readFileSync(path, 'utf8')).toBe(body);
  });

  it('does not fetch when the file is already there with the pinned hash', async () => {
    const fetch = fetchReturning(body);
    await ensureGcpSnapshot({ path, url, sha256: sha256(body), fetch });
    await expect(ensureGcpSnapshot({ path, url, sha256: sha256(body), fetch })).resolves.toBe(
      'cached',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a download whose hash differs and leaves nothing on disk', async () => {
    const fetch = fetchReturning(body);
    await expect(ensureGcpSnapshot({ path, url, sha256: sha256('other'), fetch })).rejects.toThrow(
      /SHA-256/,
    );
    expect(existsSync(path)).toBe(false);
  });

  it('replaces a file on disk that does not match the pinned hash', async () => {
    const stale = join(dir, 'stale.json');
    writeFileSync(stale, 'stale');
    const fetch = fetchReturning(body);
    await expect(
      ensureGcpSnapshot({ path: stale, url, sha256: sha256(body), fetch }),
    ).resolves.toBe('downloaded');
    expect(readFileSync(stale, 'utf8')).toBe(body);
  });

  it('reports an HTTP failure', async () => {
    const fetch = fetchReturning('not found', 404);
    await expect(ensureGcpSnapshot({ path, url, sha256: sha256(body), fetch })).rejects.toThrow(
      /404/,
    );
    expect(existsSync(path)).toBe(false);
  });
});
