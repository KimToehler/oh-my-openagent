import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const AGENT_DIR = join(import.meta.dir, "agent")
const REPO_ROOT = join(import.meta.dir, "..")

describe("agent dev-environment scripts", () => {
  describe("setup.sh", () => {
    const setup = join(AGENT_DIR, "setup.sh")

    test("#given the shared bootstrap #when inspected #then it is an executable strict bash script", () => {
      expect(existsSync(setup), "script/agent/setup.sh must exist").toBe(true)
      if (process.platform !== "win32") {
        expect((statSync(setup).mode & 0o111) !== 0, "setup.sh must be executable").toBe(true)
      }
      const body = readFileSync(setup, "utf8")
      expect(body.startsWith("#!/usr/bin/env bash")).toBe(true)
      expect(body).toContain("set -euo pipefail")
    })

    test("#given the bootstrap #when it runs #then it verifies tools, installs, and conditionally builds", () => {
      const body = readFileSync(setup, "utf8")

      expect(body).toContain("command -v") // tool presence check
      expect(body).toContain("bun node git") // required toolchain verified
      expect(body).toContain("tmux") // non-fatal warning path
      expect(body).toContain("bun install")
      expect(body).toContain("bun run build")
      expect(body).toContain("OMO_AGENT_FORCE_BUILD") // idempotent skip-build guard
      expect(body).toContain(".env") // credential sourcing
      expect(body).toContain("--ignore-scripts")
      expect(body).toMatch(/expected_bun="\d+\.\d+\.\d+"/) // drift warning is version-pinned
      expect(body).toContain("submodule update --init") // provenance submodules
      expect(body).toContain("materialize-frontend-refs") // frontend ref materialize
    })

    test("#given the CI-pinned Bun version #when setup.sh, the devcontainer image, and CI are compared #then all three pin the same version", () => {
      // given
      const setupPin = readFileSync(setup, "utf8").match(/expected_bun="([^"]+)"/)?.[1]
      const dockerfilePin = readFileSync(join(REPO_ROOT, ".devcontainer", "Dockerfile"), "utf8").match(
        /bash -s "bun-v([^"]+)"/,
      )?.[1]
      const ciPins = [
        ...readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8").matchAll(
          /bun-version:\s*"([^"]+)"/g,
        ),
      ].map((match) => match[1])

      // then
      expect(setupPin, "setup.sh must declare expected_bun").toBeDefined()
      expect(dockerfilePin, ".devcontainer/Dockerfile must pin an explicit bun-v<version>").toBeDefined()
      expect(ciPins.length, "ci.yml must pin bun-version").toBeGreaterThan(0)
      // The devcontainer image and the setup.sh drift warning must both track CI.
      for (const ciPin of new Set(ciPins)) {
        expect(ciPin, "every ci.yml bun-version must match the devcontainer pin").toBe(dockerfilePin as string)
      }
      expect(setupPin).toBe(dockerfilePin as string)
    })
  })

  describe("qa-sandbox.sh", () => {
    const sandbox = join(AGENT_DIR, "qa-sandbox.sh")

    test("#given the QA isolation helper #when inspected #then it isolates XDG + CODEX_HOME and injects creds", () => {
      expect(existsSync(sandbox), "script/agent/qa-sandbox.sh must exist").toBe(true)
      const body = readFileSync(sandbox, "utf8")
      expect(body.startsWith("#!/usr/bin/env bash")).toBe(true)
      expect(body).toContain("mktemp")
      for (const xdg of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
        expect(body, `must isolate ${xdg}`).toContain(xdg)
      }
      expect(body).toContain("CODEX_HOME")
      expect(body).toContain("OPENCODE_DISABLE_AUTOUPDATE")
      expect(body).toContain("OPENCODE_DISABLE_MODELS_FETCH")
      expect(body).toContain(".env") // creds injection, set once
      expect(body).toContain(":-$0")
    })

    // The plugin's own config chain is $HOME/.omo/omo.json[c], which is NOT an XDG
    // path, so isolating XDG_* alone leaves it pointing at the operator's real
    // config. A QA run that pins agent/category models then destroys it. This
    // executes the helper rather than grepping it, because the guarantee that
    // matters is the value of HOME in the resulting environment.
    test.skipIf(process.platform === "win32")(
      "#given the QA isolation helper #when sourced #then HOME is redirected away from the real home",
      () => {
        const realHome = process.env["HOME"]
        expect(realHome, "HOME must be set to run this test").toBeTruthy()

        const probe = `set -e
export HOME=${JSON.stringify(realHome)}
. ${JSON.stringify(sandbox)} >/dev/null 2>&1
printf 'HOME=%s\\n' "$HOME"
printf 'OMO_QA_ROOT=%s\\n' "$OMO_QA_ROOT"
`
        const result = Bun.spawnSync(["bash", "-c", probe])
        const stdout = result.stdout.toString()
        const sandboxHome = /^HOME=(.*)$/m.exec(stdout)?.[1]
        const qaRoot = /^OMO_QA_ROOT=(.*)$/m.exec(stdout)?.[1]

        expect(qaRoot, "sandbox must export OMO_QA_ROOT").toBeTruthy()
        expect(sandboxHome, "sandbox must export HOME").toBeTruthy()
        expect(sandboxHome, "HOME must not remain the real home").not.toBe(realHome)
        expect(
          sandboxHome?.startsWith(qaRoot ?? "\0"),
          `HOME (${sandboxHome}) must live under OMO_QA_ROOT (${qaRoot})`,
        ).toBe(true)

        if (qaRoot !== undefined && qaRoot.length > 0) {
          Bun.spawnSync(["rm", "-rf", qaRoot])
        }
      },
    )

    // Moving HOME alone does not isolate the plugin's config. Project layers are
    // collected by walking cwd upward until $HOME and they outrank the user
    // layer, so a cwd under the operator's real home still claims the real
    // ~/.omo — winning over the sandbox, and writable by the migration engine.
    // The sandbox project dir is what terminates that walk inside the sandbox.
    test.skipIf(process.platform === "win32")(
      "#given the QA isolation helper #when sourced #then it exports a project dir inside the sandbox to run QA from",
      () => {
        const probe = `set -e
. ${JSON.stringify(sandbox)} >/dev/null 2>&1
printf 'PROJ=%s\\n' "$OMO_QA_PROJ"
printf 'ROOT=%s\\n' "$OMO_QA_ROOT"
printf 'ISDIR=%s\\n' "$([ -d "$OMO_QA_PROJ" ] && echo yes || echo no)"
`
        const result = Bun.spawnSync(["bash", "-c", probe])
        const stdout = result.stdout.toString()
        const proj = /^PROJ=(.*)$/m.exec(stdout)?.[1]
        const qaRoot = /^ROOT=(.*)$/m.exec(stdout)?.[1]
        const isDir = /^ISDIR=(.*)$/m.exec(stdout)?.[1]

        expect(proj, "sandbox must export OMO_QA_PROJ").toBeTruthy()
        expect(isDir, "OMO_QA_PROJ must exist as a directory").toBe("yes")
        expect(
          proj?.startsWith(qaRoot ?? "\0"),
          `OMO_QA_PROJ (${proj}) must live under OMO_QA_ROOT (${qaRoot})`,
        ).toBe(true)

        if (qaRoot !== undefined && qaRoot.length > 0) {
          Bun.spawnSync(["rm", "-rf", qaRoot])
        }
      },
    )
  })

  describe(".env.example", () => {
    test("#given the credential template #when inspected #then it documents the injection points without real secrets", () => {
      const example = join(REPO_ROOT, ".env.example")

      expect(existsSync(example), ".env.example must exist (committed injection point)").toBe(true)
      const body = readFileSync(example, "utf8")
      expect(body).toContain("ANTHROPIC_API_KEY")
      expect(body).toContain("OPENAI_API_KEY")
      expect(body).toContain("#") // documented with comments
      expect(body).toContain("# ANTHROPIC_API_KEY")
    })
  })
})
