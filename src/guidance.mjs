import { EXECUTABLE_GUIDANCE_CONTRACT } from './tool-contracts.mjs';

// Any version marker suppresses append so a caller-composed block is preserved.
// A marker alone does not prove a complete block or the current contract version.
const GUIDANCE_MARKER = /【可执行指导要求(?: v\d+)?】/;

// Opt-in deterministic assembly: append the fixed block only when requested and
// absent. The returned prompt is the canonical text that gets persisted,
// digested in pending state and reconciled on resume.
export function applyGuidanceBlock(prompt, guidance) {
  if (guidance !== true) return { prompt, appended: false };
  if (GUIDANCE_MARKER.test(prompt)) return { prompt, appended: false };
  return { prompt: `${prompt}\n\n${EXECUTABLE_GUIDANCE_CONTRACT}`, appended: true };
}
