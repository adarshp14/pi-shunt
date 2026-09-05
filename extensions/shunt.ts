/**
 * shunt — route I/O-heavy work to a cheap worker model (any model Pi can auth to).
 *
 * Port of Spotify's shunt Claude Code plugin, minus Portal. The worker is any
 * model in Pi's registry: Copilot, OpenAI, Anthropic, Gemini, OpenRouter...
 *
 *   /shunt                        show status
 *   /shunt <provider>/<model-id>  pick the worker (tab-completes authed models)
 *   /shunt lines <n>              line threshold for blocking full reads (default 350)
 *   /shunt off                    disable gating (tools stay available)
 *
 * Gating: `read` of a file over the threshold (no offset/limit) and bare
 * `cat|head|tail|less|more <bigfile>` in bash are blocked with a pointer to
 * `bulk_read`. Nothing is blocked until a worker is configured.
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const CONFIG_PATH = resolve(homedir(), ".pi/agent/shunt.json");
const READ_CMD = /^\s*(cat|head|tail|less|more)\s+(.+)$/;

const PROMPTS = {
	"bulk-reader":
		"You are a precise code analyst. Read the provided files and answer the question concisely. Output structured bullets only. No greetings, no prose, no preambles, no summaries. Lead every bullet with the exact name, type, or line number. Use nested bullets for details. Skip anything the caller did not ask for. Only report relationships that are explicitly declared in the code; never infer them from names.",
	"code-writer":
		"You generate code files based on a spec and reference files. Match the existing patterns, conventions, naming, and style exactly. Use only identifiers, columns and APIs that appear in the reference files. Output only the code. No explanations, no markdown fences unless asked. If the spec is ambiguous, make reasonable choices that match the patterns in the reference code.",
};

type Config = { provider?: string; model?: string; minLines: number; enabled: boolean };

function loadConfig(): Config {
	try {
		return { minLines: 350, enabled: true, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
	} catch {
		return { minLines: 350, enabled: true };
	}
}
function saveConfig(c: Config) {
	writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

function lineCount(path: string): number {
	try {
		if (!statSync(path).isFile()) return 0;
		return readFileSync(path, "utf8").split("\n").length;
	} catch {
		return 0;
	}
}

function wrapFiles(paths: string[], cwd: string): { text: string; missing: string[] } {
	const missing: string[] = [];
	let text = "";
	for (const p of paths) {
		const abs = resolve(cwd, p);
		if (!existsSync(abs)) {
			missing.push(p);
			continue;
		}
		text += `<file path="${p}">\n${readFileSync(abs, "utf8")}\n</file>\n\n`;
	}
	return { text, missing };
}

export default function shunt(pi: ExtensionAPI) {
	let cfg = loadConfig();
	let registry: ExtensionContext["modelRegistry"] | undefined;
	pi.on("session_start", (_e, ctx) => { registry = ctx.modelRegistry; });

	const workerLabel = () => (cfg.provider && cfg.model ? `${cfg.provider}/${cfg.model}` : "not set");

	// Resolve worker model + auth from Pi's own registry, so Copilot/OpenAI/etc. OAuth just works.
	async function invoke(mode: keyof typeof PROMPTS, message: string, ctx: ExtensionContext, signal?: AbortSignal) {
		if (!cfg.provider || !cfg.model) throw new Error("No worker model. Run /shunt <provider>/<model-id>.");
		const model = ctx.modelRegistry.find(cfg.provider, cfg.model);
		if (!model) throw new Error(`Worker ${workerLabel()} not in registry. Run /shunt to pick another.`);
		// Two attempts: concurrent Pi processes (subagents, a second session) can race on an
		// OAuth token refresh, and the loser's request fails once. Fresh auth on retry picks
		// up the refreshed token from disk.
		const t0 = Date.now();
		let res!: Awaited<ReturnType<typeof complete>>;
		for (let attempt = 1; ; attempt++) {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(`Auth for ${workerLabel()}: ${auth.error}`);
			if (!auth.apiKey) throw new Error(`No API key/OAuth for ${workerLabel()}.`);
			res = await complete(
				model,
				{
					systemPrompt: PROMPTS[mode],
					messages: [{ role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() }],
				},
				{ apiKey: auth.apiKey, headers: auth.headers, signal, ...(model.reasoning ? {} : { temperature: 0.2 }) },
			);
			if (res.stopReason !== "error" || attempt >= 2 || signal?.aborted) break;
			await new Promise((r) => setTimeout(r, 1500));
		}
		const text = res.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
		if (!text) throw new Error(`${workerLabel()} returned no text (stop: ${res.stopReason}${res.errorMessage ? `: ${res.errorMessage}` : ""}).`);
		return { text, inputTokens: res.usage ? (res.usage.input ?? 0) + (res.usage.cacheRead ?? 0) : Math.round(message.length / 4), ms: Date.now() - t0 };
	}

	// ---- gate -----------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		if (!cfg.enabled || !cfg.provider) return;
		let path: string | undefined;
		if (isToolCallEventType("read", event)) {
			if (event.input.offset != null || event.input.limit != null) return;
			path = event.input.path;
		} else if (isToolCallEventType("bash", event)) {
			const cmd = event.input.command;
			if (/[|>]/.test(cmd)) return; // targeted read or redirect
			const m = READ_CMD.exec(cmd);
			if (!m) return;
			path = m[2].split(/\s+/).find((a) => !a.startsWith("-"))?.replace(/^["']|["']$/g, "");
		}
		if (!path) return;
		const lines = lineCount(resolve(ctx.cwd, path));
		if (lines <= cfg.minLines) return;
		return {
			block: true,
			reason: `File is ${lines} lines (threshold ${cfg.minLines}). Use bulk_read to delegate this to the ${workerLabel()} worker. If you need exact content for editing, re-read with offset/limit for just that section.`,
		};
	});

	// ---- tools ----------------------------------------------------------
	pi.registerTool({
		name: "bulk_read",
		label: "Bulk Read",
		description:
			"Delegate reading large files to a cheap worker model and get back a concise structured answer. Use for files over the threshold, questions spanning 3+ files, or summarising large diffs. Line numbers in the answer are unreliable; verify with a targeted read before editing.",
		promptSnippet: "Answer a question about large files via a cheap worker model without loading them into context",
		promptGuidelines: [
			"Use bulk_read instead of read for files over the shunt line threshold, or when a question spans several files.",
			"Never edit based on line numbers from bulk_read; re-read the exact section with offset/limit first.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "What you want to know about the files" }),
			paths: Type.Array(Type.String(), { description: "Files to read (relative to cwd)", minItems: 1 }),
		}),
		async execute(_id, { question, paths }, signal, _onUpdate, ctx) {
			const { text: files, missing } = wrapFiles(paths, ctx.cwd);
			if (missing.length) throw new Error(`File not found: ${missing.join(", ")}`);
			const r = await invoke("bulk-reader", `${files}Question: ${question}\n`, ctx, signal);
			return {
				content: [{ type: "text", text: r.text }],
				details: { worker: workerLabel(), inputTokens: r.inputTokens, ms: r.ms, paths },
			};
		},
	});

	pi.registerTool({
		name: "code_write",
		label: "Code Write",
		description:
			"Delegate boilerplate generation (tests, stubs, config, routers) to a cheap worker model that matches the patterns in reference files. Pass the pattern file AND the source/schema it must be correct against as references. Writes to target if given, else returns the code.",
		promptSnippet: "Generate boilerplate from a spec + reference files via a cheap worker model",
		promptGuidelines: [
			"Use code_write for tests, stubs and scaffolding where most of the output is predictable from reference files; always typecheck or run the result.",
		],
		parameters: Type.Object({
			spec: Type.String({ description: "What to generate" }),
			references: Type.Array(Type.String(), { description: "Files whose patterns/identifiers the output must match", minItems: 1 }),
			target: Type.Optional(Type.String({ description: "Write output here (relative to cwd) instead of returning it" })),
		}),
		async execute(_id, { spec, references, target }, signal, _onUpdate, ctx) {
			const { text: files, missing } = wrapFiles(references, ctx.cwd);
			if (missing.length) throw new Error(`Reference not found: ${missing.join(", ")}`);
			const r = await invoke("code-writer", `Spec: ${spec}\n\n${files}`, ctx, signal);
			const code = r.text.replace(/^```[a-z]*\n?/gm, "").replace(/^```\s*$/gm, "");
			if (target) {
				writeFileSync(resolve(ctx.cwd, target), code.endsWith("\n") ? code : code + "\n");
				const n = code.split("\n").length;
				return {
					content: [{ type: "text", text: `Wrote ${n} lines to ${target} via ${workerLabel()}. Not shown; typecheck/run it, then read specific parts if needed.` }],
					details: { worker: workerLabel(), inputTokens: r.inputTokens, ms: r.ms, target, lines: n },
				};
			}
			return { content: [{ type: "text", text: code }], details: { worker: workerLabel(), inputTokens: r.inputTokens, ms: r.ms } };
		},
	});

	// ---- command --------------------------------------------------------
	pi.registerCommand("shunt", {
		description: "Pick the shunt worker model: /shunt <provider>/<model> | lines <n> | off | on",
		getArgumentCompletions: (prefix: string) => {
			const items = (registry?.getAvailable() ?? [])
				.map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}` }))
				.concat([{ value: "off", label: "off" }, { value: "on", label: "on" }, { value: "lines ", label: "lines <n>" }])
				.filter((i) => i.value.startsWith(prefix));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const a = args.trim();
			if (!a) {
				ctx.ui.notify(`shunt: worker ${workerLabel()} | threshold ${cfg.minLines} lines | gate ${cfg.enabled ? "on" : "off"}`, "info");
				return;
			}
			if (a === "off" || a === "on") {
				cfg.enabled = a === "on";
			} else if (a.startsWith("lines ")) {
				const n = parseInt(a.slice(6), 10);
				if (!Number.isFinite(n) || n < 1) return ctx.ui.notify("Usage: /shunt lines <n>", "error");
				cfg.minLines = n;
			} else {
				const slash = a.indexOf("/");
				if (slash < 1) return ctx.ui.notify("Usage: /shunt <provider>/<model-id>", "error");
				const provider = a.slice(0, slash), id = a.slice(slash + 1);
				if (!ctx.modelRegistry.find(provider, id)) return ctx.ui.notify(`Unknown model ${a}. Tab-complete to see authed models.`, "error");
				cfg.provider = provider;
				cfg.model = id;
			}
			saveConfig(cfg);
			ctx.ui.notify(`shunt: worker ${workerLabel()} | threshold ${cfg.minLines} lines | gate ${cfg.enabled ? "on" : "off"}`, "info");
		},
	});
}
