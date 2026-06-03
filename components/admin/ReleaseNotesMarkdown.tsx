'use client'

import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Shared renderer for release-note markdown (the `## x.y.z … ### New … **bold**
// … - lists` notes published in the update manifest). Both the dashboard
// "Update available" card and the Settings → Updates page run their notes
// through this so the operator sees rendered copy, never raw `##`/`**`/`-`.
//
// The version-line heading (`## x.y.z`) is stripped upstream into the card
// title, so the body here starts at the lead paragraph — its top-level
// headings are the `### New —` section titles.
const COMPONENTS: Components = {
  h1: ({ children }) => (
    <h3 className="mt-6 text-base font-bold tracking-tight text-near-black first:mt-0">
      {children}
    </h3>
  ),
  h2: ({ children }) => (
    <h3 className="mt-6 text-base font-bold tracking-tight text-near-black first:mt-0">
      {children}
    </h3>
  ),
  h3: ({ children }) => (
    <h4 className="mt-5 text-sm font-semibold tracking-tight text-near-black first:mt-0">
      {children}
    </h4>
  ),
  p: ({ children }) => (
    <p className="mt-2.5 text-sm leading-relaxed text-near-black first:mt-0">
      {children}
    </p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-near-black">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-copper-700">{children}</em>,
  ul: ({ children }) => (
    <ul className="mt-2.5 list-disc space-y-1.5 pl-5 marker:text-copper-400">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mt-2.5 list-decimal space-y-1.5 pl-5 marker:text-copper-400">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="text-sm leading-relaxed text-near-black [&>p]:mt-0">
      {children}
    </li>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-copper-700 underline underline-offset-2 hover:text-copper-800"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-warm-stone/20" />,
  code: ({ children }) => (
    <code className="rounded bg-warm-stone/15 px-1 py-0.5 font-mono text-[0.85em] text-near-black">
      {children}
    </code>
  ),
}

export function ReleaseNotesMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {children}
    </ReactMarkdown>
  )
}
