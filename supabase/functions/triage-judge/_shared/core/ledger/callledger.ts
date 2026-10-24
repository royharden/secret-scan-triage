// Per-attempt accounting seam. Production uses durable RPCs; MemoryCallLedger is ONLY for one Node eval process.
export type UsageStatus = 'reserved' | 'dispatching' | 'settled' | 'failed' | 'ambiguous';
export interface ReservationBinding {
  requestId: string;
  attempt: 1 | 2;
  payloadHash: string;
  provider: string;
  modelId: string;
  units: number;
  estimateUsd: number;
  promptFingerprint: string;
}
export interface UsageReservation {
  usageId: string;
  status: UsageStatus;
  estimateUsd: number;
  actualUsd: number | null;
}
export interface CallLedger {
  reserve(binding: ReservationBinding): Promise<UsageReservation>;
  claim(usageId: string): Promise<boolean>;
  settle(usageId: string, outcome: 'settled' | 'failed' | 'ambiguous', actualUsd?: number): Promise<void>;
}
interface MemoryRow extends UsageReservation { binding: ReservationBinding }
export class MemoryCallLedger implements CallLedger {
  readonly capUsd: number;
  private readonly rows = new Map<string, MemoryRow>();
  private readonly keys = new Map<string, string>();
  private nextId = 0;
  constructor(opts: { capUsd: number }) {
    if (!Number.isFinite(opts.capUsd) || opts.capUsd <= 0) throw new Error('');
    this.capUsd = opts.capUsd;
  }
  get chargedUsd(): number {
    let total = 0;
    for (const row of this.rows.values()) total += row.actualUsd ?? row.estimateUsd;
    return total;
  }
  snapshot(): UsageReservation[] {
    return [...this.rows.values()].map(({ usageId, status, estimateUsd, actualUsd }) => ({ usageId, status, estimateUsd, actualUsd }));
  }
  async reserve(binding: ReservationBinding): Promise<UsageReservation> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(binding.requestId) || !/^[a-f0-9]{64}$/.test(binding.payloadHash) ||
        ![1, 2].includes(binding.attempt) || !Number.isSafeInteger(binding.units) || binding.units < 1 ||
        !Number.isFinite(binding.estimateUsd) || binding.estimateUsd <= 0) throw new Error('');
    const key = `${binding.requestId}:${binding.attempt}`;
    const prior = this.keys.get(key);
    if (prior) {
      const row = this.rows.get(prior)!;
      if (JSON.stringify(row.binding) !== JSON.stringify(binding)) throw new Error('');
      return { ...row };
    }
    // No await between aggregate check and insertion: one process, one synchronous critical section.
    if (this.chargedUsd + binding.estimateUsd > this.capUsd) throw new Error('');
    const row: MemoryRow = { usageId: `usage-${++this.nextId}`, status: 'reserved', estimateUsd: binding.estimateUsd,
      actualUsd: null, binding: { ...binding } };
    this.keys.set(key, row.usageId);
    this.rows.set(row.usageId, row);
    return { ...row };
  }
  async claim(usageId: string): Promise<boolean> {
    const row = this.rows.get(usageId);
    if (!row || row.status !== 'reserved') return false;
    row.status = 'dispatching';
    return true;
  }
  async settle(usageId: string, outcome: 'settled' | 'failed' | 'ambiguous', actualUsd?: number): Promise<void> {
    const row = this.rows.get(usageId);
    if (!row) throw new Error('');
    const actual = outcome === 'settled' ? actualUsd : row.estimateUsd;
    if (typeof actual !== 'number' || !Number.isFinite(actual) || actual < 0 || actual > row.estimateUsd) throw new Error('');
    if (row.status === outcome && row.actualUsd === actual) return;
    if (row.status !== 'dispatching') throw new Error('');
    row.status = outcome;
    row.actualUsd = actual;
  }
}
