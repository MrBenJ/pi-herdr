import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
let packed: Promise<string[]> | undefined;
function packedFiles(): Promise<string[]> {
  return packed ??= run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: resolve("."), timeout: 20000, maxBuffer: 51200 })
    .then(({ stdout }) => (JSON.parse(stdout)[0].files as Array<{ path: string }>).map(file => file.path));
}
it("loads packed source without its devDependencies through real pi twice, with no hosting or subprocesses", async () => {
  const sandbox = await fs.mkdtemp(join(tmpdir(), "pi-herdr-package-test-"));
  const root = join(sandbox, "harness");
  const source = join(sandbox, "package");
  try {
    await fs.mkdir(root);
    for (const file of await packedFiles()) {
      const target = join(source, file);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.copyFile(resolve(file), target);
    }
    await expect(fs.stat(join(source, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    const script = `
      import assert from 'node:assert/strict';
      import cp from 'node:child_process';
      import fs from 'node:fs/promises';
      const [root, source, sdk] = process.argv.slice(1);
      const { DefaultResourceLoader, SettingsManager } = await import(sdk);
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
        assert.equal(loaded.extensions.length, 2);
        const byTools = [...loaded.extensions].sort((a, b) => [...a.tools.keys()].join(',').localeCompare([...b.tools.keys()].join(',')));
        const primitive = byTools.find(extension => extension.tools.has('herdr_workspace'));
        const orchestrator = byTools.find(extension => extension.tools.has('herdr_task'));
        assert.ok(primitive); assert.ok(orchestrator);
        const primitiveNames = [...primitive.tools.keys()].sort();
        assert.deepEqual(primitiveNames, ['herdr_agent','herdr_pane','herdr_tab','herdr_workspace']);
        assert.deepEqual([...orchestrator.tools.keys()], ['herdr_task']);
        assert.equal(primitive.commands.size, 0); assert.equal(orchestrator.commands.size, 0);
        await assert.rejects(primitive.tools.get('herdr_workspace').definition.execute(
          'fixture', { action: 'list' }, undefined, undefined, { cwd: root }), /missing_host/);
        assert.equal(primitive.handlers.get('session_shutdown').length, 1);
        assert.equal(orchestrator.handlers.get('session_shutdown').length, 1);
        assert.equal(orchestrator.handlers.get('tool_call').length, 1);
        for (const extension of [primitive, orchestrator]) {
          const handlers = extension.handlers.get('session_shutdown');
          await handlers[0]({type:'session_shutdown', reason:'reload'}, {cwd:root});
          await handlers[0]({type:'session_shutdown', reason:'reload'}, {cwd:root});
        }
        cycles.push([...primitiveNames, ...orchestrator.tools.keys()].sort());
      }
      assert.deepEqual(await fs.readdir(root), []);
      console.log(JSON.stringify(cycles));
    `;
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script, root, source, import.meta.resolve("@earendil-works/pi-coding-agent")], {
      cwd: root, timeout: 20000, maxBuffer: 51200,
      env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: root, NODE_PATH: undefined, HERDR_ENV: undefined, HERDR_SOCKET_PATH: undefined, HERDR_SESSION: undefined },
    });
    expect(JSON.parse(stdout)).toHaveLength(2);
  } finally { await fs.rm(sandbox, { recursive: true, force: true }); }
}, 30000);

it("declares the standalone pi source entry and unbundled core peers, with no install hooks or execution API", async () => {
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  expect(pkg.pi).toEqual({ extensions: ["./src/index.ts", "./src/orchestrator/index.ts"] });
  expect(pkg.peerDependencies).toEqual({ "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-ai": "*", typebox: "*" });
  expect(pkg.dependencies ?? {}).toEqual({});
  for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack"]) expect(pkg.scripts[hook]).toBeUndefined();
  expect(pkg.bin).toBeUndefined(); expect(pkg.main).toBeUndefined(); expect(pkg.exports).toBeUndefined();
});
it("packs the source entry and all runtime modules, not tests, dependencies or private artifacts", async () => {
  const files = await packedFiles();
  for (const file of ["src/index.ts", "src/execute.ts", "src/contracts.ts", "src/errors.ts", "src/context.ts", "src/results.ts", "src/transport/capture.ts", "src/transport/runner.ts", "src/actions/index.ts", "src/actions/shared.ts", "src/actions/workspace.ts", "src/actions/tab.ts", "src/actions/pane.ts", "src/actions/agent.ts", "src/orchestrator/index.ts", "src/orchestrator/contracts.ts", "src/orchestrator/errors.ts", "src/orchestrator/repository.ts", "src/orchestrator/herdr-inventory.ts", "src/orchestrator/prompt.ts", "src/orchestrator/launch.ts", "src/orchestrator/guards.ts"]) expect(files).toContain(file);
  expect(files).toContain("LICENSE"); expect(files).toContain("package.json");
  for (const file of ["README.md", "docs/compatibility.md", "docs/tool-contract.md", "docs/manual-smoke.md", "docs/release-checklist.md"]) expect(files).toContain(file);
  expect(files.some(file => /^(tests|node_modules|\.superpowers|\.worktrees|coverage)\//.test(file))).toBe(false);
}, 30000);
