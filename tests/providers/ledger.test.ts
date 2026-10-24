import { describe, expect, it } from 'vitest';
import { MemoryCallLedger } from '../../src/core/ledger/callledger.ts';
import type { ReservationBinding } from '../../src/core/ledger/callledger.ts';
const binding = (id = 'request-1'): ReservationBinding => ({ requestId: id, attempt: 1, payloadHash: 'a'.repeat(64),
  provider: 'anthropic', modelId: 'test-model', units: 1, estimateUsd: 0.1, promptFingerprint: 'b'.repeat(64) });
describe('per-process eval ledger (not production accounting)', () => {
  it('idempotently binds a request, claims once, rejects payload borrowing', async () => {
    const ledger = new MemoryCallLedger({ capUsd: 1 });
    const a = await ledger.reserve(binding());
    expect((await ledger.reserve(binding())).usageId).toBe(a.usageId);
    expect(await Promise.all([ledger.claim(a.usageId), ledger.claim(a.usageId)])).toEqual([true, false]);
    await expect(ledger.reserve({ ...binding(), payloadHash: 'c'.repeat(64) })).rejects.toThrow();
    await ledger.settle(a.usageId, 'ambiguous');
    expect(ledger.chargedUsd).toBe(0.1);
    await ledger.settle(a.usageId, 'ambiguous');
    await expect(ledger.settle(a.usageId, 'settled', 0)).rejects.toThrow();
  });
  it('reserves before dispatch, keeps failed maxima and shares one cap across request ids', async () => {
    const ledger = new MemoryCallLedger({ capUsd: 0.15 });
    const a = await ledger.reserve(binding());
    await expect(ledger.reserve(binding('other-request'))).rejects.toThrow();
    await ledger.claim(a.usageId);
    await ledger.settle(a.usageId, 'failed');
    await expect(ledger.reserve(binding('third-request'))).rejects.toThrow();
    expect(ledger.chargedUsd).toBe(0.1);
  });
});
