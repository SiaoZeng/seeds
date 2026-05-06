import { dirname } from "node:path";
import { Command } from "commander";
import { findSeedsDir, loadPlanTemplates, maxPlanDepth, readConfig } from "../config.ts";
import { generateId } from "../id.ts";
import { accent, brand, muted, outputJson, printSuccess } from "../output.ts";
import { type ChildSummary, summarisePlanChildren } from "../plan-context.ts";
import { inferDomain } from "../plan-domain.ts";
import { enrichPriorArt, recordDecision } from "../plan-mulch.ts";
import { compilePlanTemplate, defaultTemplateForType } from "../plan-schema.ts";
import {
	appendPlan,
	issuesPath,
	plansPath,
	readIssues,
	readPlans,
	withLock,
	writeIssues,
	writePlans,
} from "../store.ts";
import type { Issue, Plan, PlanTemplate, SectionSpec } from "../types.ts";

export function register(program: Command): void {
	const plan = new Command("plan").description("Plan management");

	plan
		.command("templates")
		.description("List available plan templates")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			await runTemplates(Boolean(opts.json));
		});

	plan
		.command("prompt <seed-id>")
		.description("Emit structured planning prompt JSON for a seed")
		.option("--template <name>", "Override the inferred template")
		.option("--domain <name>", "Force the mulch domain used for prior_art enrichment")
		.option("--json", "Output as JSON")
		.action(
			async (seedId: string, opts: { template?: string; domain?: string; json?: boolean }) => {
				await runPrompt(seedId, opts.template, opts.domain, Boolean(opts.json));
			},
		);

	plan
		.command("submit <seed-id>")
		.description("Validate a plan, spawn children, write plans.jsonl row")
		.requiredOption("--plan <file>", "Path to plan JSON, or '-' to read from stdin")
		.option(
			"--overwrite",
			"Replace an existing non-draft plan: rewrite the row, bump revision, flag obsolete children",
		)
		.option(
			"--record-decision",
			"Best-effort: after success, record the chosen approach as a mulch decision",
		)
		.option("--domain <name>", "Force the mulch domain used for --record-decision")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			`
Plan file shape:

  {
    "template": "feature",
    "sections": {
      "approach": "Plain-text approach...",
      "steps": [{ "title": "Step 1" }, ...],
      "acceptance": ["criterion 1", ...]
    }
  }

The shape mirrors 'sd plan prompt': drop the plan_request wrapper, and
sections is an object keyed by name (not the array of section metadata
that the prompt emits). Section names and value kinds match the template.
`,
		)
		.action(
			async (
				seedId: string,
				opts: {
					plan: string;
					overwrite?: boolean;
					recordDecision?: boolean;
					domain?: string;
					json?: boolean;
				},
			) => {
				await runSubmit(seedId, opts.plan, {
					overwrite: Boolean(opts.overwrite),
					recordDecision: Boolean(opts.recordDecision),
					domainOverride: opts.domain,
					jsonMode: Boolean(opts.json),
				});
			},
		);

	plan
		.command("show <pl-id>")
		.description("Show a plan with sections, children, and status")
		.option("--json", "Output as JSON")
		.action(async (planId: string, opts: { json?: boolean }) => {
			await runShow(planId, Boolean(opts.json));
		});

	plan
		.command("validate <pl-id>")
		.description("Re-run validation against the current template definition")
		.option("--json", "Output as JSON")
		.action(async (planId: string, opts: { json?: boolean }) => {
			await runValidate(planId, Boolean(opts.json));
		});

	plan
		.command("outcome <pl-id>")
		.description("Record a plan outcome (storage-only; not a state transition)")
		.requiredOption("--result <value>", "One of: success, partial, failure")
		.option("--note <text>", "Optional free-form note")
		.option("--json", "Output as JSON")
		.action(async (planId: string, opts: { result: string; note?: string; json?: boolean }) => {
			await runOutcome(planId, opts.result, opts.note, Boolean(opts.json));
		});

	plan
		.command("review <pl-id>")
		.description("Record a reviewer (informational; not a state transition)")
		.requiredOption("--by <name>", "Reviewer name")
		.option("--json", "Output as JSON")
		.action(async (planId: string, opts: { by: string; json?: boolean }) => {
			await runReview(planId, opts.by, Boolean(opts.json));
		});

	plan
		.command("list")
		.description("List plans with optional filters")
		.option("--seed <id>", "Filter by parent seed id")
		.option("--status <status>", "Filter by status (draft|approved|active|done)")
		.option("--outcome <outcome>", "Filter by outcome (success|partial|failure)")
		.option("--template <name>", "Filter by template name")
		.option("--json", "Output as JSON")
		.action(
			async (opts: {
				seed?: string;
				status?: string;
				outcome?: string;
				template?: string;
				json?: boolean;
			}) => {
				await runList(opts, Boolean(opts.json));
			},
		);

	// `sd plan` (no subcommand) prints help and exits non-zero so scripted callers notice.
	plan.action(() => {
		plan.outputHelp();
		process.exitCode = 1;
	});

	program.addCommand(plan);
}

async function runTemplates(jsonMode: boolean): Promise<void> {
	const dir = await findSeedsDir();
	const templates = await loadPlanTemplates(dir);
	const list = Object.keys(templates).sort();
	const entries = list.map((name) => ({
		name,
		description: templates[name]?.description ?? "",
	}));
	if (jsonMode) {
		outputJson({
			success: true,
			command: "plan templates",
			templates: entries,
			count: entries.length,
		});
		return;
	}
	console.log(`${brand("Available templates:")}`);
	for (const t of entries) {
		const desc = t.description ? `  ${muted(t.description)}` : "";
		console.log(`  ${accent.bold(t.name)}${desc}`);
	}
}

interface PromptSection {
	name: string;
	required: boolean;
	kind: SectionSpec["kind"];
	prompt: string;
	prior_art: unknown[];
	min_length?: number;
	min?: number;
	item?: SectionSpec["item"];
}

interface PlanRequest {
	seed: string;
	template: string;
	instructions: string;
	sections: PromptSection[];
	validation: {
		all_required_present: boolean;
		min_steps: number;
		min_acceptance: number;
	};
}

const INSTRUCTIONS =
	'Fill every section. Required fields are marked. Use prior_art entries to ground decisions. Reply with JSON shaped { "template": "<name>", "sections": { "<section-name>": <value>, ... } } — drop the plan_request wrapper, and sections in your reply is an object keyed by name (not the array of section metadata above).';

function buildPlanRequest(
	seedId: string,
	templateName: string,
	template: PlanTemplate,
): PlanRequest {
	const sections: PromptSection[] = Object.entries(template.sections).map(([name, s]) => {
		const out: PromptSection = {
			name,
			required: s.required,
			kind: s.kind,
			prompt: s.prompt,
			prior_art: [], // Phase 1: empty; Phase 3 fills from mulch
		};
		if (s.min_length !== undefined) out.min_length = s.min_length;
		if (s.min !== undefined) out.min = s.min;
		if (s.item !== undefined) out.item = s.item;
		return out;
	});
	const stepsSection = template.sections.steps;
	const acceptanceSection = template.sections.acceptance;
	return {
		seed: seedId,
		template: templateName,
		instructions: INSTRUCTIONS,
		sections,
		validation: {
			all_required_present: true,
			min_steps: stepsSection?.min ?? 0,
			min_acceptance: acceptanceSection?.min ?? 0,
		},
	};
}

async function runPrompt(
	seedId: string,
	templateOverride: string | undefined,
	domainOverride: string | undefined,
	jsonMode: boolean,
): Promise<void> {
	const dir = await findSeedsDir();
	const issues = await readIssues(dir);
	const seed = issues.find((i) => i.id === seedId);
	if (!seed) throw new Error(`Seed not found: ${seedId}`);

	const templates = await loadPlanTemplates(dir);
	// PLAN_SPEC.md:329-342 — a child spawned from a step with plan_template
	// inherits that template name unless --template overrides. The back-link
	// to the parent plan is via plan_step_index + plan.children[].
	const inheritedTemplate = templateOverride ? undefined : await resolveStepPlanTemplate(dir, seed);
	const templateName = templateOverride ?? inheritedTemplate ?? defaultTemplateForType(seed.type);
	const template = templates[templateName];
	if (!template) {
		const available = Object.keys(templates).join(", ");
		throw new Error(`Unknown template: ${templateName}. Available: ${available}`);
	}

	const planRequest = buildPlanRequest(seedId, templateName, template);

	// Phase 3: prior_art enrichment via mulch. Soft coupling — empty arrays
	// when ml is absent or a domain cannot be inferred.
	const { domain } = inferDomain({ seed, explicitDomain: domainOverride });
	const sectionRequests = Object.entries(template.sections).map(([name, spec]) => ({
		name,
		mulchSource: spec.mulch_source,
	}));
	const priorArt = enrichPriorArt({ domain, sections: sectionRequests });
	for (const section of planRequest.sections) {
		const entries = priorArt[section.name];
		if (entries && entries.length > 0) section.prior_art = entries;
	}

	if (jsonMode) {
		outputJson({ plan_request: planRequest });
		return;
	}

	console.log(`${brand("Plan prompt")} for ${accent.bold(seedId)}`);
	console.log(`${muted("Template:")} ${planRequest.template}`);
	console.log(`${muted("Seed title:")} ${seed.title}`);
	console.log("");
	console.log(planRequest.instructions);
	console.log("");
	for (const s of planRequest.sections) {
		const tag = s.required ? brand("required") : muted("optional");
		const kindLabel = typeof s.kind === "string" ? s.kind : "object";
		console.log(`  ${accent.bold(s.name)} ${muted(`(${kindLabel})`)} ${tag}`);
		console.log(`    ${muted(s.prompt)}`);
		if (s.min_length !== undefined) console.log(`    ${muted(`min_length: ${s.min_length}`)}`);
		if (s.min !== undefined) console.log(`    ${muted(`min entries: ${s.min}`)}`);
	}
	console.log("");
	console.log(`${muted("Pipe --json into a file the LLM fills, then run:")}`);
	console.log(`  sd plan submit ${seedId} --plan <file>`);
}

interface SubmittedStep {
	title: string;
	type?: string;
	priority?: number;
	blocks?: number[];
	plan_template?: string;
}

interface SubmittedPlan {
	template: string;
	sections: {
		steps: SubmittedStep[];
		[key: string]: unknown;
	};
}

// Resolve the plan_template declared on the parent plan's step that spawned
// this seed (PLAN_SPEC.md:329-342). For plan_template children, plan_id is
// unset, so we fall back to scanning plans by children[] membership.
async function resolveStepPlanTemplate(dir: string, seed: Issue): Promise<string | undefined> {
	if (seed.plan_step_index === undefined) return undefined;
	const plans = await readPlans(dir);
	let parentPlan: Plan | undefined;
	if (seed.plan_id) {
		parentPlan = plans.find((p) => p.id === seed.plan_id);
	}
	if (!parentPlan) {
		parentPlan = plans.find((p) => p.children.includes(seed.id));
	}
	if (!parentPlan) return undefined;
	const sections = parentPlan.sections as { steps?: SubmittedStep[] };
	const step = sections.steps?.[seed.plan_step_index];
	return step?.plan_template;
}

// PLAN_SPEC.md:329-338 — submit-time check that step.plan_template references
// a template defined in plan_templates: in config.yaml. Returns null on success
// or a one-line error message pointing the author at the template config.
function validatePlanTemplateRefs(
	steps: SubmittedStep[],
	templates: Record<string, PlanTemplate>,
): string | null {
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		if (!step) continue;
		const ref = step.plan_template;
		if (!ref) continue;
		if (!templates[ref]) {
			const available = Object.keys(templates).join(", ");
			return `step ${i} (${step.title}): plan_template '${ref}' is not defined. Available: ${available}. Add it under plan_templates: in .seeds/config.yaml.`;
		}
	}
	return null;
}

async function readPlanInput(planFile: string): Promise<string> {
	if (planFile === "-") {
		return await Bun.stdin.text();
	}
	const file = Bun.file(planFile);
	if (!(await file.exists())) {
		throw new Error(`Plan file not found: ${planFile}`);
	}
	return await file.text();
}

interface SubmitOptions {
	overwrite: boolean;
	recordDecision: boolean;
	domainOverride?: string;
	jsonMode: boolean;
}

async function runSubmit(seedId: string, planFile: string, opts: SubmitOptions): Promise<void> {
	const { overwrite, recordDecision: shouldRecordDecision, domainOverride, jsonMode } = opts;
	const dir = await findSeedsDir();

	const raw = await readPlanInput(planFile);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(`Invalid JSON in plan file: ${(e as Error).message}`);
	}

	const templateName =
		parsed &&
		typeof parsed === "object" &&
		typeof (parsed as { template?: unknown }).template === "string"
			? (parsed as { template: string }).template
			: "feature";

	const templates = await loadPlanTemplates(dir);
	const template = templates[templateName];
	if (!template) {
		const available = Object.keys(templates).join(", ");
		throw new Error(`Unknown template in plan: ${templateName}. Available: ${available}`);
	}

	const validate = compilePlanTemplate(template);
	const result = validate(parsed);
	if (!result.valid) {
		// Partial-state diff JSON to stderr (PLAN_SPEC.md:180-195).
		// stdout stays clean so callers can pipe it into a file.
		process.stderr.write(`${JSON.stringify(result.diff, null, 2)}\n`);
		process.exitCode = 1;
		return;
	}

	const submitted = parsed as SubmittedPlan;
	const refError = validatePlanTemplateRefs(submitted.sections.steps, templates);
	if (refError) {
		process.stderr.write(`${refError}\n`);
		process.exitCode = 1;
		return;
	}
	const config = await readConfig(dir);

	let createdPlanId = "";
	let childIds: string[] = [];
	let revision = 1;
	let obsoleteChildren: Issue[] = [];
	let aborted = false;
	// Captured inside the lock so the post-success outbound mulch write has
	// access without re-reading issues.jsonl.
	let seedSnapshot: Issue | null = null;

	// Combined lock: hold plans + issues while we read and write both.
	// Order: outer lock = plans, inner = issues. Same across submit/validate
	// to avoid deadlocks.
	await withLock(plansPath(dir), async () => {
		await withLock(issuesPath(dir), async () => {
			const allIssues = await readIssues(dir);
			const allPlans = await readPlans(dir);

			const seedIdx = allIssues.findIndex((i) => i.id === seedId);
			const seed = allIssues[seedIdx];
			if (!seed) throw new Error(`Seed not found: ${seedId}`);
			seedSnapshot = seed;

			const existingPlan = allPlans.find((p) => p.seed === seedId && p.status !== "draft");
			if (existingPlan && !overwrite) {
				// PLAN_SPEC.md:374-391 — reject without --overwrite, exit non-zero
				// with a multi-line stderr message.
				process.stderr.write(
					`✗ plan ${existingPlan.id} already exists for ${seedId} (status: ${existingPlan.status}, revision: ${existingPlan.revision})\n  Use --overwrite to replace it.\n`,
				);
				process.exitCode = 1;
				aborted = true;
				return;
			}

			const steps = submitted.sections.steps;
			const now = new Date().toISOString();

			if (existingPlan && overwrite) {
				const result = applyOverwrite({
					existingPlan,
					seed,
					seedIdx,
					allIssues,
					allPlans,
					steps,
					projectName: config.project,
					templateName,
					newSections: submitted.sections as Record<string, unknown>,
					now,
				});
				await writeIssues(dir, allIssues);
				await writePlans(dir, allPlans);
				createdPlanId = existingPlan.id;
				childIds = result.finalChildIds;
				revision = result.revision;
				obsoleteChildren = result.obsolete;
				return;
			}

			// Fresh-submit path (no existing non-draft plan).
			const issueIds = new Set(allIssues.map((i) => i.id));
			const planIds = new Set(allPlans.map((p) => p.id));
			const planId = generateId("pl", planIds);

			const newChildIds: string[] = [];
			for (let i = 0; i < steps.length; i++) {
				const id = generateId(config.project, new Set([...issueIds, ...newChildIds]));
				newChildIds.push(id);
			}

			const newIssues: Issue[] = steps.map((step, idx) => {
				const childId = newChildIds[idx];
				if (!childId) throw new Error(`Internal: missing child id at index ${idx}`);
				const stepType = (step.type ?? "task") as Issue["type"];
				const issue: Issue = {
					id: childId,
					title: step.title,
					status: "open",
					type: stepType,
					priority: step.priority ?? 2,
					plan_step_index: idx,
					createdAt: now,
					updatedAt: now,
				};
				// PLAN_SPEC.md:329-342 — when the parent step declares a
				// plan_template, the child needs its own sub-plan first. Mark it
				// requires_plan and leave plan_id unset so it does not back-link
				// to the parent plan; the back-link is via children: [] on the
				// parent plan row + plan_step_index on the child.
				if (step.plan_template) {
					issue.requires_plan = true;
				} else {
					issue.plan_id = planId;
				}
				const deps = step.blocks ?? [];
				if (deps.length > 0) {
					const blockedByIds: string[] = [];
					for (const j of deps) {
						const target = newChildIds[j];
						if (target) blockedByIds.push(target);
					}
					if (blockedByIds.length > 0) issue.blockedBy = blockedByIds;
				}
				return issue;
			});

			for (let i = 0; i < steps.length; i++) {
				const step = steps[i];
				if (!step) continue;
				const childId = newChildIds[i];
				if (!childId) continue;
				for (const j of step.blocks ?? []) {
					const blocker = newIssues[j];
					if (!blocker) continue;
					blocker.blocks = [...(blocker.blocks ?? []), childId];
				}
			}

			const updatedSeed: Issue = {
				...seed,
				plan_id: planId,
				blockedBy: [...(seed.blockedBy ?? []), ...newChildIds],
				updatedAt: now,
			};
			allIssues[seedIdx] = updatedSeed;

			for (const child of newIssues) {
				child.blocks = [...(child.blocks ?? []), seedId];
			}

			const plan: Plan = {
				id: planId,
				seed: seedId,
				template: templateName,
				status: "approved",
				revision: 1,
				sections: submitted.sections as Record<string, unknown>,
				children: newChildIds,
				createdAt: now,
				updatedAt: now,
			};

			await writeIssues(dir, [...allIssues, ...newIssues]);

			const draftIdx = allPlans.findIndex((p) => p.seed === seedId && p.status === "draft");
			if (draftIdx >= 0) {
				allPlans[draftIdx] = plan;
				await writePlans(dir, allPlans);
			} else {
				await appendPlan(dir, plan);
			}

			createdPlanId = planId;
			childIds = newChildIds;
		});
	});

	if (aborted) return;

	if (shouldRecordDecision && seedSnapshot) {
		// PLAN_SPEC.md:354-356 — best-effort outbound write. Submit has already
		// succeeded by this point; any failure here warns on stderr and leaves
		// the plan + children intact.
		await runOutboundDecision({
			seed: seedSnapshot,
			planId: createdPlanId,
			approach: submitted.sections.approach,
			domainOverride,
			cwd: dir,
		});
	}

	if (obsoleteChildren.length > 0) {
		// PLAN_SPEC.md:388 — emit one suggestion line per obsolete child to
		// stderr; never auto-close.
		for (const o of obsoleteChildren) {
			process.stderr.write(
				`sd close ${o.id} --reason "obsoleted by plan ${createdPlanId} revision ${revision}"\n`,
			);
		}
	}

	if (jsonMode) {
		outputJson({
			success: true,
			command: "plan submit",
			plan_id: createdPlanId,
			children: childIds,
			parent_seed: seedId,
			revision,
			obsolete: obsoleteChildren.map((o) => o.id),
			overwritten: revision > 1,
		});
		return;
	}

	if (revision > 1) {
		printSuccess(
			`plan ${accent(createdPlanId)} overwritten (revision ${revision}, status: approved)`,
		);
	} else {
		printSuccess(`plan ${accent(createdPlanId)} created (status: approved)`);
	}
	printSuccess(
		`${childIds.length} child seed${childIds.length === 1 ? "" : "s"}: ${childIds
			.map((id) => accent(id))
			.join(", ")}`,
	);
	if (obsoleteChildren.length > 0) {
		printSuccess(
			`${obsoleteChildren.length} obsolete child seed${
				obsoleteChildren.length === 1 ? "" : "s"
			} flagged (see stderr for close suggestions)`,
		);
	}
	printSuccess(`${accent(seedId)} now blocked by ${childIds.length} children`);
}

interface OverwriteArgs {
	existingPlan: Plan;
	seed: Issue;
	seedIdx: number;
	allIssues: Issue[];
	allPlans: Plan[];
	steps: SubmittedStep[];
	projectName: string;
	templateName: string;
	newSections: Record<string, unknown>;
	now: string;
}

interface OverwriteResult {
	finalChildIds: string[];
	revision: number;
	obsolete: Issue[];
}

// applyOverwrite mutates allIssues + allPlans in place. The caller is expected
// to have already acquired the plans + issues locks.
function applyOverwrite(args: OverwriteArgs): OverwriteResult {
	const {
		existingPlan,
		seed,
		seedIdx,
		allIssues,
		allPlans,
		steps,
		projectName,
		templateName,
		newSections,
		now,
	} = args;

	// Match existing children to new steps by title (PLAN_SPEC.md:387-388).
	const oldChildIssues: Issue[] = [];
	for (const cid of existingPlan.children) {
		const c = allIssues.find((i) => i.id === cid);
		if (c) oldChildIssues.push(c);
	}
	const usedOldIds = new Set<string>();
	const finalChildIds: string[] = [];
	const newSpawnedIds: string[] = [];
	const issueIds = new Set(allIssues.map((i) => i.id));

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		if (!step) continue;
		const match = oldChildIssues.find((c) => !usedOldIds.has(c.id) && c.title === step.title);
		if (match) {
			usedOldIds.add(match.id);
			finalChildIds.push(match.id);
		} else {
			const taken = new Set([...issueIds, ...newSpawnedIds, ...finalChildIds]);
			const id = generateId(projectName, taken);
			newSpawnedIds.push(id);
			finalChildIds.push(id);
		}
	}

	// Build issues for newly spawned children only. Existing matched children
	// are kept verbatim (PLAN_SPEC.md:389: "Existing matching children are kept").
	const newIssues: Issue[] = [];
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		if (!step) continue;
		const childId = finalChildIds[i];
		if (!childId) continue;
		if (usedOldIds.has(childId)) continue; // matched — leave untouched
		const stepType = (step.type ?? "task") as Issue["type"];
		const issue: Issue = {
			id: childId,
			title: step.title,
			status: "open",
			type: stepType,
			priority: step.priority ?? 2,
			plan_step_index: i,
			createdAt: now,
			updatedAt: now,
		};
		if (step.plan_template) {
			issue.requires_plan = true;
		} else {
			issue.plan_id = existingPlan.id;
		}
		const deps = step.blocks ?? [];
		const blockedByIds: string[] = [];
		for (const j of deps) {
			const target = finalChildIds[j];
			if (target) blockedByIds.push(target);
		}
		if (blockedByIds.length > 0) issue.blockedBy = blockedByIds;
		issue.blocks = [seed.id];
		newIssues.push(issue);
	}

	// Obsolete children = old plan children with no matching step in new plan.
	const obsolete: Issue[] = oldChildIssues.filter((c) => !usedOldIds.has(c.id));

	// Parent seed: drop obsolete from blockedBy, ensure all current plan children
	// are present. Preserve unrelated blockers.
	const oldChildSet = new Set(existingPlan.children);
	const externalBlockers = (seed.blockedBy ?? []).filter((b) => !oldChildSet.has(b));
	const updatedSeed: Issue = {
		...seed,
		plan_id: existingPlan.id,
		blockedBy: [...externalBlockers, ...finalChildIds],
		updatedAt: now,
	};
	allIssues[seedIdx] = updatedSeed;

	// Update the plan row in place — single mutation per overwrite.
	const planIdx = allPlans.findIndex((p) => p.id === existingPlan.id);
	const updatedPlan: Plan = {
		...existingPlan,
		template: templateName,
		sections: newSections,
		children: finalChildIds,
		revision: existingPlan.revision + 1,
		updatedAt: now,
	};
	if (planIdx >= 0) allPlans[planIdx] = updatedPlan;

	const allIssuesWithNew = [...allIssues, ...newIssues];
	// allIssues is mutated; replace its contents to reflect appended new children
	// so the caller's writeIssues snapshot is consistent.
	allIssues.length = 0;
	allIssues.push(...allIssuesWithNew);

	// Caller already holds locks; do the persistence here so the row mutation
	// of plans.jsonl shows up as a single replaced line in git diff.
	return { finalChildIds, revision: updatedPlan.revision, obsolete };
}

interface PlanTreeNode {
	plan: Plan;
	children: ChildSummary[];
	children_plans: PlanTreeEntry[];
}

interface PlanTreeTruncation {
	plan_id: string;
	truncated: true;
	hint: string;
}

type PlanTreeEntry = PlanTreeNode | PlanTreeTruncation;

function buildPlansBySeed(plans: Plan[]): Map<string, Plan> {
	const out = new Map<string, Plan>();
	for (const p of plans) {
		const existing = out.get(p.seed);
		if (!existing || existing.updatedAt < p.updatedAt) out.set(p.seed, p);
	}
	return out;
}

function truncationHint(planId: string): string {
	return `depth limit reached — use \`sd plan show ${planId}\` to drill in`;
}

// PLAN_SPEC.md:340, 425, 430 — recurse through nested plans up to max_plan_depth.
// Depth is 1-indexed: the root plan is at depth 1, nested plans start at 2.
function buildPlanTree(
	plan: Plan,
	issues: Issue[],
	plansBySeed: Map<string, Plan>,
	depth: number,
	maxDepth: number,
): PlanTreeNode {
	const childrenSummary = summarisePlanChildren(plan, issues);
	const childrenPlans: PlanTreeEntry[] = [];
	for (const childId of plan.children) {
		const sub = plansBySeed.get(childId);
		if (!sub) continue;
		const nextDepth = depth + 1;
		if (nextDepth > maxDepth) {
			childrenPlans.push({
				plan_id: sub.id,
				truncated: true,
				hint: truncationHint(sub.id),
			});
		} else {
			childrenPlans.push(buildPlanTree(sub, issues, plansBySeed, nextDepth, maxDepth));
		}
	}
	return { plan, children: childrenSummary, children_plans: childrenPlans };
}

function renderPlanSections(plan: Plan, template: PlanTemplate | undefined): void {
	console.log(brand("Sections:"));
	const order = ["context", "approach", "alternatives", "steps", "risks", "acceptance"];
	const knownKeys = new Set(order);
	const orderedKeys = [
		...order.filter((k) => k in plan.sections),
		...Object.keys(plan.sections).filter((k) => !knownKeys.has(k)),
	];
	for (const key of orderedKeys) {
		const value = plan.sections[key];
		const spec = template?.sections[key];
		console.log(`  ${accent.bold(key)}`);
		if (value === undefined || value === null) {
			console.log(muted("    (empty)"));
			continue;
		}
		if (typeof value === "string") {
			for (const line of value.split("\n")) console.log(`    ${line}`);
			continue;
		}
		if (Array.isArray(value)) {
			if (value.length === 0) {
				console.log(muted("    (none)"));
				continue;
			}
			renderListSection(value, spec);
			continue;
		}
		console.log(`    ${JSON.stringify(value)}`);
	}
}

function renderListSection(entries: unknown[], spec: SectionSpec | undefined): void {
	const kind = spec?.kind;
	const itemSpec = spec?.item;
	entries.forEach((entry, i) => {
		const marker = `    ${i + 1}.`;
		if (typeof entry === "string") {
			console.log(`${marker} ${entry}`);
			return;
		}
		if (kind === "steps" && isPlainRecord(entry)) {
			renderStepEntry(marker, entry);
			return;
		}
		if (kind === "list" && isPlainRecord(entry) && isItemSchema(itemSpec)) {
			renderListEntry(marker, entry, itemSpec);
			return;
		}
		console.log(`${marker} ${JSON.stringify(entry)}`);
	});
}

function renderStepEntry(marker: string, entry: Record<string, unknown>): void {
	const title = typeof entry.title === "string" ? entry.title : JSON.stringify(entry);
	console.log(`${marker} ${title}`);
	const subIndent = " ".repeat(marker.length + 1);
	const blocks = entry.blocks;
	if (Array.isArray(blocks) && blocks.length > 0) {
		const labels = blocks
			.map((b) => (typeof b === "number" ? String(b + 1) : JSON.stringify(b)))
			.join(", ");
		console.log(`${subIndent}${muted(`blocks: ${labels}`)}`);
	}
	if (entry.requires_plan === true) {
		console.log(`${subIndent}${muted("requires_plan: true")}`);
	}
	if (typeof entry.plan_template === "string" && entry.plan_template.length > 0) {
		console.log(`${subIndent}${muted(`plan_template: ${entry.plan_template}`)}`);
	}
}

function renderListEntry(
	marker: string,
	entry: Record<string, unknown>,
	itemSpec: Record<string, SectionSpec>,
): void {
	const subIndent = " ".repeat(marker.length + 1);
	const fieldNames = Object.keys(itemSpec);
	let firstLineWritten = false;
	for (const field of fieldNames) {
		const fv = entry[field];
		if (fv === undefined || fv === null || fv === "") continue;
		const rendered = typeof fv === "string" ? fv : JSON.stringify(fv);
		if (!firstLineWritten) {
			console.log(`${marker} ${field}: ${rendered}`);
			firstLineWritten = true;
		} else {
			console.log(`${subIndent}${field}: ${rendered}`);
		}
	}
	if (!firstLineWritten) {
		console.log(`${marker} ${JSON.stringify(entry)}`);
	}
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isItemSchema(item: SectionSpec["item"]): item is Record<string, SectionSpec> {
	return typeof item === "object" && item !== null;
}

function renderNestedPlanHuman(entry: PlanTreeEntry, indent: string): void {
	if ("truncated" in entry) {
		console.log(`${indent}${muted(entry.hint)}`);
		return;
	}
	const { plan, children, children_plans } = entry;
	console.log(
		`${indent}${brand("Sub-plan:")} ${accent.bold(plan.id)}  ${muted(`[${plan.status}]`)}  ${muted(`rev ${plan.revision}`)}  ${muted(`seed=${plan.seed}`)}`,
	);
	console.log(`${indent}${muted(`Children (${children.length}):`)}`);
	const childIndent = `${indent}  `;
	if (children.length === 0) {
		console.log(`${childIndent}${muted("(none)")}`);
	} else {
		for (const c of children) {
			console.log(`${childIndent}${accent(c.id)}  ${muted(`[${c.status}]`)}  ${c.title}`);
		}
	}
	for (const sub of children_plans) {
		console.log("");
		renderNestedPlanHuman(sub, childIndent);
	}
}

async function runShow(planId: string, jsonMode: boolean): Promise<void> {
	const dir = await findSeedsDir();
	const config = await readConfig(dir);
	const maxDepth = maxPlanDepth(config);
	const plans = await readPlans(dir);
	const plan = plans.find((p) => p.id === planId);
	if (!plan) {
		throw new Error(`Plan not found: ${planId}. Run 'sd plan list' to see available plans.`);
	}
	const issues = await readIssues(dir);
	const plansBySeed = buildPlansBySeed(plans);
	const tree = buildPlanTree(plan, issues, plansBySeed, 1, maxDepth);
	const templates = await loadPlanTemplates(dir);
	const template = templates[plan.template];

	if (jsonMode) {
		outputJson({
			success: true,
			command: "plan show",
			plan,
			children: tree.children,
			children_plans: tree.children_plans,
		});
		return;
	}

	console.log(`${accent.bold(plan.id)}  ${brand(plan.status)}  ${muted(`rev ${plan.revision}`)}`);
	console.log(`Seed:     ${accent(plan.seed)}`);
	console.log(`Template: ${plan.template}`);
	console.log(`Created:  ${muted(plan.createdAt)}`);
	console.log(`Updated:  ${muted(plan.updatedAt)}`);
	if (plan.outcome) {
		const note = plan.outcomeNote ? ` — ${plan.outcomeNote}` : "";
		console.log(`Outcome:  ${plan.outcome}${note}`);
	}
	// PLAN_SPEC.md:404-413 — review hint is purely cosmetic and only relevant
	// while a plan is awaiting work or in flight.
	const reviewActionable = plan.status === "approved" || plan.status === "active";
	if (!plan.reviewedBy && reviewActionable) {
		console.log(muted("Review suggested (no reviewer recorded yet)"));
	}
	if (plan.reviewedBy) {
		console.log(`Reviewed: ${plan.reviewedBy}`);
	}

	console.log("");
	renderPlanSections(plan, template);

	console.log("");
	console.log(brand(`Children (${tree.children.length}):`));
	if (tree.children.length === 0) {
		console.log(muted("  (none)"));
	} else {
		for (const c of tree.children) {
			console.log(`  ${accent(c.id)}  ${muted(`[${c.status}]`)}  ${c.title}`);
		}
	}

	for (const sub of tree.children_plans) {
		console.log("");
		renderNestedPlanHuman(sub, "  ");
	}
}

interface ListFilters {
	seed?: string;
	status?: string;
	outcome?: string;
	template?: string;
}

const VALID_PLAN_STATUSES = new Set(["draft", "approved", "active", "done"]);
const VALID_PLAN_OUTCOMES = new Set(["success", "partial", "failure"]);

async function runList(filters: ListFilters, jsonMode: boolean): Promise<void> {
	if (filters.status && !VALID_PLAN_STATUSES.has(filters.status)) {
		throw new Error(
			`--status must be one of: ${[...VALID_PLAN_STATUSES].join(", ")} (got: ${filters.status})`,
		);
	}
	if (filters.outcome && !VALID_PLAN_OUTCOMES.has(filters.outcome)) {
		throw new Error(
			`--outcome must be one of: ${[...VALID_PLAN_OUTCOMES].join(", ")} (got: ${filters.outcome})`,
		);
	}

	const dir = await findSeedsDir();
	const plans = await readPlans(dir);
	const filtered = plans
		.filter((p) => (filters.seed ? p.seed === filters.seed : true))
		.filter((p) => (filters.status ? p.status === filters.status : true))
		.filter((p) => (filters.outcome ? p.outcome === filters.outcome : true))
		.filter((p) => (filters.template ? p.template === filters.template : true))
		.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

	if (jsonMode) {
		outputJson({
			success: true,
			command: "plan list",
			plans: filtered,
			count: filtered.length,
		});
		return;
	}

	if (filtered.length === 0) {
		console.log(muted("No plans match."));
		return;
	}
	for (const p of filtered) {
		const outcome = p.outcome ? muted(` (${p.outcome})`) : "";
		console.log(
			`${accent.bold(p.id)}  ${muted(p.status)}  rev ${p.revision}  ${muted(p.template)}  ${muted(`seed=${p.seed}`)}  ${muted(`children=${p.children.length}`)}${outcome}  ${muted(p.createdAt)}`,
		);
	}
}

const VALID_OUTCOMES = new Set(["success", "partial", "failure"]);

async function runOutcome(
	planId: string,
	result: string,
	note: string | undefined,
	jsonMode: boolean,
): Promise<void> {
	if (!VALID_OUTCOMES.has(result)) {
		throw new Error(`--result must be one of: ${[...VALID_OUTCOMES].join(", ")} (got: ${result})`);
	}
	const dir = await findSeedsDir();
	let updatedPlan: Plan | null = null;
	let openChildren = 0;
	await withLock(plansPath(dir), async () => {
		await withLock(issuesPath(dir), async () => {
			const plans = await readPlans(dir);
			const idx = plans.findIndex((p) => p.id === planId);
			const plan = plans[idx];
			if (!plan) {
				throw new Error(`Plan not found: ${planId}. Run 'sd plan list' to see available plans.`);
			}
			const issues = await readIssues(dir);
			openChildren = plan.children.filter((cid) => {
				const issue = issues.find((i) => i.id === cid);
				return issue && issue.status !== "closed";
			}).length;
			const next: Plan = {
				...plan,
				outcome: result as Plan["outcome"],
				updatedAt: new Date().toISOString(),
			};
			if (note !== undefined) next.outcomeNote = note;
			plans[idx] = next;
			await writePlans(dir, plans);
			updatedPlan = next;
		});
	});

	if (!updatedPlan) return; // unreachable; throw above
	const finalPlan: Plan = updatedPlan;

	// PLAN_SPEC.md:431 — open children → warning, not error.
	if (openChildren > 0) {
		process.stderr.write(
			`⚠ plan ${finalPlan.id} has ${openChildren} open child${openChildren === 1 ? "" : "ren"}\n`,
		);
	}

	if (jsonMode) {
		outputJson({
			success: true,
			command: "plan outcome",
			plan_id: finalPlan.id,
			outcome: finalPlan.outcome,
			outcomeNote: finalPlan.outcomeNote,
			open_children: openChildren,
		});
		return;
	}
	const noteSuffix = finalPlan.outcomeNote ? ` — ${finalPlan.outcomeNote}` : "";
	printSuccess(`plan ${accent(finalPlan.id)} outcome recorded: ${finalPlan.outcome}${noteSuffix}`);
}

async function runReview(planId: string, by: string, jsonMode: boolean): Promise<void> {
	const dir = await findSeedsDir();
	let updatedPlan: Plan | null = null;
	await withLock(plansPath(dir), async () => {
		const plans = await readPlans(dir);
		const idx = plans.findIndex((p) => p.id === planId);
		const plan = plans[idx];
		if (!plan) {
			throw new Error(`Plan not found: ${planId}. Run 'sd plan list' to see available plans.`);
		}
		const next: Plan = { ...plan, reviewedBy: by, updatedAt: new Date().toISOString() };
		plans[idx] = next;
		await writePlans(dir, plans);
		updatedPlan = next;
	});

	if (!updatedPlan) return;
	const finalPlan: Plan = updatedPlan;

	if (jsonMode) {
		outputJson({
			success: true,
			command: "plan review",
			plan_id: finalPlan.id,
			reviewedBy: finalPlan.reviewedBy,
		});
		return;
	}
	printSuccess(`plan ${accent(finalPlan.id)} reviewed by ${finalPlan.reviewedBy}`);
}

async function runValidate(planId: string, jsonMode: boolean): Promise<void> {
	const dir = await findSeedsDir();
	const plans = await readPlans(dir);
	const plan = plans.find((p) => p.id === planId);
	if (!plan) {
		throw new Error(`Plan not found: ${planId}. Run 'sd plan list' to see available plans.`);
	}
	const templates = await loadPlanTemplates(dir);
	const template = templates[plan.template];
	if (!template) {
		const available = Object.keys(templates).join(", ");
		throw new Error(
			`Plan ${planId} references unknown template '${plan.template}'. Available: ${available}.`,
		);
	}

	// Re-run the same validator submit uses so the partial-state diff shape stays
	// in sync (PLAN_SPEC.md:148-149 + 180-195).
	const validate = compilePlanTemplate(template);
	const subject = { template: plan.template, sections: plan.sections };
	const result = validate(subject);

	if (result.valid) {
		if (jsonMode) {
			outputJson({ success: true, command: "plan validate", valid: true, plan_id: planId });
		} else {
			printSuccess(`plan ${accent(planId)} valid`);
		}
		return;
	}

	process.stderr.write(`${JSON.stringify(result.diff, null, 2)}\n`);
	process.exitCode = 1;
}

interface OutboundDecisionArgs {
	seed: Issue;
	planId: string;
	approach: unknown;
	domainOverride?: string;
	cwd: string;
}

async function runOutboundDecision(args: OutboundDecisionArgs): Promise<void> {
	const projectRoot = dirname(args.cwd);
	// Check ml availability first so the stderr warning distinguishes
	// "ml not installed" from "no domain matched" — the spec mandates the
	// former phrasing for the absent-ml branch (PLAN_SPEC.md:354-356).
	if (!Bun.which("ml", { PATH: process.env.PATH })) {
		process.stderr.write("⚠ --record-decision: ml not found on PATH; skipping\n");
		return;
	}
	const { domain } = inferDomain({
		seed: args.seed,
		explicitDomain: args.domainOverride,
		cwd: projectRoot,
	});
	if (!domain) {
		process.stderr.write("⚠ --record-decision: no mulch domain inferred (skipping)\n");
		return;
	}
	const approach = typeof args.approach === "string" ? args.approach : "";
	const result = recordDecision({
		domain,
		planId: args.planId,
		title: args.seed.title,
		approach,
		cwd: projectRoot,
	});
	if (!result.ok) {
		process.stderr.write(`⚠ --record-decision: ${result.reason ?? "failed"}\n`);
	}
}
