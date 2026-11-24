/**
 * 询问用户冒烟测试：验证 QuestionBroker 的挂起/作答/中止，以及 ask_user_question
 * 的参数校验、卡片推导与工具结果。
 *
 * 与 test:image / test:mcp 同样的理由：项目没有前端测试运行器，
 * 用 rolldown 把不依赖 Electron 的主进程模块打成 CJS 后直接跑（见 package.json 的 test:question）。
 */

import { QuestionBroker, normalizeAnswers } from '../src/main/ai/questions/broker'
import { createAskUserTool, toQuestions } from '../src/main/ai/tools/ask'
import type { ToolContext } from '../src/main/ai/tools/registry'
import type { AiQuestion } from '../src/shared/ai/types'

/** 断言失败即退出，避免后续断言给出误导性的连锁错误 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`✗ ${message}`)
    process.exit(1)
  }
  console.log(`✓ ${message}`)
}

/** 取 Promise 的拒绝消息；没有拒绝时返回空串 */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const QUESTIONS: AiQuestion[] = [
  {
    id: 'mode',
    question: '采用哪种实现方式？',
    options: [{ label: '快速修复（推荐）' }, { label: '完整重构' }]
  },
  {
    id: 'checks',
    question: '完成后要跑哪些检查？',
    options: [{ label: '单元测试' }, { label: '类型检查' }],
    multiSelect: true
  }
]

async function main(): Promise<void> {
  const broker = new QuestionBroker()

  // 1) 挂起 → 作答 → 工具拿到答案
  const controller = new AbortController()
  const pending = broker.ask({
    sessionId: 'session-a',
    callId: 'call-1',
    questions: QUESTIONS,
    signal: controller.signal
  })
  assert(broker.size === 1, '提问后进入挂起状态')
  broker.answer('session-a', 'call-1', [
    { id: 'mode', selected: ['快速修复（推荐）'] },
    { id: 'checks', selected: ['单元测试'], custom: ' 另外跑一次冒烟测试 ' }
  ])
  const answers = await pending
  assert(answers.length === 2, '回答按问题数量返回')
  assert(answers[0]?.selected[0] === '快速修复（推荐）', '单选答案原样回传')
  assert(answers[1]?.custom === '另外跑一次冒烟测试', '自由输入去掉首尾空白后保留')
  assert(broker.size === 0, '作答后挂起状态清除')

  // 2) 非法答案被拒绝，问题继续等待
  const waiting = broker.ask({
    sessionId: 'session-a',
    callId: 'call-2',
    questions: QUESTIONS,
    signal: new AbortController().signal
  })
  let invalid = ''
  try {
    broker.answer('session-a', 'call-2', [
      { id: 'mode', selected: ['不存在的选项'] },
      { id: 'checks', selected: [] }
    ])
  } catch (error) {
    invalid = error instanceof Error ? error.message : String(error)
  }
  assert(invalid.includes('选项'), '选项不在模型给出的范围里时拒绝作答')
  assert(broker.size === 1, '非法答案不会结束挂起')
  broker.answer('session-a', 'call-2', [
    { id: 'mode', selected: [], custom: '你决定' },
    { id: 'checks', selected: ['类型检查'] }
  ])
  const second = await waiting
  assert(
    second[0]?.selected.length === 0 && second[0]?.custom === '你决定',
    '只输入自由文本也算作答'
  )

  // 3) 没有答案、重复 id、额外问题都被拒绝
  const badBatches: unknown[] = [
    [],
    [{ id: 'mode', selected: ['快速修复（推荐）'] }],
    [
      { id: 'mode', selected: ['快速修复（推荐）'] },
      { id: 'mode', selected: ['完整重构'] }
    ],
    [
      { id: 'mode', selected: [] },
      { id: 'checks', selected: [] }
    ]
  ]
  for (const batch of badBatches) {
    let rejected = false
    try {
      normalizeAnswers(QUESTIONS, batch)
    } catch {
      rejected = true
    }
    assert(rejected, `非法答案批次被拒绝：${JSON.stringify(batch).slice(0, 40)}`)
  }

  // 4) 中止：挂起的询问以“中止”收尾
  const abortController = new AbortController()
  const aborted = broker.ask({
    sessionId: 'session-a',
    callId: 'call-3',
    questions: QUESTIONS,
    signal: abortController.signal
  })
  abortController.abort()
  assert((await rejection(aborted)).includes('中止'), '中止后询问立即结束')
  assert(broker.size === 0, '中止后不留下挂起条目')

  // 5) 会话结束：兜底收尾
  const closing = broker.ask({
    sessionId: 'session-b',
    callId: 'call-4',
    questions: QUESTIONS,
    signal: new AbortController().signal
  })
  assert(broker.pendingCallIds('session-b').includes('call-4'), '挂起的调用 id 可按会话列出')
  broker.closeSession('session-b')
  assert((await rejection(closing)).includes('结束'), '会话结束后未回答的问题一并收尾')
  assert(broker.pendingCallIds('session-b').length === 0, '收尾后不再列出挂起调用')

  // 6) 工具：参数校验、执行与卡片
  const tool = createAskUserTool()
  const args = {
    questions: [
      {
        id: 'target',
        question: '部署到哪个环境？',
        header: '确认',
        options: [{ label: '预发（推荐）', description: '先验证再上线' }, { label: '生产' }]
      }
    ]
  }
  const ctx = {
    sessionId: 'session-c',
    callId: 'call-5',
    signal: new AbortController().signal,
    questions: broker
  } as unknown as ToolContext
  const callCard = tool.presentCall?.(args)
  assert(
    callCard?.kind === 'question' &&
      callCard.questions?.length === 1 &&
      callCard.title === '部署到哪个环境？',
    '挂起卡片带上问题与标题'
  )
  assert(tool.presentCall?.({ questions: [] }) === undefined, '非法参数不生成询问卡片')
  const run = tool.execute(args, ctx)
  broker.answer('session-c', 'call-5', [{ id: 'target', selected: ['预发（推荐）'] }])
  const outcome = await run
  const payload = JSON.parse(outcome.text) as { answers?: { selected?: string[] }[] }
  assert(payload.answers?.[0]?.selected?.[0] === '预发（推荐）', '工具结果按 JSON 回灌答案')
  const resultCard = tool.presentResult?.(args, outcome)
  assert(
    resultCard?.kind === 'question' && resultCard.answers?.[0]?.selected?.[0] === '预发（推荐）',
    '完成卡片带上用户答案'
  )

  // 7) 模型参数校验：重复 id 与非数组直接失败
  let duplicate = false
  try {
    toQuestions([
      { id: 'same', question: '第一个问题' },
      { id: 'same', question: '第二个问题' }
    ])
  } catch {
    duplicate = true
  }
  assert(duplicate, '重复的问题 id 被拒绝')
  let empty = false
  try {
    await tool.execute({ questions: [] }, ctx)
  } catch {
    empty = true
  }
  assert(empty, '空问题列表被拒绝，不会进入等待')

  console.log('全部询问用户冒烟测试通过')
}

void main()
