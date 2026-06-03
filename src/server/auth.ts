import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AgentIdentity {
  key: string;
  displayName: string;
}

/**
 * Loads the set of valid agent API keys. Keys come from (in order):
 *   1. AGENT_KEYS env var: "key1:Alice,key2:Bob"
 *   2. agent-keys.json: { "key1": { "displayName": "Alice" }, ... }
 *
 * There is deliberately NO "accept any key" mode — an unknown key is rejected.
 */
export function loadAgentKeys(file = "agent-keys.json"): Map<string, AgentIdentity> {
  const keys = new Map<string, AgentIdentity>();

  const env = process.env.AGENT_KEYS?.trim();
  if (env) {
    for (const pair of env.split(",")) {
      const [key, name] = pair.split(":").map((s) => s.trim());
      if (key) keys.set(key, { key, displayName: name || key.slice(0, 8) });
    }
  }

  const path = resolve(file);
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      { displayName?: string }
    >;
    for (const [key, value] of Object.entries(parsed)) {
      keys.set(key, { key, displayName: value.displayName || key.slice(0, 8) });
    }
  }

  return keys;
}

export function authenticate(
  keys: Map<string, AgentIdentity>,
  presented: string | null | undefined,
): AgentIdentity | null {
  if (!presented) return null;
  return keys.get(presented) ?? null;
}
