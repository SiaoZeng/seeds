// @os-eco/pi-seeds — pi-coding-agent extension that hard-wires seeds'
// session_start / agent_end rituals into pi lifecycle events.
//
// Wired today:
//   • session_start — read pi config, render selected `sd prime` sections,
//     compute status counts, refresh the ready-list cache, register the
//     `#sd-*` autocomplete provider (seeds-3a2a + seeds-e9d0)
//   • before_agent_start — append memoed sections to the system prompt
//   • agent_end — stat .seeds/issues.jsonl mtime; refresh widget + ready cache
//   • input — expand `#sd-<id>` references into a hidden <seeds-context>
//     block, capped at pi.reference_expansion.max_refs (seeds-e9d0)
//   • Tools — sd_create, sd_ready, sd_show, sd_update, sd_close, sd_dep,
//     sd_search (seeds-adb1)
//
// Subsequent plan steps fill in:
//   • seeds-5103 — slash commands (/sd, /sd:ready, /sd:create, ...) + currentIssueId state
//   • seeds-89d2 — sd setup pi recipe + pi-aware onboarding marker variant

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { findSeedsDir } from "../../src/config.ts";
import {
	bindSeedsAutocomplete,
	createSeedsAutocompleteFactory,
	type ReadyCache,
	type ReadyItem,
	readReadyItems,
} from "./lib/autocomplete.ts";
import { type ResolvedPiConfig, readPiConfig } from "./lib/config.ts";
import { buildPrimeInjection } from "./lib/prime.ts";
import {
	formatStatusText,
	readIssuesMtime,
	readStatus,
	type StatusSnapshot,
} from "./lib/status.ts";
import { registerSeedsTools } from "./lib/tools.ts";

const STATUS_KEY = "seeds";

export default function piSeedsExtension(pi: ExtensionAPI): void {
	// Tools register once at load time (pi expects a stable tool surface across
	// reloads). They derive cwd from ctx on each call, so seeds-init state is
	// resolved per-invocation rather than at registration.
	registerSeedsTools(pi);

	// Resolved at session_start so config edits take effect on /reload without
	// re-installing the extension. Subsequent hooks read this via the closure.
	let resolved: ResolvedPiConfig | undefined;
	let primedInjection: string | undefined;
	let status: StatusSnapshot | undefined;
	let readyItems: ReadyItem[] = [];
	let autocompleteRegistered = false;
	// Tracked independently of `status` so cache invalidation works even when
	// status_widget is disabled.
	let lastSeedsDir: string | undefined;
	let lastIssuesMtimeMs: number | undefined;

	const readyCache: ReadyCache = { get: () => readyItems };

	// Reference expansion fires from pi.on("input"), which is registered at
	// load time. It reads `resolved` from this closure so it stays a no-op
	// until session_start populates the config (or when seeds isn't initialized).
	bindSeedsAutocomplete(pi, {
		cache: readyCache,
		getMaxRefs: () => resolved?.reference_expansion.max_refs ?? 0,
		isEnabled: () => resolved !== undefined,
	});

	async function refreshStatus(cwd: string, ui: ExtensionUIContext): Promise<void> {
		if (!resolved?.status_widget) return;
		status = await readStatus(cwd);
		if (!status) return;
		lastSeedsDir = status.seedsDir;
		lastIssuesMtimeMs = status.mtimeMs;
		ui.setStatus(STATUS_KEY, formatStatusText(status.counts));
	}

	async function refreshReadyCache(cwd: string): Promise<void> {
		const items = await readReadyItems(cwd);
		readyItems = items ?? [];
		if (lastSeedsDir) {
			const mtime = readIssuesMtime(lastSeedsDir);
			if (mtime !== undefined) lastIssuesMtimeMs = mtime;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		// Reset closures on every session_start (covers reload / new / resume).
		resolved = undefined;
		primedInjection = undefined;
		status = undefined;
		readyItems = [];
		lastSeedsDir = undefined;
		lastIssuesMtimeMs = undefined;

		try {
			resolved = await readPiConfig(ctx.cwd);
		} catch {
			// Seeds not initialized in this project — extension stays inert.
			return;
		}

		try {
			lastSeedsDir = await findSeedsDir(ctx.cwd);
		} catch {
			// already caught above
		}

		if (resolved.auto_prime && resolved.prime.sections.length > 0) {
			try {
				const injection = buildPrimeInjection(resolved.prime.sections);
				primedInjection = injection.length > 0 ? injection : undefined;
			} catch {
				primedInjection = undefined;
			}
		}

		if (resolved.status_widget) {
			try {
				await refreshStatus(ctx.cwd, ctx.ui);
			} catch {
				// best-effort
			}
		}

		try {
			await refreshReadyCache(ctx.cwd);
		} catch {
			// best-effort — autocomplete just shows an empty list.
		}

		if (!autocompleteRegistered) {
			ctx.ui.addAutocompleteProvider(createSeedsAutocompleteFactory(readyCache));
			autocompleteRegistered = true;
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!resolved?.auto_prime) return;
		if (!primedInjection) return;
		const existing = event.systemPrompt;
		const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
		return { systemPrompt: `${existing}${separator}${primedInjection}\n` };
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!resolved) return;
		if (!resolved.cache.invalidate_on_write) return;
		if (!lastSeedsDir) return;
		const currentMtime = readIssuesMtime(lastSeedsDir);
		if (currentMtime === undefined) return;
		if (currentMtime === lastIssuesMtimeMs) return;
		if (resolved.status_widget) {
			await refreshStatus(ctx.cwd, ctx.ui);
		}
		await refreshReadyCache(ctx.cwd);
		lastIssuesMtimeMs = currentMtime;
	});
}
