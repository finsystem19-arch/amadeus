import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SUBSCRIPTION_FLOW_ID = "subscription-provider-execution";

/** The declared privacy-flow registry beside the packaged runtime, or in a source checkout. */
export function privacyFlowsPath(coordinatorRoot: string): string | null {
  const candidates = [
    resolve(coordinatorRoot, "..", "privacy-flows.json"),
    join(resolve(coordinatorRoot), "plugins", "amadeus", "privacy-flows.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Fail closed unless a subscription provider is declared in the public
 * privacy-flow registry (PRIVACY.md promises every external flow is declared).
 */
export function assertSubscriptionProviderDeclared(provider: string, flowsPath: string | null): void {
  if (!flowsPath) throw new Error("Privacy-flow registry not found; refusing to dispatch to a subscription provider");
  const registry = JSON.parse(readFileSync(flowsPath, "utf8")) as { defaultDecision?: string; flows?: Array<{ id?: string; allowedOrigins?: string[] }> };
  if (registry.defaultDecision !== "deny" || !Array.isArray(registry.flows)) throw new Error("Invalid privacy-flow registry");
  const flow = registry.flows.find((candidate) => candidate.id === SUBSCRIPTION_FLOW_ID);
  if (!flow?.allowedOrigins?.includes(provider)) {
    throw new Error(`Provider ${provider} is not declared in the privacy-flow registry; refusing to dispatch`);
  }
}

/** Fail closed unless the loopback local-model flow is declared in the same registry. */
export function assertLocalProviderDeclared(flowsPath: string | null): void {
  if (!flowsPath) throw new Error("Privacy-flow registry not found; refusing to dispatch to a local model");
  const registry = JSON.parse(readFileSync(flowsPath, "utf8")) as { defaultDecision?: string; flows?: Array<{ id?: string; allowedOrigins?: string[] }> };
  if (registry.defaultDecision !== "deny" || !Array.isArray(registry.flows)) throw new Error("Invalid privacy-flow registry");
  const flow = registry.flows.find((candidate) => candidate.id === "local-openai-compatible");
  if (!flow?.allowedOrigins?.includes("loopback")) {
    throw new Error("The loopback local-model flow is not declared in the privacy-flow registry; refusing to dispatch");
  }
}
