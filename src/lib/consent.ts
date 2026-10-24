export interface ConsentState { cloudStorage: boolean; liveInference: boolean }
export const OFFLINE_CONSENT: Readonly<ConsentState> = Object.freeze({ cloudStorage: false, liveInference: false });
export function mayUseCloud(consent: ConsentState, userId: string | null, guardReady: boolean): boolean {
  return consent.cloudStorage === true && Boolean(userId) && guardReady;
}
export function mayUseInference(consent: ConsentState, userId: string | null, guardReady: boolean, enabled: boolean): boolean {
  return consent.liveInference === true && Boolean(userId) && guardReady && enabled;
}
export function inferenceNotice(provider: string): string {
  return `Live inference sends the masked value, rule id, path class, file basename and up to seven masked source lines to ${provider}. Your account also stores minimal budget/usage accounting: user, budget/request id, time, provider/model, units and estimated/actual cost. This does not opt in to storing rulings, full paths or source lines.`;
}
export const CLOUD_NOTICE = 'Cloud storage stores ruling ids, binding hashes, decisions, reason codes, sanitized notes and masked run summaries in your account. Raw values, full paths and source lines are excluded. Changing store mode clears this imported session; re-import to use that store. Existing local-only history is not automatically uploaded.';
