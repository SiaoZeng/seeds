// @os-eco/pi-seeds — pi-coding-agent extension that hard-wires seeds'
// session_start / agent_end rituals into pi lifecycle events.
//
// Step 2 (seeds-3a2a) wires:
//   • session_start — read pi config, render selected `sd prime` sections
//     into a memo, compute status counts, set the widget
//   • before_agent_start — append memoed sections to the system prompt
//   • agent_end — stat .seeds/issues.jsonl mtime; refresh widget when changed
//
// Subsequent plan steps fill in:
//   • seeds-adb1 — custom tools (sd_create, sd_ready, sd_show, sd_update, sd_close, sd_dep, sd_search)
//   • seeds-e9d0 — autocomplete (#sd-* completion + reference expansion)
//   • seeds-5103 — slash commands (/sd, /sd:ready, /sd:create, ...) + currentIssueId state
//   • seeds-89d2 — sd setup pi recipe + pi-aware onboarding marker variant

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
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

	async function refreshStatus(cwd: string, ui: ExtensionUIContext): Promise<void> {
		if (!resolved?.status_widget) return;
		status = await readStatus(cwd);
		if (!status) return;
		ui.setStatus(STATUS_KEY, formatStatusText(status.counts));
	}

	pi.on("session_start", async (_event, ctx) => {
		// Reset closures on every session_start (covers reload / new / resume).
		resolved = undefined;
		primedInjection = undefined;
		status = undefined;

		try {
			resolved = await readPiConfig(ctx.cwd);
		} catch {
			// Seeds not initialized in this project — extension stays inert.
			return;
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
	});

	pi.on("before_agent_start", (event) => {
		if (!resolved?.auto_prime) return;
		if (!primedInjection) return;
		const existing = event.systemPrompt;
		const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
		return { systemPrompt: `${existing}${separator}${primedInjection}\n` };
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!resolved?.status_widget) return;
		if (!resolved.cache.invalidate_on_write) return;
		const seedsDir = status?.seedsDir;
		if (!seedsDir) {
			await refreshStatus(ctx.cwd, ctx.ui);
			return;
		}
		const currentMtime = readIssuesMtime(seedsDir);
		if (currentMtime === undefined) return;
		if (status && currentMtime === status.mtimeMs) return;
		await refreshStatus(ctx.cwd, ctx.ui);
	});
}
