// Host registry: one data-driven entry per agent host this project can install
// into. Nothing here writes to disk; path resolution and detection are pure so
// the installer and the tests share the same source of truth.
//
// Supported hosts were verified against real config files on this machine
// (2026-11-05). The cc-switch host list also contains hosts whose config
// location and schema are unverified; they are listed as `unsupported` with the
// reason and never receive a guessed write.
import { join } from 'node:path';

export const SERVER_NAME = 'claude_web';
export const SKILL_NAME = 'claude';

// Codex is the only host whose long tool calls were verified to honour these
// keys; other TOML hosts get the conservative `command`/`args` pair only.
const CODEX_ENTRY_KEYS = [['tool_timeout_sec', 660], ['startup_timeout_sec', 20]];

// dsh defaults to execute_timeout 60s, which is shorter than a real
// consultation; write an explicit larger value or the client aborts the call.
const DSH_EXECUTE_TIMEOUT = 660;

const platformConfigDir = (home, env, platform, name) => {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', name);
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), name);
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), name);
};

const asList = (v) => (Array.isArray(v) ? v : [v]);

export const HOSTS = [
  {
    id: 'codex',
    label: 'Codex CLI',
    status: 'supported',
    format: 'toml',
    evidence: 'verified: managed block in ~/.codex/config.toml, existing installer',
    serverName: SERVER_NAME,
    skillName: SKILL_NAME,
    extraKeys: CODEX_ENTRY_KEYS,
    recordStyle: 'codex',
    skills: 'skills',
    detectPaths: (r) => [{ path: r.configPath, kind: 'file' }, { path: r.homeDir, kind: 'dir' }],
    resolve: ({ home, env, override, stateDir }) => {
      const root = override ?? env.CODEX_HOME ?? join(home, '.codex');
      return {
        hostId: 'codex',
        homeDir: root,
        configPath: join(root, 'config.toml'),
        skillsDir: join(root, 'skills'),
        skillDest: join(root, 'skills', SKILL_NAME),
        legacySkillDest: join(root, 'skills', 'claude-consult'),
        recordPath: join(root, 'claude-web-api-install.json'),
        lockPath: join(root, '.claude-web-api-install.lock'),
        homeLabel: 'Codex home',
        stateDir,
      };
    },
  },
  {
    id: 'claude',
    label: 'Claude Code',
    status: 'supported',
    format: 'json-members',
    evidence: 'verified: mcpServers in ~/.claude.json, skills in ~/.claude/skills',
    serverName: SERVER_NAME,
    skillName: SKILL_NAME,
    container: ['mcpServers'],
    entry: ({ nodePath, mcpPath }) => ({ type: 'stdio', command: nodePath, args: [mcpPath] }),
    skills: 'skills',
    detectPaths: (r) => [{ path: r.configPath, kind: 'file' }, { path: r.homeDir, kind: 'dir' }],
    resolve: ({ home, env, override, stateDir }) => {
      const configDir = override ?? env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
      const configPath = override
        ? join(configDir, '.claude.json')
        : (env.CLAUDE_CONFIG_DIR ? join(configDir, '.claude.json') : join(home, '.claude.json'));
      return {
        hostId: 'claude',
        homeDir: configDir,
        configPath,
        skillsDir: join(configDir, 'skills'),
        skillDest: join(configDir, 'skills', SKILL_NAME),
        legacySkillDest: join(configDir, 'skills', 'claude-consult'),
        recordPath: join(stateDir, 'installs', 'claude.json'),
        lockPath: join(stateDir, '.install-claude.lock'),
        homeLabel: 'Claude Code config directory',
        stateDir,
      };
    },
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    status: 'supported',
    format: 'json-members',
    evidence: 'verified path + mcpServers shape; desktop apps have no skills directory',
    serverName: SERVER_NAME,
    skillName: SKILL_NAME,
    container: ['mcpServers'],
    entry: ({ nodePath, mcpPath }) => ({ command: nodePath, args: [mcpPath] }),
    skills: null,
    detectPaths: (r) => [{ path: r.configPath, kind: 'file' }, { path: r.homeDir, kind: 'dir' }],
    resolve: ({ home, env, platform, override, stateDir }) => {
      const root = override ?? platformConfigDir(home, env, platform, 'Claude');
      return {
        hostId: 'claude-desktop',
        homeDir: root,
        configPath: join(root, 'claude_desktop_config.json'),
        skillsDir: null,
        skillDest: null,
        recordPath: join(stateDir, 'installs', 'claude-desktop.json'),
        lockPath: join(stateDir, '.install-claude-desktop.lock'),
        homeLabel: 'Claude Desktop data directory',
        stateDir,
      };
    },
  },
  {
    id: 'pi',
    label: 'Pi agent',
    status: 'supported',
    format: 'json-members',
    evidence: 'verified: mcpServers in ~/.pi/agent/mcp.json, skills in ~/.pi/agent/skills',
    serverName: SERVER_NAME,
    skillName: SKILL_NAME,
    container: ['mcpServers'],
    entry: ({ nodePath, mcpPath }) => ({ command: nodePath, args: [mcpPath] }),
    skills: 'skills',
    detectPaths: (r) => [{ path: r.configPath, kind: 'file' }, { path: r.homeDir, kind: 'dir' }],
    resolve: ({ home, env, override, stateDir }) => {
      const root = override ?? env.PI_CODING_AGENT_DIR ?? join(home, '.pi', 'agent');
      return {
        hostId: 'pi',
        homeDir: root,
        configPath: join(root, 'mcp.json'),
        skillsDir: join(root, 'skills'),
        skillDest: join(root, 'skills', SKILL_NAME),
        legacySkillDest: join(root, 'skills', 'claude-consult'),
        recordPath: join(stateDir, 'installs', 'pi.json'),
        lockPath: join(stateDir, '.install-pi.lock'),
        homeLabel: 'Pi agent directory',
        stateDir,
      };
    },
  },  {
    id: 'dsh',
    label: 'DeepSeek Harness',
    status: 'supported',
    format: 'json-members',
    evidence: 'verified: {timeouts, servers} in ~/.deepseek/mcp.json (deepseek setup template), skills in ~/.deepseek/skills',
    serverName: SERVER_NAME,
    skillName: SKILL_NAME,
    container: ['servers'],
    entry: ({ nodePath, mcpPath }) => ({
      command: nodePath,
      args: [mcpPath],
      env: {},
      url: null,
      connect_timeout: null,
      execute_timeout: DSH_EXECUTE_TIMEOUT,
      read_timeout: null,
      disabled: false,
      enabled: true,
      required: false,
      enabled_tools: [],
      disabled_tools: [],
    }),
    skills: 'skills',
    detectPaths: (r) => [{ path: r.configPath, kind: 'file' }, { path: r.homeDir, kind: 'dir' }],
    resolve: ({ home, env, override, stateDir }) => {
      const root = override ?? env.DEEPSEEK_HOME ?? join(home, '.deepseek');
      return {
        hostId: 'dsh',
        homeDir: root,
        configPath: join(root, 'mcp.json'),
        skillsDir: join(root, 'skills'),
        skillDest: join(root, 'skills', SKILL_NAME),
        legacySkillDest: join(root, 'skills', 'claude-consult'),
        recordPath: join(stateDir, 'installs', 'dsh.json'),
        lockPath: join(stateDir, '.install-dsh.lock'),
        homeLabel: 'DeepSeek home',
        stateDir,
      };
    },
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    status: 'supported',
    format: 'json-members',
    evidence: 'verified: mcpServers in ~/.gemini/settings.json, skills in ~/.gemini/skills',
    serverName: SERVER_NAME,
    skillName: SKILL_NAME,
    container: ['mcpServers'],
    entry: ({ nodePath, mcpPath }) => ({ command: nodePath, args: [mcpPath] }),
    skills: 'skills',
    detectPaths: (r) => [{ path: r.configPath, kind: 'file' }, { path: r.homeDir, kind: 'dir' }],
    resolve: ({ home, override, stateDir }) => {
      const root = override ?? join(home, '.gemini');
      return {
        hostId: 'gemini',
        homeDir: root,
        configPath: join(root, 'settings.json'),
        skillsDir: join(root, 'skills'),
        skillDest: join(root, 'skills', SKILL_NAME),
        legacySkillDest: join(root, 'skills', 'claude-consult'),
        recordPath: join(stateDir, 'installs', 'gemini.json'),
        lockPath: join(stateDir, '.install-gemini.lock'),
        homeLabel: 'Gemini CLI config directory',
        stateDir,
      };
    },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    status: 'supported',
    format: 'json-members',
    evidence: 'verified: mcp entries {type:"local", command:[...]} in ~/.config/opencode/opencode.json, skills in ~/.config/opencode/skills',
    serverName: SERVER_NAME,
    skillName: SKILL_NAME,
    container: ['mcp'],
    entry: ({ nodePath, mcpPath }) => ({ type: 'local', command: [nodePath, mcpPath], enabled: true }),
    skills: 'skills',
    detectPaths: (r) => [{ path: r.configPath, kind: 'file' }, { path: r.homeDir, kind: 'dir' }],
    resolve: ({ home, env, override, stateDir }) => {
      const root = override ?? join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode');
      return {
        hostId: 'opencode',
        homeDir: root,
        configPath: join(root, 'opencode.json'),
        skillsDir: join(root, 'skills'),
        skillDest: join(root, 'skills', SKILL_NAME),
        legacySkillDest: join(root, 'skills', 'claude-consult'),
        recordPath: join(stateDir, 'installs', 'opencode.json'),
        lockPath: join(stateDir, '.install-opencode.lock'),
        homeLabel: 'OpenCode config directory',
        stateDir,
      };
    },
  },
  {
    id: 'grokbuild',
    label: 'Grok Build',
    status: 'supported',
    format: 'toml',
    evidence: 'structure verified from cc-switch (~/.grok/config.toml [mcp_servers]); runtime unverified — command/args only',
    serverName: SERVER_NAME,
    skillName: SKILL_NAME,
    extraKeys: [],
    recordStyle: 'generic',
    skills: null,
    detectPaths: (r) => [{ path: r.configPath, kind: 'file' }, { path: r.homeDir, kind: 'dir' }],
    resolve: ({ home, override, stateDir }) => {
      const root = override ?? join(home, '.grok');
      return {
        hostId: 'grokbuild',
        homeDir: root,
        configPath: join(root, 'config.toml'),
        skillsDir: null,
        skillDest: null,
        recordPath: join(stateDir, 'installs', 'grokbuild.json'),
        lockPath: join(stateDir, '.install-grokbuild.lock'),
        homeLabel: 'Grok Build config directory',
        stateDir,
      };
    },
  },
];

// Present in cc-switch's host list, but their config location and schema have no
// verified evidence here. They are reported, never written to.
export const UNSUPPORTED_HOSTS = [
  { id: 'openclaw', label: 'OpenClaw', status: 'unsupported', reason: 'MCP config path and schema unverified' },
  { id: 'hermes', label: 'Hermes', status: 'unsupported', reason: 'MCP config path and schema unverified' },
  { id: 'mcode', label: 'MCode', status: 'unsupported', reason: 'MCP config path and schema unverified' },
  { id: 'kimi', label: 'Kimi Code', status: 'unsupported', reason: 'MCP config path and schema unverified' },
  { id: 'agy', label: 'Antigravity', status: 'unsupported', reason: 'MCP config path and schema unverified' },
  { id: 'omp', label: 'Oh My Pi', status: 'unsupported', reason: 'MCP config lives in a YAML profile whose schema is unverified' },
];

export const SUPPORTED_IDS = HOSTS.map((h) => h.id);

export function findHost(id) {
  return HOSTS.find((h) => h.id === id) ?? null;
}

// Resolve every host's concrete paths for one installation base.
export function resolveTargets({ home, env = process.env, platform = process.platform, stateDir, overrides = {} }) {
  return HOSTS.map((host) => ({
    host,
    target: host.resolve({ home, env, platform, override: overrides[host.id] ?? null, stateDir }),
  }));
}

export async function isDetected(io, host, target) {
  const lstatSafe = async (p) => {
    try {
      return await io.lstat(p);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  };
  for (const { path, kind } of asList(host.detectPaths(target))) {
    const st = await lstatSafe(path);
    if (st === null) continue;
    if (kind === 'dir' && st.isDirectory()) return true;
    if (kind === 'file' && st.isFile()) return true;
  }
  return false;
}

// Inventory for `--list`: supported hosts with resolved paths, unsupported hosts
// with the reason. Never touches the filesystem.
export function inventory({ home, env = process.env, platform = process.platform, stateDir, overrides = {} }) {
  const supported = resolveTargets({ home, env, platform, stateDir, overrides }).map(({ host, target }) => ({
    id: host.id,
    label: host.label,
    status: host.status,
    mcp: { configPath: target.configPath, format: host.format, serverName: host.serverName },
    skills: target.skillsDir ? { dir: target.skillsDir } : null,
    recordPath: target.recordPath,
    evidence: host.evidence,
  }));
  return [...supported, ...UNSUPPORTED_HOSTS];
}
