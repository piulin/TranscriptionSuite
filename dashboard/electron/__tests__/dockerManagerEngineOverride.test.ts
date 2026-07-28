// @vitest-environment node

/**
 * Issue #2 — manual container-engine override.
 *
 * Covers the pure/persisted pieces of the override: `readEngineOverrideFromStore`
 * (the electron-store-backed persistence — reading straight off disk exercises
 * the same path a real app relaunch takes) and `isBareWslDockerEngine`'s
 * override param (lets a user's manual classification win over the
 * DOCKER_HOST heuristic for WSL2 bind-mount path translation).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock `electron` before importing dockerManager — the module imports `app`
// at the top level and needs a usable path for `getPath('userData')`.
const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-engine-override-test-'));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (_name: string) => userDataRoot,
    setPath: vi.fn(),
  },
}));

// Mock electron-store (imported transitively by config readers)
vi.mock('electron-store', () => ({
  default: class MockStore {
    get() {
      return undefined;
    }
    set() {}
  },
}));

import { readEngineOverrideFromStore, isBareWslDockerEngine } from '../dockerManager.js';

const STORE_FILE = path.join(userDataRoot, 'dashboard-config.json');

function writeStore(contents: Record<string, unknown>): void {
  fs.writeFileSync(STORE_FILE, JSON.stringify(contents), 'utf8');
}

// Clean store between tests (mirrors dockerManagerLegacyGpu.test.ts pattern)
beforeEach(() => {
  try {
    fs.unlinkSync(STORE_FILE);
  } catch {
    // fine
  }
});

afterEach(() => {
  try {
    fs.unlinkSync(STORE_FILE);
  } catch {
    // fine
  }
});

describe('[Issue #2] readEngineOverrideFromStore', () => {
  it("returns 'auto' when the store file is absent", () => {
    expect(readEngineOverrideFromStore()).toBe('auto');
  });

  it("returns 'auto' when the store is present but the key is unset", () => {
    writeStore({ 'connection.port': 9786 });
    expect(readEngineOverrideFromStore()).toBe('auto');
  });

  it("persists and reads back 'podman'", () => {
    writeStore({ 'server.engineOverride': 'podman' });
    expect(readEngineOverrideFromStore()).toBe('podman');
  });

  it("persists and reads back 'docker-desktop'", () => {
    writeStore({ 'server.engineOverride': 'docker-desktop' });
    expect(readEngineOverrideFromStore()).toBe('docker-desktop');
  });

  it("persists and reads back 'docker-engine-wsl2'", () => {
    writeStore({ 'server.engineOverride': 'docker-engine-wsl2' });
    expect(readEngineOverrideFromStore()).toBe('docker-engine-wsl2');
  });

  it("returns 'auto' for an invalid/unrecognized value (defensive against store corruption)", () => {
    writeStore({ 'server.engineOverride': 'bogus-value' });
    expect(readEngineOverrideFromStore()).toBe('auto');
  });

  it("returns 'auto' when the store file is malformed JSON", () => {
    fs.writeFileSync(STORE_FILE, '{not json', 'utf8');
    expect(readEngineOverrideFromStore()).toBe('auto');
  });
});

describe('[Issue #2] isBareWslDockerEngine — engine override precedence', () => {
  it("override 'docker-engine-wsl2' forces true regardless of DOCKER_HOST/platform", () => {
    expect(isBareWslDockerEngine('linux', undefined, 'docker-engine-wsl2')).toBe(true);
    expect(isBareWslDockerEngine('win32', undefined, 'docker-engine-wsl2')).toBe(true);
  });

  it("override 'docker-desktop' forces false even with a tcp:// DOCKER_HOST on Windows", () => {
    expect(isBareWslDockerEngine('win32', 'tcp://localhost:2375', 'docker-desktop')).toBe(false);
  });

  it("override 'podman' forces false even with a tcp:// DOCKER_HOST on Windows", () => {
    expect(isBareWslDockerEngine('win32', 'tcp://localhost:2375', 'podman')).toBe(false);
  });

  it("override 'auto' (or omitted) falls back to the DOCKER_HOST heuristic — unchanged behavior", () => {
    expect(isBareWslDockerEngine('win32', 'tcp://localhost:2375', 'auto')).toBe(true);
    expect(isBareWslDockerEngine('win32', 'tcp://localhost:2375')).toBe(true);
    expect(isBareWslDockerEngine('win32', undefined, 'auto')).toBe(false);
  });
});
