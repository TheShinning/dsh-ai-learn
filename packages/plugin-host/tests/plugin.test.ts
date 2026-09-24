import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 接线验证：真跑 `apply()` 与工具执行链。
 *
 * 这层测试补的是最贵的一课 —— 原系统有整棵未挂载的 UI 树、只有定义没有调用者的函数、
 * 以及"写完了但没人接线"的模块。这里用假 ctx 把宿主插件真的启动一遍，
 * 再把"导入 → 进度 → 证据 → 建卡 → 复习"这条链真跑一遍，
 * 断言每一步都落到存储上，而不是只看函数返回值。
 *
 * ## 依赖主机 peer
 *
 * `plugin-host` 依赖 `@deepseek-ai/dsh-tools` / `schemastery` / `zod` 等，
 * 它们由 DSH 主机提供。本仓库里通过 `scripts/dev-link.ps1` 建的 junction 解析到它们。
 * 没有这个 junction 时，本文件**整体跳过**并说明原因 —— 不伪装成通过。
 */

let toolsModule: typeof import('../src/tools.ts') | undefined
let storeModule: typeof import('../src/store.ts') | undefined
let promptModule: typeof import('../src/prompt.ts') | undefined
let indexModule: typeof import('../src/index.ts') | undefined
let skipReason: string | undefined

try {
  toolsModule = await import('../src/tools.ts')
  storeModule = await import('../src/store.ts')
  promptModule = await import('../src/prompt.ts')
  indexModule = await import('../src/index.ts')
} catch (error) {
  skipReason = error instanceof Error ? error.message : String(error)
}

const SAMPLE = [
  '# 实践论',
  '',
  '## 第一节 认识与实践的关系',
  '',
  '认识来源于实践，又反过来指导实践。',
  '',
  '### 一、实践是认识的来源',
  '',
  '离开实践的认识是无源之水。',
  '',
  '## 第二节 认识的辩证发展',
  '',
  '认识经过感性到理性的飞跃。',
  '',
  '## 第三节 真理的标准',
  '',
  '真理的标准只能是社会实践。',
  '',
].join('\n')

test('接线验证（需要 dev-link 建的 peer junction）', { skip: skipReason ? `主机 peer 未解析：${skipReason}` : false }, async (t) => {
  const { createStudyTools } = toolsModule!
  const { createMemoryStore } = storeModule!
  const { apply } = indexModule!
  const { STUDY_PROMPT_SECTION, STUDY_CONTEXT_SECTION, teachingStateSnapshot } = promptModule!

  await t.test('apply() 注册了 11 个工具、系统提示两节、以及 /study 与 /socratic 命令', () => {
    const registered: { name: string }[] = []
    const sections: { name: string; order: number }[] = []
    const contexts: { name: string; order: number }[] = []
    const commands: { name: string }[] = []
    const logs: string[] = []

    const fakeCtx = {
      effect: (fn: () => unknown) => {
        fn()
        return () => {}
      },
      get: () => undefined, // 让插件走内存存储分支
      logger: () => ({ info: (...args: unknown[]) => logs.push(args.join(' ')), warn: () => {}, error: () => {} }),
      tools: { register: (definition: { name: string }) => { registered.push(definition); return () => {} } },
      systemPrompt: {
        section: (section: { name: string; order: number }) => { sections.push(section); return () => {} },
        context: (context: { name: string; order: number }) => { contexts.push(context); return () => {} },
      },
      commands: { register: (command: { name: string }) => { commands.push(command); return () => {} } },
    }

    apply(fakeCtx as never, { protocol: true, command: true, domainVersion: 1 })

    assert.equal(registered.length, 11, `应注册 11 个工具，实际 ${registered.map((item) => item.name).join(', ')}`)
    assert.deepEqual(
      registered.map((item) => item.name).sort(),
      [
        'study_create_card',
        'study_formats',
        'study_import_textbook',
        'study_progress',
        'study_rebuild_structure',
        'study_record_evidence',
        'study_retract_evidence',
        'study_review_queue',
        'study_steps',
        'study_submit_review',
        'study_wrap_up',
      ].sort(),
    )
    assert.equal(sections.length, 1)
    assert.equal(sections[0]!.name, STUDY_PROMPT_SECTION)
    assert.equal(contexts.length, 1, '易变状态必须走 context，不能进 section')
    assert.equal(contexts[0]!.name, STUDY_CONTEXT_SECTION)
    assert.deepEqual(commands.map((item) => item.name), ['study', 'socratic'])
    assert.ok(logs.some((line) => line.includes('study_alongwith_ai')), '日志应报出数据域名')
    assert.ok(logs.some((line) => line.includes('memory')), '无 storage.domain 时应明确报出降级为内存')
  })

  await t.test('存储域：open 必须配对 close，且失败不得掀翻宿主', async () => {
    // 回归来源：真机上 profile 的 patchReload 是 live —— 保存 cordis.patch.yml 会
    // 卸载插件再挂载一次。旧 fiber 不关域、新 fiber 再 open，抛「已打开」；
    // 而当时用 `void promise.then(...)` 吞了它 → unhandled rejection →
    // `dsh: fatal load failure` → 宿主退出 1。
    const events: string[] = []
    const disposers: (() => Promise<void>)[] = []
    const table = {
      get: () => undefined,
      entries: () => [][Symbol.iterator](),
      put: async () => {},
      delete: async () => true,
    }
    const handle = {
      table: () => table,
      global: { get: () => ({ activeTextbookKey: null }), set: async () => {} },
      close: async () => {
        events.push('close')
      },
    }

    const makeCtx = (storage: unknown, logs: string[]) => ({
      effect: (fn: () => unknown) => {
        // effect 回调可能是异步的：它返回 Promise，settle 之后才拿到真正的 disposer
        const returned = fn()
        disposers.push(async () => {
          const settled = await returned
          if (typeof settled === 'function') await settled()
        })
        return () => {}
      },
      get: (service: string) => (service === 'storage' ? storage : undefined),
      logger: () => ({
        info: (...args: unknown[]) => logs.push(args.join(' ')),
        warn: (...args: unknown[]) => logs.push(args.join(' ')),
        error: () => {},
      }),
      tools: { register: () => () => {} },
      systemPrompt: { section: () => () => {}, context: () => () => {} },
      commands: { register: () => () => {} },
    })

    const logs: string[] = []
    const opening = {
      domain: {
        open: async () => {
          events.push('open')
          return handle
        },
      },
    }
    apply(makeCtx(opening, logs) as never, { protocol: false, command: false, domainVersion: 1 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(events, ['open'], '挂载时应打开一次数据域')

    for (const dispose of disposers.reverse()) await dispose()
    assert.deepEqual(events, ['open', 'close'], '卸载必须关闭数据域，否则热重载会二次 open')

    // open 失败：降级为内存并记日志，绝不抛出（宿主必须活着）
    const failureLogs: string[] = []
    const failing = {
      domain: {
        open: async () => {
          throw new Error('domain "study_alongwith_ai" is already open')
        },
      },
    }
    assert.doesNotThrow(() =>
      apply(makeCtx(failing, failureLogs) as never, { protocol: false, command: false, domainVersion: 1 }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(
      failureLogs.some((line) => line.includes('降级为内存存储')),
      `域打开失败必须记录降级日志，实际：${failureLogs.join(' | ')}`,
    )
  })

  await t.test('导入 → 进度 → 证据 → 建卡 → 复习：整条链真的落到存储上', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const exec = {} as never

    // 1. 导入
    const imported = await byName.get('study_import_textbook')!.execute!({ text: SAMPLE }, exec)
    assert.equal(imported.ok, true, JSON.stringify(imported))
    assert.equal(imported.action, 'create')
    assert.match(imported.report, /已导入教材「实践论」/)
    assert.match(imported.report, /3 章 \/ 4 节/)

    const textbook = await store.getTextbook(imported.key)
    assert.ok(textbook, '教材记录应落盘')
    assert.equal(textbook!.title, '实践论')
    assert.equal(textbook!.structureVersion, 1)
    assert.equal(await store.activeTextbookKey(), imported.key, '导入后应设为当前教材')

    const nodes = await store.nodesFor(imported.key)
    const edges = await store.edgesFor(imported.key)
    assert.equal(nodes.filter((node) => node.type === 'chapter').length, 3)
    assert.equal(nodes.filter((node) => node.type === 'section').length, 4)
    assert.equal(edges.filter((edge) => edge.relation === 'prerequisite').length, 1, '只有第一节内部有相邻小节')
    assert.ok(nodes.some((node) => node.type === 'page'), '应生成页节点')

    // 2. 进度：能推荐出可推进的学习单元
    const progress = await byName.get('study_progress')!.execute!({}, exec)
    assert.ok(progress.next.length > 0, '应给出下一处推荐')
    assert.match(progress.report, /候选路线/)
    assert.match(progress.report, /统计（每项带来源标注）/)
    assert.equal(progress.probe_depth, 0)

    // 3. 证据：单条正向证据只到半掌握
    const sectionNode = nodes.find((node) => node.type === 'section')!
    const first = await byName.get('study_record_evidence')!.execute!(
      { node_id: sectionNode.id, kind: 'answer-quality', summary: '用户复述了实践与认识的关系', result: 'light', bloom_level: 'understand' },
      exec,
    )
    assert.equal(first.mastery, 'partial')
    assert.equal(first.positive_kinds, 1, 'answer-quality + result=light 是一条正向证据，但单条不足以点亮')

    // 第二条不同 kind 的正向证据 → 点亮
    const second = await byName.get('study_record_evidence')!.execute!(
      { node_id: sectionNode.id, kind: 'flashcard', summary: '闪卡答对', correct: true, source_id: 'card-1' },
      exec,
    )
    assert.equal(second.mastery, 'mastered', '两种正向证据应点亮')
    assert.equal(second.positive_kinds, 2)

    // 4. 建卡：口诀卡没有选项，但必须可练习
    const card = await byName.get('study_create_card')!.execute!(
      { kind: 'mnemonic', prompt: '如何记住实践与认识的关系？', answer: '实践出真知，认识反哺实践。', knowledge_point: '实践与认识', node_id: sectionNode.id },
      exec,
    )
    assert.equal(card.practicable, true, '口诀卡必须可练习（原系统在这里断链）')

    // 5. 复习队列与提交
    const queue = await byName.get('study_review_queue')!.execute!({}, exec)
    assert.equal(queue.due, 1)
    assert.match(queue.report, /记忆口诀/)

    const reviewed = await byName.get('study_submit_review')!.execute!({ card_id: card.card_id, self_report: 'good' }, exec)
    assert.equal(reviewed.result, 'good')
    assert.ok(reviewed.next_review_at.length > 0, '应排下次复习时间')
    assert.equal(reviewed.interval_days, 1)

    const afterReview = await store.cardsFor()
    assert.equal(afterReview[0]!.srs.practiceCount, 1, '复习计数应落盘')

    // 复习证据也写回了节点
    const evidence = await store.evidenceFor(imported.key)
    assert.ok(evidence.some((item) => item.kind === 'srs-review'), '复习应产出 srs-review 证据')

    // 6. 修订：同一来源再次导入是修订，身份不变、结构版本递增
    const revised = await byName.get('study_import_textbook')!.execute!(
      { text: `${SAMPLE}\n补充一段。\n` },
      exec,
    )
    assert.equal(revised.action, 'revise')
    assert.equal(revised.key, imported.key, '教材身份必须保持不变')
    const after = await store.getTextbook(imported.key)
    assert.equal(after!.structureVersion, 2, '重建结构应递增版本')
    assert.ok((await store.evidenceFor(imported.key)).length > 0, '修订后既有证据必须保留')
  })

  await t.test('explicit_id 把身份钉在稳定名字上（不传则按来源推导）', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const exec = {} as never
    const pinned = await byName.get('study_import_textbook')!.execute!({ text: SAMPLE, explicit_id: 'shijianlun' }, exec)
    assert.equal(pinned.key, 'book:shijianlun', '显式身份优先于来源推导')

    // 同一显式身份、正文变化 → 修订（身份不变）
    const again = await byName.get('study_import_textbook')!.execute!(
      { text: `${SAMPLE}\n又补一段。\n`, explicit_id: 'shijianlun' },
      exec,
    )
    assert.equal(again.action, 'revise')
    assert.equal(again.key, 'book:shijianlun')

    // 不传 explicit_id 时按来源推导，得到的是另一个身份 → 视为新建而非误当修订
    const derived = await byName.get('study_import_textbook')!.execute!({ text: SAMPLE }, exec)
    assert.notEqual(derived.key, pinned.key)
    assert.equal(derived.action, 'create')
  })

  await t.test('图片不能当教材：如实拒绝并给出替代做法', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const exec = {} as never
    const result = await byName.get('study_import_textbook')!.execute!({ path: 'lesson.pdf' }, exec).catch((error: Error) => ({
      ok: false,
      key: '',
      action: 'threw',
      report: error.message,
    }))
    // 文件不存在 → 管线给出失败轨迹与建议，而不是抛栈
    assert.equal(result.ok, false)
    assert.match(result.report, /解析|失败|不存在|ENOENT/)
  })

  await t.test('study_steps：按材料类型给不同的追问重点与降阶阶梯（不是同一套话术）', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const exec = {} as never

    // 同一段正文，用显式材料类型区分：条例 vs 真题
    const regulation = await byName.get('study_import_textbook')!.execute!(
      { title: '某条例', text: SAMPLE, explicit_id: 'reg-demo', material_type: 'regulation' },
      exec,
    )
    const regMove = await byName.get('study_steps')!.execute!({ textbook_key: regulation.key }, exec)
    assert.match(regMove.report, /条文驱动/)
    assert.match(regMove.report, /适用条件/)
    assert.match(regMove.report, /例外/)

    const exam = await byName.get('study_import_textbook')!.execute!(
      { title: '某真题', text: SAMPLE, explicit_id: 'exam-demo', material_type: 'exam' },
      exec,
    )
    const examMove = await byName.get('study_steps')!.execute!({ textbook_key: exam.key }, exec)
    assert.match(examMove.report, /刷题驱动/)
    assert.match(examMove.report, /先.*说.*答案|先让学生自答/)
    assert.match(examMove.report, /题眼/)

    assert.notEqual(regMove.report, examMove.report, '两种材料的追问重点必须真的不同')
    // 跨模式底线不受材料类型影响
    for (const move of [regMove, examMove]) {
      assert.equal(move.question_budget, 1, '一次只问一个问题')
      assert.equal(move.may_reveal_answer, false, '第一轮都不允许给答案')
    }
  })

  await t.test('study_steps：快照带材料形态与教学模式，供 context 节每轮读取', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const exec = {} as never
    await byName.get('study_import_textbook')!.execute!(
      { title: '某条例', text: SAMPLE, explicit_id: 'snapshot-demo', material_type: 'regulation' },
      exec,
    )
    await byName.get('study_steps')!.execute!({}, exec)
    assert.equal(teachingStateSnapshot.current.teachingMode, 'clause-driven')
    assert.equal(teachingStateSnapshot.current.scenario, 'regulation', '材料情景此前从来没有生产者')
    assert.equal(teachingStateSnapshot.current.step, 'diagnose')
  })

  await t.test('study_wrap_up：生成课堂记录并落库，缺口带下一步，报告如实说明是否写入工作区', async () => {
    const store = createMemoryStore()
    // 不传 ctx：走"记录入库但不写文件"的分支（saved=false）——生产里传了 ctx 才会写 Markdown
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const exec = {} as never
    await byName.get('study_import_textbook')!.execute!({ text: SAMPLE }, exec)
    const focusId = (await byName.get('study_steps')!.execute!({}, exec)).focus_node_id

    // 制造一个真实缺口：答错（困惑未澄清），并走一次环节留痕
    await byName.get('study_record_evidence')!.execute!(
      { node_id: focusId, kind: 'answer-quality', summary: '答错一次', source_id: 'wrap-1', result: 'clarify', correct: false },
      exec,
    )

    const result = await byName.get('study_wrap_up')!.execute!({ note: '学生说这一节有点绕' }, exec)
    assert.ok(result.session_id, '应生成记录 id')
    assert.ok(result.gaps >= 1, `应有缺口（实际 ${result.gaps}）`)
    assert.equal(result.saved, false, '没有 ctx 时不得谎报"已写入"')
    assert.equal(result.record_path, '', '未写入时路径为空')
    assert.match(result.report, /课堂记录已生成/)
    assert.match(result.report, /未能写入工作区/)
    assert.match(result.report, /概念混淆未澄清|还不完善的点/)
    assert.match(result.report, /下一步：/)

    // 真的落进存储了（而不只是返回一段文本）
    const key = (await store.activeTextbookKey())!
    const sessions = await store.sessionsFor(key)
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]!.id, result.session_id)
    assert.ok(sessions[0]!.gaps.length >= 1)
    assert.ok(sessions[0]!.evidenceIds.length >= 1, '记录里应引用本节证据 id')
    assert.equal(typeof sessions[0]!.recordPath, 'string')
    assert.ok(sessions[0]!.steps.length >= 1, '记录里应有环节留痕')

    // 最新一条可被读回（进度/命令用）
    const latest = await store.latestSession(key)
    assert.equal(latest!.id, result.session_id)
  })

  await t.test('study_wrap_up：记录是快照 —— 生成后再写证据不改写它', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const exec = {} as never
    await byName.get('study_import_textbook')!.execute!({ text: SAMPLE }, exec)
    const focusId = (await byName.get('study_steps')!.execute!({}, exec)).focus_node_id
    const first = await byName.get('study_wrap_up')!.execute!({}, exec)

    // 之后再写证据：新记录会有新 id，但旧记录内容不变
    await byName.get('study_record_evidence')!.execute!(
      { node_id: focusId, kind: 'answer-quality', summary: '收束之后的作答', source_id: 'after-1', correct: true },
      exec,
    )
    const key = (await store.activeTextbookKey())!
    const sessions = await store.sessionsFor(key)
    const snapshot = sessions.find((record) => record.id === first.session_id)!
    assert.equal(snapshot.evidenceIds.length, 0, '旧记录的证据引用不因后来的证据而增长')
    assert.equal(snapshot.answered, 0)

    const second = await byName.get('study_wrap_up')!.execute!({}, exec)
    assert.notEqual(second.session_id, first.session_id, '第二次收束生成新记录，而不是改写旧的')
    assert.equal((await store.sessionsFor(key)).length, 2)
  })

  await t.test('study_wrap_up：没有教材时明确报错，而不是生成一份空记录', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const failure = await byName.get('study_wrap_up')!.execute!({}, {} as never).then(
      () => undefined,
      (error: unknown) => error as Error,
    )
    assert.ok(failure, '应拒绝执行')
    assert.match(failure.message, /先导入一份材料/)
  })

  await t.test('teachingStateSnapshot：进度工具会把状态写进同步快照', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const exec = {} as never
    await byName.get('study_import_textbook')!.execute!({ text: SAMPLE }, exec)
    await byName.get('study_progress')!.execute!({}, exec)
    assert.ok(teachingStateSnapshot.current.knowledgePoint, '快照应记录当前知识点')
    assert.equal(teachingStateSnapshot.current.probeState?.probeDepth, 0)
  })

  // —— S2 接线验证：新增工具必须真的接到 core 的纯函数上（不是"注册了但没调用"）
  await t.test('study_steps 零起点：无教材时给出"先锁定材料"，不抛错、不返回空对象', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const exec = {} as never
    const result = await byName.get('study_steps')!.execute!({}, exec)
    assert.equal(result.action, 'import-material')
    assert.equal(result.may_reveal_answer, false)
    assert.equal(result.question_budget, 1)
    assert.match(result.report, /锁定/)
  })

  await t.test('study_steps：导入后走焦点 + 步骤机，且默认不写证据', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const exec = {} as never
    await byName.get('study_import_textbook')!.execute!({ text: SAMPLE }, exec)

    const before = (await store.evidenceFor((await store.activeTextbookKey())!)).length
    const first = await byName.get('study_steps')!.execute!({ last_answer: '我觉得认识来自实践' }, exec)
    assert.equal(first.step, 'diagnose')
    assert.equal(first.action, 'ask')
    assert.equal(first.may_reveal_answer, false, '第一轮绝不允许给答案')
    assert.equal(first.must_retell, false)
    assert.ok(first.focus_node_id, '应选中一个焦点节点')
    assert.ok(first.focus_title)
    assert.match(first.report, /焦点：/)
    assert.match(first.report, /一次只问一个问题/)

    const after = (await store.evidenceFor((await store.activeTextbookKey())!)).length
    assert.equal(after, before, 'record 默认 false：只编排，不落证据')

    // 显式记账时才写证据
    const recorded = await byName.get('study_steps')!.execute!(
      { last_answer: '因为实践是来源', answer_kind: 'answer', correct: true, record: true, source_id: 's2-1' },
      exec,
    )
    assert.ok(recorded.recorded_evidence_id, '传 record=true 必须真的写入证据')
    const finalCount = (await store.evidenceFor((await store.activeTextbookKey())!)).length
    assert.equal(finalCount, before + 1)
  })

  await t.test('study_steps：答错两次后进入降阶，深度到 3 才允许直讲（回归"先问后讲"）', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const exec = {} as never
    await byName.get('study_import_textbook')!.execute!({ text: SAMPLE }, exec)
    const focusId = (await byName.get('study_steps')!.execute!({}, exec)).focus_node_id

    // 用真实证据路径写入三次"答错"（走 study_record_evidence，掌握度由纯函数重算）
    for (const index of [1, 2, 3]) {
      await byName.get('study_record_evidence')!.execute!(
        {
          node_id: focusId,
          kind: 'answer-quality',
          summary: `第 ${index} 次答错`,
          source_id: `probe-${index}`,
          result: 'clarify',
          correct: false,
        },
        exec,
      )
    }
    const move = await byName.get('study_steps')!.execute!({ node_id: focusId }, exec)
    assert.equal(move.action, 'explain-then-retell', '连续三次困惑后必须直讲，而不是继续追问')
    assert.equal(move.may_reveal_answer, true)
    assert.equal(move.must_retell, true, '直讲之后必须先复述')

    const first = await byName.get('study_steps')!.execute!({}, exec)
    assert.match(first.focus_reason, /confused/, '困惑点必须成为焦点')
  })

  await t.test('study_formats：把 ingest 的能力清单接到生产上（本机实测缺什么要如实说）', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const exec = {} as never
    const result = await byName.get('study_formats')!.execute!({}, exec)
    assert.ok(result.available > 0, '至少要有原生/内置解析器可用')
    assert.match(result.report, /本机可用的输入格式/)
    assert.match(result.report, /明确不支持：pptx/)
    assert.match(result.report, /图片/)
    // 本机 tesseract 未安装 → 必须如实出现在"缺失"清单里（换了机器也不会假绿：只断言"缺失项被列出"）
    if (result.unavailable > 0) assert.match(result.report, /本机缺失的解析器/)
  })

  await t.test('导入即分类：材料类型写进 sourceFormat 复合值，旧值仍可读', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const exec = {} as never

    const regulation = await byName.get('study_import_textbook')!.execute!(
      {
        title: '建设工程质量管理条例',
        text: '# 建设工程质量管理条例\n\n第一条 为了加强管理，制定本条例。\n\n第二条 建设单位应当将工程发包给有资质的单位。\n\n第三条 本条例自公布之日起施行。\n',
      },
      exec,
    )
    const record = await store.getTextbook(regulation.key)
    assert.ok(record?.sourceFormat.includes('|regulation|'), `应写入复合 sourceFormat，实际 ${record?.sourceFormat}`)
    assert.match(regulation.report, /材料类型：/)

    // 显式指定优先
    const explicit = await byName.get('study_import_textbook')!.execute!(
      { title: '某材料', text: SAMPLE, explicit_id: 'explicit-demo', material_type: 'exam' },
      exec,
    )
    const explicitRecord = await store.getTextbook(explicit.key)
    assert.match(explicitRecord!.sourceFormat, /\|exam\|explicit$/)
  })

  await t.test('study_progress：复习口径以证据行为准，且追加字段不破坏既有字段', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const exec = {} as never
    await byName.get('study_import_textbook')!.execute!({ text: SAMPLE }, exec)
    const key = (await store.activeTextbookKey())!
    const focusId = (await byName.get('study_steps')!.execute!({}, exec)).focus_node_id

    // 建卡 → 提交复习（会写 srs-review 证据行）
    const card = await byName.get('study_create_card')!.execute!(
      { kind: 'short-answer', prompt: '实践与认识的关系是什么？', answer: '实践是认识的来源', node_id: focusId },
      exec,
    )
    await byName.get('study_submit_review')!.execute!({ card_id: card.card_id, self_report: 'good' }, exec)

    const progress = await byName.get('study_progress')!.execute!({}, exec)
    // 既有五个字段一个不少（向后兼容）
    for (const field of ['textbook_key', 'next', 'reason', 'probe_depth', 'report'] as const) {
      assert.ok(field in progress, `旧字段 ${field} 不能丢`)
    }
    assert.ok(progress.review_days >= 1, `复习天数必须非零（实际 ${progress.review_days}）——这是 F1 死接线的回归`)
    assert.ok(['diagnose', 'probe', 'scaffold', 'explain-and-retell', 'quiz', 'wrapup'].includes(progress.step))
    assert.ok(['import-material', 'ask', 'narrow', 'give-example', 'offer-binary', 'explain-then-retell', 'retell-again', 'quiz', 'review', 'advance'].includes(progress.next_action))
    assert.ok(progress.teaching_mode.length > 0)
    assert.ok((await store.evidenceFor(key)).some((item) => item.kind === 'srs-review'), '提交复习应写入 srs-review 证据')
  })
})

/**
 * C4 回归：`setActiveTextbook` 必须写**完整** global。
 *
 * 这是独立核验发现、并由探针实测确认为真的 bug：
 * - domain 的 `global.set(value)` **写入时不校验**（`dsh-storage-domain/lib/index.js:162-172`）；
 * - 校验发生在**重新 open** 时：`global.schema.parse(snapshot.global)`（`:383`）；
 * - 而 `STUDY_DOMAIN.global.schema` 要求 `activeTextbookKey` 与 `schemaNote` **都在**。
 *
 * 旧写法 `domain.global.set({ activeTextbookKey: key })` 于是把持久态写成半截对象：
 * 本次运行一切正常，**下次启动打不开数据域**（DomainError('invalid-record')），
 * 而设置活动教材就发生在"第一次成功导入教材"之后 —— 即每个正常用户都会踩到。
 *
 * 这个测试用真实 `defineDomain` + 真实 facility + 内存介质跑"写 → close → 重新 open"，
 * 因此它保护的是**往返**，而不是某一行代码的写法。
 */
test('C4 回归：设置活动教材后重新打开数据域，global 必须能通过 schema 往返', async (t) => {
  let domainModule: typeof import('@deepseek-ai/dsh-storage-domain') | undefined
  let zodModule: { default?: unknown } | undefined
  let skip: string | undefined
  try {
    domainModule = (await import('@deepseek-ai/dsh-storage-domain')) as typeof import('@deepseek-ai/dsh-storage-domain')
    zodModule = (await import('zod')) as { default?: unknown }
  } catch (error) {
    skip = error instanceof Error ? error.message : String(error)
  }
  if (skip) {
    t.diagnostic(`跳过：主机 peer 未解析（${skip}）`)
    return
  }

  const { STUDY_DOMAIN } = await import('../src/storage.ts')
  const { createDomainStore } = await import('../src/store.ts')
  const domainApi = domainModule as unknown as { DomainFacility: new (ctx: unknown, config: unknown) => { open(spec: unknown): Promise<DomainLike> } }
  const z = (zodModule as { default?: unknown }).default as { object(shape: unknown): unknown } | undefined
  assert.ok(z && typeof z.object === 'function', 'zod 应可用（peer 由 DSH 提供）')

  type DomainLike = {
    global: { get(): { activeTextbookKey: string | null; schemaNote: string | null }; set(value: unknown): Promise<void> }
    table(name: string): { get(key: string): unknown; put(key: string, value: unknown): Promise<void> }
    close(): Promise<void>
  }

  // 内存介质：跨 open 保留，模拟落盘
  const medium: { version: number; global: unknown; tables: Record<string, Record<string, unknown>> } = {
    version: STUDY_DOMAIN.version,
    global: null,
    tables: {},
  }
  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  const unit = {
    async loadAll() {
      return { version: medium.version, global: medium.global, tables: clone(medium.tables) }
    },
    async setGlobal(value: unknown) {
      medium.global = clone(value)
    },
    async putRecord(table: string, key: string, value: unknown) {
      medium.tables[table] ??= {}
      medium.tables[table]![key] = clone(value)
    },
    async deleteRecord(table: string, key: string) {
      if (medium.tables[table]) delete medium.tables[table]![key]
    },
    async close() {},
  }

  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const ctx = {
    logger: Object.assign(() => logger, logger),
    emit() {},
    storage: { backend: { get: () => ({ kv: { open: async () => unit } }) } },
  }
  const facility = new domainApi.DomainFacility(ctx, { backend: 'json' })

  const first = (await facility.open(STUDY_DOMAIN)) as DomainLike
  // 用**真实**的 domain store（生产实现），而不是在测试里重写一遍写法
  const store = createDomainStore(first as never)
  await store.putTextbook({
    key: 'book:x',
    title: '实践论',
    sourceRef: 'pasted-text',
    sourceFormat: 'markdown',
    revision: 'r1',
    structureVersion: 1,
    parseStatus: 'ready',
    parseError: null,
    createdAt: '2026-09-23T10:00:00.000Z',
    updatedAt: '2026-09-23T10:00:00.000Z',
  })
  await store.setActiveTextbook('book:x')
  assert.equal(await store.activeTextbookKey(), 'book:x', '本进程内立即可读')
  await first.close()

  // 重新 open：真实校验在这里发生
  const second = (await facility.open(STUDY_DOMAIN)) as DomainLike
  const reopened = createDomainStore(second as never)
  assert.equal(await reopened.activeTextbookKey(), 'book:x', '活动教材必须跨 open 往返')
  await second.close()

  // 反证：旧的半截写法确实会让重新 open 失败（证明这个回归测试有效）
  medium.global = { activeTextbookKey: 'book:x' }
  const failure = await facility.open(STUDY_DOMAIN).then(
    () => undefined,
    (error: unknown) => error as { code?: string; message?: string },
  )
  assert.ok(failure, '只写 activeTextbookKey 的持久态必须打不开 —— 这是本回归要挡住的形态')
  assert.match(
    `${failure.code ?? ''} ${failure.message ?? ''}`,
    /invalid-record|global/,
    `拒写原因应指向 global 校验，实际：${failure.code} ${failure.message}`,
  )
})
