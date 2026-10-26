export type ModelRoute = {
  provider: SubscriptionModelProvider | "cursor-browser-login";
  model: string | null;
  reasoningEffort?: string;
};
import type { ModelCatalog, ListedModel } from "./model-catalog.ts";

import { DEFAULT_TIER_MODELS, WORKER_PROVIDERS, isSubscriptionModelProvider, providerLabel, workerProvider,
  type CapabilityTierName, type SubscriptionModelProvider, type TierModels } from "./worker-providers.ts";
export { DEFAULT_TIER_MODELS, type CapabilityTierName, type SubscriptionModelProvider, type TierModels };

/**
 * The model for a capability tier on any provider: the owner's setting, else the
 * provider's default name, else the live catalog (best first: frontier, then
 * workhorse, then efficient). Null when nothing names a model for this tier.
 */
export function tierModelFor(provider: string, tier: CapabilityTierName, input: {
  catalog?: ListedModel[]; tierModels?: Partial<Record<string, TierModels>> | null }): string | null {
  const configured = input.tierModels?.[provider]?.[tier]?.trim();
  if (configured) return configured;
  const named = DEFAULT_TIER_MODELS[provider]?.[tier];
  if (named) return named;
  if (workerProvider(provider) && !workerProvider(provider)!.liveCatalog) return null;
  const ranked = input.catalog ?? [];
  const position = tier === "frontier" ? 0 : tier === "workhorse" ? 1 : 2;
  return ranked[Math.min(position, ranked.length - 1)]?.slug ?? null;
}

/**
 * Order the installed providers that can take work now. An owner preference
 * wins; otherwise the provider the host chat runs on, so one plan, one set of
 * tool behaviour and one model family handle the goal, and the other provider
 * is the reserve when this one fails or reaches its usage limit. With no
 * signal, Codex first.
 */
export function orderModelProviders(input: { available: SubscriptionModelProvider[];
  preferredProvider?: SubscriptionModelProvider | null; hostProvider?: SubscriptionModelProvider | null }): SubscriptionModelProvider[] {
  const registryOrder = (provider: SubscriptionModelProvider) => WORKER_PROVIDERS.findIndex((entry) => entry.id === provider);
  const rank = (provider: SubscriptionModelProvider) => provider === input.preferredProvider ? -2
    : input.hostProvider && provider === input.hostProvider ? -1
    : registryOrder(provider);
  return [...input.available].sort((a, b) => rank(a) - rank(b));
}
import { parseWindowsUiObjective, type WindowsUiCommand } from "./windows-ui-automation.ts";
/** A model route that a failed attempt can steer later attempts away from. */
export type AvoidableProvider = ModelRoute["provider"] | LocalModelRoute["provider"];
export type RoutingPolicy = "balanced-quality" | "quality-first";
export type DeterministicCommand = "npm-test" | "node-test" | "npm-build" | "npm-lint" | "npm-check" | "npm-typecheck" | WindowsUiCommand;
/** Local OpenAI-compatible route — only selected when pilot gate + qualification allow it. */
export type LocalModelRoute = {
  provider: "local-openai-compatible";
  model: string;
  reasoningEffort: string;
  endpoint?: string;
  providerId?: string;
};
export type WorkRoute = {
  provider: ModelRoute["provider"] | "software" | LocalModelRoute["provider"];
  model: string | null;
  reasoningEffort: string;
  reason: string;
  command?: DeterministicCommand;
  financialBasis: "no-model" | "subscription-suitability-not-price-comparison" | "no-subscription-local";
  /**
   * balanced-quality (default): cheapest capable tier. quality-first: never trade
   * reasoning for cost; local models take only routine steps they qualified for,
   * and every other step uses the provider's strongest tiers.
   */
  routingPolicy: RoutingPolicy;
  taskClass: "deterministic" | "routine-implementation" | "lightweight-reasoning" | "complex-reasoning" | "frontier-reasoning" | "provider-fallback" | "explicit";
  capabilityTier: "software" | "cursor-auto" | "efficient" | "workhorse" | "frontier" | "explicit" | "local-qualified";
  capabilitySignals: string[];
  localModelCandidate: boolean;
  endpoint?: string;
  providerId?: string;
};
export type RoutePlanStep = {
  step: "inspect" | "execute" | "verify";
  provider: WorkRoute["provider"];
  model: string | null;
  reasoningEffort: string;
  financialBasis: WorkRoute["financialBasis"];
  reason: string;
};
export type WorkRoutePlan = { schemaVersion: 1; primary: WorkRoute; steps: RoutePlanStep[] };

/**
 * `inherit` is a UI/configuration sentinel, not a provider model name.  It
 * must never reach a worker adapter.  Automatic routing represents that
 * choice by omitting the model and selecting a concrete route below.
 */
export function normalizeRouteModel(value: unknown, context: "automatic" | "pinned" = "automatic"): string | null {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const model = String(value).trim();
  if (model.toLowerCase() === "inherit") {
    if (context === "pinned") throw new Error("Invalid pinned model 'inherit'; specify a concrete model or leave routing automatic");
    return null;
  }
  return model;
}

export type WorkProfile = Pick<WorkRoute, "taskClass" | "capabilitySignals" | "localModelCandidate">;

/** Every model route a failed attempt can steer away from: each registered provider, Cursor, and the local model. */
function isRetryAvoidableProvider(value: unknown): value is AvoidableProvider {
  return isSubscriptionModelProvider(value) || value === "cursor-browser-login" || value === "local-openai-compatible";
}

export function providerToAvoidAfterAuthorizedRetry(input: {
  jobStatus: string;
  retryAuthorized: boolean;
  provider: unknown;
}): AvoidableProvider | null {
  if (input.jobStatus !== "failed" || !input.retryAuthorized) return null;
  return isRetryAvoidableProvider(input.provider) ? input.provider : null;
}

export function providersToAvoidForRetryChain(attemptsNewestFirst: Array<{
  jobStatus: string;
  retryAuthorized: boolean;
  provider: unknown;
  failureDetail?: unknown;
}>): AvoidableProvider[] {
  const avoided = new Set<AvoidableProvider>();
  let insideRetryChain = true;
  for (const attempt of attemptsNewestFirst) {
    const provider = isRetryAvoidableProvider(attempt.provider) ? attempt.provider : null;
    const hardEnvironmentFailure = attempt.jobStatus === "failed"
      && /\bisolation acceptance harness is unavailable\b/i.test(String(attempt.failureDetail ?? ""));
    if (provider && hardEnvironmentFailure) avoided.add(provider);
    if (insideRetryChain && attempt.jobStatus === "failed") {
      const retriedProvider = providerToAvoidAfterAuthorizedRetry(attempt);
      if (retriedProvider) avoided.add(retriedProvider);
    } else {
      insideRetryChain = false;
    }
  }
  return [...avoided];
}

/**
 * Classify the immediate work requested, not broad project-management wording.
 * Words such as "dependency-safe", "authoritative", "reconcile" and
 * "coherent milestone" describe normal operating discipline; they are not
 * evidence that a frontier or workhorse model is required.
 */
export function classifyWork(objective: string): WorkProfile {
  const signals: string[] = [];
  if (/\b(hardest|highest.capability|strongest|frontier|ambiguous|deep analysis|end.to.end|multi.system|novel architecture|repeated failures?)\b/i.test(objective)) {
    signals.push("explicit exceptional-complexity or repeated-failure requirement");
    return { taskClass: "frontier-reasoning", capabilitySignals: signals, localModelCandidate: false };
  }
  if (/\b(architecture|architectural|race condition|deadlock|concurrency|root cause|complex|security vulnerability|migration design)\b/i.test(objective)) {
    signals.push("explicit complex design, diagnosis, concurrency, migration, or security requirement");
    return { taskClass: "complex-reasoning", capabilitySignals: signals, localModelCandidate: false };
  }
  if (/\b(implement|build|fix|repair|refactor|add|create|develop|change|edit|update)\b/i.test(objective)) {
    signals.push("bounded repository implementation requested");
    return { taskClass: "routine-implementation", capabilitySignals: signals, localModelCandidate: false };
  }
  signals.push("no explicit complex-risk or repository-edit requirement");
  return { taskClass: "lightweight-reasoning", capabilitySignals: signals, localModelCandidate: true };
}

// Entire-step match, not arbitrary shell text or a word found in a larger goal.
export function deterministicCommand(objective: string): WorkRoute["command"] {
  const text = objective.trim().replace(/[.!]$/, "");
  const windowsUi = parseWindowsUiObjective(objective);
  if (windowsUi) return windowsUi;
  if (/^(?:run|execute)\s+(?:the\s+)?(?:local\s+)?(?:npm\s+)?tests?(?:\s+suite)?$/i.test(text)
    || /^(?:run|execute)\s+`?npm test`?$/i.test(text)) return "npm-test";
  if (/^(?:run|execute)\s+`?node --test`?$/i.test(text)) return "node-test";
  if (/^(?:run|execute)\s+(?:the\s+)?(?:local\s+)?build$/i.test(text)
    || /^(?:run|execute)\s+`?npm run build`?$/i.test(text)) return "npm-build";
  if (/^(?:run|execute)\s+(?:the\s+)?(?:local\s+)?lint(?:er| checks?)?$/i.test(text)
    || /^(?:run|execute)\s+`?npm run lint`?$/i.test(text)) return "npm-lint";
  if (/^(?:run|execute)\s+(?:the\s+)?(?:local\s+)?checks?$/i.test(text)
    || /^(?:run|execute)\s+`?npm run check`?$/i.test(text)) return "npm-check";
  if (/^(?:run|execute)\s+(?:the\s+)?(?:local\s+)?type[ -]?checks?$/i.test(text)
    || /^(?:run|execute)\s+`?npm run typecheck`?$/i.test(text)) return "npm-typecheck";
  return undefined;
}

export type QualifiedLocalModelCandidate = {
  providerId: string;
  model: string;
  endpoint?: string;
  /** Must be true only after approval + enable + capability qualification. */
  routable: boolean;
  /** Effort the local server accepts; "none" when unset. */
  reasoningEffort?: string;
};

export function selectWorkRoute(input: {
  objective: string;
  pinned?: ModelRoute | null;
  suggested?: ModelRoute | null;
  avoidProvider?: AvoidableProvider | null;
  /** Providers that already failed in this goal's retry chain. */
  avoidProviders?: AvoidableProvider[];
  cursorInstalled: boolean;
  /** Optional Claude signed-in route; never changes default Cursor/Codex selection when absent. */
  claudeInstalled?: boolean;
  /**
   * Every subscription provider that is installed, signed in and allowed. When
   * given it replaces codexInstalled/claudeInstalled, so new providers need no
   * routing change.
   */
  installedProviders?: SubscriptionModelProvider[];
  catalog: ModelCatalog;
  /**
   * Experimental 0.4 local-model path. Stable channel must pass
   * localModelPilotGateOpen=false (default) so candidates are ignored.
   */
  localModelPilotGateOpen?: boolean;
  qualifiedLocalModels?: QualifiedLocalModelCandidate[];
  /** A local Codex executable is available (default true: the catalog came from it). */
  codexInstalled?: boolean;
  /** The provider the host chat runs on; workers use the same one first. */
  hostProvider?: SubscriptionModelProvider | null;
  /** Owner preference between equal providers; overrides the host provider. */
  preferredProvider?: SubscriptionModelProvider | null;
  /** Providers whose usage window is exhausted right now; skipped like an uninstalled provider. */
  limitedProviders?: SubscriptionModelProvider[];
  /** Owner overrides of the model per tier, keyed by provider (see DEFAULT_TIER_MODELS). */
  tierModels?: Partial<Record<string, TierModels>> | null;
  /** Owner setting (worker config "routingPolicy"); balanced-quality when absent. */
  routingPolicy?: RoutingPolicy;
  /**
   * Windows UI plans act on the host desktop, outside every worker sandbox.
   * Only an objective the owner wrote may route to them; a worker-proposed
   * continuation is ordinary sandboxed model work. Defaults to false.
   */
  desktopAutomationAllowed?: boolean;
}): WorkRoute {
  const avoided = new Set<AvoidableProvider>([
    ...(input.avoidProvider ? [input.avoidProvider] : []),
    ...(input.avoidProviders ?? []),
  ]);
  const profile = classifyWork(input.objective);
  const policy: RoutingPolicy = input.routingPolicy === "quality-first" ? "quality-first" : "balanced-quality";
  const defaultCapabilityTier = (provider: ModelRoute["provider"]): WorkRoute["capabilityTier"] => {
    if (provider === "cursor-browser-login") return "cursor-auto";
    if (provider === "claude-subscription-signin") return "workhorse";
    return "efficient";
  };
  const modelRoute = (route: ModelRoute, reason: string,
    overrides: Partial<Pick<WorkRoute, "taskClass" | "capabilityTier" | "capabilitySignals" | "localModelCandidate">> = {}): WorkRoute => ({ ...route,
    model: normalizeRouteModel(route.model, input.pinned ? "pinned" : "automatic"),
    reasoningEffort: route.reasoningEffort ?? "low", reason,
    financialBasis: "subscription-suitability-not-price-comparison", routingPolicy: policy,
    taskClass: overrides.taskClass ?? profile.taskClass,
    capabilityTier: overrides.capabilityTier ?? defaultCapabilityTier(route.provider),
    capabilitySignals: overrides.capabilitySignals ?? profile.capabilitySignals,
    localModelCandidate: overrides.localModelCandidate ?? profile.localModelCandidate });
  if (input.pinned) {
    if (input.pinned.provider === "claude-subscription-signin" && input.claudeInstalled !== true) {
      throw new Error("Pinned Claude route requires an available signed-in Claude environment");
    }
    return modelRoute(input.pinned, "Preserved explicit provider/model selection.", {
      taskClass: "explicit", capabilityTier: "explicit", capabilitySignals: ["explicit provider/model selection"], localModelCandidate: false,
    });
  }
  const detected = deterministicCommand(input.objective);
  const command = detected?.startsWith("windows-ui-") && input.desktopAutomationAllowed !== true ? undefined : detected;
  if (command) return { provider: "software", model: null, reasoningEffort: "none", command,
    reason: command.startsWith("windows-ui-")
      ? "Exact allowlisted Windows UI plan: use deterministic host software without a model call."
      : "Exact supported test command: run ordinary software without a model call.", financialBasis: "no-model",
    routingPolicy: policy, taskClass: "deterministic", capabilityTier: "software",
    capabilitySignals: ["exact supported deterministic command"], localModelCandidate: false };
  const suggestedProvider = input.suggested?.provider;
  const suggestionAvailable = !avoided.has(suggestedProvider as ModelRoute["provider"]) && (
    suggestedProvider === "cursor-browser-login" ? input.cursorInstalled
    : suggestedProvider === "codex-chatgpt-signin" ? input.catalog.models.some(model => model.slug === input.suggested?.model)
    : workerProvider(suggestedProvider)
      ? (input.installedProviders ? input.installedProviders.includes(suggestedProvider as SubscriptionModelProvider)
        : suggestedProvider === "claude-subscription-signin" && input.claudeInstalled === true)
      : false);
  if (input.suggested && suggestionAvailable) {
    return modelRoute(input.suggested, "Worker requested a different route for this next step; retained within the approved task.", {
      taskClass: "explicit", capabilityTier: "explicit", capabilitySignals: ["worker-requested provider/model handoff"], localModelCandidate: false,
    });
  }
  // Qualified local models sit after ordinary software and before Cursor/Codex,
  // but only when the experimental pilot gate is open (never on stable 0.3.x).
  // quality-first also gives them bounded implementation, which independent
  // verification checks and a failed attempt escalates (see below).
  const localEligible = profile.localModelCandidate
    || policy === "quality-first" && profile.taskClass === "routine-implementation";
  if (input.localModelPilotGateOpen === true && localEligible && !avoided.has("local-openai-compatible")) {
    const local = (input.qualifiedLocalModels ?? []).find((candidate) => candidate.routable === true && candidate.model);
    if (local) {
      return {
        provider: "local-openai-compatible",
        model: local.model,
        reasoningEffort: local.reasoningEffort ?? "none",
        endpoint: local.endpoint,
        providerId: local.providerId,
        reason: "Qualified local OpenAI-compatible model selected behind open experimental pilot gate.",
        financialBasis: "no-subscription-local",
        routingPolicy: policy,
        taskClass: profile.taskClass,
        capabilityTier: "local-qualified",
        capabilitySignals: [...profile.capabilitySignals, "local-model-pilot-gate-open", "capability-qualified"],
        localModelCandidate: true,
      };
    }
  }
  const ranked = input.catalog.models;
  const limited = new Set(input.limitedProviders ?? []);
  const declared: SubscriptionModelProvider[] = input.installedProviders ?? [
    ...(input.codexInstalled !== false ? ["codex-chatgpt-signin" as const] : []),
    ...(input.claudeInstalled === true ? ["claude-subscription-signin" as const] : []),
  ];
  // A provider whose tiers come from a live catalog needs that catalog to route.
  const installed = declared.filter((provider) => !limited.has(provider)
    && (!workerProvider(provider)?.liveCatalog || ranked.length > 0));
  const order = orderModelProviders({ available: installed.filter((provider) => !avoided.has(provider)),
    preferredProvider: input.preferredProvider ?? null, hostProvider: input.hostProvider ?? null });
  const selectionSignal = input.preferredProvider && order[0] === input.preferredProvider ? "owner provider preference"
    : input.hostProvider && order[0] === input.hostProvider ? "same provider as the host chat"
    : order[0] && limited.size > 0 ? "other provider is at its usage limit"
    : input.hostProvider && order[0] ? "host chat's provider unavailable; using the other provider"
    : order.length === 1 && installed.length === 1 ? "only installed model provider" : "default provider order";
  /** A capability tier on the first available provider (or a named one). */
  const tierRoute = (tier: CapabilityTierName, desiredEffort: string, reason: string,
    overrides: Parameters<typeof modelRoute>[2] = {}, provider: SubscriptionModelProvider | undefined = order[0]): WorkRoute => {
    if (!provider && limited.size > 0) throw new Error("Every installed subscription model provider is at its usage limit");
    // The same rule for every provider (see tierModelFor).
    const routed: SubscriptionModelProvider = provider ?? "codex-chatgpt-signin";
    const catalog = workerProvider(routed)?.liveCatalog ? ranked : [];
    const slug = tierModelFor(routed, tier, { catalog, tierModels: input.tierModels });
    // A provider with a live catalog must name a model; others may use their CLI's default model.
    if (!slug && workerProvider(routed)?.liveCatalog !== false) throw new Error("No installed subscription model provider is available for this step");
    // A catalog entry states which efforts the model supports; otherwise pass the tier's effort through.
    const listed = catalog.find((entry) => entry.slug === slug);
    const effort = !listed ? desiredEffort
      : listed.supportedEfforts.includes(desiredEffort) ? desiredEffort
      : listed.supportedEfforts.includes("medium") ? "medium"
      : listed.supportedEfforts[0];
    if (!effort) throw new Error(`No supported reasoning effort for ${slug ?? routed}`);
    return modelRoute({ provider: routed, model: slug, reasoningEffort: effort }, reason, {
      ...overrides, capabilityTier: tier,
      capabilitySignals: [...(overrides.capabilitySignals ?? profile.capabilitySignals), ...(installed.length > 1 || limited.size > 0 || routed !== "codex-chatgpt-signin" ? [selectionSignal] : [])] });
  };
  const fallback = (signal: string) => ({ taskClass: "provider-fallback" as const, capabilitySignals: [signal], localModelCandidate: false });
  if (avoided.has("cursor-browser-login") && order.length > 0) {
    return tierRoute("efficient", "low", `The previous diagnosed Cursor attempt failed; switch to the efficient ${providerLabel(order[0])} tier for the corrected replacement instead of repeating it.`,
      fallback("diagnosed Cursor provider failure requires one alternate-provider replacement"));
  }
  const modelFailed = installed.filter((provider) => avoided.has(provider));
  if (modelFailed.length > 0 && !avoided.has("cursor-browser-login") && input.cursorInstalled) {
    return modelRoute({ provider: "cursor-browser-login", model: "auto" },
      "The previous diagnosed model-provider attempt failed; switch provider for the corrected replacement instead of repeating it.", {
        taskClass: "provider-fallback", capabilityTier: "cursor-auto",
        capabilitySignals: ["diagnosed provider failure requires one alternate-provider replacement"], localModelCandidate: false,
      });
  }
  if (avoided.has("local-openai-compatible") && modelFailed.length === 0 && order.length > 0) {
    return tierRoute(policy === "quality-first" ? "frontier" : "workhorse", "high",
      `The local model's attempt failed; escalate to ${providerLabel(order[0])} instead of repeating it.`,
      fallback("diagnosed local-model failure escalates to a subscription provider"));
  }
  if (modelFailed.length > 0 && order.length > 0) {
    return tierRoute("efficient", "low", `The previous diagnosed attempt failed; use ${providerLabel(order[0])} for the corrected replacement instead of repeating the same provider.`,
      fallback("diagnosed provider failure requires one alternate-provider replacement"));
  }
  if (modelFailed.length > 0) {
    // Every provider failed once: retry on a stronger tier rather than dead-ending the goal.
    const strongest = orderModelProviders({ available: installed,
      preferredProvider: input.preferredProvider ?? null, hostProvider: input.hostProvider ?? null })[0];
    return tierRoute("workhorse", "medium",
      `Every available provider failed in this corrected retry chain; resume with a stronger ${providerLabel(strongest)} route instead of dead-ending the approved goal.`,
      fallback("all alternate subscription providers were exercised; a verified correction permits a distinct stronger retry"), strongest);
  }
  if (profile.taskClass === "frontier-reasoning") {
    return tierRoute("frontier", "high", "Exceptional complexity is explicit: use the top capability tier of the selected provider.");
  }
  if (policy === "quality-first") {
    // Never trade reasoning for cost: complex work gets the top tier, everything else the workhorse tier.
    return profile.taskClass === "complex-reasoning"
      ? tierRoute("frontier", "high", "Quality first: complex design or diagnosis uses the top capability tier of the selected provider.")
      : tierRoute("workhorse", "high", "Quality first: use the workhorse tier of the selected provider at high effort.");
  }
  if (profile.taskClass === "complex-reasoning") {
    return tierRoute("workhorse", "medium", "Complex design or diagnosis is explicit: use the workhorse tier of the selected provider.");
  }
  if (profile.taskClass === "routine-implementation" && input.cursorInstalled) {
    return modelRoute({ provider: "cursor-browser-login", model: "auto" },
      "Routine implementation: use installed Cursor Auto as an opaque server-selected subscription route; independent local verification protects quality.", {
        capabilityTier: "cursor-auto",
      });
  }
  const providerName = providerLabel(order[0] ?? "codex-chatgpt-signin");
  return tierRoute("efficient", "low", profile.taskClass === "routine-implementation"
    ? `Cursor is unavailable; use the efficient ${providerName} tier for the bounded implementation.`
    : `Lightweight reasoning: use the efficient ${providerName} tier.`);
}

/** A visible step plan: deterministic preparation and verification surround the one model/tool step that needs judgment or editing. */
export function planWorkRoute(input: Parameters<typeof selectWorkRoute>[0]): WorkRoutePlan {
  const primary = selectWorkRoute(input);
  const software = (step: "inspect" | "verify", reason: string): RoutePlanStep => ({
    step, provider: "software", model: null, reasoningEffort: "none", financialBasis: "no-model", reason,
  });
  const steps: RoutePlanStep[] = [software("inspect", "Refresh and validate project files and execution boundaries without a model call")];
  steps.push({ step: "execute", provider: primary.provider, model: primary.model,
    reasoningEffort: primary.reasoningEffort, financialBasis: primary.financialBasis, reason: primary.reason });
  if (primary.provider !== "software") {
    steps.push(software("verify", "Run universal patch-integrity and explicitly declared project checks in isolation before applying changes"));
  }
  return { schemaVersion: 1, primary, steps };
}

export function hasCompletedProviderResult(jsonl: string, provider: string): boolean {
  try {
    const rows = jsonl.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    if (provider === "cursor-browser-login") {
      const results = rows.filter(row => row.type === "result");
      return results.length === 1 && results[0].subtype === "success" && results[0].is_error === false;
    }
    if (provider === "codex-chatgpt-signin" || provider === "local-openai-compatible") {
      return rows.filter(row => row.type === "turn.completed").length === 1
        && !rows.some(row => row.type === "turn.failed" || row.type === "error");
    }
    if (provider === "claude-subscription-signin") {
      const results = rows.filter(row => row.type === "result");
      return results.length === 1 && results[0].is_error !== true && results[0].subtype !== "error";
    }
    return false;
  } catch { return false; }
}
