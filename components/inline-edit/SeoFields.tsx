'use client'
import { Input } from '@/components/ui/Input'
import clsx from 'clsx'

// SEO title + description editor with live character counters and a
// Google-style snippet preview. Replaces two plain Input fields so
// editors can see exactly what shows up in search results before
// publishing.
export function SeoFields({
  title,
  description,
  onTitleChange,
  onDescriptionChange,
  placeholderTitle = 'Your page title',
  placeholderDescription = 'Your meta description',
  url,
  titleMax = 60,
  descriptionMax = 160,
  hardTitleMax = 180,
  hardDescriptionMax = 320,
}: {
  title: string
  description: string
  onTitleChange: (v: string) => void
  onDescriptionChange: (v: string) => void
  placeholderTitle?: string
  placeholderDescription?: string
  url?: string
  // Soft caps drive the colour cue: green under, copper near, red over.
  titleMax?: number
  descriptionMax?: number
  // Hard caps enforce server validation length.
  hardTitleMax?: number
  hardDescriptionMax?: number
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <label className="block">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-near-black">SEO title</span>
            <CharCount value={title.length} max={titleMax} hardMax={hardTitleMax} />
          </div>
          <Input
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder={placeholderTitle}
            maxLength={hardTitleMax}
          />
        </label>
        <label className="block">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-near-black">SEO description</span>
            <CharCount value={description.length} max={descriptionMax} hardMax={hardDescriptionMax} />
          </div>
          <Input
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder={placeholderDescription}
            maxLength={hardDescriptionMax}
          />
        </label>
      </div>
      <GoogleSnippetPreview
        title={title || placeholderTitle}
        description={description || placeholderDescription}
        url={url}
      />
    </div>
  )
}

function CharCount({
  value,
  max,
  hardMax,
}: {
  value: number
  max: number
  hardMax: number
}) {
  const near = value > max * 0.9
  const over = value > max
  const danger = value > hardMax * 0.95
  return (
    <span
      className={clsx(
        'text-[10px] font-medium tabular-nums tracking-wider',
        danger ? 'text-red-600' : over ? 'text-copper-700' : near ? 'text-copper-600' : 'text-warm-stone',
      )}
    >
      {value}/{max}
    </span>
  )
}

function GoogleSnippetPreview({
  title,
  description,
  url,
}: {
  title: string
  description: string
  url?: string
}) {
  return (
    <div className="rounded-2xl border border-warm-stone/20 bg-white p-5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-warm-stone">
        Search preview
      </p>
      <div className="mt-3 max-w-xl">
        {url && (
          <p className="text-xs text-near-black/80 truncate">{url}</p>
        )}
        <p className="mt-1 truncate text-lg font-medium leading-tight text-[#1a0dab] hover:underline cursor-default">
          {title}
        </p>
        <p className="mt-1 line-clamp-2 text-sm text-near-black/70">
          {description}
        </p>
      </div>
    </div>
  )
}
