import { describe, expect, it } from "bun:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { Issue } from "../../../src/types.ts";
import {
	applySeedsCompletion,
	buildAutocompleteItems,
	computeReadyItems,
	createSeedsAutocompleteFactory,
	expandSeedsReferences,
	extractRefPrefix,
	extractSeedsReferences,
	fetchReferenceBodies,
	filterReadyItems,
	type ReadyCache,
	type ReadyItem,
	renderReferenceBlock,
	type SdExecBin,
} from "./autocomplete.ts";

function issue(overrides: Partial<Issue>): Issue {
	return {
		id: "seeds-aaaa",
		title: "untitled",
		status: "open",
		type: "task",
		priority: 2,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	} as Issue;
}

function makeCache(items: ReadyItem[]): ReadyCache {
	return { get: () => items };
}

describe("computeReadyItems", () => {
	it("excludes closed issues and those with unresolved blockers", () => {
		const issues: Issue[] = [
			issue({ id: "seeds-0001", title: "A", priority: 0 }),
			issue({ id: "seeds-0002", title: "B", status: "closed" }),
			issue({ id: "seeds-0003", title: "C", blockedBy: ["seeds-0002"] }),
			issue({ id: "seeds-0004", title: "D", blockedBy: ["seeds-0001"] }),
		];
		const out = computeReadyItems(issues);
		expect(out.map((i) => i.id)).toEqual(["seeds-0001", "seeds-0003"]);
	});

	it("sorts by priority ascending then id ascending", () => {
		const issues: Issue[] = [
			issue({ id: "seeds-0002", priority: 1 }),
			issue({ id: "seeds-0001", priority: 2 }),
			issue({ id: "seeds-0003", priority: 1 }),
		];
		const out = computeReadyItems(issues);
		expect(out.map((i) => i.id)).toEqual(["seeds-0002", "seeds-0003", "seeds-0001"]);
	});
});

describe("extractRefPrefix", () => {
	it("matches at end of line", () => {
		expect(extractRefPrefix("look at #sd-ab", 14)).toEqual({
			text: "#sd-ab",
			queryAfter: "ab",
		});
	});

	it("matches the bare prefix with no query", () => {
		expect(extractRefPrefix("see #sd-", 8)).toEqual({
			text: "#sd-",
			queryAfter: "",
		});
	});

	it("returns undefined when cursor is past the token", () => {
		expect(extractRefPrefix("#sd-ab cd", 9)).toBeUndefined();
	});

	it("returns undefined when no #sd- present", () => {
		expect(extractRefPrefix("plain text", 5)).toBeUndefined();
	});
});

describe("filterReadyItems", () => {
	const items: ReadyItem[] = [
		{ id: "seeds-0001", title: "alpha", priority: 1, type: "task" },
		{ id: "seeds-0002", title: "beta", priority: 2, type: "task" },
		{ id: "myapp-abcd", title: "gamma", priority: 2, type: "task" },
	];

	it("returns all items when query is empty", () => {
		expect(filterReadyItems(items, "").map((i) => i.id)).toEqual([
			"seeds-0001",
			"seeds-0002",
			"myapp-abcd",
		]);
	});

	it("filters by substring on id", () => {
		expect(filterReadyItems(items, "0001").map((i) => i.id)).toEqual(["seeds-0001"]);
		expect(filterReadyItems(items, "ABCD").map((i) => i.id)).toEqual(["myapp-abcd"]);
	});

	it("respects the limit", () => {
		expect(filterReadyItems(items, "", 2)).toHaveLength(2);
	});
});

describe("buildAutocompleteItems", () => {
	it("emits #sd-<id> tokens with priority+title descriptions", () => {
		const items = buildAutocompleteItems([
			{ id: "seeds-0001", title: "alpha", priority: 1, type: "bug" },
		]);
		expect(items).toEqual([
			{
				value: "#sd-seeds-0001",
				label: "#sd-seeds-0001",
				description: "P1 bug — alpha",
			},
		]);
	});
});

describe("applySeedsCompletion", () => {
	it("replaces the prefix with the chosen value", () => {
		const result = applySeedsCompletion(
			["look at #sd-ab"],
			0,
			14,
			{ value: "#sd-seeds-abcd", label: "#sd-seeds-abcd" },
			"#sd-ab",
		);
		expect(result.lines).toEqual(["look at #sd-seeds-abcd"]);
		expect(result.cursorLine).toBe(0);
		expect(result.cursorCol).toBe("look at #sd-seeds-abcd".length);
	});

	it("preserves the line if prefix no longer matches", () => {
		const result = applySeedsCompletion(
			["nothing"],
			0,
			7,
			{ value: "#sd-seeds-abcd", label: "#sd-seeds-abcd" },
			"#sd-ab",
		);
		expect(result.lines).toEqual(["nothing"]);
		expect(result.cursorCol).toBe(7);
	});
});

describe("createSeedsAutocompleteFactory", () => {
	const baseProvider: AutocompleteProvider = {
		async getSuggestions(_lines, _cursorLine, _cursorCol, _options) {
			return { items: [{ value: "from-base", label: "from-base" }], prefix: "@" };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, _prefix) {
			return {
				lines: lines.map((l) => `${l}::${item.value}`),
				cursorLine,
				cursorCol,
			};
		},
	};

	const cache = makeCache([
		{ id: "seeds-0001", title: "alpha", priority: 1, type: "task" },
		{ id: "seeds-0002", title: "beta", priority: 2, type: "task" },
	]);

	it("returns our suggestions when cursor is at a #sd- prefix", async () => {
		const factory = createSeedsAutocompleteFactory(cache);
		const provider = factory(baseProvider);
		const result = await provider.getSuggestions(["check #sd-"], 0, 10, {
			signal: new AbortController().signal,
		});
		expect(result).not.toBeNull();
		if (!result) throw new Error("unreachable");
		expect(result.prefix).toBe("#sd-");
		expect(result.items.map((i: { value: string }) => i.value)).toEqual([
			"#sd-seeds-0001",
			"#sd-seeds-0002",
		]);
	});

	it("delegates to the underlying provider when not in a #sd- token", async () => {
		const factory = createSeedsAutocompleteFactory(cache);
		const provider = factory(baseProvider);
		const result = await provider.getSuggestions(["@thing"], 0, 6, {
			signal: new AbortController().signal,
		});
		expect(result).not.toBeNull();
		if (!result) throw new Error("unreachable");
		expect(result.prefix).toBe("@");
		expect(result.items[0]?.value).toBe("from-base");
	});

	it("routes applyCompletion based on item ownership", () => {
		const factory = createSeedsAutocompleteFactory(cache);
		const provider = factory(baseProvider);
		const seedsApplied = provider.applyCompletion(
			["check #sd-"],
			0,
			10,
			{ value: "#sd-seeds-0001", label: "#sd-seeds-0001" },
			"#sd-",
		);
		expect(seedsApplied.lines).toEqual(["check #sd-seeds-0001"]);

		const baseApplied = provider.applyCompletion(
			["@thi"],
			0,
			4,
			{ value: "other.txt", label: "other.txt" },
			"@",
		);
		expect(baseApplied.lines).toEqual(["@thi::other.txt"]);
	});
});

describe("extractSeedsReferences", () => {
	it("returns unique ids up to maxRefs", () => {
		const text = "see #sd-seeds-0001 and #sd-seeds-0002 plus #sd-seeds-0001 again";
		expect(extractSeedsReferences(text, 5)).toEqual(["seeds-0001", "seeds-0002"]);
	});

	it("truncates beyond maxRefs", () => {
		const text = "#sd-a-0001 #sd-a-0002 #sd-a-0003";
		expect(extractSeedsReferences(text, 2)).toEqual(["a-0001", "a-0002"]);
	});

	it("returns [] when maxRefs is 0", () => {
		expect(extractSeedsReferences("#sd-a-0001", 0)).toEqual([]);
	});

	it("ignores #sd- without a valid id suffix", () => {
		expect(extractSeedsReferences("#sd-  #sd-foo #sd-x-12", 5)).toEqual([]);
	});
});

describe("fetchReferenceBodies", () => {
	it("calls sd show <id> --json for each id", async () => {
		const calls: string[][] = [];
		const exec: SdExecBin = async (args) => {
			calls.push([...args]);
			const stdout = JSON.stringify({ success: true, id: args[1] });
			return { stdout, stderr: "", code: 0, killed: false } as ExecResult;
		};
		const entries = await fetchReferenceBodies(exec, ["seeds-0001", "seeds-0002"]);
		expect(calls).toEqual([
			["show", "seeds-0001", "--json"],
			["show", "seeds-0002", "--json"],
		]);
		expect(entries).toHaveLength(2);
		expect(entries[0]?.id).toBe("seeds-0001");
	});

	it("surfaces exec failures as success:false JSON bodies", async () => {
		const exec: SdExecBin = async () => {
			throw new Error("exec failed");
		};
		const entries = await fetchReferenceBodies(exec, ["seeds-0001"]);
		const body = JSON.parse(entries[0]?.body ?? "{}");
		expect(body.success).toBe(false);
		expect(body.error).toContain("exec failed");
	});
});

describe("renderReferenceBlock", () => {
	it("wraps entries in <seeds-context>", () => {
		const block = renderReferenceBlock([{ id: "seeds-0001", body: '{"x":1}' }]);
		expect(block).toBe(
			["<seeds-context>", '<seed id="seeds-0001">', '{"x":1}', "</seed>", "</seeds-context>"].join(
				"\n",
			),
		);
	});

	it("returns empty string when no entries", () => {
		expect(renderReferenceBlock([])).toBe("");
	});
});

describe("expandSeedsReferences", () => {
	const exec: SdExecBin = async (args) => ({
		stdout: JSON.stringify({ success: true, id: args[1] }),
		stderr: "",
		code: 0,
		killed: false,
	});

	it("prepends a hidden context block to user text", async () => {
		const result = await expandSeedsReferences("ping #sd-seeds-0001", exec, 5);
		expect(result.expanded).toBe(true);
		expect(result.references).toEqual(["seeds-0001"]);
		expect(result.text.startsWith("<seeds-context>")).toBe(true);
		expect(result.text.endsWith("\n\nping #sd-seeds-0001")).toBe(true);
	});

	it("caps at maxRefs and reports truncation", async () => {
		const result = await expandSeedsReferences("#sd-a-0001 #sd-a-0002 #sd-a-0003", exec, 2);
		expect(result.references).toEqual(["a-0001", "a-0002"]);
		expect(result.truncated).toBe(true);
	});

	it("returns unexpanded when no references found", async () => {
		const result = await expandSeedsReferences("nothing here", exec, 5);
		expect(result.expanded).toBe(false);
		expect(result.text).toBe("nothing here");
	});

	it("is a no-op when maxRefs is 0", async () => {
		const result = await expandSeedsReferences("#sd-seeds-0001", exec, 0);
		expect(result.expanded).toBe(false);
	});
});
