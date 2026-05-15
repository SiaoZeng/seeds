// Resolved pi-extension config for @os-eco/pi-seeds. Step 1 (seeds-2774):
// just the read helper. Later steps consume the resolved values in their
// respective hooks. Read on every invocation so edits to .seeds/config.yaml
// take effect without restarting the pi session.

import { join } from "node:path";
import { findSeedsDir } from "../../../src/config.ts";
import { CONFIG_FILE } from "../../../src/types.ts";
import { parseYaml } from "../../../src/yaml.ts";

export type PrimeSectionName = "closeProtocol" | "rules" | "commandGroups" | "workflows";

export interface PiPrimeConfig {
	sections?: PrimeSectionName[];
}

export interface PiCacheConfig {
	invalidate_on_write?: boolean;
}

export interface PiReferenceExpansionConfig {
	max_refs?: number;
}

export interface PiConfig {
	auto_prime?: boolean;
	status_widget?: boolean;
	prime?: PiPrimeConfig;
	cache?: PiCacheConfig;
	reference_expansion?: PiReferenceExpansionConfig;
}

export interface ResolvedPiConfig {
	auto_prime: boolean;
	status_widget: boolean;
	prime: Required<PiPrimeConfig>;
	cache: Required<PiCacheConfig>;
	reference_expansion: Required<PiReferenceExpansionConfig>;
}

export const DEFAULT_PI_CONFIG: ResolvedPiConfig = {
	auto_prime: true,
	status_widget: true,
	prime: { sections: ["closeProtocol", "rules"] },
	cache: { invalidate_on_write: true },
	reference_expansion: { max_refs: 5 },
};

export function resolvePiConfig(user: PiConfig | undefined): ResolvedPiConfig {
	return {
		auto_prime: user?.auto_prime ?? DEFAULT_PI_CONFIG.auto_prime,
		status_widget: user?.status_widget ?? DEFAULT_PI_CONFIG.status_widget,
		prime: {
			sections: user?.prime?.sections ?? DEFAULT_PI_CONFIG.prime.sections,
		},
		cache: {
			invalidate_on_write:
				user?.cache?.invalidate_on_write ?? DEFAULT_PI_CONFIG.cache.invalidate_on_write,
		},
		reference_expansion: {
			max_refs:
				user?.reference_expansion?.max_refs ?? DEFAULT_PI_CONFIG.reference_expansion.max_refs,
		},
	};
}

export async function readPiConfig(cwd: string): Promise<ResolvedPiConfig> {
	const seedsDir = await findSeedsDir(cwd);
	const file = Bun.file(join(seedsDir, CONFIG_FILE));
	const content = await file.text();
	const data = parseYaml(content);
	const pi = data.pi as PiConfig | undefined;
	return resolvePiConfig(pi);
}
