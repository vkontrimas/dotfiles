# HTML Export Patch for qwedit

## Problem
Pi's HTML export (`/export`) has hardcoded special handling for the `edit` tool:
- `dist/core/export-html/index.js`: `TEMPLATE_RENDERED_TOOLS` includes `"edit"`, which skips custom `renderResult` invocation
- `dist/core/export-html/template.js`: `case 'edit':` renders using built-in template (expects `details.diff`, not our `details.results`)

## Patch (applied 2026-06-06)

Two files in the installed `@earendil-works/pi-coding-agent` package:

### 1. `dist/core/export-html/index.js` (line ~119)
```diff
- const TEMPLATE_RENDERED_TOOLS = new Set(["bash", "read", "write", "edit", "ls"]);
+ const TEMPLATE_RENDERED_TOOLS = new Set(["bash", "read", "write", "ls"]);
```
Removes `"edit"` so `preRenderCustomTools` invokes our `renderResult`.

### 2. `dist/core/export-html/template.js` (line ~990)
Remove the entire `case 'edit':` block (from `case 'edit':` through its `break;`). This lets `edit` fall through to `default:` which uses pre-rendered HTML from `renderedTools`.

## Extension structure
```
qwedit/
├── index.ts          # Entry point
├── package.json      # pi.extensions: ["./index.ts"]
├── HTML_EXPORT_PATCH.md
└── node_modules/
```

## Re-applying after update
After any `pi` package update, these files are overwritten. Re-apply both patches.

## Alternative (if patching becomes untenable)
Rename the tool from `"edit"` to `"edit-multi"`. It would then be treated as a custom tool and use our `renderResult` automatically. Tradeoff: the LLM would call `edit-multi` instead of `edit`.
