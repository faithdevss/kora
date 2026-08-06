/**
 * A tool-permission request from the agent.
 *
 * The approve button says exactly what approving covers, because that varies by
 * agent: some can gate a single call, others (Claude Code among them) can only
 * widen permissions for the whole session. The label comes from the scope the
 * adapter reported, so the UI never promises a narrower grant than the agent can
 * actually deliver.
 */

import { useState } from 'react';

import type { PermissionDecision, PermissionScope, PermLine as PermLineType } from '../../types/agent';

interface Props {
  line: PermLineType;
  onAnswer: (requestId: string, decision: PermissionDecision) => void;
}

const APPROVE_LABEL: Record<PermissionScope, string> = {
  once: 'approve this call',
  session_edits: 'allow file edits for this session',
  session_all: 'allow all tools for this session',
};

const APPROVE_NOTE: Record<PermissionScope, string> = {
  once: 'Applies to this call only.',
  session_edits: 'The agent will not ask again before editing files in this session.',
  session_all:
    'This agent cannot grant one tool at a time — approving lifts every tool prompt, including file edits, for the rest of this session. Respawn the session to get prompts back.',
};

/** The broadest grant asks twice, because one click cannot be taken back. */
const NEEDS_CONFIRM: PermissionScope[] = ['session_all'];

const ANSWERED: Record<PermissionDecision, string> = {
  allow: 'approved',
  deny: 'denied',
};

export function PermLine({ line, onAnswer }: Props) {
  const [confirming, setConfirming] = useState(false);
  const needsConfirm = NEEDS_CONFIRM.includes(line.scope);

  return (
    <div className="k-perm">
      <div className="k-perm-row">
        <span aria-hidden="true">⚠</span>
        <span className="k-perm-text">
          <span>
            <span className="k-perm-tool">{line.tool}</span> needs your permission
          </span>
          {line.detail ? <span className="k-perm-detail">{line.detail}</span> : null}
        </span>
      </div>

      {line.resolved ? (
        <div className="k-perm-answered">
          {line.resolved === 'allow' ? '✓' : '✗'} {ANSWERED[line.resolved]}
        </div>
      ) : (
        <>
          <div className="k-perm-actions">
            {needsConfirm && !confirming ? (
              <button type="button" className="k-chip" onClick={() => setConfirming(true)}>
                {APPROVE_LABEL[line.scope]}…
              </button>
            ) : (
              <button
                type="button"
                className="k-chip"
                onClick={() => onAnswer(line.requestId, 'allow')}
              >
                {confirming ? 'yes — lift tool prompts for this session' : APPROVE_LABEL[line.scope]}
              </button>
            )}
            <button
              type="button"
              className="k-chip k-chip-deny"
              onClick={() => (confirming ? setConfirming(false) : onAnswer(line.requestId, 'deny'))}
            >
              {confirming ? 'cancel' : 'deny'}
            </button>
          </div>
          <div className="k-perm-note">{APPROVE_NOTE[line.scope]}</div>
        </>
      )}
    </div>
  );
}
