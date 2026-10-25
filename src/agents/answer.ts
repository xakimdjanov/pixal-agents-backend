// Builds an answer strictly from the server's project-status snapshot. Never invents data.
export function describeStatus(s: any, now = Date.now(), staleAfterMs = 24 * 3_600_000): { text: string; stale: boolean } {
  if (!s || !s.project) return { text: 'No project status data is available, so I cannot answer this. Please check the task board.', stale: true };
  const updated = s.updated_at ? new Date(s.updated_at).getTime() : null;
  const stale = updated === null || now - updated > staleAfterMs;
  const lines: string[] = [];
  if (updated === null) lines.push(`Project "${s.project.name}" has no recorded task activity yet; there is no data to report.`);
  else lines.push(`Project "${s.project.name}" — data last updated ${s.updated_at}${stale ? ' (STALE: older than the freshness window, treat as possibly outdated)' : ''}.`);
  const fmt = (t: any) => `${t.title} [${t.status}]`;
  lines.push(`Active tasks (${s.active_tasks.length}): ${s.active_tasks.map(fmt).join('; ') || 'none'}.`);
  lines.push(`Recently completed (${s.completed_tasks.length}): ${s.completed_tasks.map((t: any) => t.title).join('; ') || 'none'}.`);
  lines.push(`Blockers (${s.blockers.length}): ${s.blockers.map((b: any) => `${b.title}${b.note ? ` — ${b.note}` : ''}`).join('; ') || 'none recorded'}.`);
  const t = s.latest_test_results[0];
  lines.push(t ? `Latest test results (task "${t.title}", ${t.created_at}): ${typeof t.test_results === 'string' ? t.test_results : JSON.stringify(t.test_results)}.` : 'Latest test results: none recorded.');
  return { text: lines.join('\n'), stale };
}

const DEEP_RE = /\b(git|commits?|branch(es)?|diff|pull requests?|prs?|merge[sd]?|changed|changes|repo(sitory)?|source|code|files?|jira|tickets?|issues?|github|backlog|sprint|epic)\b/i;

// Plain status questions are answered from the server's project snapshot; anything about code,
// repos or external tools (or naming one of the project's extra repos) needs the repo/connector path.
export function needsDeepAnswer(question: string, repoNames: string[] = []): boolean {
  const q = question.toLowerCase();
  return DEEP_RE.test(question) || repoNames.some((n) => q.includes(n.toLowerCase()));
}
