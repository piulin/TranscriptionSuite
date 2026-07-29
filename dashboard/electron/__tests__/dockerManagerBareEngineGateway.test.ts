// @vitest-environment node

/**
 * Issue #3 follow-up — resolving the real Windows host IP under a bare WSL2
 * Docker Engine.
 *
 * `extra_hosts: host.docker.internal:host-gateway` resolves to whatever
 * machine runs the Docker engine. Under Docker Desktop / native Linux that IS
 * the machine LM Studio / whisper-server.exe run on; under a bare Docker
 * Engine inside a WSL2 distro, the engine's own host is the WSL2 VM — a
 * container's host.docker.internal lands on the VM's docker0 bridge gateway,
 * not on Windows (verified manually: connection refused). The real Windows
 * host is reachable only via the VM's own default-route gateway, read from
 * `/proc/net/route` inside the engine's network namespace.
 *
 * `parseDefaultGatewayFromProcNetRoute` is the pure parsing piece
 * `resolveBareEngineWindowsHostIp` funnels through; the docker-invoking half
 * needs a live engine and isn't unit-tested here, same as the existing
 * `checkModelsCachedOffline` helper it mirrors.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-bare-engine-gateway-test-'));

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

import { parseDefaultGatewayFromProcNetRoute } from '../dockerManager.js';

describe('parseDefaultGatewayFromProcNetRoute', () => {
  it('extracts the default gateway from a real /proc/net/route sample (bare WSL2 Engine)', () => {
    // Captured via `docker run --rm --network host alpine:3 cat /proc/net/route`
    // on an actual bare WSL2 Docker Engine — 0180A8C0 reversed is 192.168.128.1.
    const procNetRoute = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t0180A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0',
      'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
      'eth0\t0080A8C0\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0',
    ].join('\n');

    expect(parseDefaultGatewayFromProcNetRoute(procNetRoute)).toBe('192.168.128.1');
  });

  it('returns null when there is no default route', () => {
    const procNetRoute = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    ].join('\n');

    expect(parseDefaultGatewayFromProcNetRoute(procNetRoute)).toBeNull();
  });

  it('returns null for a default-destination row with a zero gateway (link-local, no gateway)', () => {
    const procNetRoute = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0',
    ].join('\n');

    expect(parseDefaultGatewayFromProcNetRoute(procNetRoute)).toBeNull();
  });

  it('returns null for empty or header-only input', () => {
    expect(parseDefaultGatewayFromProcNetRoute('')).toBeNull();
    expect(
      parseDefaultGatewayFromProcNetRoute('Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric'),
    ).toBeNull();
  });

  it('finds the default route regardless of its position among other routes', () => {
    const procNetRoute = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
      'br-abc123\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
      'eth0\t00000000\t0180A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0',
    ].join('\n');

    expect(parseDefaultGatewayFromProcNetRoute(procNetRoute)).toBe('192.168.128.1');
  });
});
