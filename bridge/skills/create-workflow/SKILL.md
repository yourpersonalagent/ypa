---
name: create-workflow
category: yha
description: "Author a YHA workflow .md file from a free-text description. Produces a single fenced markdown block — frontmatter + Nodes + Connections — that the user can save and import via the workflow editor's ⤴ MD button. Invoked by the 🪄 Prompt button in the workflow picker; append your workflow description below the WORKFLOW DESCRIPTION footer."
version: 1.0.0
metadata:
  hermes:
    tags: [YHA, workflows, authoring, node-editor]
---

<!-- yha-workflow-md v1 -->
You are designing a YHA workflow. Reply with ONE fenced markdown block — nothing else
before or after. The block content IS the workflow .md file the user will save and
import. No commentary, no explanations outside the fence.

Output shape:

```markdown
---
id: wf_<8 alphanumeric>
name: <short name>
createdAt: <ISO8601>
updatedAt: <ISO8601>
---

# <name>

## Nodes

### <nodeId>
<key>: <value>
...

### <nodeId>
...

## Connections

- <fromId> → <toId>
- <fromId> → <toId> (true)
- <fromId> → <toId> (false)

## Notes

<optional free text>
```

NODE-ID CONVENTION
- Each node id starts with `n` followed by 8 lowercase alphanumeric chars (e.g. `nkb574p3`).
- Workflow id (frontmatter) is `wf_` + a short timestamp/random suffix.
- IDs MUST be unique within a workflow and referenced verbatim in Connections.

NODE BLOCK SYNTAX
- Each node opens with `### <nodeId>`.
- Followed by `key: value` lines.
- Multiline values: leave the value empty after the colon, then put 2-space-indented
  continuation lines underneath. The block ends at the first blank line OR the next non-
  indented `key:` line. Example:
  ```
  ### nabc12345
  type: chat
  command:
    Do thing A.
    Then thing B.
  x: 80
  y: 80
  ```
- Dotted keys expand to nested objects: `decisionLogic.operator: ==` becomes
  `{ decisionLogic: { operator: '==' } }`. Same for `triggerConfig.*`.
- Booleans: `true` / `false`. Numbers are bare. Empty value = null.

REQUIRED PROPERTIES
- `type` (always)
- `x`, `y` (canvas coords, integers)
- `title` (short label shown on the node card)

NODE TYPES (use the right type for the job)
| type       | purpose                                                          |
| ---------- | ---------------------------------------------------------------- |
| `chat`     | Plain-language prompt sent to the LLM. Default for AI steps.     |
| `command`  | Container for a hash-command (`#bash`, `#read`, `#webfetch`, …). |
| `tool`     | Direct MCP tool call. `title` = tool name, `command` = JSON args. |
| `if`       | Branching. Evaluates `decisionLogic`, exposes `true`/`false` ports. |
| `workflow` | Run a saved workflow. `command`: `#workflow <wfId-or-name>`.       |
| `trigger`  | Schedule/automation entry point. Uses `triggerConfig.*`.          |
| `note`     | Inline annotation; not executed by the runner.                   |
| `agent`    | Sub-agent spawn (rare; prefer `chat` unless the user asks).        |

CHAT NODE — optional per-node overrides
- `nodeModel`: e.g. `claude-opus-4.5`, `codex/gpt-5.4`
- `nodeModelProvider`: e.g. `Anthropic`, `OpenAI`
- `nodeCapVision`: `true`/`false`
- `nodeCapReasoning`: `enabled`/`disabled` (omit for default)
- `nodeCapTools`: `on`/`filter`/`false`
- `nodeSkillSet`, `nodeToolSetPreset`, `nodePreset`, `nodeSystemMode`: strings, optional.
- `inputMode`: `upstream` (default for chat — concatenate upstream outputs into input),
  `manual` (use `input` field as-is), `off` (ignore input).

IF NODE — decisionLogic
- `decisionLogic.leftOperand`: `content` | `wordCount` | `charCount` | `lineCount`.
- `decisionLogic.operator`: `>` `<` `>=` `<=` `==` `!=` `contains` `notContains` `isEmpty` `isNotEmpty`.
- `decisionLogic.rightOperand`: comparison value (omit for unary `isEmpty`/`isNotEmpty`).
- Outgoing connections MUST use `(true)` or `(false)` port suffix.

TRIGGER NODE — triggerConfig
- `triggerConfig.triggerType`: `timer` | `daily` | `website` | `newdata` | `heartbeat`.
- For `timer`/`heartbeat`: `triggerConfig.duration` (minutes).
- For `daily`: `triggerConfig.time` (HH:MM, 24h).
- For `website`: `triggerConfig.url`, `triggerConfig.interval` (minutes).
- For `newdata`: `triggerConfig.path`, `triggerConfig.interval` (minutes).

HASH-COMMANDS (use inside `command` field of `command`/`tool` nodes)
- File ops: `#read <path>`, `#write <path>`, `#edit <path>`, `#multiedit <path>`, `#glob <pat>`, `#grep <pat>`
- Shell:    `#bash <cmd>`
- Web:      `#webfetch <url>`, `#search <query>`
- Memory:   `#note <text>`, `#btw <text>`, `#todoread`, `#todowrite`
- Sessions: `#ns`, `#session "<name>"`
- Models:   `#m <model>`
- Sub:      `#workflow <id-or-name>`, `#task <agent-prompt>`

CONNECTION SYNTAX
- Default port:    `- fromId → toId`
- IF true branch:  `- fromId → toId (true)`
- IF false branch: `- fromId → toId (false)`
- A node can fan out (multiple connections from one source) or fan in (multiple connections into one target).

LAYOUT RULES (so the canvas is readable)
- x: increase by ~250 per stage from left to right (start at 80).
- y: 80 for the main row; offset parallel branches by ±200.
- Keep IF branches above (true) / below (false) for clarity.

EXAMPLES (compact, illustrative — adapt freely)

Example A — linear chain (chat → tool → chat)
```
### na1111111
type: chat
command: Summarise the file ./README.md in 3 bullet points.
x: 80
y: 80
title: ask

### na2222222
type: tool
command: {"command":"/bin/bash -lc 'wc -l README.md'"}
x: 330
y: 80
title: functions.exec_command

### na3333333
type: chat
command: Combine the summary and line count into a one-paragraph status.
x: 580
y: 80
title: combine
```
Connections: `- na1111111 → na2222222` / `- na2222222 → na3333333`.

Example B — IF branching (chat → if → chat / note)
```
### nb1111111
type: chat
command: Rate the input quality 1–10. Reply with just the number.
x: 80
y: 80
title: rate

### nb2222222
type: if
x: 330
y: 80
decisionLogic.leftOperand: content
decisionLogic.operator: >=
decisionLogic.rightOperand: 7
title: good?

### nb3333333
type: chat
command: Write a celebratory tweet about the result.
x: 580
y: -120
title: celebrate

### nb4444444
type: note
command: Score below 7 — skipping celebration.
x: 580
y: 280
title: skip
```
Connections: `- nb1111111 → nb2222222` / `- nb2222222 → nb3333333 (true)` / `- nb2222222 → nb4444444 (false)`.

Example C — tool pipeline (read → chat → write)
```
### nc1111111
type: command
command: #read ./TODO.md
x: 80
y: 80
title: read TODO

### nc2222222
type: chat
command: Rewrite the TODO list, group by priority, drop completed items.
x: 330
y: 80
title: regroup

### nc3333333
type: command
command: #write ./TODO.md
x: 580
y: 80
title: save
```
Connections: `- nc1111111 → nc2222222` / `- nc2222222 → nc3333333`.

CHECKLIST BEFORE YOU OUTPUT
1. Frontmatter has id/name/createdAt/updatedAt.
2. Every node has type + x + y + title.
3. Every Connection refers to existing node IDs.
4. IF nodes have `(true)`/`(false)` on outgoing edges.
5. The whole answer is ONE ```markdown … ``` block — nothing else.

---
WORKFLOW DESCRIPTION:
