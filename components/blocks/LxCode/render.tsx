import clsx from 'clsx'
import type { BlockData } from '@/lib/cms/block-registry'
import { CopyButton } from './CopyButton'

// Code block (Elementor: Code Highlight). SYNCHRONOUS by design: the
// editor canvas renders blocks in a CLIENT tree, where an async
// component throws "async Client Component" + an uncached-promise
// suspend. So this renders an HTML-ESCAPED <pre> on a dark surface —
// identical on server, client editor, and SSR, with no async, no
// client JS, and no syntax-highlighter dependency to trace into the
// standalone build. `code` is escaped here (it is deliberately NOT in
// parse.ts RICHTEXT_FIELDS); escaping is the sole, sufficient XSS
// boundary for a text code block. `language` is a bounded enum, shown
// as a small label. (Token coloring could be added later via a lazy
// client highlighter — intentionally omitted to keep this robust.)

// Lightweight, SYNC, dependency-free line coloring. Not a full tokenizer —
// it colors terminal/shell OUTPUT + diffs by line prefix (prompt, success,
// arrow, error, comment), which is what install-command / log snippets need
// and matches the way real product sites style their hero terminal cards.
function lineToneClass(line: string, language: string): string {
  const t = line.trimStart()
  if (language === 'diff') {
    if (t.startsWith('+')) return 'text-emerald-400'
    if (t.startsWith('-')) return 'text-red-400'
    if (t.startsWith('@')) return 'text-sky-400'
    return ''
  }
  if (t.startsWith('✓') || t.startsWith('✔')) return 'text-emerald-400'
  if (t.startsWith('→') || t.startsWith('➜')) return 'text-sky-400'
  if (t.startsWith('✗') || t.startsWith('✖') || t.startsWith('✕')) return 'text-red-400'
  if (t.startsWith('#') || t.startsWith('//')) return 'text-warm-stone/45'
  if (t.startsWith('$') || t.startsWith('❯') || t.startsWith('>')) return 'text-ivory'
  return ''
}

const LANG_LABEL: Record<BlockData<'lx_code'>['language'], string> = {
  text: 'Text', ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX',
  json: 'JSON', html: 'HTML', css: 'CSS', bash: 'Bash', python: 'Python',
  go: 'Go', rust: 'Rust', sql: 'SQL', yaml: 'YAML', markdown: 'Markdown',
  php: 'PHP', java: 'Java', ruby: 'Ruby', c: 'C', cpp: 'C++', diff: 'Diff',
}

export function LxCode({
  data,
  outerClass,
}: {
  data: BlockData<'lx_code'>
  outerClass?: string
}) {
  const lines = data.code.replace(/\n$/, '').split('\n')
  const gutterWidth = String(lines.length).length

  return (
    <div
      className={clsx(
        'mx-auto w-full max-w-4xl overflow-hidden rounded-2xl bg-[#121212] ring-1 ring-warm-stone/15',
        outerClass,
      )}
    >
      <div className="flex items-center justify-between border-b border-warm-stone/15 px-5 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-warm-stone/30" aria-hidden="true" />
          {data.filename && (
            <span className="font-mono text-xs text-warm-stone">{data.filename}</span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <span className="font-sans text-[10px] font-semibold uppercase tracking-eyebrow text-champagne">
            {LANG_LABEL[data.language]}
          </span>
          {data.copyable !== false && <CopyButton text={data.code} />}
        </div>
      </div>
      <pre className="overflow-x-auto px-5 py-4 text-sm leading-relaxed text-[#dbd7ca]">
        <code className="font-mono">
          {lines.map((line, i) => (
            <span key={i} className={clsx('block', lineToneClass(line, data.language))}>
              {data.showLineNumbers && (
                <span
                  aria-hidden="true"
                  className="mr-5 inline-block select-none text-right text-warm-stone/40"
                  style={{ width: `${gutterWidth}ch` }}
                >
                  {i + 1}
                </span>
              )}
              {line === '' ? ' ' : line}
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}
