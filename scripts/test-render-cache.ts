import { AssistantMessageComponent, CustomMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Loader } from "@earendil-works/pi-tui";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

initTheme("dark", false);

// Load the extension onto a fake pi so the render patches apply.
const eventHandlers = new Map<string, Array<(event: any, ctx: any) => Promise<void> | void>>();
const fakePi = {
	tools: new Map(), commands: new Map(),
	registerTool(d: any) { this.tools.set(d.name, d); },
	registerCommand(n: string, c: any) { this.commands.set(n, c); },
	registerShortcut(_k: string, _s: any) {},
	on(name: string, handler: (event: any, ctx: any) => Promise<void> | void) {
		const handlers = eventHandlers.get(name) ?? [];
		handlers.push(handler);
		eventHandlers.set(name, handlers);
	},
	getThinkingLevel() { return "off"; },
	getAllTools() { return [...this.tools.values()]; },
};
const ext = await import("../extensions/index.ts");
const spinnerExt = await import("../extensions/spinner.ts");
ext.default(fakePi as any);
spinnerExt.default(fakePi as any);

const W = 120;

// Snapshot string-array output for comparison (copy so later mutations don't matter).
const snap = (v: string[]) => v.join("\n");
const plain = (value: unknown) => String(value ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const eq = (a: string[], b: string[], label: string) => {
	if (snap(a) !== snap(b)) throw new Error(`MISMATCH: ${label}`);
};
const neq = (a: string[], b: string[], label: string) => {
	if (snap(a) === snap(b)) throw new Error(`UNEXPECTED EQUAL: ${label}`);
};

// ---------------------------------------------------------------------------
// 1. Assistant message: cache hit is byte-identical; updateContent invalidates.
// ---------------------------------------------------------------------------
{
	const msg = {
		role: "assistant",
		content: [{ type: "text", text: "Hello world\n\n- one\n- two\n\n```ts\nconst x = 1;\n```" }],
		stopReason: "end_turn",
	};
	const c = new AssistantMessageComponent(msg as any, false);
	const dottedParagraph = (c as any).contentContainer?.children?.find(
		(child: unknown) => (child as { constructor?: { name?: string } })?.constructor?.name === "DottedParagraph",
	);
	if (!dottedParagraph) throw new Error("assistant: cross-instance Markdown patch was not applied");
	const a = c.render(W);
	const b = c.render(W); // warm → cache hit
	eq(b, a, "assistant: warm cache hit must equal cold render");

	// Mutate content via updateContent; cache must invalidate.
	const msg2 = {
		role: "assistant",
		content: [{ type: "text", text: "Completely different content that should produce different lines." }],
		stopReason: "end_turn",
	};
	c.updateContent(msg2 as any);
	const d = c.render(W);
	neq(d, a, "assistant: updateContent did NOT invalidate the render cache (stale output)");
	const e = c.render(W); // warm again after recompute
	eq(e, d, "assistant: warm cache hit after updateContent must equal the recompute");
	console.log("OK  assistant message: cache identical + updateContent invalidates");
}

// ---------------------------------------------------------------------------
// 2. User message: immutable content → deterministic across renders.
// ---------------------------------------------------------------------------
{
	const c = new UserMessageComponent("User asks a question with **bold** and `code`.");
	const a = c.render(W);
	const b = c.render(W);
	eq(b, a, "user: warm cache hit must equal cold render");
	console.log("OK  user message: cache identical across renders");
}

// ---------------------------------------------------------------------------
// 3. Custom message: rebuild() invalidates.
// ---------------------------------------------------------------------------
{
	const message = { customType: "subagent-notification", content: "✓ Done\n⎿ transcript: foo" };
	const c = new CustomMessageComponent(message as any, undefined as any);
	const a = c.render(W);
	const b = c.render(W);
	eq(b, a, "custom: warm cache hit must equal cold render");
	// invalidate() → rebuild() → cache cleared
	c.invalidate();
	const d = c.render(W);
	eq(d, a, "custom: after invalidate output should still be equivalent (same content)");
	const e = c.render(W);
	eq(e, d, "custom: warm cache hit after invalidate must equal recompute");
	console.log("OK  custom message: cache identical + rebuild invalidates");
}

// ---------------------------------------------------------------------------
// 4. Parent Container.render must NOT mutate the cached child array.
//    Render child, capture cached ref, wrap in a parent, render parent, then
//    re-render child and confirm the cached array is unchanged.
// ---------------------------------------------------------------------------
{
	const msg = { role: "assistant", content: [{ type: "text", text: "Line one\nLine two\nLine three" }], stopReason: "end_turn" };
	const child = new AssistantMessageComponent(msg as any, false);
	const first = child.render(W); // populates cache, returns cached ref
	const snapshot = snap(first);
	const parent = new Container();
	parent.addChild(child);
	parent.render(W); // spreads child's cached array — must not mutate it
	if (snap(first) !== snapshot) throw new Error("parent render mutated the child's cached array");
	if (snap(child.render(W)) !== snapshot) throw new Error("child cached array changed after parent render");
	console.log("OK  parent does not mutate cached child array");
}

// ---------------------------------------------------------------------------
// 5. Custom (subagent) message framing follows toolBackgroundMode. Switching
//    mode must invalidate the cached framing. Uses an isolated temp HOME so the
//    real ~/.pi/settings.json is never touched.
// ---------------------------------------------------------------------------
{
	const realHome = process.env.HOME;
	const tmpHome = `${realHome}/.pi-cache-test-home-${Date.now()}`;
	const fs = await import("node:fs");
	fs.mkdirSync(`${tmpHome}/.pi`, { recursive: true });
	process.env.HOME = tmpHome;
	try {
		const ccTools = (fakePi as any).commands.get("cc-tools");
		if (!ccTools) throw new Error("cc-tools command not registered");
		const ctx = { hasUI: true, ui: { theme, notify() {}, getToolsExpanded() { return false; }, setToolsExpanded() {} } } as any;
		const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
		// A full-width rule line (borderLine) is all '─' chars; branch connectors '└─' are not.
		const hasFullWidthRule = (lines: string[]) =>
			lines.some((l) => { const p = stripAnsi(l); return /^─+$/.test(p) && p.length > 5; });

		// Start in outlines mode (default). Render subagent msg → has full-width border rules.
		ccTools.handler("outlines", ctx);
		const message = { customType: "subagent-notification", content: "✓ Done\n⎿ transcript: foo" };
		const c = new CustomMessageComponent(message as any, undefined as any);
		const outlines = c.render(W);
		const outlinesWarm = c.render(W);
		eq(outlinesWarm, outlines, "custom: warm cache identical in outlines mode");
		if (!hasFullWidthRule(outlines)) {
			throw new Error("outlines mode did not produce full-width border rule lines");
		}

		// Switch to default mode (no borders). Cache must miss and reframe.
		ccTools.handler("default", ctx);
		const def = c.render(W);
		neq(def, outlines, "custom: switching toolBackgroundMode did NOT reframe (stale cache)");
		if (hasFullWidthRule(def)) {
			throw new Error("default mode still shows full-width border rule lines");
		}
		const defWarm = c.render(W);
		eq(defWarm, def, "custom: warm cache identical in default mode");

		// Switch back to outlines — must reframe again.
		ccTools.handler("outlines", ctx);
		const outlinesAgain = c.render(W);
		eq(outlinesAgain, outlines, "custom: switching back to outlines did not restore original framing");
		console.log("OK  custom message: toolBackgroundMode change invalidates framing");
	} finally {
		process.env.HOME = realHome;
		fs.rmSync(tmpHome, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 6. Working indicator uses the public API and the completion line has one
//    owner. Thinking transitions must not schedule a duplicate status update.
// ---------------------------------------------------------------------------
{
	const loader = new Loader(
		{ requestRender() {} } as any,
		(value) => value,
		(value) => value,
		"working",
		{ frames: ["X"], intervalMs: 1_000 },
	);
	const loaderText = plain(loader.render(40).join("\n"));
	loader.stop();
	if (!loaderText.includes("X working")) {
		throw new Error("spinner: custom Loader indicator was overridden globally");
	}

	const workingMessages: Array<string | undefined> = [];
	const workingIndicators: Array<{ frames?: string[]; intervalMs?: number } | undefined> = [];
	const ui = {
		theme,
		setWorkingMessage(message?: string) { workingMessages.push(message); },
		setWorkingIndicator(indicator?: { frames?: string[]; intervalMs?: number }) { workingIndicators.push(indicator); },
		requestRender() {},
		invalidate() {},
		notify() {},
		getToolsExpanded() { return false; },
		setToolsExpanded() {},
	};
	const ctx = { hasUI: true, ui } as any;
	const fire = async (name: string, event: Record<string, unknown> = { type: name }) => {
		for (const handler of eventHandlers.get(name) ?? []) {
			await handler(event, ctx);
		}
	};

	await fire("session_start", { type: "session_start", reason: "startup" });
	const indicator = workingIndicators.find((value) => value !== undefined);
	if (!indicator || indicator.intervalMs !== 250 || !Array.isArray(indicator.frames) || indicator.frames.length === 0) {
		throw new Error("spinner: public working indicator was not configured");
	}

	const message = {
		role: "assistant",
		content: [{ type: "text", text: "Lifecycle answer" }],
		stopReason: "stop",
		timestamp: Date.now(),
	};
	await fire("before_agent_start");
	await fire("agent_start");
	await fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
	await fire("message_start", { type: "message_start", message });

	const beforeThinking = workingMessages.length;
	await fire("message_update", {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	if (workingMessages.length - beforeThinking !== 1) {
		throw new Error("spinner: thinking transition produced duplicate working-message updates");
	}

	await fire("message_end", { type: "message_end", message });
	await fire("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] });
	if (workingIndicators.filter((value) => value !== undefined).length !== 1) {
		throw new Error("spinner: working indicator was configured more than once per session");
	}
	const completionLines = plain(message.content[0].text)
		.split("\n")
		.filter((line) => line.includes("Turn took"));
	if (completionLines.length !== 1) {
		throw new Error(`statusline: expected one completion line, got ${completionLines.length}`);
	}
	if (workingMessages.some((value) => plain(value).includes("Turn took"))) {
		throw new Error("statusline: completion line was duplicated in the working status");
	}

	await fire("agent_end", { type: "agent_end", messages: [message] });
	await fire("session_shutdown", { type: "session_shutdown", reason: "exit" });
	if (workingIndicators.at(-1) !== undefined) {
		throw new Error("spinner: working indicator was not restored on shutdown");
	}
	console.log("OK  spinner lifecycle: public indicator + single completion line + no duplicate status update");
}

console.log("\nAll correctness checks passed.");
