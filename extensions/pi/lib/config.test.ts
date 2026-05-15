import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PI_CONFIG, readPiConfig, resolvePiConfig } from "./config.ts";

describe("resolvePiConfig", () => {
	it("returns defaults when user config is undefined", () => {
		expect(resolvePiConfig(undefined)).toEqual(DEFAULT_PI_CONFIG);
	});

	it("returns defaults when user config is empty", () => {
		expect(resolvePiConfig({})).toEqual(DEFAULT_PI_CONFIG);
	});

	it("overrides individual top-level fields without touching others", () => {
		const resolved = resolvePiConfig({ auto_prime: false, commands: false });
		expect(resolved.auto_prime).toBe(false);
		expect(resolved.commands).toBe(false);
		expect(resolved.status_widget).toBe(true);
		expect(resolved.prime.sections).toEqual(DEFAULT_PI_CONFIG.prime.sections);
		expect(resolved.cache.invalidate_on_write).toBe(true);
		expect(resolved.reference_expansion.max_refs).toBe(5);
	});

	it("overrides nested prime.sections", () => {
		const resolved = resolvePiConfig({ prime: { sections: ["rules"] } });
		expect(resolved.prime.sections).toEqual(["rules"]);
	});

	it("overrides nested cache + reference_expansion", () => {
		const resolved = resolvePiConfig({
			cache: { invalidate_on_write: false },
			reference_expansion: { max_refs: 12 },
		});
		expect(resolved.cache.invalidate_on_write).toBe(false);
		expect(resolved.reference_expansion.max_refs).toBe(12);
	});

	it("accepts an empty section list (caller can disable prime injection)", () => {
		const resolved = resolvePiConfig({ prime: { sections: [] } });
		expect(resolved.prime.sections).toEqual([]);
	});
});

describe("readPiConfig", () => {
	async function makeSeedsProject(tmp: string, configBody: string): Promise<void> {
		await Bun.write(join(tmp, ".seeds", "config.yaml"), configBody);
		await Bun.write(join(tmp, ".seeds", "issues.jsonl"), "");
	}

	it("returns defaults when .seeds/config.yaml has no pi block", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "pi-config-test-"));
		try {
			await makeSeedsProject(tmp, 'project: "demo"\nversion: "1"\n');
			const resolved = await readPiConfig(tmp);
			expect(resolved).toEqual(DEFAULT_PI_CONFIG);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("throws when not inside a seeds project", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "pi-config-test-"));
		try {
			await expect(readPiConfig(tmp)).rejects.toThrow(/Not in a seeds project/);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});
});
