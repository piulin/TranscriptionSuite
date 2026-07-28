// @vitest-environment node

/**
 * P1-DOCK-002 — Container runtime detection: Docker vs Podman
 *
 * Tests that detectRuntime() correctly identifies the available container
 * runtime, handles partial availability (binary found but daemon not running),
 * and returns actionable guidance when no runtime is found.
 *
 * 3 primary detection scenarios + edge cases for compose/socket/override.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted Mocks ─────────────────────────────────────────────────────────

const { mockExecFile, mockConnect, mockExistsSync } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockConnect: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('net', () => ({
  default: { connect: (...args: unknown[]) => mockConnect(...args) },
  connect: (...args: unknown[]) => mockConnect(...args),
}));

// Partial fs mock — only override existsSync for socket probing.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: { ...actual, existsSync: mockExistsSync },
    existsSync: mockExistsSync,
  };
});

// ─── Import after mocks ────────────────────────────────────────────────────

import {
  detectRuntime,
  resetDetection,
  getRuntimePathAdditions,
  getDetectionResult,
  isDockerDesktopBinaryPath,
  resolveDockerEngineKind,
} from '../containerRuntime.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const originalPlatform = process.platform;
const originalEnv = { ...process.env };

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, writable: true });
}

/**
 * Configure mockExecFile to succeed or fail for specific command+args combos.
 * Keys are `"bin arg1"` strings (prefix-matched); values are stdout or Error.
 */
function setExecResponses(responses: Record<string, string | Error>): void {
  mockExecFile.mockImplementation(
    (cmd: string, args: string[], _opts: unknown, callback?: Function) => {
      const key = `${cmd} ${args.join(' ')}`;
      const matched = Object.entries(responses).find(([k]) => key.startsWith(k));

      if (matched && !(matched[1] instanceof Error)) {
        if (callback) callback(null, { stdout: matched[1] });
        return;
      }

      const err = matched?.[1] instanceof Error ? matched[1] : new Error(`ENOENT: ${key}`);
      if (callback) callback(err, { stdout: '' });
    },
  );
}

/** Make mockConnect simulate a successful or failed socket connection. */
function setSocketResult(succeeds: boolean): void {
  mockConnect.mockImplementation(() => {
    const handlers: Record<string, Function> = {};
    const sock = {
      on: (event: string, cb: Function) => {
        handlers[event] = cb;
        return sock;
      },
      destroy: vi.fn(),
    };
    setTimeout(() => {
      if (succeeds && handlers['connect']) handlers['connect']();
      else if (!succeeds && handlers['error']) handlers['error'](new Error('refused'));
    }, 0);
    return sock;
  });
}

beforeEach(() => {
  resetDetection();
  vi.clearAllMocks();
  // Default: socket files exist and connections succeed
  mockExistsSync.mockReturnValue(true);
  setSocketResult(true);
  delete process.env.CONTAINER_RUNTIME;
  delete process.env.DOCKER_HOST;
  delete process.env.CONTAINER_HOST;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  process.env = { ...originalEnv };
});

// ─── P1-DOCK-002: Container Runtime Detection ──────────────────────────────

describe('[P1] detectRuntime', () => {
  // ── Scenario 1: Docker available ──────────────────────────────────────

  it('detects Docker when daemon is running', async () => {
    setExecResponses({
      'docker version': '24.0.7',
      'docker compose version': 'Docker Compose v2.24.0',
    });

    const result = await detectRuntime();

    expect(result.runtime).not.toBeNull();
    expect(result.runtime!.kind).toBe('docker');
    expect(result.runtime!.bin).toBe('docker');
    expect(result.runtime!.displayName).toBe('Docker');
    expect(result.binaryFoundButNotRunning).toBe(false);
    expect(result.composeAvailable).toBe(true);
    // Issue #2: no DOCKER_HOST set → classified as Docker Desktop.
    expect(result.runtime!.engineKind).toBe('docker-desktop');
  });

  it('Docker running but compose missing: runtime set, guidance provided', async () => {
    setExecResponses({
      'docker version': '24.0.7',
    });

    const result = await detectRuntime();

    expect(result.runtime).not.toBeNull();
    expect(result.runtime!.kind).toBe('docker');
    expect(result.composeAvailable).toBe(false);
    expect(result.guidance).toContain('Compose');
  });

  // ── Scenario 2: Podman available ──────────────────────────────────────

  it('detects Podman when running with live socket', async () => {
    setPlatform('linux');
    setExecResponses({
      'podman version': '4.9.3',
      'podman compose version': 'podman-compose 1.0.6',
    });

    const result = await detectRuntime();

    expect(result.runtime).not.toBeNull();
    expect(result.runtime!.kind).toBe('podman');
    expect(result.runtime!.bin).toBe('podman');
    expect(result.runtime!.displayName).toBe('Podman');
    expect(result.composeAvailable).toBe(true);
    // Issue #2: Podman always maps to the 'podman' engine kind.
    expect(result.runtime!.engineKind).toBe('podman');
  });

  // ── Scenario 3: Neither available ─────────────────────────────────────

  it('returns null runtime when nothing is installed', async () => {
    setExecResponses({});

    const result = await detectRuntime();

    expect(result.runtime).toBeNull();
    expect(result.binaryFoundButNotRunning).toBe(false);
    expect(result.binaryFound).toBeNull();
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it('binary found but daemon not running: sets binaryFoundButNotRunning', async () => {
    setExecResponses({
      'docker --version': 'Docker version 24.0.7, build afdd53b',
    });

    const result = await detectRuntime();

    expect(result.runtime).toBeNull();
    expect(result.binaryFoundButNotRunning).toBe(true);
    expect(result.binaryFound).toBe('docker');
  });

  it('CONTAINER_RUNTIME env override forces detection', async () => {
    process.env.CONTAINER_RUNTIME = 'docker';
    setExecResponses({
      'docker version': '24.0.7',
      'docker compose version': 'v2',
    });

    const result = await detectRuntime();

    expect(result.runtime).not.toBeNull();
    expect(result.runtime!.kind).toBe('docker');
  });

  it('Podman socket dead on Linux: returns guidance, no runtime', async () => {
    setPlatform('linux');
    // Socket file exists but connection fails
    mockExistsSync.mockReturnValue(true);
    setSocketResult(false);
    setExecResponses({
      'podman version': '4.9.3',
    });

    const result = await detectRuntime();

    expect(result.runtime).toBeNull();
    expect(result.socketDead).toBe(true);
    expect(result.guidance).toContain('socket');
  });

  it('resetDetection() clears cache so next call re-probes', async () => {
    setExecResponses({
      'docker version': '24.0.7',
      'docker compose version': 'v2',
    });

    const first = await detectRuntime();
    expect(first.runtime).not.toBeNull();
    expect(first.runtime!.kind).toBe('docker');

    // Reset cache then wipe mock → re-detection finds nothing
    resetDetection();
    setExecResponses({});
    const second = await detectRuntime();
    expect(second.runtime).toBeNull();
  });
});

// ─── Issue #2: WSL2 bare Docker Engine vs. Docker Desktop ───────────────────
//
// A bare Docker Engine running inside a WSL2 distro (no Docker Desktop) is
// reached from Windows via `docker.exe` over `DOCKER_HOST=tcp://...`. Both
// signals — the env var AND a non-Desktop-bundled docker.exe path — must
// agree before detectRuntime() classifies the engine as 'docker-engine-wsl2';
// otherwise it defaults to 'docker-desktop' (unchanged pre-Issue-#2 behavior).

describe('[Issue #2] detectRuntime — engine kind classification', () => {
  const DESKTOP_DOCKER_EXE = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
  const STANDALONE_DOCKER_EXE = 'C:\\ProgramData\\DockerCLI\\docker.exe';

  it('classifies as docker-engine-wsl2 on Windows with DOCKER_HOST=tcp://... and a non-Desktop docker.exe', async () => {
    setPlatform('win32');
    process.env.DOCKER_HOST = 'tcp://localhost:2375';
    setExecResponses({
      'docker version': '24.0.7',
      'docker compose version': 'v2',
      'where docker': STANDALONE_DOCKER_EXE,
    });

    const result = await detectRuntime();

    expect(result.runtime).not.toBeNull();
    expect(result.runtime!.kind).toBe('docker');
    expect(result.runtime!.engineKind).toBe('docker-engine-wsl2');
  });

  it('classifies as docker-desktop on Windows with a tcp:// DOCKER_HOST when docker.exe IS the Desktop bundle', async () => {
    setPlatform('win32');
    process.env.DOCKER_HOST = 'tcp://localhost:2375';
    setExecResponses({
      'docker version': '24.0.7',
      'docker compose version': 'v2',
      'where docker': DESKTOP_DOCKER_EXE,
    });

    const result = await detectRuntime();

    expect(result.runtime!.engineKind).toBe('docker-desktop');
  });

  it('classifies as docker-desktop on Windows with no DOCKER_HOST (Docker Desktop default)', async () => {
    setPlatform('win32');
    setExecResponses({
      'docker version': '24.0.7',
      'docker compose version': 'v2',
      'where docker': DESKTOP_DOCKER_EXE,
    });

    const result = await detectRuntime();

    expect(result.runtime!.engineKind).toBe('docker-desktop');
  });

  it('never classifies as docker-engine-wsl2 on Linux, even with a tcp:// DOCKER_HOST', async () => {
    setPlatform('linux');
    process.env.DOCKER_HOST = 'tcp://localhost:2375';
    setExecResponses({
      'docker version': '24.0.7',
      'docker compose version': 'v2',
    });

    const result = await detectRuntime();

    expect(result.runtime!.engineKind).toBe('docker-desktop');
  });

  it('never classifies as docker-engine-wsl2 on macOS, even with a tcp:// DOCKER_HOST', async () => {
    setPlatform('darwin');
    process.env.DOCKER_HOST = 'tcp://localhost:2375';
    setExecResponses({
      'docker version': '24.0.7',
      'docker compose version': 'v2',
    });

    const result = await detectRuntime();

    expect(result.runtime!.engineKind).toBe('docker-desktop');
  });
});

describe('[Issue #2] isDockerDesktopBinaryPath', () => {
  it('true for the Desktop-bundled docker.exe path on Windows', () => {
    expect(
      isDockerDesktopBinaryPath(
        'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
        'win32',
      ),
    ).toBe(true);
  });

  it('false for a standalone docker.exe install on Windows', () => {
    expect(isDockerDesktopBinaryPath('C:\\ProgramData\\DockerCLI\\docker.exe', 'win32')).toBe(
      false,
    );
  });

  it('false for null binPath', () => {
    expect(isDockerDesktopBinaryPath(null, 'win32')).toBe(false);
  });

  it('false on non-Windows platforms regardless of path', () => {
    expect(
      isDockerDesktopBinaryPath(
        '/Applications/Docker.app/Contents/Resources/bin/docker',
        'darwin',
      ),
    ).toBe(false);
  });
});

describe('[Issue #2] resolveDockerEngineKind', () => {
  it('docker-engine-wsl2: win32 + tcp:// host + non-Desktop binary', () => {
    expect(
      resolveDockerEngineKind('win32', 'tcp://localhost:2375', 'C:\\ProgramData\\DockerCLI\\docker.exe'),
    ).toBe('docker-engine-wsl2');
  });

  it('docker-desktop: win32 + no DOCKER_HOST', () => {
    expect(resolveDockerEngineKind('win32', undefined, null)).toBe('docker-desktop');
  });

  it('docker-desktop: win32 + named-pipe DOCKER_HOST', () => {
    expect(resolveDockerEngineKind('win32', 'npipe:////./pipe/docker_engine', null)).toBe(
      'docker-desktop',
    );
  });

  it('docker-desktop: win32 + tcp:// host but Desktop-bundled binary', () => {
    expect(
      resolveDockerEngineKind(
        'win32',
        'tcp://localhost:2375',
        'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
      ),
    ).toBe('docker-desktop');
  });

  it('docker-desktop: non-Windows platforms regardless of DOCKER_HOST', () => {
    expect(resolveDockerEngineKind('linux', 'tcp://localhost:2375', null)).toBe('docker-desktop');
    expect(resolveDockerEngineKind('darwin', 'tcp://localhost:2375', null)).toBe('docker-desktop');
  });
});

// ─── GH #158: Windows compose-provider PATH augmentation ────────────────────
//
// On Windows, `podman compose` is a thin wrapper that shells out to an external
// provider binary (docker-compose.exe), located by searching PATH. If the
// provider's directory is not on the PATH we hand to `podman`, `podman compose`
// fails with exit 125 even though `podman` itself works. A GUI Electron process
// does not always inherit the post-install user PATH, so getRuntimePathAdditions
// must defensively include the well-known provider locations.

describe('[GH158] getRuntimePathAdditions', () => {
  const WIN_ENV = {
    LOCALAPPDATA: 'C:\\Users\\bob\\AppData\\Local',
    USERPROFILE: 'C:\\Users\\bob',
    ProgramFiles: 'C:\\Program Files',
  };

  it('Windows: includes the WindowsApps app-alias provider directory', () => {
    const dirs = getRuntimePathAdditions('win32', WIN_ENV);
    expect(dirs).toContain('C:\\Users\\bob\\AppData\\Local\\Microsoft\\WindowsApps');
  });

  it('Windows: includes both per-user and machine-wide Podman install dirs', () => {
    const dirs = getRuntimePathAdditions('win32', WIN_ENV);
    expect(dirs).toContain('C:\\Users\\bob\\AppData\\Local\\Programs\\Podman'); // Podman Desktop
    expect(dirs).toContain('C:\\Program Files\\RedHat\\Podman'); // machine-wide
  });

  it('Windows: still includes the Docker Desktop bin dir (compose plugin)', () => {
    const dirs = getRuntimePathAdditions('win32', WIN_ENV);
    expect(dirs).toContain('C:\\Program Files\\Docker\\Docker\\resources\\bin');
  });

  it('Windows: includes the pip --user bin dir for podman-compose', () => {
    const dirs = getRuntimePathAdditions('win32', WIN_ENV);
    expect(dirs).toContain('C:\\Users\\bob\\.local\\bin');
  });

  it('Windows: derives LOCALAPPDATA from USERPROFILE when unset (no crash)', () => {
    const dirs = getRuntimePathAdditions('win32', { USERPROFILE: 'C:\\Users\\bob' });
    expect(dirs).toContain('C:\\Users\\bob\\AppData\\Local\\Microsoft\\WindowsApps');
  });

  it('Windows: tolerates a completely empty environment', () => {
    expect(() => getRuntimePathAdditions('win32', {})).not.toThrow();
    // The static ProgramFiles fallbacks are still present.
    const dirs = getRuntimePathAdditions('win32', {});
    expect(dirs.some((d) => d.includes('RedHat\\Podman'))).toBe(true);
  });

  it('Linux: returns the standard unix bin dirs and no Windows paths', () => {
    const dirs = getRuntimePathAdditions('linux', {});
    expect(dirs).toEqual(['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    expect(dirs.some((d) => /windowsapps|podman/i.test(d))).toBe(false);
  });

  it('macOS: returns the standard unix bin dirs (no Windows provider dirs)', () => {
    const dirs = getRuntimePathAdditions('darwin', {});
    expect(dirs).toContain('/usr/local/bin');
    expect(dirs.some((d) => /windowsapps/i.test(d))).toBe(false);
  });
});

// ─── GH #158 (review follow-up): in-flight detection de-duplication ─────────
//
// getComposeAvailable() became async and now routes through getDetectionResult()
// in the same renderer Promise.all as available(). getDetectionResult() must
// memoize the in-flight detection so concurrent cold-start callers share ONE
// probe pass instead of each spawning their own `<runtime> version` /
// `<runtime> compose version` subprocesses.

describe('[GH158] getDetectionResult in-flight de-duplication', () => {
  function countProbe(cmd: string, firstArg: string): number {
    return mockExecFile.mock.calls.filter(
      (call) => call[0] === cmd && Array.isArray(call[1]) && call[1][0] === firstArg,
    ).length;
  }

  it('concurrent cold-cache calls run detectRuntime() only once', async () => {
    setExecResponses({
      'docker version': '24.0.7',
      'docker compose version': 'Docker Compose v2.24.0',
    });

    const [a, b] = await Promise.all([getDetectionResult(), getDetectionResult()]);

    // Same resolved result, and the `docker version` probe ran exactly once.
    expect(a).toBe(b);
    expect(a.runtime!.kind).toBe('docker');
    expect(countProbe('docker', 'version')).toBe(1);
  });

  it('resetDetection() clears the in-flight memo so the next call re-probes', async () => {
    setExecResponses({
      'docker version': '24.0.7',
      'docker compose version': 'Docker Compose v2.24.0',
    });

    await getDetectionResult();
    expect(countProbe('docker', 'version')).toBe(1);

    resetDetection();
    await getDetectionResult();
    expect(countProbe('docker', 'version')).toBe(2);
  });
});
