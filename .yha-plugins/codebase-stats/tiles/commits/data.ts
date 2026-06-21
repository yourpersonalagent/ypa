// Recent-commits loader for the codebase-stats plugin.
//
// Runs `git log` against the active CWD and returns the last 10 commits
// with the shape the `list` widget's itemTemplate expects.

interface ExecResult { stdout: string; stderr: string; code: number; }
interface Ctx {
  cwd: string;
  exec: (cmd: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;
}

export default async function load(ctx: Ctx) {
  const { stdout, code } = await ctx.exec([
    'git', '-C', ctx.cwd,
    'log', '-n', '10',
    // Tab-separated for unambiguous parsing — commit subjects can contain
    // anything except newlines.
    "--pretty=format:%h\t%s\t%an\t%cr",
  ]);
  if (code !== 0) return { commits: [], error: 'git log failed' };
  const commits = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [shortHash, subject, author, relDate] = line.split('\t');
      return { shortHash, subject, author, relDate };
    });
  return { commits };
}
