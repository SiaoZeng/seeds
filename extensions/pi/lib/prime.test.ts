import { describe, expect, it } from "bun:test";
import { buildPrimeInjection, getPrimeSections, renderSelectedSections } from "./prime.ts";

describe("getPrimeSections", () => {
	it("returns the full sections shape from the in-tree CLI", () => {
		const sections = getPrimeSections();
		expect(sections.mode).toBe("full");
		expect(sections.closeProtocol.steps.length).toBeGreaterThan(0);
		expect(sections.rules.length).toBeGreaterThan(0);
		expect(sections.commandGroups.length).toBeGreaterThan(0);
		expect(sections.workflows.length).toBeGreaterThan(0);
	});
});

describe("renderSelectedSections", () => {
	const sections = getPrimeSections();

	it("returns an empty string when no names are requested", () => {
		expect(renderSelectedSections(sections, [])).toBe("");
	});

	it("renders closeProtocol with the warning, steps, and footer", () => {
		const out = renderSelectedSections(sections, ["closeProtocol"]);
		expect(out).toContain("# Session Close Protocol");
		expect(out).toContain(sections.closeProtocol.warning);
		for (const step of sections.closeProtocol.steps) {
			expect(out).toContain(step);
		}
		expect(out).toContain(sections.closeProtocol.footer);
	});

	it("renders rules as a bullet list", () => {
		const out = renderSelectedSections(sections, ["rules"]);
		expect(out).toContain("## Seeds Rules");
		const firstRule = sections.rules[0];
		expect(firstRule).toBeDefined();
		if (firstRule) expect(out).toContain(`- ${firstRule}`);
	});

	it("renders commandGroups with each group heading and command line", () => {
		const out = renderSelectedSections(sections, ["commandGroups"]);
		expect(out).toContain("## Seeds Commands");
		const group = sections.commandGroups[0];
		expect(group).toBeDefined();
		if (!group) return;
		expect(out).toContain(`### ${group.name}`);
		const cmd = group.commands[0];
		if (cmd) expect(out).toContain(`\`${cmd.command}\``);
	});

	it("renders workflows inside fenced bash blocks", () => {
		const out = renderSelectedSections(sections, ["workflows"]);
		expect(out).toContain("## Seeds Workflows");
		expect(out).toContain("```bash");
		const wf = sections.workflows[0];
		if (wf) expect(out).toContain(`**${wf.name}:**`);
	});

	it("preserves the order names are passed in", () => {
		const rulesFirst = renderSelectedSections(sections, ["rules", "closeProtocol"]);
		const closeFirst = renderSelectedSections(sections, ["closeProtocol", "rules"]);
		expect(rulesFirst.indexOf("## Seeds Rules")).toBeLessThan(
			rulesFirst.indexOf("# Session Close Protocol"),
		);
		expect(closeFirst.indexOf("# Session Close Protocol")).toBeLessThan(
			closeFirst.indexOf("## Seeds Rules"),
		);
	});

	it("trims trailing whitespace", () => {
		const out = renderSelectedSections(sections, ["rules"]);
		expect(out).toBe(out.trimEnd());
	});
});

describe("buildPrimeInjection", () => {
	it("returns empty string for an empty section list", () => {
		expect(buildPrimeInjection([])).toBe("");
	});

	it("matches renderSelectedSections for the same names", () => {
		const sections = getPrimeSections();
		expect(buildPrimeInjection(["rules"])).toBe(renderSelectedSections(sections, ["rules"]));
	});
});
