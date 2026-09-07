import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
it("loads only this package through real pi twice, without hosting, subprocesses or capture files", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-herdr-package-test-"));
  try {
    const script = `
      import assert from 'node:assert/strict';
      import cp from 'node:child_process';
      import fs from 'node:fs/promises';
      import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
      const [root, source] = process.argv.slice(1);
      cp.spawn = () => { throw new Error('Unexpected subprocess during registration'); };
      fs.mkdtemp = async () => { throw new Error('Unexpected capture directory during registration'); };
      const loader = new DefaultResourceLoader({ cwd: root, agentDir: root,
        settingsManager: SettingsManager.inMemory(), noExtensions: true,
        noSkills: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: [source] });
      const cycles = [];
      for (let cycle=0; cycle<2; cycle++) {
        await loader.reload();
        const loaded = loader.getExtensions();
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.extensions.length, 1);
        const extension = loaded.extensions[0];
        const names = [...extension.tools.keys()].sort();
        assert.deepEqual(names, ['herdr_agent','herdr_pane','herdr_tab','herdr_workspace']);
        assert.equal(extension.commands.size, 0);
        await assert.rejects(extension.tools.get('herdr_workspace').definition.execute(
          'fixture', { action: 'list' }, undefined, undefined, { cwd: root }), /missing_host/);
        const handlers = extension.handlers.get('session_shutdown');
        assert.equal(handlers.length, 1);
        await handlers[0]({type:'session_shutdown', reason:'reload'}, {cwd:root});
        await handlers[0]({type:'session_shutdown', reason:'reload'}, {cwd:root});
        cycles.push(names);
      }
      assert.deepEqual(await fs.readdir(root), []);
      console.log(JSON.stringify(cycles));
    `;
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script, root, resolve(".")], {
      cwd: resolve("."), timeout: 20000, maxBuffer: 51200,
      env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: root, HERDR_ENV: undefined, HERDR_SOCKET_PATH: undefined, HERDR_SESSION: undefined },
    });
    expect(JSON.parse(stdout)).toHaveLength(2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 30000);

it("declares the standalone pi source entry and unbundled core peers, with no install hooks or execution API", async () => {
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  expect(pkg.pi).toEqual({ extensions: ["./src/index.ts"] });
  expect(pkg.peerDependencies).toEqual({ "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-ai": "*", typebox: "*" });
  expect(pkg.dependencies ?? {}).toEqual({});
  for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack"]) expect(pkg.scripts[hook]).toBeUndefined();
  expect(pkg.bin).toBeUndefined(); expect(pkg.main).toBeUndefined(); expect(pkg.exports).toBeUndefined();
});
it("packs the source entry and all runtime modules, not tests, dependencies or private artifacts", async () => {
  const { stdout } = await run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: resolve("."), timeout: 20000, maxBuffer: 51200 });
  const files = (JSON.parse(stdout)[0].files as Array<{ path: string }>).map(file => file.path);
  for (const file of ["src/index.ts", "src/execute.ts", "src/contracts.ts", "src/errors.ts", "src/context.ts", "src/results.ts", "src/transport/capture.ts", "src/transport/runner.ts", "src/actions/index.ts", "src/actions/shared.ts", "src/actions/workspace.ts", "src/actions/tab.ts", "src/actions/pane.ts", "src/actions/agent.ts"]) expect(files).toContain(file);
  expect(files).toContain("LICENSE"); expect(files).toContain("package.json");
  expect(files.some(file => /^(tests|node_modules|\.superpowers|\.worktrees|coverage)\//.test(file))).toBe(false);
}, 30000);
