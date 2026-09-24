/**
 * `@dsh-study/ingest` 公共出口。
 *
 * 契约（类型 + `detectFormat` + `runIngestPipeline`）来自 `@dsh-study/core` 的
 * `src/ingest/types.ts`，这里只做再导出，调用方一个包就能拿全。
 */

             
                    
                
               
             
                   
               
               
                                       
export { INGEST_TIER_LABEL, detectFormat, runIngestPipeline } from '../core/ingest/types.js'

export * from './image.js'
export * from './office.js'
export * from './pdf.js'
export * from './registry.js'
export * from './text.js'
