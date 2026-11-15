'use client';

import { useState } from 'react';

/**
 * The install command with a copy button.
 *
 * Copy feedback is a label swap rather than a toast: the confirmation belongs
 * on the control the reader just pressed. The timer that clears it is set in the
 * click handler, which is where the behaviour is caused, not in an effect.
 */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be denied or unavailable. The command is visible
      // and selectable either way, so there is nothing to recover from.
      setCopied(false);
    }
  }

  return (
    <div className="copycmd">
      <code className="copycmd-text">
        <span className="sa-term-prompt" aria-hidden="true">
          ${' '}
        </span>
        {command}
      </code>
      <button type="button" className="copycmd-btn" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
        <span className="sa-sr">{copied ? '' : ` install command: ${command}`}</span>
      </button>
    </div>
  );
}
