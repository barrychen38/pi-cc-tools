import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssistantMessageComponent, InteractiveMode, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
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

	registerTool(definition: ToolDefinition): void {
		this.tools.set(definition.name, definition);
	}

	registerCommand(): void {}
	registerShortcut(): void {}

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

function toolComponent(
	name: string,
	args: Record<string, unknown>,
	result: Record<string, unknown>,
	definition: ToolDefinition | undefined = fakePi.tools.get(name),
): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		name,
		`test-${name}`,
		args,
		{ showImages: false },
		definition as never,
		fakeUi as never,
		cwd,
	);
	component.markExecutionStarted();
	component.setArgsComplete();
	component.updateResult(result as never, false);
	return component;
}

// The extension only replaces the seven built-in display adapters.
for (const name of ["read", "bash", "grep", "find", "ls", "write", "edit"]) {
	assert(fakePi.tools.has(name), `missing built-in override: ${name}`);
}

// Successful results are hidden in collapsed mode, while the existing compact
// title/status style remains visible.
{
	const component = toolComponent("read", { path: "src/index.ts" }, {
		content: [{ type: "text", text: "success payload\nsecond line" }],
	});
	const collapsed = plain(component.render(width));
	assert(collapsed.includes("● Read src/index.ts"), "collapsed read call style changed");
	assert(!collapsed.includes("success payload"), "successful collapsed output was not hidden");

	component.setExpanded(true);
	const expanded = plain(component.render(width));
	assert(expanded.includes("└─ success payload"), "expanded result did not keep branch styling");
	console.log("OK  built-in renderer: compact success + styled expanded result");
}

// Partial results never render live previews; the call remains a static
// pending dot, so no interval or invalidation loop is needed.
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
	const pending = plain(component.render(width));
	assert(pending.includes("○ Bash $ printf hello"), "pending call did not use static status dot");
	console.log("OK  pending renderer: no live output preview");
}

// Errors stay visible but are reduced to the first line when collapsed.
{
	const component = toolComponent("bash", { command: "false" }, {
		isError: true,
		content: [{ type: "text", text: "command failed\nverbose diagnostic body" }],
	});
	const collapsed = plain(component.render(width));
	assert(collapsed.includes("● Bash $ false"), "error call style changed");
	assert(collapsed.includes("└─ command failed"), "collapsed error was hidden");
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
	const component = toolComponent("mcp__demo__search", { query: "needle" }, {
		content: [{ type: "text", text: "custom result" }],
	}, custom);
	const collapsed = plain(component.render(width));
	assert(collapsed.includes("● MCP needle"), "generic custom call renderer was not installed");
	assert(collapsed.includes("└─ custom result"), "generic custom result did not show first-line summary");
	console.log("OK  generic renderer: MCP/custom tools show first-line result summary");
}

// Registered custom renderers take precedence over the generic fallback.
// pi-mcp-adapter relies on this path for its dedicated call/result UI.
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
	console.log("OK  MCP renderer: registered call/result/shell stay unchanged");
}

// If a custom tool only supplies one renderer, preserve it and fill the
// missing half with the compact generic renderer in the tool's own shell.
{
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
	}, callOnly);
	const callRendered = plain(callComponent.render(width));
	assert((callComponent as unknown as { getRenderShell(): string }).getRenderShell() === "default", "partial renderer shell changed");
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
	}, resultOnly);
	const resultRendered = plain(resultComponent.render(width));
	assert(resultRendered.includes("needle"), `partial generic call missing: ${resultRendered}`);
	assert(resultRendered.includes("Native result only"), `partial native result missing: ${resultRendered}`);
	assert(!resultRendered.includes("ignored generic result"), "partial native result was replaced");
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

// Agent/subagent tools keep their own registered renderers instead of the
// compact MCP/custom fallback, so pi-subagents controls its native output style.
{
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
		cwd,
	);
	agent.markExecutionStarted();
	agent.updateResult({ content: [{ type: "text", text: "full agent result" }] } as never, false);
	const rendered = plain(ensureArray(agent.render(width)));

	assert((agent as unknown as { getRenderShell(): string }).getRenderShell() === "default", "Agent shell was overridden");
	assert(callRendered && resultRendered, "Agent native renderers were not used");
	assert(rendered.includes("Native Agent call"), `Agent native call missing: ${rendered}`);
	assert(rendered.includes("Native Agent result"), `Agent native result missing: ${rendered}`);
	assert(!rendered.includes("full agent result"), "Agent fell back to generic text output");
	console.log("OK  Agent renderer: native subagent output stays unchanged");
}

// Ordinary assistant content remains on Pi's native renderer.
{
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		stopReason: "stop",
	};
	const component = new AssistantMessageComponent(message as never, false);
	const children = (component as unknown as { contentContainer?: { children?: unknown[] } }).contentContainer?.children ?? [];
	assert(!children.some((child) => (child as { constructor?: { name?: string } }).constructor?.name === "DottedParagraph"), "assistant renderer was globally patched");
	assert(message.content[0].text === "hello", "assistant message was mutated");
	console.log("OK  native messages: ordinary assistant rendering remains unchanged");
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

// Pi's default empty widget spacer must not look like a stopped working row.
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
	assert(container.children.length === 0, "empty widget container retained a spacer");

	renderWidgetContainer.call(
		{},
		container,
		new Map([["todos", new Text("Todos", 0, 0) as Component]]),
		true,
		true,
	);
	assert(container.children.length === 2, "non-empty widget spacing changed");
	console.log("OK  idle layout: empty working/widget area leaves no placeholder");
}

// Pi's native working indicator remains visible while the agent is streaming.
{
	const workingIndicators: Array<{ frames?: string[] } | undefined> = [];
	const workingMessages: Array<string | undefined> = [];
	const visibility: boolean[] = [];
	const thinkingLabels: Array<string | undefined> = [];
	const ui = {
		theme,
		setWorkingIndicator(value?: { frames?: string[] }) { workingIndicators.push(value); },
		setWorkingMessage(value?: string) { workingMessages.push(value); },
		setWorkingVisible(value: boolean) { visibility.push(value); },
		setHiddenThinkingLabel(value?: string) { thinkingLabels.push(value); },
	};
	const context = { hasUI: true, cwd, ui };
	for (const name of ["session_start", "before_agent_start", "agent_start", "turn_start"]) {
		for (const handler of fakePi.events.get(name) ?? []) await handler({ type: name }, context);
	}
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
		const idx = stripped.indexOf("└─");
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
		const branchLine = lines.find((line) => stripAnsi(line).includes("└─"));
		const renderedResultIndent = branchLine ? branchIndent(branchLine) : undefined;

		// Error variant: must align with success variant
		const errComponent = toolComponent(name, args, {
			isError: true,
			content: [{ type: "text", text: "fail" }],
		});
		const errCallLine = ensureArray(errComponent.render(width)).find((line) => stripAnsi(line).trim().length > 0);
		assert(errCallLine, `${name} error call line was missing`);
		const errorCallIndent = callIndent(errCallLine);

		assert(renderedCallIndent === 2, `${name} call indent was ${renderedCallIndent}, expected 2`);
		assert(renderedResultIndent === 2, `${name} result indent was ${renderedResultIndent}, expected 2`);
		assert(errorCallIndent === 2, `${name} error call indent was ${errorCallIndent}, expected 2`);
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
	assert(pendingIndent === 2, `pending indent was ${pendingIndent}, expected 2`);
	console.log("OK  alignment: pending ○ and completed ● share same left indent");
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
	assert(visible.every((line) => line.startsWith("  ") && !line.startsWith("   ")), `todo output did not use two-column indent: ${JSON.stringify(visible)}`);
	console.log("OK  alignment: todo/custom shell is unboxed and starts at column 2");
}

// ── Todo and subagent widgets receive the same two-column indent ──
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
			visible.every((line) => line.startsWith("  ") && !line.startsWith("   ")),
			`${testCase.key} widget did not use two-column indent: ${JSON.stringify(visible)}`,
		);
	}
	console.log("OK  alignment: todo and subagent widgets start at column 2");
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

// ── Active thinking shows elapsed time without rendering its content ──
{
	const historicalMessage = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "historical thought" }],
		stopReason: "stop",
		timestamp: 1,
		_piCcToolsThinkDurationMs: 1_234,
	};
	const historical = new AssistantMessageComponent(historicalMessage as never, true);
	assert(plain(ensureArray(historical.render(width))).includes("Thought for 1.2s"), "historical duration label was missing");

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
	assert(activeOutput.includes("Thinking for "), "active thinking elapsed label was missing");
	assert(!activeOutput.includes("thought-line-12"), "active thinking content was visible");

	historical.invalidate();
	const unchangedHistory = plain(ensureArray(historical.render(width)));
	assert(unchangedHistory.includes("Thought for 1.2s"), "active thinking changed a historical label");
	assert(!unchangedHistory.includes("thought-line-12"), "current thinking leaked into history");

	await new Promise((resolve) => setTimeout(resolve, 220));
	current.updateContent(currentDeltaMessage as never);
	const refreshedOutput = plain(ensureArray(current.render(width)));
	assert(
		/Thinking for (?:\d+ms|\d+\.\ds)/.test(refreshedOutput) && refreshedOutput !== activeOutput,
		"active thinking elapsed label did not refresh",
	);
	assert(!refreshedOutput.includes("thought-line-12"), "refreshed thinking content was visible");

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
	assert(completedOutput.includes("Thought for "), "completed thinking duration label was missing");
	assert(!completedOutput.includes("thought-line-12"), "completed thinking content did not collapse");

	const finalMessage = {
		...currentMessageBase,
		content: currentDeltaMessage.content,
	};
	for (const handler of fakePi.events.get("message_end") ?? []) {
		await handler({ type: "message_end", message: finalMessage }, {});
	}
	assert(typeof (finalMessage as { _piCcToolsThinkDurationMs?: unknown })._piCcToolsThinkDurationMs === "number", "thinking duration was not persisted to the final message");
	const reloaded = new AssistantMessageComponent(finalMessage as never, true);
	const reloadedOutput = plain(ensureArray(reloaded.render(width)));
	assert(reloadedOutput.includes("Thought for "), "persisted thinking duration was not rendered");
	assert(!reloadedOutput.includes("thought-line-12"), "persisted thinking content was not collapsed");
	console.log("OK  thinking: elapsed label refreshes, content stays hidden, history stays unchanged");
}

console.log("\nAll minimal-renderer checks passed.");
