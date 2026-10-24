// S-F11 path_test_fixture_docs: weak, DOWNGRADE ONLY. A test/fixture/docs path can move keep -> review in policy, never
// review -> dismiss (traps T06, T08: real-format tokens in test and docs paths are never dismissed by path alone).
import type { PathClass } from '../finding.ts';
import type { SignalContext, SignalHit } from './shapes.ts';

export const DOWNGRADE_PATH_CLASSES: ReadonlyArray<PathClass> = ['test', 'fixture', 'docs'];

export function evalPathSignals(ctx: SignalContext): SignalHit[] {
  if (DOWNGRADE_PATH_CLASSES.includes(ctx.features.pathClass)) return [{ id: 'S-F11', pointer: ctx.span.pointer }];
  return [];
}
