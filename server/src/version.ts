import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What this build is, so a running instance can be identified.
 *
 * Until now every image was `:latest` and there was no way to ask an instance
 * what it was — whether a bug was already fixed, or whether the container that
 * has been up for a month predates a change, were both unanswerable.
 *
 * The release number comes from the root package.json, which release-please
 * bumps and which the Dockerfile copies into the runtime image. The commit is a
 * build argument, because `.git` is deliberately not in the build context.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Two levels up lands on the repo root from both `server/src` under tsx and
 * `server/dist` in the image, which is why this works in either.
 */
function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * The checked-out commit, when running from a working tree.
 *
 * Only for development: the image has no `.git`, and gets its sha from the
 * build argument instead. Reads the files rather than shelling out to git,
 * because spawning a process at import time to answer a cosmetic question is a
 * poor trade.
 */
function readGitSha(): string {
  try {
    const gitDir = path.resolve(__dirname, '../../.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head;
    const ref = head.slice(4).trim();
    try {
      return fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
    } catch {
      // A packed ref, which is where a freshly cloned branch lives.
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
      const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
      return line ? line.split(' ')[0] : '';
    }
  } catch {
    return '';
  }
}

export const VERSION = readPackageVersion();

/** Full commit sha, or '' when neither the build nor a working tree named one. */
export const GIT_SHA = (process.env.GIT_SHA ?? readGitSha()).trim();

export const BUILT_AT = process.env.BUILD_TIME ?? '';

export interface VersionInfo {
  version: string;
  /** Short form, for display. '' when unknown. */
  commit: string;
  builtAt: string;
  /**
   * What to show. A release build is its number; anything else says so, since
   * "0.2.0" on a build made from four commits after the tag would be a lie.
   */
  display: string;
}

export function versionInfo(): VersionInfo {
  const commit = GIT_SHA.slice(0, 7);
  return {
    version: VERSION,
    commit,
    builtAt: BUILT_AT,
    display: commit ? `${VERSION}+${commit}` : VERSION,
  };
}
