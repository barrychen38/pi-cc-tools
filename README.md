# pi-claude-style-tools

Compact Pi tool rendering with the existing Claude-style colors, labels, status dots, and branch styling.

## Behavior

- Built-in tools keep one compact call row: `read`, `bash`, `grep`, `find`, `ls`, `write`, and `edit`.
- Successful tool results are hidden by default.
- Failed tool results keep only the first error line visible.
- `Ctrl+O` can still expand a tool result; expanded output is plain text and capped at `expandedPreviewMaxLines`.
- MCP and unknown custom tools use the same compact fallback renderer.
- Live output previews, diff generation, syntax highlighting, grouping, turn-time text, thinking summaries, and custom spinners are disabled.
- Tool execution is delegated to Pi's built-in tools without changing their behavior.

The default render path does not read tool files, calculate diffs, load a syntax highlighter, split successful output, or run a refresh timer.

## Configuration

Pi reads global settings from `~/.pi/agent/settings.json` and project settings from `.pi/settings.json`. Project settings take precedence.

```json
{
  "toolBackground": "transparent",
  "expandedPreviewMaxLines": 2000
}
```

`toolBackground` accepts `default`, `transparent`, `outlines`, or the legacy alias `border`. The compact renderer removes full-width background fills for the non-default modes; it intentionally does not add border rows to the hot path.

Pi's own settings can be used alongside this extension to keep startup and thinking output quiet:

```json
{
  "quietStartup": true,
  "hideThinkingBlock": true,
  "outputPad": 0
}
```

## Development

```sh
npm test
npm run typecheck
npm run bench:tools -- baseline 120 12 8
npm run bench:tools -- minimal 120 12 8
```

The extension uses Pi's public `registerTool`, `renderCall`, and `renderResult` interfaces. A small private fallback is kept only for tools that do not expose a renderer, so MCP/custom tools also stay compact.
