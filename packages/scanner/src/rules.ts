import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const ruleSchema = z.object({
  id: z.string(),
  category: z.enum(['exec', 'exfiltration', 'credentials', 'obfuscation', 'persistence', 'destructive', 'prompt-injection', 'network', 'privilege', 'custom']),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  message: z.string(),
  pattern: z.string(),
  flags: z.string().default('i'),
  /** Regex applied to the file path; omitted = all text files. */
  files: z.string().optional(),
});
export type Rule = z.infer<typeof ruleSchema>;

const SCRIPTS = '\\.(sh|bash|zsh|py|js|mjs|cjs|ts|ps1|rb|pl|php|bat|cmd)$|(^|/)[^./]+$';
const DOCS = '\\.(md|mdx|txt)$';

/** Built-in rule pack. Admins can append rules (YAML) from Admin → Security. */
export const DEFAULT_RULES: Rule[] = [
  // Remote code execution
  { id: 'exec.curl_pipe_shell', category: 'exec', severity: 'high', message: 'Downloads and pipes remote content into a shell', pattern: String.raw`(curl|wget|iwr|Invoke-WebRequest)[^\n|]*\|\s*(sudo\s+)?(ba|z|)sh\b|\b(bash|sh)\s+<\(\s*(curl|wget)`, flags: 'i' },
  { id: 'exec.eval_remote', category: 'exec', severity: 'high', message: 'Evaluates code fetched at runtime', pattern: String.raw`(eval|exec)\s*\(\s*(requests\.get|urllib|fetch|http\.get|urlopen)`, flags: 'i' },
  { id: 'exec.iex', category: 'exec', severity: 'high', message: 'PowerShell Invoke-Expression of downloaded content', pattern: String.raw`(iex|Invoke-Expression)\s*\(?\s*(\(?New-Object\s+Net\.WebClient|iwr|Invoke-WebRequest|irm)`, flags: 'i' },
  { id: 'exec.reverse_shell', category: 'exec', severity: 'critical', message: 'Reverse shell pattern', pattern: String.raw`(/dev/tcp/\d|nc(at)?\s+(-e|-c)\s|bash\s+-i\s+>&|socket\.socket\([^)]*\)[\s\S]{0,200}(subprocess|pty\.spawn|os\.dup2))`, flags: 'i' },
  { id: 'exec.sudo', category: 'privilege', severity: 'medium', message: 'Requests elevated privileges (sudo)', pattern: String.raw`(^|[\s;&|])sudo\s+\S`, flags: 'im' },
  { id: 'exec.chmod_world', category: 'privilege', severity: 'medium', message: 'World-writable permissions', pattern: String.raw`chmod\s+(-R\s+)?(777|a\+w|o\+w)`, flags: 'i' },
  // Destructive
  { id: 'destructive.rm_root', category: 'destructive', severity: 'critical', message: 'Recursive delete of root or home directory', pattern: String.raw`rm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(--no-preserve-root\s+)?(/|~|\$HOME|/\*)(\s|$|")`, flags: 'i' },
  { id: 'destructive.disk', category: 'destructive', severity: 'critical', message: 'Raw disk write / format', pattern: String.raw`(mkfs\.|dd\s+if=[^\n]*of=/dev/(sd|nvme|disk)|format\s+[a-z]:)`, flags: 'i' },
  { id: 'destructive.git_force', category: 'destructive', severity: 'medium', message: 'Force-push or hard reset can destroy work', pattern: String.raw`git\s+(push\s+[^\n]*--force(?!-with-lease)|push\s+-f\b|reset\s+--hard\s+origin|clean\s+-[a-z]*f[a-z]*d)`, flags: 'i' },
  // Credentials & exfiltration
  { id: 'creds.sensitive_paths', category: 'credentials', severity: 'high', message: 'Accesses credential stores', pattern: String.raw`(~|\$HOME|%USERPROFILE%)?/?\.(ssh/(id_|authorized_keys)|aws/credentials|azure/|kube/config|docker/config\.json|npmrc|pypirc|netrc|gnupg)|Library/Keychains|login\.keychain`, flags: 'i' },
  { id: 'creds.env_dump', category: 'credentials', severity: 'medium', message: 'Dumps the whole environment (may leak secrets)', pattern: String.raw`(\bprintenv\b(?!\s+\w)|\benv\s*(\||>)|os\.environ\b(?!\s*\[|\.get)|process\.env\b(?!\s*\.|\s*\[))`, flags: 'i' },
  { id: 'exfil.post_secrets', category: 'exfiltration', severity: 'high', message: 'Sends environment or credential data to a remote endpoint', pattern: String.raw`(curl|wget|fetch|requests\.post|http\.post|axios\.post)[^\n]{0,200}(\$\{?[A-Z_]*(TOKEN|SECRET|KEY|PASSWORD)|os\.environ|process\.env|\.ssh|credentials)`, flags: 'i' },
  { id: 'exfil.webhook_sites', category: 'exfiltration', severity: 'high', message: 'Known request-capture / paste endpoints', pattern: String.raw`(webhook\.site|requestbin|pipedream\.net|ngrok\.(io|app)|pastebin\.com|transfer\.sh|interact\.sh|burpcollaborator|oast\.)`, flags: 'i' },
  { id: 'network.raw_ip', category: 'network', severity: 'low', message: 'Hard-coded IP address endpoint', pattern: String.raw`https?://(\d{1,3}\.){3}\d{1,3}`, flags: 'i' },
  // Obfuscation
  { id: 'obfuscation.base64_exec', category: 'obfuscation', severity: 'high', message: 'Decodes and executes encoded payload', pattern: String.raw`(base64\s+(-d|--decode)[^\n]*\|\s*(ba)?sh|eval\s*\(\s*(atob|Buffer\.from)\(|exec\s*\(\s*(base64\.b64decode|codecs\.decode)|FromBase64String[^\n]*(iex|Invoke-Expression))`, flags: 'i' },
  { id: 'obfuscation.long_blob', category: 'obfuscation', severity: 'medium', message: 'Long encoded blob (possible hidden payload)', pattern: String.raw`[A-Za-z0-9+/]{400,}={0,2}`, flags: '' },
  { id: 'obfuscation.hex_escape', category: 'obfuscation', severity: 'medium', message: 'Heavy hex/unicode escaping', pattern: String.raw`(\\x[0-9a-f]{2}){24,}`, flags: 'i', files: SCRIPTS },
  // Persistence
  { id: 'persistence.cron', category: 'persistence', severity: 'high', message: 'Installs scheduled tasks', pattern: String.raw`(crontab\s+-|/etc/cron|schtasks\s+/create|launchctl\s+load|systemctl\s+enable)`, flags: 'i' },
  { id: 'persistence.shell_rc', category: 'persistence', severity: 'high', message: 'Modifies shell startup files', pattern: String.raw`>>?\s*(~|\$HOME)/\.(bashrc|zshrc|profile|bash_profile|zprofile)`, flags: 'i' },
  { id: 'persistence.agent_config', category: 'persistence', severity: 'high', message: 'Modifies agent configuration or hooks', pattern: String.raw`(\.claude/settings(\.local)?\.json|\.cursor/(rules|mcp\.json)|\.codex/config|CLAUDE\.md|AGENTS\.md)[^\n]{0,80}(>>|write|append|>)`, flags: 'i' },
  // Prompt injection in instructions
  { id: 'prompt.ignore_instructions', category: 'prompt-injection', severity: 'high', message: 'Attempts to override prior instructions', pattern: String.raw`(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier|system)\s+(instructions|prompts|rules|messages)`, flags: 'i', files: DOCS },
  { id: 'prompt.hide_from_user', category: 'prompt-injection', severity: 'high', message: 'Asks the agent to hide actions from the user', pattern: String.raw`(do\s+not|don't|never)\s+(tell|inform|mention|show|reveal)\s+(this\s+)?(to\s+)?(the\s+)?user`, flags: 'i', files: DOCS },
  { id: 'prompt.bypass_safety', category: 'prompt-injection', severity: 'high', message: 'Instructs to bypass permissions or safety checks', pattern: String.raw`(--dangerously-skip-permissions|bypass\s+(the\s+)?(safety|security|permission)|disable\s+(the\s+)?(sandbox|safety|guardrails)|yolo\s+mode)`, flags: 'i' },
  { id: 'prompt.html_comment', category: 'prompt-injection', severity: 'medium', message: 'Hidden HTML comment containing instructions', pattern: String.raw`<!--(?![\s\S]{0,10}(prettier|markdownlint|toc|TODO))[\s\S]{0,400}?\b(you must|always|never|ignore|execute|run)\b[\s\S]{0,400}?-->`, flags: 'i', files: DOCS },
  { id: 'prompt.auto_approve', category: 'prompt-injection', severity: 'medium', message: 'Asks the agent to auto-approve or not ask for confirmation', pattern: String.raw`(without\s+(asking|confirmation|prompting)\s+(the\s+)?user|auto[- ]?approve|don't\s+ask\s+for\s+(permission|confirmation))`, flags: 'i', files: DOCS },
];

export function loadRulePack(yaml: string): Rule[] {
  const data = parseYaml(yaml) as unknown;
  const list = Array.isArray(data) ? data : ((data as { rules?: unknown[] })?.rules ?? []);
  return z.array(ruleSchema).parse(list);
}
