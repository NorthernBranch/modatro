import { useDeferredValue, useMemo, useRef } from 'react';
import { luaDiagnostics } from '../shared/creator-lua';

// Highlight plain text as React nodes. No HTML injection and no Lua execution.
function highlighted(source: string) {
  const tokens = source.split(
    /(--\[\[[\s\S]*?\]\]|--[^\n]*|\[\[[\s\S]*?\]\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:and|break|do|else|elseif|end|false|for|function|if|in|local|nil|not|or|repeat|return|then|true|until|while)\b|\b\d+(?:\.\d+)?\b)/g,
  );
  return tokens.map((token, i) => (
    <span
      key={i}
      className={
        token.startsWith('--')
          ? 'lua-comment'
          : /^["'[]/.test(token)
            ? 'lua-string'
            : /^\d/.test(token)
              ? 'lua-number'
              : /^(and|break|do|else|elseif|end|false|for|function|if|in|local|nil|not|or|repeat|return|then|true|until|while)$/.test(
                    token,
                  )
                ? 'lua-keyword'
                : undefined
      }
    >
      {token}
    </span>
  ));
}
export function LuaEditor({
  source,
  onChange,
  readOnly,
}: {
  source: string;
  onChange: (source: string) => void;
  readOnly: boolean;
}) {
  const code = useDeferredValue(source);
  const errors = useMemo(() => luaDiagnostics(code), [code]);
  const backdrop = useRef<HTMLPreElement>(null);
  return (
    <div className="creator-code">
      <div className="creator-code-heading">
        <strong>main.lua</strong>
        <span>{readOnly ? 'Generated · read only' : 'Custom Lua · LuaJIT syntax'}</span>
      </div>
      <div className="lua-editor">
        <pre ref={backdrop} aria-hidden="true">
          <code>
            {highlighted(source)}
            {'\n'}
          </code>
        </pre>
        <textarea
          aria-label="main.lua source"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={source}
          readOnly={readOnly}
          maxLength={128 * 1024}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => {
            if (backdrop.current) {
              backdrop.current.scrollTop = e.currentTarget.scrollTop;
              backdrop.current.scrollLeft = e.currentTarget.scrollLeft;
            }
          }}
        />
      </div>
      <div className="creator-diagnostics" aria-live="polite">
        {errors.length ? (
          errors.map((error, i) => (
            <p key={i}>
              {error.file}:{error.line}:{error.column} · {error.message}
            </p>
          ))
        ) : (
          <p>Validation passed · syntax only. This code has not been run or tested in-game.</p>
        )}
      </div>
    </div>
  );
}
