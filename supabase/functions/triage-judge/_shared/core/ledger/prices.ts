// Dated activation settings, never current-price claims. Core takes rows as arguments; no env/config reads.
export interface PriceRow {
  provider: string;
  modelId: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  asOf: string;
  verified: boolean;
}
export function validPrice(row: PriceRow): boolean {
  return row.verified === true && /^\d{4}-\d{2}-\d{2}$/.test(row.asOf) &&
    Number.isFinite(row.inputUsdPerMillion) && row.inputUsdPerMillion >= 0 &&
    Number.isFinite(row.outputUsdPerMillion) && row.outputUsdPerMillion >= 0 &&
    row.inputUsdPerMillion + row.outputUsdPerMillion > 0;
}
export function priceUsage(row: PriceRow, inputTokens: number, outputTokens: number): number {
  if (!validPrice(row) || !Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
      !Number.isSafeInteger(outputTokens) || outputTokens < 0) throw new Error('');
  return (inputTokens * row.inputUsdPerMillion + outputTokens * row.outputUsdPerMillion) / 1_000_000;
}
