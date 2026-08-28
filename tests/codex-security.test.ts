import { describe, expect, it } from "vitest";
import {
  CODEX_PERMISSION_PROFILE,
  codexChildEnvironment,
  codexPermissionParams,
  codexPermissionProfileConfig,
  codexPrivacyArgs,
} from "../src/model/codex.js";

describe("Codex App Server privacy boundary", () => {
  it("mechanically disables shell and external tool surfaces", () => {
    const args = codexPrivacyArgs();
    const disabled = args.flatMap((argument, index) =>
      argument === "--disable" ? [args[index + 1]] : [],
    );

    expect(disabled).toEqual(
      expect.arrayContaining([
        "shell_tool",
        "unified_exec",
        "apps",
        "plugins",
        "multi_agent",
        "browser_use",
        "computer_use",
      ]),
    );
    expect(args).toEqual(
      expect.arrayContaining(["--config", "tools.web_search=false"]),
    );
    expect(args).toEqual(
      expect.arrayContaining(["--config", 'web_search="disabled"']),
    );
  });

  it("defines a read-only, offline evidence profile without broad roots", () => {
    const config = codexPermissionProfileConfig();

    expect(config).toContain(
      `default_permissions = "${CODEX_PERMISSION_PROFILE}"`,
    );
    expect(config).toContain('web_search = "disabled"');
    expect(config).toContain('":minimal" = "read"');
    expect(config).toContain(
      `[permissions.${CODEX_PERMISSION_PROFILE}.filesystem.":workspace_roots"]`,
    );
    expect(config).toContain('"." = "read"');
    expect(config).toContain("enabled = false");
    expect(config).not.toContain('":root"');
    expect(config).not.toContain("write");
    expect(config).not.toContain("fullAccess");
    expect(config).not.toContain("dangerFullAccess");
  });

  it("selects only the private extraction root at thread and turn scope", () => {
    expect(codexPermissionParams("/private/ree-evidence")).toEqual({
      permissions: CODEX_PERMISSION_PROFILE,
      runtimeWorkspaceRoots: ["/private/ree-evidence"],
    });
  });

  it("does not expose unrelated parent-process environment variables", () => {
    const environment = codexChildEnvironment("/private/codex-home", {
      PATH: "/usr/bin",
      HTTPS_PROXY: "https://proxy.example",
      REE_TEST_CODEX_ARGS_PATH: "/tmp/codex-args.json",
      OPENAI_API_KEY: "must-not-be-forwarded",
      PERSONAL_SECRET: "must-not-be-forwarded",
    });

    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      HTTPS_PROXY: "https://proxy.example",
      REE_TEST_CODEX_ARGS_PATH: "/tmp/codex-args.json",
      CODEX_HOME: "/private/codex-home",
      HOME: "/private/codex-home",
      USERPROFILE: "/private/codex-home",
    });
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("PERSONAL_SECRET");
  });
});
