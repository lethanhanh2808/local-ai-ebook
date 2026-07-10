import type { ChildProcess } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inflightCount, kill, killAll, track } from '@/worker/process-tracker';

function fakeChild() {
  const child = {
    pid: 1234,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  } as unknown as ChildProcess;
  return child;
}

afterEach(() => {
  killAll('test cleanup');
});

describe('process tracker', () => {
  it('releases only the process registered for a key', () => {
    const first = fakeChild();
    const second = fakeChild();
    const releaseFirst = track('chapter', first);
    const releaseSecond = track('chapter', second);

    releaseFirst();
    expect(inflightCount()).toBe(1);
    releaseSecond();
    expect(inflightCount()).toBe(0);
  });

  it('sends SIGTERM and removes a killed process immediately', () => {
    const child = fakeChild();
    track('chapter', child);

    expect(kill('chapter', 'user stop')).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(inflightCount()).toBe(0);
    expect(kill('chapter', 'duplicate stop')).toBe(false);
  });

  it('kills all tracked generators during worker shutdown', () => {
    const first = fakeChild();
    const second = fakeChild();
    track('one', first);
    track('two', second);

    expect(killAll('shutdown')).toBe(2);
    expect(first.kill).toHaveBeenCalledWith('SIGTERM');
    expect(second.kill).toHaveBeenCalledWith('SIGTERM');
    expect(inflightCount()).toBe(0);
  });
});
