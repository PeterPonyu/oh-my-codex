import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getScopedStatePath,
  readCurrentSessionId,
  readScopedJsonIfExists,
  resolveScopedStateDir,
  writeScopedJson,
} from '../notify-hook/state-io.js';

const isolatedEnvKeys = [
  'OMX_ROOT',
  'OMX_STATE_ROOT',
  'OMX_TEAM_STATE_ROOT',
  'OMX_SESSION_ID',
  'CODEX_SESSION_ID',
  'SESSION_ID',
] as const;
const originalEnv = Object.fromEntries(
  isolatedEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof isolatedEnvKeys)[number], string | undefined>;

beforeEach(() => {
  for (const key of isolatedEnvKeys) delete process.env[key];
});

afterEach(() => {
  for (const key of isolatedEnvKeys) {
    const value = originalEnv[key];
    if (typeof value === 'string') process.env[key] = value;
    else delete process.env[key];
  }
});

describe('notify-hook state I/O session authority', () => {
  it('uses an explicit session id before the current session pointer', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-state-io-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(join(stateDir, 'sessions', 'sess-current'), { recursive: true });
      await mkdir(join(stateDir, 'sessions', 'sess-explicit'), { recursive: true });
      await writeFile(
        join(stateDir, 'session.json'),
        JSON.stringify({ session_id: 'sess-current', cwd: wd }, null, 2),
        'utf-8',
      );

      assert.equal(
        await resolveScopedStateDir(stateDir, 'sess-explicit'),
        join(stateDir, 'sessions', 'sess-explicit'),
      );
      assert.equal(
        await getScopedStatePath(stateDir, 'hud-state.json', 'sess-explicit'),
        join(stateDir, 'sessions', 'sess-explicit', 'hud-state.json'),
      );

      await writeScopedJson(stateDir, 'hud-state.json', 'sess-explicit', { turn_count: 3 });
      const explicitHud = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-explicit', 'hud-state.json'), 'utf-8'),
      ) as { turn_count?: unknown };
      assert.equal(explicitHud.turn_count, 3);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not read current-session data when an explicit session has no state file', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-state-io-missing-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(join(stateDir, 'sessions', 'sess-current'), { recursive: true });
      await writeFile(
        join(stateDir, 'session.json'),
        JSON.stringify({ session_id: 'sess-current', cwd: wd }, null, 2),
        'utf-8',
      );
      await writeFile(
        join(stateDir, 'sessions', 'sess-current', 'auto-nudge-state.json'),
        JSON.stringify({ count: 9 }, null, 2),
        'utf-8',
      );

      const value = await readScopedJsonIfExists(
        stateDir,
        'auto-nudge-state.json',
        'sess-explicit',
        null,
      );
      assert.equal(value, null);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('resolves current session from authoritative team state root without cwd inference', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-state-io-team-root-'));
    try {
      const teamStateRoot = join(wd, 'team-state-root');
      await mkdir(join(teamStateRoot, 'sessions', 'sess-team-root'), { recursive: true });
      await writeFile(
        join(teamStateRoot, 'session.json'),
        JSON.stringify({ session_id: 'sess-team-root', cwd: join(wd, 'source-repo') }, null, 2),
        'utf-8',
      );
      await writeFile(
        join(teamStateRoot, 'hud-state.json'),
        JSON.stringify({ turn_count: 99 }, null, 2),
        'utf-8',
      );
      await writeFile(
        join(teamStateRoot, 'sessions', 'sess-team-root', 'hud-state.json'),
        JSON.stringify({ turn_count: 4 }, null, 2),
        'utf-8',
      );

      assert.equal(await resolveScopedStateDir(teamStateRoot), join(teamStateRoot, 'sessions', 'sess-team-root'));
      const value = await readScopedJsonIfExists(teamStateRoot, 'hud-state.json', undefined, null);
      assert.equal(value?.turn_count, 4);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not treat inherited OMX_SESSION_ID as current session metadata for implicit notify writes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-state-io-env-'));
    const previousSessionId = process.env.OMX_SESSION_ID;
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(join(stateDir, 'sessions', 'sess-env'), { recursive: true });
      process.env.OMX_SESSION_ID = 'sess-env';

      assert.equal(await readCurrentSessionId(stateDir), undefined);
      assert.equal(await resolveScopedStateDir(stateDir), stateDir);

      await writeScopedJson(stateDir, 'hud-state.json', undefined, { turn_count: 7 });
      const value = JSON.parse(
        await readFile(join(stateDir, 'hud-state.json'), 'utf-8'),
      ) as { turn_count?: unknown };
      assert.equal(value.turn_count, 7);
      await assert.rejects(readFile(join(stateDir, 'sessions', 'sess-env', 'hud-state.json'), 'utf-8'));
    } finally {
      if (typeof previousSessionId === 'string') process.env.OMX_SESSION_ID = previousSessionId;
      else delete process.env.OMX_SESSION_ID;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not let inherited OMX_SESSION_ID override session metadata', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-state-io-env-mismatch-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(join(stateDir, 'sessions', 'sess-current'), { recursive: true });
      await mkdir(join(stateDir, 'sessions', 'sess-inherited'), { recursive: true });
      await writeFile(
        join(stateDir, 'session.json'),
        JSON.stringify({ session_id: 'sess-current', cwd: wd }, null, 2),
        'utf-8',
      );
      process.env.OMX_SESSION_ID = 'sess-inherited';

      assert.equal(await readCurrentSessionId(stateDir), 'sess-current');
      assert.equal(await resolveScopedStateDir(stateDir), join(stateDir, 'sessions', 'sess-current'));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('maps native Codex session aliases to the canonical OMX session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-state-io-native-alias-'));
    const previousOmxSessionId = process.env.OMX_SESSION_ID;
    const previousCodexSessionId = process.env.CODEX_SESSION_ID;
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(join(stateDir, 'sessions', 'omx-canonical'), { recursive: true });
      await writeFile(
        join(stateDir, 'session.json'),
        JSON.stringify({
          session_id: 'omx-canonical',
          native_session_id: 'codex-native',
          cwd: wd,
        }, null, 2),
        'utf-8',
      );
      delete process.env.OMX_SESSION_ID;
      process.env.CODEX_SESSION_ID = 'codex-native';

      assert.equal(await readCurrentSessionId(stateDir), 'omx-canonical');
      assert.equal(await resolveScopedStateDir(stateDir), join(stateDir, 'sessions', 'omx-canonical'));

      await writeScopedJson(stateDir, 'hud-state.json', undefined, { turn_count: 11 });
      const value = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'omx-canonical', 'hud-state.json'), 'utf-8'),
      ) as { turn_count?: unknown };
      assert.equal(value.turn_count, 11);
    } finally {
      if (typeof previousOmxSessionId === 'string') process.env.OMX_SESSION_ID = previousOmxSessionId;
      else delete process.env.OMX_SESSION_ID;
      if (typeof previousCodexSessionId === 'string') process.env.CODEX_SESSION_ID = previousCodexSessionId;
      else delete process.env.CODEX_SESSION_ID;
      await rm(wd, { recursive: true, force: true });
    }
  });
});
