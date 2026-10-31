import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * GS1's GCP length table, the copy GS1 publishes in its Apache-2.0 licensed gs1/TDT repository
 * (demo/gcpprefixformatlist.json, 192,979 entries, committed 2026-02-17). Test-only (plan decision
 * E1): never shipped and not tracked in git. `ensureGcpSnapshot` downloads it from the pinned commit
 * into docs/specifications/data (gitignored) on the first test run and checks its SHA-256 before
 * anything reads it.
 */
export const GCP_SNAPSHOT_PATH =
  'docs/specifications/data/gcpprefixformatlist-snapshot-2026-02-17.json';
export const GCP_SNAPSHOT_URL =
  'https://raw.githubusercontent.com/gs1/TDT/bf0d94b8019b67d0023ec61488ab797ce74eee43/demo/gcpprefixformatlist.json';
export const GCP_SNAPSHOT_SHA256 =
  '453d137842aec27cd59932303905dcf9de9ecbf34900430ea1daec84f01b017c';

export interface EnsureGcpSnapshotOptions {
  readonly path?: string;
  readonly url?: string;
  readonly sha256?: string;
  readonly fetch?: (url: string) => Promise<Response>;
}

const sha256Of = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/**
 * Makes sure the snapshot is on disk with the pinned SHA-256, downloading it when it is missing or
 * does not match. Untrusted bytes are checked before they are written; a mismatch leaves the
 * disk unchanged. Resolves to how the file got there.
 */
export async function ensureGcpSnapshot(
  options: EnsureGcpSnapshotOptions = {},
): Promise<'cached' | 'downloaded'> {
  const path = options.path ?? GCP_SNAPSHOT_PATH;
  const url = options.url ?? GCP_SNAPSHOT_URL;
  const expected = options.sha256 ?? GCP_SNAPSHOT_SHA256;
  const fetchFn = options.fetch ?? fetch;

  if (existsSync(path) && sha256Of(readFileSync(path)) === expected) return 'cached';

  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256Of(bytes);
  if (actual !== expected) {
    throw new Error(
      `${url} does not match its pinned SHA-256 (expected ${expected}, got ${actual}); not saved`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return 'downloaded';
}

interface Snapshot {
  readonly GCPPrefixFormatList: {
    readonly entry: readonly { readonly prefix: string; readonly gcpLength: number }[];
  };
}

let table: Map<string, number> | undefined;

/**
 * Test-only GCP length lookup over the snapshot (call `ensureGcpSnapshot` first, in a
 * `beforeAll`). The entries are prefix-free, so at most one prefix of the key matches.
 */
export function gcpSnapshotLength(keyDigits: string): number | undefined {
  if (table === undefined) {
    if (!existsSync(GCP_SNAPSHOT_PATH)) {
      throw new Error(`${GCP_SNAPSHOT_PATH} is missing; await ensureGcpSnapshot() first`);
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON file of known shape
    const snapshot = JSON.parse(readFileSync(GCP_SNAPSHOT_PATH, 'utf8')) as Snapshot;
    table = new Map(
      snapshot.GCPPrefixFormatList.entry.map((e) => [e.prefix, e.gcpLength] as const),
    );
  }
  for (let n = 3; n <= 12 && n <= keyDigits.length; n++) {
    const v = table.get(keyDigits.slice(0, n));
    if (v !== undefined) return v;
  }
  return undefined;
}
