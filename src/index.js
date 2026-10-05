// 统一出口：宿主只 import 这一个文件就够了。
export { DEFAULTS, MESSAGES, UNCOMPRESSED_LIMITS, resolveOptions, fail } from './limits.js';
export { planSegments, planTiles, overlapsOf } from './plan.js';
export { splitImageBuffer, splitRequestImages, wouldSplit, defaultPreamble, DATA_URL_PATTERN, DEFAULT_INPUT_FORMATS, DEFAULT_MARKER } from './split.js';
export { unavailablePart, stripRejectedImages, looksLikeImageRejection, REJECTION_PATTERN } from './fallback.js';
export { resolveDecoder, pickFormat, mimeOf, normalizeFormat, toBase64, fromBase64 } from './decoder.js';
