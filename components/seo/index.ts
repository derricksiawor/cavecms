// Shared SEO admin kit. Import surfaces for the SEO settings pages so
// every page composes from the same copper/cream primitives.
//
// Components are client components (they carry 'use client'); the barrel
// itself is import-only and safe to re-export from a server page so long
// as the page renders them inside a client boundary or as leaves of a
// server tree (Next allows server → client component composition).

export { SeoCard } from './SeoCard'
export {
  PageSeoPanel,
  type PageSeoPanelProps,
  type PanelSeoMeta,
  type AnalysisContent,
} from './PageSeoPanel'
export { VariableInserter } from './VariableInserter'
export { TemplatePreview, sampleContext } from './TemplatePreview'
export { CopyField } from './CopyField'
export { EngineToggle } from './EngineToggle'
export { EngineLogo } from './EngineLogo'
export { SetupGuide, SetupGuideSteps, type GuideStep } from './SetupGuide'
export { EngineExplainer } from './EngineExplainer'
export {
  INDEXNOW_ENGINES,
  VERIFY_ENGINES,
  type EngineMeta,
} from './engines'
