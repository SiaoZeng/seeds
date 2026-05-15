// Renders selected sections of `sd prime --json` for systemPrompt injection.
// Consumes the typed sections shape (PrimeSectionsFull) directly from the
// in-tree CLI rather than shelling out: the extension ships with the CLI in
// one package, so the type is the contract. Out-of-tree consumers that prefer
// subprocess + JSON should defensively fall back to the legacy `content` field
// — that's their problem; this extension imports the source of truth.

import { buildFullSections, type PrimeSectionsFull } from "../../../src/commands/prime.ts";
import type { PrimeSectionName } from "./config.ts";

export function getPrimeSections(): PrimeSectionsFull {
	return buildFullSections();
}

export function renderSelectedSections(
	sections: PrimeSectionsFull,
	names: readonly PrimeSectionName[],
): string {
	const lines: string[] = [];
	for (const name of names) {
		if (name === "closeProtocol") {
			lines.push("# Session Close Protocol");
			lines.push("");
			lines.push(`**CRITICAL**: ${sections.closeProtocol.warning}`);
			lines.push("");
			lines.push("```");
			sections.closeProtocol.steps.forEach((step, i) => {
				lines.push(`[ ] ${i + 1}. ${step}`);
			});
			lines.push("```");
			lines.push("");
			lines.push(sections.closeProtocol.footer);
			lines.push("");
		} else if (name === "rules") {
			lines.push("## Seeds Rules");
			for (const rule of sections.rules) {
				lines.push(`- ${rule}`);
			}
			lines.push("");
		} else if (name === "commandGroups") {
			lines.push("## Seeds Commands");
			lines.push("");
			for (const group of sections.commandGroups) {
				lines.push(`### ${group.name}`);
				if (group.notes) {
					for (const note of group.notes) {
						lines.push(note);
						lines.push("");
					}
				}
				for (const cmd of group.commands) {
					lines.push(`- \`${cmd.command}\` — ${cmd.description}`);
				}
				lines.push("");
			}
		} else if (name === "workflows") {
			lines.push("## Seeds Workflows");
			lines.push("");
			for (const wf of sections.workflows) {
				lines.push(`**${wf.name}:**`);
				lines.push("```bash");
				for (const c of wf.commands) {
					lines.push(c);
				}
				lines.push("```");
				lines.push("");
			}
		}
	}
	return lines.join("\n").trimEnd();
}

export function buildPrimeInjection(names: readonly PrimeSectionName[]): string {
	if (names.length === 0) return "";
	return renderSelectedSections(getPrimeSections(), names);
}
