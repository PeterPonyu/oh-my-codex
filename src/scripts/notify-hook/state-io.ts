/**
 * State file I/O helpers for notify-hook modules.
 */

import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { validateSessionId } from '../../mcp/state-paths.js';
import { isSessionStateUsable, type SessionState } from '../../hooks/session.js';
import { asNumber, safeString } from './utils.js';


export { readdir };

export function readJsonIfExists(path: string, fallback: any): Promise<any> {
  return readFile(path, 'utf-8')
    .then(content => JSON.parse(content))
    .catch(() => fallback);
}

function isSafeStateFileName(fileName: string): boolean {
  return fileName.length > 0
    && !fileName.includes('..')
    && !fileName.includes('/')
    && !fileName.includes('\\');
}

interface SessionMetadata {
  sessionId?: string;
  nativeAliases: string[];
}

async function readSessionMetadataFromBaseStateDir(baseStateDir: string, cwd?: string): Promise<SessionMetadata> {
  const session = await readJsonIfExists(join(baseStateDir, 'session.json'), null);
  let sessionId: string | undefined;
  try {
    if (cwd && (!session || typeof session !== 'object' || !isSessionStateUsable(session as SessionState, cwd))) {
      return { nativeAliases: [] };
    }
    sessionId = validateSessionId(session?.session_id);
  } catch {
    sessionId = undefined;
  }
  const nativeAliases = [
    session?.native_session_id,
    session?.codex_session_id,
    session?.previous_native_session_id,
  ]
    .map((value) => safeString(value).trim())
    .filter(Boolean);
  return { sessionId, nativeAliases: [...new Set(nativeAliases)] };
}

function resolveCanonicalSessionId(candidate: string | undefined, metadata: SessionMetadata): string | undefined {
  if (!candidate) return undefined;
  if (!metadata.sessionId) return candidate;
  if (candidate === metadata.sessionId) return metadata.sessionId;
  return metadata.nativeAliases.includes(candidate) ? metadata.sessionId : undefined;
}

function resolveExplicitSessionId(candidate: string | undefined, metadata: SessionMetadata): string | undefined {
  if (!candidate) return undefined;
  return resolveCanonicalSessionId(candidate, metadata) ?? candidate;
}

function resolveImplicitSessionId(metadata: SessionMetadata): string | undefined {
  return metadata.sessionId;
}

async function resolveBaseScopedStateDir(
  baseStateDir: string,
  explicitSessionId?: string,
  cwd?: string,
): Promise<string> {
  const normalizedExplicit = typeof explicitSessionId === 'string' && explicitSessionId.trim()
    ? explicitSessionId.trim()
    : undefined;
  const validatedExplicit = validateSessionId(normalizedExplicit);
  const metadata = await readSessionMetadataFromBaseStateDir(baseStateDir, cwd);
  const sessionId = resolveExplicitSessionId(validatedExplicit, metadata)
    ?? resolveImplicitSessionId(metadata);
  return sessionId ? join(baseStateDir, 'sessions', sessionId) : baseStateDir;
}

async function resolveBaseScopedStateDirs(
  baseStateDir: string,
  explicitSessionId?: string,
  options: { includeRootFallback?: boolean } = {},
  cwd?: string,
): Promise<string[]> {
  const scopedDir = await resolveBaseScopedStateDir(baseStateDir, explicitSessionId, cwd);
  return options.includeRootFallback === true && scopedDir !== baseStateDir
    ? [scopedDir, baseStateDir]
    : [scopedDir];
}




export async function readCurrentSessionId(baseStateDir: string, cwd?: string): Promise<string | undefined> {
  const metadata = await readSessionMetadataFromBaseStateDir(baseStateDir, cwd);
  return resolveImplicitSessionId(metadata);
}

export async function resolveScopedStateDir(
  baseStateDir: string,
  explicitSessionId?: string,
  cwd?: string,
): Promise<string> {
  return resolveBaseScopedStateDir(baseStateDir, explicitSessionId, cwd);
}

export async function getScopedStateDirsForCurrentSession(
  baseStateDir: string,
  explicitSessionId?: string,
  options: { includeRootFallback?: boolean } = {},
  cwd?: string,
): Promise<string[]> {
  return resolveBaseScopedStateDirs(baseStateDir, explicitSessionId, options, cwd);
}

export async function getScopedStatePath(
  baseStateDir: string,
  fileName: string,
  explicitSessionId?: string,
  cwd?: string,
): Promise<string> {
  if (!isSafeStateFileName(fileName)) {
    throw new Error(`unsafe state file name: ${fileName}`);
  }
  return join(await resolveScopedStateDir(baseStateDir, explicitSessionId, cwd), fileName);
}

export async function readScopedJsonIfExists(
  baseStateDir: string,
  fileName: string,
  explicitSessionId: string | undefined,
  fallback: any,
  options: { includeRootFallback?: boolean } = {},
  cwd?: string,
): Promise<any> {
  if (!isSafeStateFileName(fileName)) {
    throw new Error(`unsafe state file name: ${fileName}`);
  }
  const candidateDirs = await getScopedStateDirsForCurrentSession(
    baseStateDir,
    explicitSessionId,
    options,
    cwd,
  );
  for (const dir of candidateDirs) {
    const value = await readJsonIfExists(join(dir, fileName), fallback);
    if (value !== fallback) return value;
  }
  return fallback;
}

export async function writeScopedJson(
  baseStateDir: string,
  fileName: string,
  explicitSessionId: string | undefined,
  value: unknown,
  cwd?: string,
): Promise<void> {
  const targetPath = await getScopedStatePath(baseStateDir, fileName, explicitSessionId, cwd);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(value, null, 2));
}

export function normalizeTmuxState(raw: any): any {
  if (!raw || typeof raw !== 'object') {
    return {
      total_injections: 0,
      pane_counts: {},
      session_counts: {},
      recent_keys: {},
      last_injection_ts: 0,
      last_reason: 'init',
      last_event_at: '',
    };
  }
  return {
    total_injections: asNumber(raw.total_injections) ?? 0,
    pane_counts: raw.pane_counts && typeof raw.pane_counts === 'object' ? raw.pane_counts : {},
    session_counts: raw.session_counts && typeof raw.session_counts === 'object' ? raw.session_counts : {},
    recent_keys: raw.recent_keys && typeof raw.recent_keys === 'object' ? raw.recent_keys : {},
    last_injection_ts: asNumber(raw.last_injection_ts) ?? 0,
    last_reason: safeString(raw.last_reason),
    last_event_at: safeString(raw.last_event_at),
  };
}

export function normalizeNotifyState(raw: any): any {
  if (!raw || typeof raw !== 'object') {
    return {
      recent_turns: {},
      last_event_at: '',
    };
  }
  return {
    recent_turns: raw.recent_turns && typeof raw.recent_turns === 'object' ? raw.recent_turns : {},
    last_event_at: safeString(raw.last_event_at),
  };
}

export function pruneRecentTurns(recentTurns: any, now: number): Record<string, number> {
  const pruned: Record<string, number> = {};
  const minTs = now - (24 * 60 * 60 * 1000);
  const entries = Object.entries(recentTurns || {}).slice(-2000);
  for (const [key, value] of entries) {
    const ts = asNumber(value);
    if (ts !== null && ts >= minTs) pruned[key] = ts;
  }
  return pruned;
}

export function pruneRecentKeys(recentKeys: any, now: number): Record<string, number> {
  const pruned: Record<string, number> = {};
  const minTs = now - (24 * 60 * 60 * 1000);
  const entries = Object.entries(recentKeys || {}).slice(-1000);
  for (const [key, value] of entries) {
    const ts = asNumber(value);
    if (ts !== null && ts >= minTs) pruned[key] = ts;
  }
  return pruned;
}
