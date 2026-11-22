import {
  createWindowContext,
  readWindowEvidence,
} from "../../src/core/brain/dream-replay/window.ts";
import { scanBrain } from "../../src/core/brain/dream-scan.ts";

export function makeTestDreamWindow(vault: string | null, instant: Date, checkpoint?: () => void) {
  const context = createWindowContext(instant, scanBrain(vault));
  context.setEvidence(readWindowEvidence(vault, context.signals, checkpoint));
  return context;
}
