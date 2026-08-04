/**
 * pi model catalog lookup — replaces name-heuristic with pi's built-in
 * provider model directory. Provides reasoning flag + thinking levels
 * for a given model id, or empty for unknown models (L2 test is the truth).
 */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

// Build flat model index once at module load (static catalog, no network).
const allProviders = builtinProviders();
const modelIndex = new Map<string, { reasoning: boolean; thinkingLevels: string[] }>();

for (const provider of allProviders) {
  const models = provider.getModels?.() ?? [];
  for (const model of models) {
    if (!model?.id) continue;
    const levels = getSupportedThinkingLevels(model);
    modelIndex.set(model.id, {
      reasoning: !!model.reasoning,
      thinkingLevels: levels,
    });
  }
}

/**
 * Look up a model's reasoning capability and supported thinking levels
 * from the pi built-in catalog.
 *
 * Returns empty arrays for unknown models — the L2 thinking test is the
 * final arbiter (per spec ⑤: "目录管展示、测试管真相").
 */
export function lookupModelMeta(modelId: string): {
  reasoning: boolean;
  thinking_levels: string[];
} {
  const hit = modelIndex.get(modelId);
  if (!hit) return { reasoning: false, thinking_levels: [] };
  return { reasoning: hit.reasoning, thinking_levels: hit.thinkingLevels };
}
