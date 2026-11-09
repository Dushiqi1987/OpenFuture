import os from "node:os";
import path from "node:path";
import { StdioMcpClient } from "./mcp-client.mjs";
import { ensureDir, pathExists, readJson, safeId, shortHash, writeJson } from "./util.mjs";

/**
 * One isolated vault + fake home per project.
 *
 * pi-llm-wiki resolves its personal vault from WIKI_HOME/homedir, and its
 * project vault from WIKI_ROOT/cwd. Redirecting HOME, USERPROFILE, APPDATA,
 * LOCALAPPDATA and WIKI_HOME keeps personal pages and real credentials out of
 * the adapter's view: the fake home has no .llm-wiki directory at all.
 */
export function projectPaths({ baseDir, projectId }) {
  const safe = safeId(projectId, "project");
  const root = path.join(baseDir, `${safe}-${shortHash(projectId, 6)}`);
  const vaultRoot = path.join(root, "vault");
  const homeRoot = path.join(root, "home");
  const stateFile = path.join(root, "state.json");
  const draftsDir = path.join(root, "drafts");
  const publishedDir = path.join(root, "published");
  const wikiDir = path.join(vaultRoot, ".llm-wiki", "wiki");
  const rawSourcesDir = path.join(vaultRoot, ".llm-wiki", "raw", "sources");
  return {
    projectRoot: root,
    vaultRoot,
    homeRoot,
    stateFile,
    draftsDir,
    publishedDir,
    wikiDir,
    rawSourcesDir,
    configFile: path.join(vaultRoot, ".llm-wiki", "config.json"),
  };
}

export function createServerEnv({ homeRoot, vaultRoot }) {
  const fakeAppData = path.join(homeRoot, "AppData", "Roaming");
  const fakeLocalAppData = path.join(homeRoot, "AppData", "Local");
  return {
    WIKI_ROOT: vaultRoot,
    WIKI_HOME: homeRoot,
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    APPDATA: fakeAppData,
    LOCALAPPDATA: fakeLocalAppData,
    XDG_CONFIG_HOME: path.join(homeRoot, ".config"),
    NO_COLOR: "1",
    TERM: "dumb",
    CI: "1",
  };
}

export function defaultState(projectId) {
  return {
    version: 1,
    projectId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sources: {},
    topics: {},
  };
}

export async function loadState(stateFile, projectId) {
  const state = await readJson(stateFile, null);
  if (!state || state.version !== 1) return defaultState(projectId);
  if (state.projectId !== projectId) {
    throw new Error(`state project mismatch: ${state.projectId} != ${projectId}`);
  }
  state.sources ??= {};
  state.topics ??= {};
  return state;
}

export async function saveState(stateFile, state) {
  state.updatedAt = new Date().toISOString();
  await writeJson(stateFile, state);
}

export async function prepareProject({ baseDir, projectId, topic, mode = "personal", serverPath, nodePath, timeoutMs = 60_000 }) {
  if (!serverPath) throw new Error("PI_LLM_WIKI_SERVER (serverPath) is required");
  const paths = projectPaths({ baseDir: baseDir ?? path.join(os.tmpdir(), "openfuture-wiki"), projectId });
  await ensureDir(paths.vaultRoot);
  await ensureDir(paths.homeRoot);
  await ensureDir(paths.draftsDir);
  await ensureDir(paths.publishedDir);

  const state = await loadState(paths.stateFile, projectId);
  const env = createServerEnv(paths);
  const client = new StdioMcpClient({
    serverPath,
    nodePath,
    cwd: paths.vaultRoot,
    env,
    timeoutMs,
  });
  await client.start();

  let bootstrapped = false;
  if (!(await pathExists(paths.configFile))) {
    const result = await client.callTool(
      "wiki_bootstrap",
      { topic: topic ?? projectId, mode },
      { timeoutMs },
    );
    bootstrapped = true;
    if (!(await pathExists(paths.configFile))) {
      throw new Error(`wiki_bootstrap did not create ${paths.configFile}: ${result.text.slice(0, 300)}`);
    }
  }

  await ensureDir(paths.wikiDir);
  await ensureDir(paths.rawSourcesDir);
  return { paths, state, env, client, bootstrapped };
}
