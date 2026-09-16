import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSessionStore,
  loadNewestSessionId,
  resumeSessionStore,
  sessionsDirFor,
} from "../src/session.ts";

describe("session store", () => {
  it("roundtrips header + messages through JSONL", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chantier-sessions-"));
    const cwd = "/tmp/fake-project";
    const store = await createSessionStore({
      cwd,
      provider: "ollama",
      model: "glm-5.3-flash:cloud",
      sessionsRoot: root,
    });

    await store.append({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    await store.append({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    });

    const entries = await store.load(store.id);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      type: "session",
      id: store.id,
      cwd,
      provider: "ollama",
      model: "glm-5.3-flash:cloud",
    });
    expect(entries[1]).toMatchObject({ type: "message", message: { role: "user" } });
    expect(entries[2]).toMatchObject({ type: "message", message: { role: "assistant" } });
  });

  it("finds the newest session per cwd and resumes without a second header", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chantier-sessions-"));
    const cwd = "/tmp/fake-project";
    const first = await createSessionStore({
      cwd,
      provider: "ollama",
      model: "m",
      sessionsRoot: root,
    });
    await first.append({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "one" }] },
    });
    const second = await createSessionStore({
      cwd,
      provider: "ollama",
      model: "m",
      sessionsRoot: root,
    });

    expect(await loadNewestSessionId(cwd, root)).toBe(second.id);
    // Different cwd hashes to a different directory
    expect(await loadNewestSessionId("/tmp/other-project", root)).toBeNull();

    const resumed = await resumeSessionStore({ cwd, id: first.id, sessionsRoot: root });
    await resumed.append({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "two" }] },
    });
    const lines = await resumed.load(first.id);
    expect(lines).toHaveLength(3); // header + "one" + resumed append, no new header line
    expect(lines[0]).toMatchObject({ type: "session", id: first.id });
    expect(lines[1]).toMatchObject({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "one" }] },
    });
    expect(lines[2]).toMatchObject({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "two" }] },
    });
  });

  it("hashes the cwd into the directory name", () => {
    const dir = sessionsDirFor("/root", "/tmp/a");
    expect(path.dirname(dir)).toBe("/root");
    expect(path.basename(dir)).toMatch(/^[0-9a-f]{12}$/);
  });
});
