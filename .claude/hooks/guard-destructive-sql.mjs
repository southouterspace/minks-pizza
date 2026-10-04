// PreToolUse hook: the allow rules in .claude/settings.json let Claude run
// migrations without review, but cannot see the SQL. This forces a permission
// prompt (even in auto mode) when the SQL drops, truncates, or deletes.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DESTRUCTIVE =
  /\bDROP\b(?!\s+(DEFAULT|NOT\s+NULL|IDENTITY|EXPRESSION)\b)|\bTRUNCATE\b|\bDELETE\s+FROM\b/i;

const stripComments = (sql) =>
  sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

function ask(reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

// A crashed hook doesn't block, so the allow rules would win; ask instead.
process.on("uncaughtException", (err) => ask(`SQL guard hook failed: ${err.message}`));

const input = JSON.parse(readFileSync(0, "utf8"));
const { tool_name: tool, tool_input: args = {}, cwd = process.cwd() } = input;

if (tool === "mcp__Neon__run_sql" || tool === "mcp__Neon__run_sql_transaction") {
  const sql = [args.sql, ...(args.sql_statements ?? [])].filter(Boolean).join("\n");
  if (DESTRUCTIVE.test(stripComments(sql))) {
    ask("SQL contains DROP, TRUNCATE, or DELETE FROM");
  }
} else if (tool === "Bash") {
  const command = args.command ?? "";
  if (!/run-migration\.ts|db:migrate/.test(command)) process.exit(0);
  for (const file of command.match(/[^\s'"]+\.sql\b/g) ?? []) {
    let sql;
    try {
      sql = readFileSync(resolve(cwd, file), "utf8");
    } catch {
      ask(`Could not read ${file} to check it for destructive SQL`);
    }
    if (DESTRUCTIVE.test(stripComments(sql))) {
      ask(`${file} contains DROP, TRUNCATE, or DELETE FROM`);
    }
  }
}
