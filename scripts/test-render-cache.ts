import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

initTheme("dark", false);

type ToolDefinition = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	renderShell?: "default" | "self";
	[key: string]: unknown;
};

class FakePi {
	tools = new Map<string, ToolDefinition>();
	events = new Map<string, Array<(...args: unknown[]) => unknown>>();

	registerTool(definition: ToolDefinition): void {
		this.tools.set(definition.name, definition);
	}

	registerCommand(): void {}
	registerShortcut(): void {}

	on(name: string, handler: (...args: unknown[]) => unknown): void {
	const handlers = this.events.get(name) ?? [];
		handlers.push(handler);
		this.events.set(name, handlers);
	}
}

const fakePi = new FakePi();
const extension = await import("../extensions/index.ts");
extension.default(fakePi as never);

const width = 120;
const cwd = process.cwd();
const fakeUi = { requestRender() {} };

function plain(lines: string[]): string {
	return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
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
		renderShell: "self",
	};
	const component = toolComponent("mcp__demo__search", { query: "needle" }, {
		content: [{ type: "text", text: "custom result" }],
	}, custom);
	const collapsed = plain(component.render(width));
	assert(collapsed.includes("● MCP needle"), "generic custom call renderer was not installed");
	assert(collapsed.includes("└─ custom result"), "generic custom result did not show first-line summary");
	console.log("OK  generic renderer: MCP/custom tools show first-line result summary");
}

// The minimal extension does not patch assistant/user/custom message
// prototypes or mutate assistant content with status lines.
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
	console.log("OK  native messages: no global renderer patch or mutation");
}

// UI cleanup is done through Pi's public API and has no timers.
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
	assert(workingIndicators.at(-1)?.frames?.length === 0, "working indicator was not hidden");
	assert(workingMessages.at(-1) === "", "working message was not cleared");
	assert(visibility.at(-1) === false, "working row was not hidden");
	assert(thinkingLabels.length === 0 || thinkingLabels.at(-1) !== "", "thinking label was cleared — should be left for native pi handling");
	console.log("OK  public UI cleanup: spinner hidden, thinking label left for native handling");
}

console.log("\nAll minimal-renderer checks passed.");
