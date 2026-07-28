// @vitest-environment node

/**
 * Issue #1 — bare WSL2 Docker Engine bind-mount path translation.
 *
 * A bare Docker Engine running inside a WSL2 distro (no Docker Desktop) is
 * driven from Windows via native docker.exe over `DOCKER_HOST=tcp://...`.
 * Docker Desktop silently rewrites Windows host paths into the Linux VM's
 * mount namespace for bind mounts; a bare engine has no such layer, so every
 * path dockerManager builds from Windows-side APIs must be translated to its
 * `/mnt/c/...` WSL2 equivalent before it reaches compose — otherwise
 * `docker compose up` fails with `invalid volume specification`.
 *
 * These cover the pure pieces `startContainer` funnels every bind-mount path
 * through: `isBareWslDockerEngine`, `windowsPathToWslMountPath`,
 * `toComposeMountPath`, and `resolveBindMountPaths`. Full `startContainer` is
 * hard to unit-test without a Docker runtime (see
 * dockerManagerRuntimeProfile.test.ts), so — as with the runtime-profile
 * desync fix — the funnel point itself is what's pinned here.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-wsl-path-test-'));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (_name: string) => userDataRoot,
    setPath: vi.fn(),
  },
}));

vi.mock('electron-store', () => ({
  default: class MockStore {
    get() {
      return undefined;
    }
    set() {}
  },
}));

import {
  isBareWslDockerEngine,
  windowsPathToWslMountPath,
  toComposeMountPath,
  resolveBindMountPaths,
} from '../dockerManager.js';

describe('isBareWslDockerEngine', () => {
  it('is true on Windows with a tcp:// DOCKER_HOST (bare WSL2 Engine)', () => {
    expect(isBareWslDockerEngine('win32', 'tcp://localhost:2375')).toBe(true);
  });

  it('is true regardless of DOCKER_HOST casing/whitespace', () => {
    expect(isBareWslDockerEngine('win32', '  TCP://127.0.0.1:2375  ')).toBe(true);
  });

  it('is false on Windows with no DOCKER_HOST (Docker Desktop default)', () => {
    expect(isBareWslDockerEngine('win32', undefined)).toBe(false);
  });

  it('is false on Windows with a named-pipe DOCKER_HOST (Docker Desktop)', () => {
    expect(isBareWslDockerEngine('win32', 'npipe:////./pipe/docker_engine')).toBe(false);
  });

  it('is false on Linux even with a tcp:// DOCKER_HOST (already POSIX paths)', () => {
    expect(isBareWslDockerEngine('linux', 'tcp://localhost:2375')).toBe(false);
  });

  it('is false on macOS even with a tcp:// DOCKER_HOST', () => {
    expect(isBareWslDockerEngine('darwin', 'tcp://localhost:2375')).toBe(false);
  });
});

describe('windowsPathToWslMountPath', () => {
  it('translates a backslash Windows path to its /mnt/<drive> equivalent', () => {
    expect(windowsPathToWslMountPath('C:\\Users\\test\\AppData\\Roaming\\TranscriptionSuite')).toBe(
      '/mnt/c/Users/test/AppData/Roaming/TranscriptionSuite',
    );
  });

  it('translates a forward-slash Windows path', () => {
    expect(windowsPathToWslMountPath('C:/Users/test/AppData')).toBe('/mnt/c/Users/test/AppData');
  });

  it('lowercases the drive letter', () => {
    expect(windowsPathToWslMountPath('D:\\data\\certs')).toBe('/mnt/d/data/certs');
  });

  it('passes through an already-POSIX path unchanged', () => {
    expect(windowsPathToWslMountPath('/mnt/c/Users/test')).toBe('/mnt/c/Users/test');
  });

  it('passes through a relative path unchanged', () => {
    expect(windowsPathToWslMountPath('./.empty')).toBe('./.empty');
  });
});

describe('toComposeMountPath', () => {
  const winPath = 'C:\\Users\\test\\AppData\\Roaming\\TranscriptionSuite';

  it('translates when the active engine is a bare WSL2 Docker Engine', () => {
    expect(toComposeMountPath(winPath, true)).toBe('/mnt/c/Users/test/AppData/Roaming/TranscriptionSuite');
  });

  it('leaves the path unchanged for Docker Desktop / native Linux/macOS', () => {
    expect(toComposeMountPath(winPath, false)).toBe(winPath);
  });
});

describe('resolveBindMountPaths', () => {
  const composeDir = 'C:\\Users\\test\\AppData\\Roaming\\TranscriptionSuite\\docker';

  it('[AC1] translates USER_CONFIG_DIR, STARTUP_EVENTS_DIR, and TLS cert/key paths under a bare engine', () => {
    const result = resolveBindMountPaths({
      userConfigDir: 'C:\\Users\\test\\AppData\\Roaming\\TranscriptionSuite',
      startupEventsDir: 'C:\\Users\\test\\AppData\\Local\\Temp\\transcription-suite-events-abc123',
      tlsCertPath: 'C:\\Users\\test\\.config\\Tailscale\\my-machine.crt',
      tlsKeyPath: 'C:\\Users\\test\\.config\\Tailscale\\my-machine.key',
      composeDir,
      isBareEngine: true,
    });

    expect(result.USER_CONFIG_DIR).toBe('/mnt/c/Users/test/AppData/Roaming/TranscriptionSuite');
    expect(result.STARTUP_EVENTS_DIR).toBe(
      '/mnt/c/Users/test/AppData/Local/Temp/transcription-suite-events-abc123',
    );
    expect(result.TLS_CERT_PATH).toBe('/mnt/c/Users/test/.config/Tailscale/my-machine.crt');
    expect(result.TLS_KEY_PATH).toBe('/mnt/c/Users/test/.config/Tailscale/my-machine.key');
  });

  it('[AC2] emits an explicit translated absolute .empty path for unset optional TLS mounts under a bare engine', () => {
    const result = resolveBindMountPaths({
      userConfigDir: 'C:\\Users\\test\\AppData\\Roaming\\TranscriptionSuite',
      startupEventsDir: 'C:\\Users\\test\\AppData\\Local\\Temp\\events-abc',
      // tlsCertPath / tlsKeyPath intentionally omitted (local, non-TLS start)
      composeDir,
      isBareEngine: true,
    });

    const expectedEmpty = '/mnt/c/Users/test/AppData/Roaming/TranscriptionSuite/docker/.empty';
    expect(result.TLS_CERT_PATH).toBe(expectedEmpty);
    expect(result.TLS_KEY_PATH).toBe(expectedEmpty);
    expect(path.posix.isAbsolute(result.TLS_CERT_PATH)).toBe(true);
    expect(path.posix.isAbsolute(result.TLS_KEY_PATH)).toBe(true);
  });

  it('[AC2] emits an absolute .empty path for EXTRA_CA_CERTS_DIR when the user has not configured one', () => {
    const result = resolveBindMountPaths({
      userConfigDir: 'C:\\Users\\test\\AppData\\Roaming\\TranscriptionSuite',
      startupEventsDir: 'C:\\Users\\test\\AppData\\Local\\Temp\\events-abc',
      composeDir,
      isBareEngine: true,
    });

    expect(result.EXTRA_CA_CERTS_DIR).toBe(
      '/mnt/c/Users/test/AppData/Roaming/TranscriptionSuite/docker/.empty',
    );
  });

  it('[Issue #1 bullet 3] passes a user-supplied EXTRA_CA_CERTS_DIR through untouched, even under a bare engine', () => {
    const result = resolveBindMountPaths({
      userConfigDir: 'C:\\Users\\test\\AppData\\Roaming\\TranscriptionSuite',
      startupEventsDir: 'C:\\Users\\test\\AppData\\Local\\Temp\\events-abc',
      extraCaCertsDir: 'C:\\Users\\test\\AppData\\Roaming\\TranscriptionSuite\\ca',
      composeDir,
      isBareEngine: true,
    });

    // Not auto-translated — the user owns this value and must supply a
    // WSL2-shaped path themselves under a bare engine.
    expect(result.EXTRA_CA_CERTS_DIR).toBe('C:\\Users\\test\\AppData\\Roaming\\TranscriptionSuite\\ca');
  });

  it('[AC4] leaves every path unchanged for Docker Desktop / native Linux/macOS (isBareEngine=false)', () => {
    const result = resolveBindMountPaths({
      userConfigDir: 'C:\\Users\\test\\AppData\\Roaming\\TranscriptionSuite',
      startupEventsDir: 'C:\\Users\\test\\AppData\\Local\\Temp\\events-abc',
      composeDir,
      isBareEngine: false,
    });

    expect(result.USER_CONFIG_DIR).toBe('C:\\Users\\test\\AppData\\Roaming\\TranscriptionSuite');
    expect(result.STARTUP_EVENTS_DIR).toBe('C:\\Users\\test\\AppData\\Local\\Temp\\events-abc');
    // The .empty fallback is still always explicit and absolute — just not
    // translated, since Docker Desktop/native daemons don't need translation.
    // Expected via path.join() itself (not a hardcoded separator): in real
    // usage composeDir and this join always come from the SAME OS's path
    // module, but this unit test's hardcoded Windows-shaped composeDir may
    // run on a POSIX test runner, where path.join uses '/' — mirroring the
    // source's own join call keeps the assertion OS-agnostic.
    const expectedEmpty = path.join(composeDir, '.empty');
    expect(result.TLS_CERT_PATH).toBe(expectedEmpty);
    expect(result.TLS_KEY_PATH).toBe(expectedEmpty);
  });
});
