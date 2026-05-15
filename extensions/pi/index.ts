// @os-eco/pi-seeds — pi-coding-agent extension that hard-wires seeds'
// session_start / agent_end rituals into pi lifecycle events.
//
// Step 1 (seeds-2774) ships only the skeleton: imports, config resolution,
// and a stub default export that subsequent plan steps fill in:
//   • seeds-3a2a — session_start auto-prime + status widget + agent_end cache invalidation
//   • seeds-adb1 — custom tools (sd_create, sd_ready, sd_show, sd_update, sd_close, sd_dep, sd_search)
//   • seeds-e9d0 — autocomplete (#sd-* completion + reference expansion)
//   • seeds-5103 — slash commands (/sd, /sd:ready, /sd:create, ...) + currentIssueId state
//   • seeds-89d2 — sd setup pi recipe + pi-aware onboarding marker variant
//
// Imports from @earendil-works/pi-coding-agent and typebox are declared as
// peerDependencies (optional) in package.json so CLI-only users do not pay
// the peer-dep noise. The extension is loaded by pi via the `pi.extensions`
// manifest entry in package.json which points at this file.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ResolvedPiConfig, readPiConfig } from "./lib/config.ts";

export default function piSeedsExtension(pi: ExtensionAPI): void {
	// Resolved at session_start so config edits take effect on /reload without
	// re-installing the extension. Subsequent hooks read this via the closure.
	let resolved: ResolvedPiConfig | undefined;

	pi.on("session_start", async (_event, ctx) => {
		try {
			resolved = await readPiConfig(ctx.cwd);
		} catch {
			// Seeds not initialized in this project — extension stays inert.
			resolved = undefined;
			return;
		}
		// seeds-3a2a wires `sd prime --json` typed sections here and stashes
		// the rendered markdown for the before_agent_start hook to inject.
		void resolved;
	});

	// Stubs for subsequent plan steps. Wiring them here (rather than adding
	// the `pi.on(...)` calls in later commits) keeps the lifecycle-registration
	// surface visible in one place for review.
	pi.on("before_agent_start", () => {
		// seeds-3a2a: inject systemPrompt with primed sections.
	});
	pi.on("agent_end", () => {
		// seeds-3a2a: stat .seeds/issues.jsonl mtime; refresh ready cache + status widget.
	});
}
