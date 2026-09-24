/**
 * `@dsh-study/ingest` 公共出口。
 *
 * 契约（类型 + `detectFormat` + `runIngestPipeline`）来自 `@dsh-study/core` 的
 * `src/ingest/types.ts`，这里只做再导出，调用方一个包就能拿全。
 */

export type {
  ImageIngestResult,
  IngestAttempt,
  IngestResult,
  IngestTier,
  ParserCapability,
  SourceFormat,
  SourceParser,
} from '../../core/src/ingest/types.ts'
export { INGEST_TIER_LABEL, detectFormat, runIngestPipeline } from '../../core/src/ingest/types.ts'

export * from './image.ts'
export * from './office.ts'
export * from './pdf.ts'
export * from './registry.ts'
export * from './text.ts'
