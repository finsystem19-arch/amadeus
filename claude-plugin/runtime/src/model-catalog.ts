import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Model that older goal packages recorded as their implicit default; kept only to read them. */
export const LEGACY_DEFAULT_CODEX_MODEL = "gpt-5.6-luna";

export type ListedModel = {
  slug: string;
  priority: number;
  supportedEfforts: string[];
};

export type ModelCatalog = {
  fetchedAt: string;
  models: ListedModel[];
};

const slugPattern = /^[a-z0-9][a-z0-9._-]{1,80}$/;
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

/** Use the signed-in Codex client's ranked model list; this never calls a model. */
export function readModelCatalog(home = process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? homedir(), ".codex")): ModelCatalog {
  const source = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8"));
  if (!Array.isArray(source.models) || typeof source.fetched_at !== "string") {
    throw new Error("Codex model catalog is incomplete");
  }
  const models = source.models
    .filter((model: any) => model.visibility === "list" && slugPattern.test(model.slug)
      && Number.isSafeInteger(model.priority) && model.priority >= 0)
    .map((model: any) => ({
      slug: model.slug as string,
      priority: model.priority as number,
      supportedEfforts: Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.map((level: any) => level?.effort).filter((effort: unknown): effort is string => typeof effort === "string" && efforts.has(effort))
        : [],
    }))
    .sort((a: ListedModel, b: ListedModel) => a.priority - b.priority || a.slug.localeCompare(b.slug));
  if (!models.length) throw new Error("Codex model catalog has no listed models");
  return { fetchedAt: source.fetched_at, models };
}
