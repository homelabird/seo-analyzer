/**
 * What changed between two audits.
 *
 * Per rule, not per score: a site where one thing broke and another was fixed
 * has an unchanged score and two things worth knowing about.
 */

import { Link, useParams } from 'react-router-dom';
import { getReads } from '../lib/api-client.js';
import { useAsync } from '../lib/hooks.js';
import { PageError } from '../components/PageError.js';
import { formatDate, getScoreColor } from '../lib/format.js';
import type { RuleChange } from '../../electron/shared/ipc-types.js';

export function ComparePage() {
  const { id = '', against } = useParams();
  const reads = getReads();
  const comparison = useAsync(() => reads.compare(id, against), [id, against]);

  if (comparison.serverGone) return <PageError kind="server-gone" onRetry={comparison.reload} />;
  if (comparison.stale) return <PageError kind="stale-session" />;
  if (comparison.error) {
    // The first audit of a site has nothing to compare against. That is not a
    // failure, so it does not get a failure's heading.
    const nothingYet = comparison.error.includes('previous');
    return (
      <PageError
        kind="not-found"
        title={nothingYet ? 'Nothing to compare yet' : undefined}
        message={
          nothingYet
            ? 'This is the only audit of this site so far. Run it again after a change and the difference will show up here.'
            : comparison.error
        }
      />
    );
  }
  if (!comparison.data) {
    return (
      <div className="max-w-[var(--content-max-width)] mx-auto p-6 text-sm" style={{ color: 'var(--color-text-muted)' }}>
        Comparing…
      </div>
    );
  }

  const { current, previous, scoreDelta, categoryDeltas, engineChanged, rules } = comparison.data;
  const moved = categoryDeltas.filter((delta) => delta.delta !== 0);

  return (
    <div className="max-w-[var(--content-max-width)] mx-auto p-6 space-y-6">
      <nav className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
        <Link to={`/audits/${current.auditId}`} className="hover:underline">
          ← back to the audit
        </Link>
      </nav>

      <section
        className="p-6 rounded-xl border"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-bg-elevated)' }}
      >
        <h1 className="text-xl font-semibold mb-1" style={{ color: 'var(--color-text)' }}>
          {current.domain}
        </h1>
        <div className="flex items-baseline gap-3 mb-2">
          <span className="text-3xl font-semibold tabular-nums" style={{ color: getScoreColor(previous.overallScore) }}>
            {previous.overallScore}
          </span>
          <span style={{ color: 'var(--color-text-muted)' }}>→</span>
          <span className="text-3xl font-semibold tabular-nums" style={{ color: getScoreColor(current.overallScore) }}>
            {current.overallScore}
          </span>
          <Delta value={scoreDelta} />
        </div>
        <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          {formatDate(previous.startedAt)} → {formatDate(current.startedAt)}
        </p>

        {engineChanged && (
          <p
            className="mt-3 text-sm px-3 py-2 rounded-lg"
            style={{ backgroundColor: 'var(--color-warn-bg)', color: 'var(--color-warn)' }}
            role="note"
          >
            These audits ran on different engine versions ({previous.engineVersion} → {current.engineVersion}).
            Some of what changed may be rule updates rather than the site.
          </p>
        )}
      </section>

      {moved.length > 0 && (
        <section
          className="p-5 rounded-xl border"
          style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-bg-elevated)' }}
        >
          <h2 className="text-base font-semibold mb-3" style={{ color: 'var(--color-text)' }}>
            Categories that moved
          </h2>
          <ul className="space-y-1">
            {moved
              .slice()
              .sort((a, b) => a.delta - b.delta)
              .map((delta) => (
                <li key={delta.categoryId} className="flex items-center justify-between text-sm py-1">
                  <span style={{ color: 'var(--color-text)' }}>{delta.categoryName}</span>
                  <span className="tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>
                    {delta.previousScore} → {delta.currentScore} <Delta value={delta.delta} />
                  </span>
                </li>
              ))}
          </ul>
        </section>
      )}

      <RuleChangeList title="Regressed" tone="fail" changes={rules.regressed} />
      <RuleChangeList title="Improved" tone="pass" changes={rules.improved} />
      <RuleChangeList title="New in this audit" tone="muted" changes={rules.added} />
      <RuleChangeList title="No longer measured" tone="muted" changes={rules.removed} />
      <RuleChangeList title="Measured URL coverage changed" tone="muted" changes={rules.coverageChanges ?? []} />

      {rules.regressed.length === 0 &&
        rules.improved.length === 0 &&
        rules.added.length === 0 &&
        rules.removed.length === 0 && (rules.coverageChanges?.length ?? 0) === 0 && (
          <p className="text-sm text-center py-6" style={{ color: 'var(--color-text-muted)' }}>
            No rule changed status between these two audits.
          </p>
        )}
    </div>
  );
}

function Delta({ value }: { value: number }) {
  if (value === 0) return <span style={{ color: 'var(--color-text-muted)' }}>no change</span>;
  const up = value > 0;
  return (
    <span style={{ color: up ? 'var(--color-pass)' : 'var(--color-fail)' }}>
      {up ? '▲' : '▼'} {Math.abs(value)}
    </span>
  );
}

function RuleChangeList({
  title,
  tone,
  changes,
}: {
  title: string;
  tone: 'pass' | 'fail' | 'muted';
  changes: RuleChange[];
}) {
  if (changes.length === 0) return null;

  const color =
    tone === 'pass' ? 'var(--color-pass)' : tone === 'fail' ? 'var(--color-fail)' : 'var(--color-text-secondary)';

  return (
    <section
      className="p-5 rounded-xl border"
      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-bg-elevated)' }}
    >
      <h2 className="text-base font-semibold mb-3" style={{ color }}>
        {title} ({changes.length})
      </h2>
      <ul className="space-y-2">
        {changes.map((change) => (
          <li key={change.ruleId} className="text-sm">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-medium" style={{ color: 'var(--color-text)' }}>
                {change.ruleName}
              </span>
              <code className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {change.ruleId}
              </code>
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {change.from ?? '—'} → {change.to ?? '—'}
                {change.totalPages > 1 && ` · ${change.previousAffectedPages ?? '?'} → ${change.affectedPages} affected · ${change.previousMeasuredPages ?? '?'} → ${change.measuredPages ?? change.totalPages} measured`}
              </span>
            </div>
            {change.coverageChanged && <p className="text-xs">Measured URL coverage changed; only shared measured URLs prove fixes or regressions.</p>}
            {!!((change.regressedPageCount ?? 0) + (change.improvedPageCount ?? 0)) && (
              <details className="text-xs mt-1">
                <summary>{change.regressedPageCount ?? 0} worsened · {change.improvedPageCount ?? 0} improved ({change.newIssuePageCount ?? 0} newly affected · {change.resolvedIssuePageCount ?? 0} resolved)</summary>
                {(change.regressedPages ?? []).map((url) => <p key={`new:${url}`}>Worsened: {url}</p>)}
                {(change.improvedPages ?? []).map((url) => <p key={`resolved:${url}`}>Improved: {url}</p>)}
                {((change.regressedPageCount ?? 0) > (change.regressedPages?.length ?? 0) || (change.improvedPageCount ?? 0) > (change.improvedPages?.length ?? 0)) && <p>Showing up to 50 URLs per change type.</p>}
              </details>
            )}
            {change.message && (
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                {change.message}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
