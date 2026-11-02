import { describe, expect, test } from "bun:test";
import { parseScoutBinding } from "../src/scout/binding";
import { scoutConnectorEnvironment } from "../src/scout/mcp";
import { draftInput } from "../src/scout/types";
import { scoutFixtureConfig } from "./scout-binding.test";

const actor = { id: "scout-fixture-alice" };

describe("protected requester process provenance", () => {
  test("ambient source, Odoo identity and arbitrary environment do not reach stdio", () => {
    const binding = parseScoutBinding(scoutFixtureConfig(), actor);
    const environment = scoutConnectorEnvironment(binding, {
      PATH: "synthetic-platform-path",
      SCOUT_QUEUE_SOURCE_SURFACE: "api",
      SCOUT_ODOO_UID: "1",
      PYTHONPATH: "synthetic-untrusted-module-path",
      OPENAI_API_KEY: "synthetic-not-a-real-key",
    });
    expect(environment).toEqual({
      ...binding.environment,
      PATH: "synthetic-platform-path",
    });
    expect(environment.SCOUT_QUEUE_SOURCE_SURFACE).toBeUndefined();
    expect(environment.SCOUT_ODOO_UID).toBe("11");
    expect(environment.PYTHONPATH).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBeUndefined();
  });

  test("only the protected operator source reaches the existing fixed command", () => {
    const config = scoutFixtureConfig();
    Object.assign(config.bindings[0].environment, {
      SCOUT_QUEUE_SOURCE_SURFACE: "api",
    });
    const binding = parseScoutBinding(config, actor);
    const environment = scoutConnectorEnvironment(binding, {
      SCOUT_QUEUE_SOURCE_SURFACE: "chatgpt",
    });
    expect(environment.SCOUT_QUEUE_SOURCE_SURFACE).toBe("api");
    expect([...binding.command]).toEqual(config.bindings[0].command);
    expect(binding.command.slice(1)).toEqual(["-m", "scout_queue.mcp_server"]);
    expect(() =>
      scoutConnectorEnvironment({
        ...binding,
        environment: {
          ...binding.environment,
          SCOUT_QUEUE_SOURCE_SURFACE: "scout" as never,
        },
      }),
    ).toThrow("SCOUT_NOT_CONFIGURED");
  });

  test("public draft requests cannot supply an operator source", () => {
    const input = {
      sourceId: "811265b9-a0a8-4ae1-8ae4-bc801f5f5c3c",
      channelId: "synthetic-channel",
      title: "Synthetic draft",
      instructions: "Return an unsent draft only.",
    };
    expect(draftInput.safeParse(input).success).toBe(true);
    expect(
      draftInput.safeParse({ ...input, source_surface: "api" }).success,
    ).toBe(false);
    expect(
      draftInput.safeParse({ ...input, SCOUT_QUEUE_SOURCE_SURFACE: "api" })
        .success,
    ).toBe(false);
  });
});
