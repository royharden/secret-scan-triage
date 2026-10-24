// Feature computation over a raw candidate (runs inside the parse worker / Node eval only).
// Output contains no raw substrings.
import type { Features, RawCandidate } from '../finding.ts';
import { shannonEntropy } from './entropy.ts';
import { classifyChars, classifyPath } from './charclass.ts';
import { entropyBucket, lengthBucket } from './buckets.ts';

export { shannonEntropy } from './entropy.ts';
export { classifyChars, classifyPath } from './charclass.ts';
export {
  LENGTH_BUCKETS,
  ENTROPY_BUCKETS,
  ENTROPY_CLASS_THRESHOLDS,
  SHORT_STRING_ENTROPY_FACTOR,
  lengthBucket,
  entropyBucket,
  entropyThreshold,
} from './buckets.ts';
export {
  isUuidShape,
  isCommitShape,
  isHexDigestShape,
  isDataUriBase64,
  pemInfo,
  isRepeatedChar,
  isIdentifierShape,
  isPathLike,
} from './shapes.ts';
export type { PemInfo } from './shapes.ts';

/** Entropy is always computed here from the raw value; scanner-reported entropy is never used. */
export function computeFeatures(raw: RawCandidate): Features {
  const value = typeof raw.rawValue === 'string' ? raw.rawValue : '';
  const entropy = shannonEntropy(value);
  return {
    length: value.length,
    charClass: classifyChars(value),
    entropy,
    lengthBucket: lengthBucket(value.length),
    entropyBucket: entropyBucket(entropy),
    pathClass: classifyPath(raw.path),
  };
}
