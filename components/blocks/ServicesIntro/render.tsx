import clsx from 'clsx'
interface ServicesIntroData { title: string; body_richtext: string; items: Array<{ icon?: string; title: string; body: string }> }
export function ServicesIntro({
  data,
  outerClass,
}: {
  data: ServicesIntroData
  outerClass?: string
}) {
  return (
    <section className={clsx('py-12 sm:py-16 px-4 sm:px-6 max-w-5xl mx-auto', outerClass)}>
      <h2 className="text-3xl font-semibold tracking-tight mb-4">{data.title}</h2>
      {/* server-sanitized via parseForRead */}
      <div className="prose mb-8" dangerouslySetInnerHTML={{ __html: data.body_richtext }} />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {data.items.map((it, i) => (
          <div key={i}>
            <h3 className="font-medium">{it.title}</h3>
            <p className="text-sm text-warm-stone mt-1">{it.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
