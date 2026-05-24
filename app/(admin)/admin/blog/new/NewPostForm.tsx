'use client'
import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SlugInput } from '@/components/inline-edit/SlugInput'
import { useToast } from '@/components/inline-edit/Toast'

import { SLUG_RE } from '@/lib/cms/slug'

export function NewPostForm() {
  const router = useRouter()
  const toast = useToast()
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (title.trim().length === 0) {
      toast.error('Please add a title.')
      return
    }
    if (!SLUG_RE.test(slug)) {
      toast.error('The web address can only use lowercase letters, numbers, and single hyphens — no spaces.')
      return
    }
    if (slug.length < 2 || slug.length > 140) {
      toast.error('The web address must be between 2 and 140 characters.')
      return
    }
    setBusy(true)
    try {
      const res = await csrfFetch('/api/cms/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, title }),
      })
      if (res.status === 409) {
        toast.error('That web address is already in use by another post. Try a different one.')
        return
      }
      if (!res.ok) {
        toast.error("We couldn't create that draft. Try again in a moment.")
        return
      }
      const { id } = (await res.json()) as { id: number }
      toast.success('Draft created.')
      router.push(`/admin/blog/${id}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <label className="block">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
          Title
        </span>
        <Input
          className="mt-1.5"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={220}
          placeholder="A short, compelling headline"
        />
        <p className="mt-1 text-[11px] text-warm-stone">
          We&rsquo;ll suggest a web address from the title until you change it yourself.
        </p>
      </label>

      <div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
          Web address
        </span>
        <div className="mt-1.5">
          <SlugInput
            value={slug}
            onChange={setSlug}
            source={title}
            baseUrl="bestworldproperties.com/blog/"
          />
        </div>
      </div>

      <div className="flex gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create draft'}
        </Button>
      </div>
    </form>
  )
}
