// Autocomplete provider + reference expansion for @os-eco/pi-seeds (seeds-e9d0).
//
// Two surfaces:
//   1. `addAutocompleteProvider` wraps pi's built-in provider so that typing
//      `#sd-` in the input opens a list of cached ready issues. Selecting one
//      inserts the full `#sd-<id>` token. Cache is read at session_start and
//      refreshed by index.ts on agent_end (alongside the status widget) when
//      .seeds/issues.jsonl mtime changes.
//   2. `expandSeedsReferences` runs on the `input` event. It scans the message
//      for `#sd-<id>` tokens, capped at `pi.reference_expansion.max_refs` unique
//      references per message, and prepends a hidden <seeds-context> block with
//      the JSON shape of each referenced issue.
//
// The autocomplete provider strictly wraps `current`: any prefix we don't claim
// (i.e. cursor is not at a `#sd-` token) falls through to the underlying
// CombinedAutocompleteProvider so file/at/slash completions keep working.

import type {
	AutocompleteProviderFactory,
	ExecResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { findSeedsDir } from "../../../src/config.ts";
import { readIssues } from "../../../src/store.ts";
import type { Issue } from "../../../src/types.ts";

export interface ReadyItem {
	id: string;
	title: string;
	priority: number;
	type: string;
}

export function computeReadyItems(issues: Issue[]): ReadyItem[] {
	const closedIds = new Set(issues.filter((i) => i.status === "closed").map((i) => i.id));
	const items: ReadyItem[] = [];
	for (const issue of issues) {
		if (issue.status === "closed") continue;
		const blockers = issue.blockedBy ?? [];
		if (blockers.some((bid) => !closedIds.has(bid))) continue;
		items.push({
			id: issue.id,
			title: issue.title,
			priority: issue.priority,
			type: issue.type,
		});
	}
	// Same ordering as `sd ready` defaults: priority asc, then id asc (mx-68e9eb).
	items.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
	return items;
}

export async function readReadyItems(cwd: string): Promise<ReadyItem[] | undefined> {
	let seedsDir: string;
	try {
		seedsDir = await findSeedsDir(cwd);
	} catch {
		return undefined;
	}
	const issues = await readIssues(seedsDir);
	return computeReadyItems(issues);
}

// Trigger when the cursor sits at the end of a `#sd-<chars>` substring. The
// character class accepts alphanumerics, `-`, and `_` so partial project ids
// like `#sd-seeds-e9` complete cleanly.
const PREFIX_REGEX = /#sd-[A-Za-z0-9_-]*$/;

export interface RefPrefix {
	text: string;
	queryAfter: string;
}

export function extractRefPrefix(line: string, col: number): RefPrefix | undefined {
	const before = line.slice(0, col);
	const m = PREFIX_REGEX.exec(before);
	if (!m) return undefined;
	const text = m[0];
	const queryAfter = text.slice("#sd-".length).toLowerCase();
	return { text, queryAfter };
}

export function filterReadyItems(
	items: readonly ReadyItem[],
	query: string,
	limit = 20,
): ReadyItem[] {
	if (query.length === 0) return items.slice(0, limit);
	const q = query.toLowerCase();
	const out: ReadyItem[] = [];
	for (const item of items) {
		if (out.length >= limit) break;
		if (item.id.toLowerCase().includes(q)) {
			out.push(item);
		}
	}
	return out;
}

export function buildAutocompleteItems(items: readonly ReadyItem[]): AutocompleteItem[] {
	return items.map((it) => ({
		value: `#sd-${it.id}`,
		label: `#sd-${it.id}`,
		description: `P${it.priority} ${it.type} — ${it.title}`,
	}));
}

export interface ReadyCache {
	get(): readonly ReadyItem[];
}

export function createSeedsAutocompleteFactory(cache: ReadyCache): AutocompleteProviderFactory {
	return (current: AutocompleteProvider): AutocompleteProvider => {
		const wrapped: AutocompleteProvider = {
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const line = lines[cursorLine] ?? "";
				const prefix = extractRefPrefix(line, cursorCol);
				if (!prefix) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}
				const matches = filterReadyItems(cache.get(), prefix.queryAfter);
				const suggestions: AutocompleteSuggestions = {
					items: buildAutocompleteItems(matches),
					prefix: prefix.text,
				};
				return suggestions;
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				if (item.value.startsWith("#sd-")) {
					return applySeedsCompletion(lines, cursorLine, cursorCol, item, prefix);
				}
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
		};
		if (current.shouldTriggerFileCompletion) {
			wrapped.shouldTriggerFileCompletion = (lines, cursorLine, cursorCol) => {
				const line = lines[cursorLine] ?? "";
				if (extractRefPrefix(line, cursorCol)) return false;
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
			};
		}
		return wrapped;
	};
}

export function applySeedsCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const line = lines[cursorLine] ?? "";
	const before = line.slice(0, cursorCol);
	if (!before.endsWith(prefix)) {
		// Out-of-band: prefix moved while suggestions resolved. Leave line as-is.
		return { lines, cursorLine, cursorCol };
	}
	const head = before.slice(0, before.length - prefix.length);
	const tail = line.slice(cursorCol);
	const newLine = `${head}${item.value}${tail}`;
	const newLines = lines.slice();
	newLines[cursorLine] = newLine;
	return {
		lines: newLines,
		cursorLine,
		cursorCol: head.length + item.value.length,
	};
}

// Reference expansion -----------------------------------------------------

// Matches `#sd-<id>` where <id> is any non-trivial identifier. The CLI is the
// validator: bogus ids come back as success:false and surface in the inlined
// JSON block, which is also useful signal for the LLM.
const REF_REGEX = /#sd-([A-Za-z][A-Za-z0-9_-]*-[A-Fa-f0-9]{4,})\b/g;

export function extractSeedsReferences(text: string, maxRefs: number): string[] {
	if (maxRefs <= 0) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of text.matchAll(REF_REGEX)) {
		const id = m[1];
		if (!id) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
		if (out.length >= maxRefs) break;
	}
	return out;
}

export type SdExecBin = (args: readonly string[], signal?: AbortSignal) => Promise<ExecResult>;

export interface ExpansionEntry {
	id: string;
	body: string;
}

export async function fetchReferenceBodies(
	exec: SdExecBin,
	ids: readonly string[],
	signal?: AbortSignal,
): Promise<ExpansionEntry[]> {
	const out: ExpansionEntry[] = [];
	for (const id of ids) {
		try {
			const res = await exec(["show", id, "--json"], signal);
			const body = res.stdout.trim();
			out.push({ id, body: body.length > 0 ? body : JSON.stringify({ success: false, id }) });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			out.push({ id, body: JSON.stringify({ success: false, id, error: message }) });
		}
	}
	return out;
}

export function renderReferenceBlock(entries: readonly ExpansionEntry[]): string {
	if (entries.length === 0) return "";
	const lines: string[] = ["<seeds-context>"];
	for (const entry of entries) {
		lines.push(`<seed id="${entry.id}">`);
		lines.push(entry.body);
		lines.push("</seed>");
	}
	lines.push("</seeds-context>");
	return lines.join("\n");
}

export interface ExpansionResult {
	expanded: boolean;
	text: string;
	references: string[];
	truncated: boolean;
}

export async function expandSeedsReferences(
	text: string,
	exec: SdExecBin,
	maxRefs: number,
	signal?: AbortSignal,
): Promise<ExpansionResult> {
	const allMatches: string[] = [];
	const seen = new Set<string>();
	for (const m of text.matchAll(REF_REGEX)) {
		const id = m[1];
		if (id && !seen.has(id)) {
			seen.add(id);
			allMatches.push(id);
		}
	}
	const ids = allMatches.slice(0, Math.max(0, maxRefs));
	const truncated = allMatches.length > ids.length;
	if (ids.length === 0) {
		return { expanded: false, text, references: [], truncated: false };
	}
	const entries = await fetchReferenceBodies(exec, ids, signal);
	const block = renderReferenceBlock(entries);
	const composed = `${block}\n\n${text}`;
	return { expanded: true, text: composed, references: ids, truncated };
}

// Wiring -----------------------------------------------------------------

const SD_BIN = "sd";

export function bindSeedsAutocomplete(
	pi: ExtensionAPI,
	state: {
		cache: ReadyCache;
		getMaxRefs: () => number;
		isEnabled: () => boolean;
	},
): void {
	pi.on("input", async (event, ctx) => {
		if (!state.isEnabled()) return;
		if (event.source !== "interactive") return;
		const text = event.text;
		if (!text || !text.includes("#sd-")) return;
		const exec: SdExecBin = (args, signal) => pi.exec(SD_BIN, [...args], { cwd: ctx.cwd, signal });
		const result = await expandSeedsReferences(text, exec, state.getMaxRefs());
		if (!result.expanded) return;
		if (result.truncated) {
			ctx.ui.setStatus(
				"seeds-expand",
				`sd: ${result.references.length} refs inlined (cap ${state.getMaxRefs()})`,
			);
		}
		return { action: "transform", text: result.text, images: event.images };
	});
}
