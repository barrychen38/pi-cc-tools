import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssistantMessageComponent, InteractiveMode, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	Container,
	Text,
	visibleWidth,
	type AutocompleteProvider,
	type Component,
} from "@earendil-works/pi-tui";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

initTheme("dark", false);

type ToolDefinition = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	renderShell?: "default" | "self";
	execute?: (...args: unknown[]) => Promise<Record<string, unknown>>;
	[key: string]: unknown;
};

class FakeEventBus extends Map<string, Array<(...args: unknown[]) => unknown>> {
	on(name: string, handler: (data: unknown) => unknown): () => void {
		const handlers = this.get(name) ?? [];
		handlers.push(handler);
		this.set(name, handlers);
		return () => {
			const current = this.get(name);
			if (!current) return;
			const index = current.indexOf(handler);
			if (index >= 0) current.splice(index, 1);
		};
	}

	emit(name: string, data: unknown): void {
		for (const handler of this.get(name) ?? []) void handler(data);
	}
}

class FakePi {
	tools = new Map<string, ToolDefinition>();
	events = new FakeEventBus();
	commands: Array<{ name: string; source: string; sourceInfo: { path: string; baseDir?: string } }> = [];

	registerTool(definition: ToolDefinition): void {
		this.tools.set(definition.name, definition);
	}

	registerCommand(): void {}
	registerShortcut(): void {}
	getCommands() { return this.commands; }

	on(name: string, handler: (...args: unknown[]) => unknown): void {
		this.events.on(name, handler);
	}
}

const fakePi = new FakePi();
const extension = await import("../extensions/index.ts");
extension.default(fakePi as never);

const width = 120;
const cwd = process.cwd();
const fakeUi = { requestRender() {} };

function plain(lines: string[]): string {
	return stripAnsi(lines.join("\n"));
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function ensureArray(output: string[] | string): string[] {
	return Array.isArray(output) ? output : [output];
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertTextStartsAtColumnZero(lines: string[], text: string): void {
	const line = lines.find((candidate) => candidate.includes(text));
	assert(line, `rendered text was missing: ${text}`);
	const textIndex = line.indexOf(text);
	assert(
		visibleWidth(line.slice(0, textIndex)) === 0,
		`rendered text had left padding: ${text}`,
	);
}

function toolComponent(
	name: string,
	args: Record<string, unknown>,
	result: Record<string, unknown>,
	definition: ToolDefinition | undefined = fakePi.tools.get(name),
	componentCwd = cwd,
): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		name,
		`test-${name}`,
		args,
		{ showImages: false },
		definition as never,
		fakeUi as never,
		componentCwd,
	);
	component.markExecutionStarted();
	component.setArgsComplete();
	component.updateResult(result as never, false);
	return component;
}

// A real /reload evaluates a NEW module, not just its default export again.
for (const reload of [1, 2]) {
	const wrapper = AssistantMessageComponent.prototype.updateContent;
	const fresh = await import(`../extensions/index.ts?thinking-reload-test=${reload}`);
	assert(fresh.default !== extension.default, "reload test reused the original module");
	const reloadedPi = new FakePi();
	fresh.default(reloadedPi as never);
	assert(AssistantMessageComponent.prototype.updateContent === wrapper, "reload stacked thinking wrappers");
	const context = {
		hasUI: true, cwd,
		ui: { theme, setWorkingIndicator() {}, setWorkingMessage() {}, setWorkingVisible() {} },
	};
	for (const handler of reloadedPi.events.get("agent_start") ?? []) await handler({}, context);
	const message = {
		role: "assistant", timestamp: 98765, provider: "test", model: "test", stopReason: "stop",
		content: [{ type: "thinking", thinking: "**one**\ntwo\nthree\nfour\nfive\nsix" }],
	};
	for (const handler of reloadedPi.events.get("message_update") ?? []) {
		await handler({ message, assistantMessageEvent: { type: "thinking_start" } }, context);
	}
	const component = new AssistantMessageComponent(message as never, true);
	const active = plain(ensureArray(component.render(width)));
	assert(active.includes("Thinking…") && active.includes("six"), `fresh module lost active thinking: ${active}`);
	for (const handler of reloadedPi.events.get("message_update") ?? []) {
		await handler({ message, assistantMessageEvent: { type: "thinking_end" } }, context);
	}
	component.updateContent(message as never);
	const done = plain(ensureArray(component.render(width)));
	assert(done.includes("… +3 lines (ctrl+o to expand)") && /took \d+\.\d+s/.test(done), "reload lost completed summary");
	assert(done.includes("│ one") && !done.includes("**"), "completed thinking exposed Markdown bold markers");
	for (const handler of reloadedPi.events.get("message_end") ?? []) await handler({ message }, context);
	component.updateContent(message as never);
	assert(/took \d+\.\d+s/.test(plain(ensureArray(component.render(width)))), "reload lost persisted duration on message_end");
	console.log(`OK  thinking: fresh module reload ${reload} keeps live state, theme and completed summary`);
}


// The extension only replaces the seven built-in display adapters.
for (const name of ["read", "bash", "grep", "find", "ls", "write", "edit"]) {
	assert(fakePi.tools.has(name), `missing built-in override: ${name}`);
}

// Built-in overrides retain behavioral metadata added by Pi, not only their
// schema and executor.
for (const name of ["read", "bash", "write", "edit"]) {
	const definition = fakePi.tools.get(name);
	assert(definition?.constrainedSampling, `${name} lost constrained sampling metadata`);
}
assert(typeof fakePi.tools.get("edit")?.prepareArguments === "function", "edit lost legacy argument preparation");
assert(typeof fakePi.tools.get("bash")?.promptSnippet === "string", "bash lost its prompt snippet");
assert(Array.isArray(fakePi.tools.get("bash")?.promptGuidelines), "bash lost its prompt guidelines");
console.log("OK  built-in metadata: constrained sampling and compatibility fields are preserved");

// Successful results show a width-bounded 3-line head preview in collapsed mode;
// Ctrl+O still expands the full result.
{
	const component = toolComponent("read", { path: "src/index.ts" }, {
		content: [{ type: "text", text: "line one\n\nline two\n   \nline three\nline four\nline five\nline six\nline seven" }],
	});
	const collapsed = plain(component.render(width));
	assert(collapsed.includes("● Read src/index.ts"), "collapsed read call style changed");
	assert(collapsed.includes("│ line one"), "collapsed preview did not show head lines");
	assert(collapsed.includes("│ line one\n│ line two\n│ line three"), "collapsed preview stopped before 3 lines");
	assert(!collapsed.includes("line four"), "collapsed preview exceeded 3 lines");
	assert(collapsed.split("\n").includes("  … +4 lines (ctrl+o to expand)"), "collapsed preview missing truncation hint");

	component.setExpanded(true);
	const expanded = plain(component.render(width));
	assert(expanded.includes("│ line one"), "expanded result did not keep branch styling");
	assert(expanded.split("\n").map((line) => line.trimEnd()).join("\n").includes("│ line six\n│ line seven"), "expanded result did not include tail lines");
	console.log("OK  built-in renderer: collapsed 3-line preview + styled expanded result");
}

// Bash partial results show a width-bounded 3-line tail preview and elapsed
// time, then clear the live timer and retain a compact duration on completion.
{
	const definition = fakePi.tools.get("bash");
	assert(definition, "missing bash definition");
	const component = new ToolExecutionComponent(
		"bash",
		"test-partial-bash",
		{ command: "printf hello" },
		{ showImages: false },
		definition as never,
		fakeUi as never,
		cwd,
	);
	component.markExecutionStarted();
	component.setArgsComplete();
	component.updateResult({
		content: [{ type: "text", text: "line one\nline two\nline three\nline four\nline five\n\nline six\n   \nline seven with a deliberately long suffix that must be clipped at narrow terminal widths" }],
	} as never, true);
	const live = plain(component.render(width));
	const narrow = ensureArray(component.render(36));
	component.updateResult({ content: [{ type: "text", text: "done" }] } as never, false);
	const completed = plain(component.render(width));

	assert(live.includes("○ Bash $ printf hello"), "pending call did not use pending status dot");
	assert(/\(\d+\.\d+s\)/.test(live), "pending bash call did not show elapsed time");
	assert(live.split("\n").includes("  …"), "live bash preview did not mark hidden earlier output");
	assert(live.includes("line five"), "live bash preview omitted the tail");
	assert(!live.includes("line four"), "live bash preview exceeded 3 lines");
	assert(narrow.every((line) => visibleWidth(line) <= 36), "live bash preview exceeded render width");
	assert(/^  took \d+\.\d+s$/m.test(completed), "completed bash result did not retain duration");
	console.log("OK  bash renderer: live 3-line tail + elapsed/took timing");
}

// Result text is untrusted terminal input. Check raw rendered bytes (not just
// visible text), across streaming, completed, expanded, error and generic paths.
{
	const controls = [
		"\x1b[1A\x1b[2K", "\x1b[?25l\x1b[2J", "\x9b1A\x9b2K",
		"\x1b]0;hidden-title\x07", "\x1b]52;c;hidden-clipboard\x1b\\",
		"\x9d0;hidden-title\x9c", "\x1bP hidden-dcs\x1b\\",
		"\x1b_hidden-apc\x1b\\", "\x1b^hidden-pm\x1b\\",
		"\x1b7\x1b8\x1bM\x1bc\x1b(B", "\x00\x07\x08\x0b\x0c\x0e\x0f\x7f\x85",
	];
	const text = `\x1b[38;2;12;34;56mcolored\x1b[0m${controls.join("")} ordinary 中文\nlast line`;
	const cases: Array<[string, Record<string, unknown>, ToolDefinition | undefined]> = [
		["bash", { command: "test-output" }, fakePi.tools.get("bash")],
		["read", { path: "test.txt" }, fakePi.tools.get("read")],
		["mcp__demo__safe", {}, { name: "mcp__demo__safe", label: "safe", description: "test", parameters: {} }],
	];
	for (const [name, args, definition] of cases) {
		for (const isError of [false, true]) {
			const result = { content: [{ type: "text", text }], isError };
			const original = JSON.stringify(result);
			const component = toolComponent(name, args, result, definition);
			for (const partial of [true, false]) {
				component.updateResult(result as never, partial);
				for (const expanded of [false, true]) {
					component.setExpanded(expanded);
					for (const renderWidth of [60, 120]) {
						const output = component.render(renderWidth).join("\n");
						const withoutStyles = output.replace(/\x1b\[[0-9;:]*m/g, "");
						assert(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(withoutStyles), `${name}: active terminal control escaped into result display`);
						assert(output.includes("\x1b[38;2;12;34;56m"), `${name}: result color was lost`);
						assert(withoutStyles.includes("colored ordinary 中文"), `${name}: ordinary result text changed`);
						assert(!withoutStyles.includes("hidden-"), `${name}: terminal string payload leaked`);
					}
				}
			}
			assert(JSON.stringify(result) === original, `${name}: rendering mutated original result`);
		}
	}
	// Generic progress clipping must not split a safe SGR sequence into an
	// unfinished escape (the old character-count clipping cut inside this one).
	const generic = toolComponent("mcp__demo__safe", {}, { content: [] }, cases[2][2]);
	generic.updateResult({ content: [{ type: "text", text: `${"x".repeat(115)}\x1b[38;2;12;34;56mcolored suffix\x1b[0m` }] } as never, true);
	const progress = generic.render(200).join("\n");
	assert(progress.includes("\x1b[38;2;12;34;56m"), "generic progress clipping split a result style");
	assert(!/[\x1b\x7f-\x9f]/.test(plain([progress])), "generic progress clipping introduced an active escape");

	for (const suffix of ["\x1b", "\x1b[", "\x1b[38;2;", "\x1b]52;c;hidden-payload", "\x1bP hidden-payload"]) {
		const component = toolComponent("read", { path: "test.txt" }, {
			content: [{ type: "text", text: `ordinary${suffix}` }],
		});
		for (const expanded of [false, true]) {
			component.setExpanded(expanded);
			const output = plain(component.render(width));
			assert(output.includes("ordinary"), "unfinished control removed ordinary text");
			assert(!/[\x1b\x7f-\x9f]/.test(output), "unfinished terminal control escaped");
			assert(!output.includes("hidden-payload"), "unfinished string control payload leaked");
		}
	}
	for (const name of ["write", "edit"]) {
		for (const details of [{ diff: `+colored${controls.join("")}` }, { piCcTools: { renderedDiff: `+colored${controls.join("")}` } }]) {
			const result = { content: [{ type: "text", text }], details };
			const original = JSON.stringify(result);
			const component = toolComponent(name, { path: "test.txt" }, result);
			for (const expanded of [false, true]) {
				component.setExpanded(expanded);
				const output = plain(component.render(width));
				assert(output.includes("+colored"), `${name}: diff content missing`);
				assert(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(output), `${name}: active control in diff`);
			}
			assert(JSON.stringify(result) === original, `${name}: rendering mutated diff details`);
		}
	}
	console.log("OK  result display: terminal controls removed, colors/text and original results preserved");
}

// Errors stay visible but are reduced to the first line when collapsed.
{
	const component = toolComponent("bash", { command: "false" }, {
		isError: true,
		content: [{ type: "text", text: "command failed\nverbose diagnostic body" }],
	});
	const collapsed = plain(component.render(width));
	assert(collapsed.includes("● Bash $ false"), "error call style changed");
	assert(collapsed.includes("│ command failed"), "collapsed error was hidden");
	assert(!collapsed.includes("verbose diagnostic body"), "collapsed error was not reduced");
	console.log("OK  error renderer: first-line error remains visible");
}

// Unknown tools use the one small generic fallback instead of their full
// result. This covers MCP/custom tools without wrapping their execute method.
{
	const custom: ToolDefinition = {
		name: "mcp__demo__search",
		label: "search",
		description: "test",
		parameters: {},
	};
	const component = new ToolExecutionComponent(
		"mcp__demo__search",
		"test-mcp-preview",
		{ query: "needle" },
		{ showImages: false },
		custom as never,
		fakeUi as never,
		cwd,
	);
	component.markExecutionStarted();
	component.setArgsComplete();
	component.updateResult({ content: [{ type: "text", text: "Searching remote source...\nignored detail" }] } as never, true);
	const partial = plain(component.render(width));
	component.updateResult({
		content: [{ type: "text", text: "custom result\nsecond line\nthird line\nfourth line\nfifth line\nsixth line" }],
	} as never, false);
	const collapsed = plain(component.render(width));
	assert(partial.includes("│ Searching remote source..."), "generic custom partial progress was hidden");
	assert(!partial.includes("ignored detail"), "generic custom partial progress exceeded one line");
	assert(collapsed.includes("● MCP needle"), "generic custom call renderer was not installed");
	assert(collapsed.includes("│ custom result"), "generic custom result did not show first-line summary");
	assert(collapsed.includes("… +3 lines (ctrl+o to expand)"), "generic custom result missing truncation hint");
	assert(!collapsed.includes("fourth line"), "generic custom result exceeded 3-line preview");
	console.log("OK  generic renderer: MCP/custom tools show 3-line result preview");
}

// Registered custom renderers take precedence over the generic fallback.
// Self-rendered MCP output keeps its dedicated UI without extension-added padding.
{
	let callRendered = false;
	let resultRendered = false;
	const custom: ToolDefinition = {
		name: "mcp",
		label: "MCP",
		description: "test",
		parameters: {},
		renderShell: "self",
		renderCall() {
			callRendered = true;
			return new Text("Native MCP call", 0, 0);
		},
		renderResult() {
			resultRendered = true;
			return new Text("Native MCP result", 0, 0);
		},
	};
	const component = toolComponent("mcp", { action: "status" }, {
		content: [{ type: "text", text: "generic result must not render" }],
	}, custom);
	const rendered = plain(component.render(width));

	assert((component as unknown as { getRenderShell(): string }).getRenderShell() === "self", "MCP shell was overridden");
	assert(callRendered && resultRendered, "MCP native renderers were not used");
	assert(rendered.includes("Native MCP call"), `MCP native call missing: ${rendered}`);
	assert(rendered.includes("Native MCP result"), `MCP native result missing: ${rendered}`);
	assert(!rendered.includes("generic result must not render"), "MCP result fell back to generic output");
	const visible = ensureArray(component.render(width)).map(stripAnsi).filter((line) => line.trim().length > 0);
	assert(
		visible.every((line) => line === line.trimStart()),
		`MCP output received extension-added padding: ${JSON.stringify(visible)}`,
	);
	console.log("OK  MCP renderer: native call/result keep full width");
}

// If a custom tool only supplies one renderer, preserve it and fill the
// missing half with the compact generic renderer in a transparent shell.
{
	const transparentCwd = mkdtempSync(join(tmpdir(), "pi-cc-tools-partial-renderer-"));
	mkdirSync(join(transparentCwd, ".pi"));
	writeFileSync(join(transparentCwd, ".pi", "settings.json"), JSON.stringify({ toolBackground: "transparent" }));
	const callOnly: ToolDefinition = {
		name: "call_only",
		label: "call only",
		description: "test",
		parameters: {},
		renderCall() {
			return new Text("Native call only", 0, 0);
		},
	};
	const callComponent = toolComponent("call_only", { query: "needle" }, {
		content: [{ type: "text", text: "generic result" }],
	}, callOnly, transparentCwd);
	const callRendered = plain(callComponent.render(width));
	assert((callComponent as unknown as { getRenderShell(): string }).getRenderShell() === "self", "partial renderer shell was not transparent");
	assert(callRendered.includes("Native call only"), `partial native call missing: ${callRendered}`);
	assert(callRendered.includes("generic result"), `partial generic result missing: ${callRendered}`);

	const resultOnly: ToolDefinition = {
		name: "result_only",
		label: "result only",
		description: "test",
		parameters: {},
		renderResult() {
			return new Text("Native result only", 0, 0);
		},
	};
	const resultComponent = toolComponent("result_only", { query: "needle" }, {
		content: [{ type: "text", text: "ignored generic result" }],
	}, resultOnly, transparentCwd);
	const resultRendered = plain(resultComponent.render(width));
	assert(resultRendered.includes("needle"), `partial generic call missing: ${resultRendered}`);
	assert(resultRendered.includes("Native result only"), `partial native result missing: ${resultRendered}`);
	assert(!resultRendered.includes("ignored generic result"), "partial native result was replaced");
	rmSync(transparentCwd, { recursive: true, force: true });
	console.log("OK  partial renderer: registered half wins and missing half uses fallback");
}

// Re-registering the extension (the /reload path) must reuse the installed
// prototype wrappers instead of stacking another generic-renderer layer.
{
	const prototype = ToolExecutionComponent.prototype as unknown as Record<string, unknown>;
	const methods = [prototype.getRenderShell, prototype.getCallRenderer, prototype.getResultRenderer];
	extension.default(new FakePi() as never);
	assert(prototype.getRenderShell === methods[0], "reload replaced the shell wrapper");
	assert(prototype.getCallRenderer === methods[1], "reload replaced the call wrapper");
	assert(prototype.getResultRenderer === methods[2], "reload replaced the result wrapper");
	console.log("OK  renderer reload: prototype wrappers remain single-layered");
}

// In transparent modes, Agent/subagent tools keep their registered renderer
// and native background while every other default-shell tool becomes unboxed.
{
	const transparentCwd = mkdtempSync(join(tmpdir(), "pi-cc-tools-background-"));
	mkdirSync(join(transparentCwd, ".pi"));
	writeFileSync(join(transparentCwd, ".pi", "settings.json"), JSON.stringify({ toolBackground: "transparent" }));
	try {
		let callRendered = false;
		let resultRendered = false;
		const agentDefinition: ToolDefinition = {
			name: "Agent",
			label: "Agent",
			description: "test",
			parameters: {},
			renderCall() {
				callRendered = true;
				return new Text("Native Agent call", 0, 0);
			},
			renderResult() {
				resultRendered = true;
				return new Text("Native Agent result", 0, 0);
			},
		};
		const agent = new ToolExecutionComponent(
			"Agent",
			"test-Agent",
			{ subagent_type: "Explore", description: "scan API", prompt: "Inspect the API" },
			{ showImages: false },
			agentDefinition as never,
			fakeUi as never,
			transparentCwd,
		);
		agent.markExecutionStarted();
		agent.updateResult({ content: [{ type: "text", text: "full agent result" }] } as never, false);
		const agentLines = ensureArray(agent.render(width));
		const rendered = plain(agentLines);

		assert((agent as unknown as { getRenderShell(): string }).getRenderShell() === "default", "Agent shell was overridden");
		assert(agentLines.some((line) => line.includes(theme.getBgAnsi("toolSuccessBg"))), "Agent background was missing");
		assert(callRendered && resultRendered, "Agent native renderers were not used");
		assert(rendered.includes("Native Agent call"), `Agent native call missing: ${rendered}`);
		assert(rendered.includes("Native Agent result"), `Agent native result missing: ${rendered}`);
		assert(!rendered.includes("full agent result"), "Agent fell back to generic text output");

		const customDefinition: ToolDefinition = {
			name: "custom",
			label: "custom",
			description: "test",
			parameters: {},
			renderCall: () => new Text("Custom call", 0, 0),
			renderResult: () => new Text("Custom result", 0, 0),
		};
		const custom = new ToolExecutionComponent(
			"custom",
			"test-custom-background",
			{},
			{ showImages: false },
			customDefinition as never,
			fakeUi as never,
			transparentCwd,
		);
		custom.markExecutionStarted();
		custom.updateResult({ content: [{ type: "text", text: "result" }] } as never, false);
		const customLines = ensureArray(custom.render(width));
		assert((custom as unknown as { getRenderShell(): string }).getRenderShell() === "self", "non-Agent shell kept its background");
		assert(!customLines.some((line) => line.includes(theme.getBgAnsi("toolSuccessBg"))), "non-Agent background was present");
		console.log("OK  Agent renderer: only subagent output keeps the native background");
	} finally {
		rmSync(transparentCwd, { recursive: true, force: true });
	}
}

// Ordinary assistant content stays on Pi's native renderer without horizontal padding.
{
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		stopReason: "stop",
	};
	const component = new AssistantMessageComponent(message as never, false);
	const children = (component as unknown as { contentContainer?: { children?: unknown[] } }).contentContainer?.children ?? [];
	assert(!children.some((child) => (child as { constructor?: { name?: string } }).constructor?.name === "DottedParagraph"), "assistant renderer was globally replaced");
	assert(message.content[0].text === "hello", "assistant message was mutated");
	assertTextStartsAtColumnZero(ensureArray(component.render(width)), "hello");

	const error = new AssistantMessageComponent({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "failure",
	} as never, false);
	assertTextStartsAtColumnZero(ensureArray(error.render(width)), "Error: failure");
	console.log("OK  native messages: assistant text and errors use full width");
}

// A quiet new session keeps one row above its first user message.
{
	const chatContainer = new Container();
	const fakeInteractiveMode = {
		chatContainer,
		getUserMessageText(message: { content?: unknown }) {
			return typeof message.content === "string" ? message.content : "";
		},
		getMarkdownThemeWithSettings() {
			return undefined;
		},
		getMarkdownTransformers() {
			return [];
		},
		toolOutputExpanded: false,
		editor: {},
	};
	const addMessageToChat = (InteractiveMode.prototype as unknown as {
		addMessageToChat(message: unknown, options?: unknown): void;
	}).addMessageToChat;
	addMessageToChat.call(fakeInteractiveMode, { role: "user", content: "first message" });
	assert(chatContainer.children.length === 2, "first user message did not receive one leading spacer");
	assert(chatContainer.children[0]?.constructor.name === "Spacer", "first user message spacer was not first");

	addMessageToChat.call(fakeInteractiveMode, { role: "user", content: "second message" });
	assert(chatContainer.children.length === 4, "subsequent user message spacing changed");
	console.log("OK  first message: one top spacer without changing later spacing");
}

// Keep Pi's native one-line gap between transcript output and the editor.
{
	const renderWidgetContainer = (InteractiveMode.prototype as unknown as {
		renderWidgetContainer(
			container: Container,
			widgets: Map<string, Component>,
			spacerWhenEmpty: boolean,
			leadingSpacer: boolean,
		): void;
	}).renderWidgetContainer;
	const container = new Container();
	renderWidgetContainer.call({}, container, new Map(), true, true);
	assert(container.children.length === 1, "empty widget container lost the native spacer");
	assert(container.children[0]?.constructor.name === "Spacer", "empty widget gap was not a spacer");

	renderWidgetContainer.call(
		{},
		container,
		new Map([["todos", new Text("Todos", 0, 0) as Component]]),
		true,
		true,
	);
	assert(container.children.length === 2, "non-empty widget spacing changed");
	console.log("OK  idle layout: native one-line editor gap is preserved");
}

// Pi's native working indicator remains visible while the agent is streaming.
{
	const workingIndicators: Array<{ frames?: string[] } | undefined> = [];
	const workingMessages: Array<string | undefined> = [];
	const visibility: boolean[] = [];
	const thinkingLabels: Array<string | undefined> = [];
	const autocompleteProviders: Array<(current: AutocompleteProvider) => AutocompleteProvider> = [];
	const ui = {
		theme,
		addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider) {
			autocompleteProviders.push(factory);
		},
		setWorkingIndicator(value?: { frames?: string[] }) { workingIndicators.push(value); },
		setWorkingMessage(value?: string) { workingMessages.push(value); },
		setWorkingVisible(value: boolean) { visibility.push(value); },
		setHiddenThinkingLabel(value?: string) { thinkingLabels.push(value); },
	};
	const context = { hasUI: true, cwd, ui };
	for (const name of ["session_start", "before_agent_start", "agent_start", "turn_start"]) {
		for (const handler of fakePi.events.get(name) ?? []) await handler({ type: name }, context);
	}

	// The session lifecycle must register `$` through Pi's wrapper API so its
	// trigger survives pi-subagents' `@` wrapper in either load order.
	assert(autocompleteProviders.length === 1, "session_start did not register the skill autocomplete provider");
	const createSkillProvider = autocompleteProviders[0]!;
	const createMentionProvider = (current: AutocompleteProvider): AutocompleteProvider => ({
		triggerCharacters: ["@"],
		getSuggestions: (...args) => current.getSuggestions(...args),
		applyCompletion: (...args) => current.applyCompletion(...args),
		shouldTriggerFileCompletion: (...args) => current.shouldTriggerFileCompletion?.(...args) ?? true,
	});
	for (const wrappers of [
		[createMentionProvider, createSkillProvider],
		[createSkillProvider, createMentionProvider],
	]) {
		let fileCompletionDelegated = false;
		let provider: AutocompleteProvider = new CombinedAutocompleteProvider([
			{ name: "skill:code-review", description: "Review code" },
		], cwd);
		provider.shouldTriggerFileCompletion = () => {
			fileCompletionDelegated = true;
			return false;
		};
		const triggerCharacters: string[] = [];
		for (const wrap of wrappers) {
			provider = wrap(provider);
			triggerCharacters.push(...(provider.triggerCharacters ?? []));
		}
		provider.triggerCharacters = [...new Set(triggerCharacters)];

		assert(provider.triggerCharacters.includes("@"), "agent mention trigger was dropped");
		assert(provider.triggerCharacters.includes("$"), "skill trigger was dropped");
		const suggestions = await provider.getSuggestions(["$"], 0, 1, { signal: new AbortController().signal });
		const skill = suggestions?.items.find((item) => item.value === "code-review");
		assert(skill, "skill suggestions were not returned");
		const completion = provider.applyCompletion(["$"], 0, 1, skill, "$");
		assert(completion.lines[0] === "$code-review ", "skill completion was not delegated");
		assert(provider.shouldTriggerFileCompletion?.(["plain"], 0, 5) === false, "file completion result changed");
		assert(fileCompletionDelegated, "file completion was not delegated");
	}
	console.log("OK  skill autocomplete: lifecycle registration survives other provider wrappers");

	assert(workingIndicators.length > 0 && workingIndicators.at(-1) === undefined, "default working indicator was not restored");
	assert(workingMessages.length > 0 && workingMessages.at(-1) === undefined, "default working message was not restored");
	assert(visibility.at(-1) === true, "working indicator row was not enabled");
	assert(thinkingLabels.length === 0 || thinkingLabels.at(-1) !== "", "thinking label was cleared — should be left for native pi handling");
	for (const handler of fakePi.events.get("agent_end") ?? []) {
		await handler({ type: "agent_end" }, context);
	}
	assert(visibility.at(-1) === false, "working indicator row remained after agent_end");
	for (const handler of fakePi.events.get("before_agent_start") ?? []) {
		await handler({ type: "before_agent_start" }, context);
	}
	assert(visibility.at(-1) === true, "working indicator row was not restored for the next run");
	console.log("OK  working indicator: visible while active, removed after completion");
}

// ── Alignment: every tool type uses the same left padding ──
{
	const testCases: { name: string; args: Record<string, unknown> }[] = [
		{ name: "read", args: { path: "src/index.ts" } },
		{ name: "bash", args: { command: "ls -la" } },
		{ name: "write", args: { path: "src/out.ts", content: "x" } },
		{ name: "edit", args: { path: "src/out.ts", edits: [{ oldText: "a", newText: "b" }] } },
		{ name: "grep", args: { pattern: "foo", path: "." } },
		{ name: "find", args: { pattern: "*.ts", path: "." } },
		{ name: "ls", args: { path: "." } },
	];

	function callIndent(line: string): number {
		const stripped = stripAnsi(line);
		const match = stripped.match(/^(\s*)/);
		return match ? match[1].length : 0;
	}

	function branchIndent(line: string): number | undefined {
		const stripped = stripAnsi(line);
		const idx = stripped.indexOf("│");
		return idx >= 0 ? idx : undefined;
	}

	const callIndents = new Map<string, number>();

	for (const { name, args } of testCases) {
		const component = toolComponent(name, args, {
			content: [{ type: "text", text: "ok\nline2" }],
		});
		const lines = ensureArray(component.render(width)).filter((line) => stripAnsi(line).trim().length > 0);

		// Every tool must show a call line with the status dot
		const callLine = lines[0];
		assert(stripAnsi(callLine).includes("●"), `${name} call line was not the first visible line`);
		const renderedCallIndent = callIndent(callLine);
		callIndents.set(name, renderedCallIndent);

		// Every tool result (collapsed) must have a branch block
		const branchLine = lines.find((line) => stripAnsi(line).includes("│"));
		const renderedResultIndent = branchLine ? branchIndent(branchLine) : undefined;

		// Error variant: must align with success variant
		const errComponent = toolComponent(name, args, {
			isError: true,
			content: [{ type: "text", text: "fail" }],
		});
		const errCallLine = ensureArray(errComponent.render(width)).find((line) => stripAnsi(line).trim().length > 0);
		assert(errCallLine, `${name} error call line was missing`);
		const errorCallIndent = callIndent(errCallLine);

		assert(renderedCallIndent === 0, `${name} call indent was ${renderedCallIndent}, expected 0`);
		assert(renderedResultIndent === 0, `${name} result indent was ${renderedResultIndent}, expected 0`);
		assert(errorCallIndent === 0, `${name} error call indent was ${errorCallIndent}, expected 0`);
		console.log(`  ${name.padEnd(6)} call@${renderedCallIndent} branch@${renderedResultIndent ?? "?"} errCall@${errorCallIndent}`);
	}

	// All call lines must have the same indentation
	const indentValues = [...new Set(callIndents.values())];
	assert(indentValues.length === 1, `call line indent varies across tools: ${JSON.stringify([...callIndents])}`);

	console.log(`OK  alignment: all ${testCases.length} tools share call indent=${indentValues[0]}`);
}

// ── Pending (partial) status dots align with completed dots ──
{
	// Pending read
	const definition = fakePi.tools.get("read");
	assert(definition, "missing read definition");
	const pending = new ToolExecutionComponent("read", "test-pending-align", { path: "f" }, { showImages: false }, definition as never, fakeUi as never, cwd);
	pending.markExecutionStarted();
	const pendingLine = ensureArray(pending.render(width)).map(stripAnsi).find((line) => line.trim().length > 0) ?? "";

	// Completed read
	const completed = toolComponent("read", { path: "f" }, { content: [{ type: "text", text: "ok" }] });
	const completedLine = ensureArray(completed.render(width)).map(stripAnsi).find((line) => line.trim().length > 0) ?? "";

	// Both should have same leading whitespace before content
	const pendingIndent = pendingLine.match(/^(\s*)/)?.[1].length ?? 0;
	const completedIndent = completedLine.match(/^(\s*)/)?.[1].length ?? 0;
	assert(pendingIndent === completedIndent, `pending indent ${pendingIndent} != completed indent ${completedIndent}`);
	assert(pendingIndent === 0, `pending indent was ${pendingIndent}, expected 0`);
	console.log("OK  alignment: pending ○ and completed ● use full width");
}

// ── Custom/todo tools use the same unboxed, left-aligned shell ──
{
	const todoDefinition: ToolDefinition = {
		name: "todo",
		label: "todo",
		description: "test",
		parameters: {},
		renderCall: (_args: unknown, renderTheme: typeof theme) => new Text(
			renderTheme.fg("toolTitle", "todo create sample"),
			0,
			0,
		),
		renderResult: (_result: unknown, _options: unknown, renderTheme: typeof theme) => new Text(
			renderTheme.fg("success", "✓ pending"),
			0,
			0,
		),
	};
	const component = toolComponent("todo", { action: "create", subject: "sample" }, {
		content: [{ type: "text", text: "created" }],
	}, todoDefinition);
	const visible = ensureArray(component.render(width)).map(stripAnsi).filter((line) => line.trim().length > 0);
	assert(visible.some((line) => line.includes("todo create sample")), "todo kept the default colored shell");
	assert(visible.every((line) => line === line.trimStart()), `todo output received extension-added padding: ${JSON.stringify(visible)}`);
	console.log("OK  alignment: todo/custom shell is unboxed and uses full width");
}

// ── Todo and subagent widgets receive the full terminal width ──
{
	const extensionWidgetsAbove = new Map<string, Component>();
	const extensionWidgetsBelow = new Map<string, Component>();
	const fakeInteractiveMode = {
		extensionWidgetsAbove,
		extensionWidgetsBelow,
		ui: {},
		renderWidgets() {},
	};
	const setExtensionWidget = (InteractiveMode.prototype as unknown as {
		setExtensionWidget(
			key: string,
			content: (...args: unknown[]) => Component,
			options?: unknown,
		): void;
	}).setExtensionWidget;
	const cases = [
		{ key: "rpiv-todos", placement: "aboveEditor", text: "● Todos (0/1)\n└─ ○ Queued" },
		{ key: "agents", placement: "aboveEditor", text: "● Explore scanning API" },
		{ key: "fleet", placement: "belowEditor", text: "○ main\n○ Explore" },
	] as const;

	for (const testCase of cases) {
		setExtensionWidget.call(
			fakeInteractiveMode,
			testCase.key,
			() => new Text(testCase.text, 0, 0),
			{ placement: testCase.placement },
		);
		const widgets = testCase.placement === "belowEditor" ? extensionWidgetsBelow : extensionWidgetsAbove;
		const widget = widgets.get(testCase.key);
		assert(widget, `${testCase.key} widget was not registered`);
		const visible = widget.render(width).map(stripAnsi).filter((line) => line.trim().length > 0);
		assert(
			visible.every((line) => line === line.trimStart()),
			`${testCase.key} widget received extension-added padding: ${JSON.stringify(visible)}`,
		);
	}

	const terminalWidth = 95;
	let receivedWidth: number | undefined;
	setExtensionWidget.call(
		fakeInteractiveMode,
		"agents",
		() => ({
			render: (renderWidth: number) => {
				receivedWidth = renderWidth;
				return [theme.fg("muted", "x".repeat(renderWidth))];
			},
			invalidate() {},
		}),
		{ placement: "aboveEditor" },
	);
	const agentWidget = extensionWidgetsAbove.get("agents");
	assert(agentWidget, "agents width regression widget was not registered");
	const agentLines = agentWidget.render(terminalWidth);
	assert(receivedWidth === terminalWidth, `agent widget received width ${receivedWidth}, expected ${terminalWidth}`);
	assert(
		agentLines.every((line) => visibleWidth(line) === terminalWidth),
		`agent widget did not use the full terminal width: ${agentLines.map(visibleWidth).join(", ")}`,
	);
	console.log("OK  alignment: todo and subagent widgets use full terminal width");
}

// ── Write/edit summaries count replacements and show changed lines ──
{
	const tempDirectory = mkdtempSync(join(tmpdir(), "pi-cc-tools-test-"));
	const previousRenderer = process.env.PI_CC_TOOLS_DIFF_RENDERER;
	process.env.PI_CC_TOOLS_DIFF_RENDERER = "plain";
	try {
		const path = "sample.txt";
		writeFileSync(join(tempDirectory, path), "alpha\nold\nomega\n");

		const writeDefinition = fakePi.tools.get("write");
		assert(writeDefinition?.execute, "missing write execute override");
		const writeArgs = { path, content: "alpha\nnew\nomega\n" };
		const writeResult = await writeDefinition.execute(
			"test-write-summary",
			writeArgs,
			undefined,
			undefined,
			{ cwd: tempDirectory },
		);
		const writeComponent = toolComponent("write", writeArgs, writeResult, writeDefinition);
		const writeOutput = plain(ensureArray(writeComponent.render(width)));
		assert(writeOutput.includes("+1 -1"), `write replacement summary was wrong: ${writeOutput}`);
		assert(writeOutput.includes("-2 old") && writeOutput.includes("+2 new"), `write diff content missing: ${writeOutput}`);
		const restoredWriteResult = JSON.parse(JSON.stringify(writeResult)) as Record<string, unknown>;
		const restoredWriteOutput = plain(ensureArray(toolComponent("write", writeArgs, restoredWriteResult, writeDefinition).render(width)));
		assert(restoredWriteOutput.includes("+1 -1"), `serialized write summary was lost: ${restoredWriteOutput}`);

		const editDefinition = fakePi.tools.get("edit");
		assert(editDefinition?.execute, "missing edit execute override");
		const editArgs = { path, edits: [{ oldText: "new", newText: "newer" }] };
		const editResult = await editDefinition.execute(
			"test-edit-summary",
			editArgs,
			undefined,
			undefined,
			{ cwd: tempDirectory },
		);
		const editComponent = toolComponent("edit", editArgs, editResult, editDefinition);
		const editOutput = plain(ensureArray(editComponent.render(width)));
		assert(editOutput.includes("+1 -1"), `edit replacement summary was wrong: ${editOutput}`);
		assert(editOutput.includes("-2 new") && editOutput.includes("+2 newer"), `edit diff content missing: ${editOutput}`);
		console.log("OK  write/edit summaries: both render replacement diff content");
	} finally {
		if (previousRenderer === undefined) delete process.env.PI_CC_TOOLS_DIFF_RENDERER;
		else process.env.PI_CC_TOOLS_DIFF_RENDERER = previousRenderer;
		rmSync(tempDirectory, { recursive: true, force: true });
	}
}

// ── Optional git-delta rendering is cached on file-change results ──
{
	const tempDirectory = mkdtempSync(join(tmpdir(), "pi-cc-tools-delta-test-"));
	const previousPath = process.env.PATH;
	const previousRenderer = process.env.PI_CC_TOOLS_DIFF_RENDERER;
	try {
		const binDirectory = join(tempDirectory, "bin");
		const deltaPath = join(binDirectory, "delta");
		await import("node:fs/promises").then(({ mkdir }) => mkdir(binDirectory));
		writeFileSync(deltaPath, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.args\"\ncat >/dev/null\nprintf '\\nDELTA RENDERED\\n- old from delta\\n+ new from delta\\n'\n");
		chmodSync(deltaPath, 0o755);
		process.env.PATH = `${binDirectory}:${previousPath ?? ""}`;
		process.env.PI_CC_TOOLS_DIFF_RENDERER = "delta";

		const path = "delta-sample.txt";
		writeFileSync(join(tempDirectory, path), "old\n");
		const writeDefinition = fakePi.tools.get("write");
		assert(writeDefinition?.execute, "missing write execute override");
		const writeArgs = { path, content: "new\n" };
		const writeResult = await writeDefinition.execute(
			"test-write-delta",
			writeArgs,
			undefined,
			undefined,
			{ cwd: tempDirectory },
		);
		const writeComponent = toolComponent("write", writeArgs, writeResult, writeDefinition);
		const writeOutput = plain(ensureArray(writeComponent.render(width)));
		const deltaArgs = readFileSync(`${deltaPath}.args`, "utf8");
		assert(writeOutput.includes("DELTA RENDERED"), `delta output missing: ${writeOutput}`);
		assert(writeOutput.includes("+1 -1"), `delta summary missing: ${writeOutput}`);
		assert(deltaArgs.includes("--no-gitconfig"), `delta did not ignore verbose user config: ${deltaArgs}`);
		assert(deltaArgs.includes("--file-style=omit"), `delta did not omit file header: ${deltaArgs}`);
		assert(deltaArgs.includes("--hunk-header-style=omit"), `delta did not omit hunk header: ${deltaArgs}`);
		assert(!deltaArgs.includes("--line-numbers"), `delta should not keep line numbers: ${deltaArgs}`);
		assert(deltaArgs.includes("--syntax-theme=Catppuccin Macchiato"), `delta did not use Catppuccin syntax theme: ${deltaArgs}`);
		assert(deltaArgs.includes("--minus-style=syntax #4c3a4c"), `delta did not use Catppuccin minus style: ${deltaArgs}`);
		assert(deltaArgs.includes("--plus-style=syntax #3e4b4c"), `delta did not use Catppuccin plus style: ${deltaArgs}`);
		assert(!deltaArgs.includes("--color-only"), `delta still uses structure-preserving color-only mode: ${deltaArgs}`);
		console.log("OK  write/edit renderer: optional compact delta output is used when configured");
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousRenderer === undefined) delete process.env.PI_CC_TOOLS_DIFF_RENDERER;
		else process.env.PI_CC_TOOLS_DIFF_RENDERER = previousRenderer;
		rmSync(tempDirectory, { recursive: true, force: true });
	}
}

// ── Referenced skills use transcript-aware structured prompt sections ──
{
	const tempDirectory = mkdtempSync(join(tmpdir(), "pi-cc-tools-skill-section-"));
	try {
		const skillPath = join(tempDirectory, "SKILL.md");
		writeFileSync(skillPath, "---\nname: demo\n---\n\nFollow the demo workflow.\n");
		fakePi.commands = [{
			name: "skill:demo",
			source: "skill",
			sourceInfo: { path: skillPath, baseDir: tempDirectory },
		}];
		const event = {
			prompt: "Use $demo for this task",
			systemPrompt: "base prompt",
			systemPromptOptions: { sections: {} as Record<string, string> },
		};
		let result: unknown;
		for (const handler of fakePi.events.get("before_agent_start") ?? []) {
			result = await handler(event, { hasUI: false, cwd, ui: {} });
		}
		assert(result === undefined, "referenced skill forced a full system prompt replacement");
		const section = event.systemPromptOptions.sections.referenced_skills;
		assert(section?.includes("Follow the demo workflow."), "referenced skill section was not populated");
		assert(!section.includes("<referenced_skills>"), "structured section redundantly included its XML wrapper");
		console.log("OK  prompt patch: referenced skills use a structured transcript section");
	} finally {
		fakePi.commands = [];
		rmSync(tempDirectory, { recursive: true, force: true });
	}
}

// ── Thinking wraps into a live tail, then retains a compact summary and timing ──
{
	const historicalMessage = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "historical thought" }],
		stopReason: "stop",
		timestamp: 1,
		_piCcToolsThinkDurationMs: 1_234,
	};
	const historical = new AssistantMessageComponent(historicalMessage as never, true);
	const historicalRender = ensureArray(historical.render(width));
	const historicalOutput = plain(historicalRender);
	assert(historicalOutput.includes("Thought"), "historical static label was missing");
	assert(historicalOutput.includes("took 1.2s"), "historical duration missing");
	assertTextStartsAtColumnZero(historicalRender, "Thought");

	const currentMessageBase = {
		role: "assistant",
		stopReason: "stop",
		timestamp: 2,
		provider: "test",
		model: "test",
	};
	for (const handler of fakePi.events.get("message_update") ?? []) {
		await handler({
			type: "message_update",
			message: {
				...currentMessageBase,
				content: [{ type: "thinking", thinking: "" }],
			},
			assistantMessageEvent: { type: "thinking_start" },
		}, {});
	}

	const currentDeltaMessage = {
		...currentMessageBase,
		content: [{
			type: "thinking",
			thinking: Array.from({ length: 12 }, (_, index) => `thought-line-${String(index + 1).padStart(2, "0")}`).join("\n"),
		}],
	};
	for (const handler of fakePi.events.get("message_update") ?? []) {
		await handler({
			type: "message_update",
			message: currentDeltaMessage,
			assistantMessageEvent: { type: "thinking_delta" },
		}, {});
	}
	const current = new AssistantMessageComponent(currentDeltaMessage as never, true);
	const activeRender = ensureArray(current.render(width));
	const thinkingTextAnsi = theme.getColorMode() === "truecolor"
		? "\x1b[38;2;165;173;203m"
		: "\x1b[38;5;146m";
	assert(activeRender.join("\n").includes(thinkingTextAnsi), "active thinking did not use Macchiato Subtext 0");
	const activeOutput = plain(activeRender);
	assert(activeOutput.includes("Thinking…"), "active static thinking label was missing");
	assert(!/Thinking for |\d+(?:ms|\.\d+s)/.test(activeOutput), "active thinking duration remained visible");
	assert(activeOutput.includes("thought-line-12"), "active thinking omitted the newest line");
	assert(activeOutput.includes("thought-line-10"), "active thinking omitted one of the last three lines");
	assert(!activeOutput.includes("thought-line-09"), "active thinking exceeded three preview lines");
	assert(activeOutput.split("\n").includes("  …"), "active thinking omitted the older-content marker");
	assert(activeOutput.split("\n").filter((line) => line.includes("thought-line-")).length === 3, "active thinking tail was not three lines");
	assert(ensureArray(current.render(20)).every((line) => visibleWidth(line) <= 20), "active thinking exceeded narrow width");
	assertTextStartsAtColumnZero(activeRender, "Thinking…");

	historical.invalidate();
	const unchangedHistory = plain(ensureArray(historical.render(width)));
	assert(unchangedHistory.includes("Thought"), "active thinking changed a historical label");

	assert(!unchangedHistory.includes("thought-line-12"), "current thinking leaked into history");

	await new Promise((resolve) => setTimeout(resolve, 220));
	current.updateContent(currentDeltaMessage as never);
	const refreshedOutput = plain(ensureArray(current.render(width)));
	assert(refreshedOutput === activeOutput, "active thinking preview changed without new content");
	const nextDeltaMessage = {
		...currentMessageBase,
		content: [{ type: "thinking", thinking: `${currentDeltaMessage.content[0].thinking}\nthought-line-13` }],
	};
	current.updateContent(nextDeltaMessage as never);
	const nextOutput = plain(ensureArray(current.render(width)));
	assert(nextOutput.includes("thought-line-13") && !nextOutput.includes("thought-line-10"), "active thinking tail did not advance");
	const thinkingRegion = (current as unknown as { contentContainer: Container }).contentContainer.children.find((child) => "onMouse" in child) as { handleMouse: (event: unknown) => unknown };
	assert(thinkingRegion, "native thinking mouse region was removed");
	thinkingRegion.handleMouse({ type: "click", button: "left" });
	const expandedOutput = plain(ensureArray(current.render(width)));
	assert(expandedOutput.includes("thought-line-01"), "native click did not reveal full thinking");
	const expandedRegion = (current as unknown as { contentContainer: Container }).contentContainer.children.find((child) => "onMouse" in child) as { handleMouse: (event: unknown) => unknown };
	expandedRegion.handleMouse({ type: "click", button: "left" });
	assert(!plain(ensureArray(current.render(width))).includes("thought-line-01"), "native click did not collapse thinking");

	const headingMessage = {
		...currentMessageBase,
		content: [{ type: "thinking", thinking: "**Checking diff formatting**" }],
	};
	current.updateContent(headingMessage as never);
	const headingOutput = plain(ensureArray(current.render(width)));
	assert(headingOutput.includes("│ Checking diff formatting"), "thinking heading was not plain text");
	assert(!headingOutput.includes("**"), "thinking preview exposed Markdown bold markers");
	assert(headingMessage.content[0].thinking === "**Checking diff formatting**", "preview mutated original thinking");

	const safeMessage = {
		...currentMessageBase,
		content: [{ type: "thinking", thinking: "old\nwide 汉字🙂 text with a long trailing segment\n\u001b[2Jlatest" }],
	};
	current.updateContent(safeMessage as never);
	const safeRender = ensureArray(current.render(16));
	const safeOutput = plain(safeRender);
	assert(safeOutput.includes("latest"), "short thinking preview was incorrect");
	assert(!safeRender.join("").includes("\u001b[2J"), "thinking preview preserved terminal controls");
	assert(safeRender.every((line) => visibleWidth(line) <= 16), "wide thinking preview exceeded narrow width");

	const paragraphMessage = {
		...currentMessageBase,
		content: [{ type: "thinking", thinking: "word ".repeat(80) + "NEWEST" }],
	};
	current.updateContent(paragraphMessage as never, true);
	assert((current as unknown as { isStreaming: boolean }).isStreaming, "streaming flag was dropped by wrapper");
	const paragraphLines = ensureArray(current.render(36));
	assert(plain(paragraphLines).includes("NEWEST"), "long paragraph hid the latest streaming text");
	assert(paragraphLines.filter((line) => line.includes("│")).length === 3, "paragraph did not fill three visual lines");
	assert(paragraphLines.some((line) => line.includes(theme.fg("borderMuted", "│"))), "thinking connector differs from tool connector");
	paragraphMessage.content[0].thinking += " " + "more ".repeat(40) + "UPDATED";
	for (const handler of fakePi.events.get("message_update") ?? []) {
		await handler({ message: paragraphMessage, assistantMessageEvent: { type: "thinking_delta" } }, {});
	}
	current.updateContent(paragraphMessage as never, true);
	const updatedParagraph = plain(ensureArray(current.render(36)));
	assert(updatedParagraph.includes("UPDATED") && !updatedParagraph.includes("NEWEST"), "paragraph tail failed to roll on delta");
	assert(ensureArray(current.render(1)).every((line) => visibleWidth(line) <= 1), "tiny viewport exceeded width");


	const thinkingEndMessage = {
		...currentMessageBase,
		content: currentDeltaMessage.content,
	};
	for (const handler of fakePi.events.get("message_update") ?? []) {
		await handler({
			type: "message_update",
			message: thinkingEndMessage,
			assistantMessageEvent: { type: "thinking_end" },
		}, {});
	}
	current.updateContent(thinkingEndMessage as never);
	const completedRender = ensureArray(current.render(width));
	assert(completedRender.join("\n").includes(thinkingTextAnsi), "completed thinking label did not use Macchiato Subtext 0");
	const completedOutput = plain(completedRender);
	assert(completedOutput.includes("Thought"), "completed static thinking label was missing");
	assert(/took \d+\.\d+s/.test(completedOutput), "completed thinking duration missing");
	assert(completedOutput.includes("… +9 lines (ctrl+o to expand)"), "completed thinking summary missing");
	assert(!completedOutput.includes("thought-line-12"), "completed thinking content did not collapse");
	assertTextStartsAtColumnZero(completedRender, "Thought");
	const expansionHost = {
		toolOutputExpanded: false,
		loadedResourcesContainer: new Container(),
		chatContainer: { children: [current] },
		showStatus() {},
	};
	const setToolsExpanded = (InteractiveMode.prototype as unknown as {
		setToolsExpanded: (expanded: boolean) => void;
	}).setToolsExpanded;
	setToolsExpanded.call(expansionHost, true);
	assert(plain(ensureArray(current.render(width))).includes("thought-line-12"), "Ctrl+O did not expand thinking");
	setToolsExpanded.call(expansionHost, false);
	assert(plain(ensureArray(current.render(width))).includes("ctrl+o to expand"), "Ctrl+O did not restore thinking summary");


	const finalMessage = {
		...currentMessageBase,
		content: currentDeltaMessage.content,
	};
	for (const handler of fakePi.events.get("message_end") ?? []) {
		await handler({ type: "message_end", message: finalMessage }, {});
	}
	assert(typeof (finalMessage as { _piCcToolsThinkDurationMs?: unknown })._piCcToolsThinkDurationMs === "number", "thinking duration was not persisted to the final message");
	const reloaded = new AssistantMessageComponent(finalMessage as never, true);
	const reloadedRender = ensureArray(reloaded.render(width));
	const reloadedOutput = plain(reloadedRender);
	assert(reloadedOutput.includes("Thought"), "reloaded static thinking label was missing");
	assert(/took \d+\.\d+s/.test(reloadedOutput), "persisted thinking duration missing");
	assert(!reloadedOutput.includes("thought-line-12"), "persisted thinking content was not collapsed");
	assertTextStartsAtColumnZero(reloadedRender, "Thought");
	console.log("OK  thinking: visual-line tail, shared connector colors, Ctrl+O, summary/duration, history");
}


console.log("\nAll minimal-renderer checks passed.");
