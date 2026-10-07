import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Suggestion } from '../types'

const suggestions = atom({ plugin: 'next-steps', key: 'suggestions' } as const, [] as Suggestion[])
// What the person last asked, so the suggestions follow from it.
const lastPrompt = atom({ plugin: 'next-steps', key: 'lastPrompt' } as const, '')
// True while the suggestions for the last reply are being written.
const loading = atom({ plugin: 'next-steps', key: 'loading' } as const, false)
// Which suggestions are ticked, by index; Send sends them together.
const selected = atom({ plugin: 'next-steps', key: 'selected' } as const, [] as number[])
// Claude's last answer, kept so Send can write the prompt with full context.
const lastAnswer = atom({ plugin: 'next-steps', key: 'lastAnswer' } as const, '')
// True while Send is writing the prompt.
const composing = atom({ plugin: 'next-steps', key: 'composing' } as const, false)

// ---------- locale ----------

type Dict = Record<string, string>

// Every string the mod shows or writes into a prompt: the built-in English, overridden key
// by key by locales/<lang>.json beside this module. A tag is tried whole, then its first
// subtag ('zh-CN' then 'zh'); {name} placeholders are filled by the t() the hooks get.
const EN: Dict = {
  'hint.working': 'Next steps appear when Claude finishes',
  'hint.loading': 'Finding next steps…',
  'hint.empty': 'No next steps yet',
  'send.composing': 'Writing prompt…',
  'send.one': 'Send',
  'send.n': 'Send {n}',
  'send.clear': 'Clear',
  'send.selected': '{picked} of {total} selected',
  'send.hint': 'Tick one or more, then Send',
  'send.fallback': 'Please do the following, in this order:',
  'suggest.system':
    'You suggest what a user might ask a coding assistant to do next. Reply with only a JSON ' +
    'array of up to {max} objects, each {"label": string}. "label" is the button text: imperative, ' +
    'at most 5 words and under 30 characters, specific to this conversation. Make the suggestions ' +
    'distinct from each other. If nothing useful follows, reply [].',
  'suggest.prompt': 'User asked:\n{asked}\n\nAssistant replied:\n{answer}\n\nNext steps (JSON array):',
  'compose.system':
    "You write the next message a user sends to an AI coding assistant. You are given the user's " +
    "last request, the assistant's last answer, and one or more next steps the user picked. Write " +
    'that message as the user, in the first person, ready to send. For each step: say exactly what ' +
    'to do, name the specific files, functions, commands, URLs or values from the conversation it ' +
    'involves, give any constraints or context the assistant needs, and say what done looks like. ' +
    'With several steps, number them in the order given and say to finish each before the next. ' +
    'Be concrete and concise: no greetings, no filler, no restating the whole conversation. ' +
    'Output only the message.',
  'compose.prompt':
    "User's last request:\n{asked}\n\nAssistant's last answer:\n{answer}\n\n" +
    'Next steps the user picked, in order:\n{steps}\n\nThe message:',
  'bench.description': 'Time next-steps storage and model calls',
  'bench.done': 'mod-bench done (full results in next-steps/bench.json):',
  'bench.writes': '  3 writes, one at a time: {seq}  ·  batched: {batched}',
  'bench.reads': '  4 reads, one at a time: {seq}  ·  batched: {batched}',
  'bench.cache': '  cache: {hits} hits, {calls} model calls, {entries} entries',
  'bench.models': '  Haiku labels: {labels} ms  ·  Send with Haiku: {haiku} ms  ·  Send with Sonnet: {sonnet} ms',
  'bench.sampleStep': 'Summarize what changed in this session',
}

// The language to fall back to when the environment names none this mod has a file for.
const DEFAULT_LANG = 'zh-CN'

let localeOnce: Promise<Dict> | undefined

type T = (key: string, vars?: Record<string, string | number>) => string

// The locale of this session, resolved once and kept: env picks the language, its file
// overrides English, and a language with no file (or a broken one) simply stays English.
async function locale($: EngineInterface): Promise<T> {
  localeOnce ??= load($)
  const dict = await localeOnce
  return (key, vars) => format(dict[key] ?? key, vars)
}

const format = (s: string, vars?: Record<string, string | number>): string =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k) => String(vars[k] ?? m)) : s

// 'zh_CN.UTF-8' -> 'zh-CN', the spelling of a file's name.
const tag = (s: string) => s.split(/[.@]/)[0].replace(/_/g, '-')

// The languages to try, most specific first. An explicit NEXT_STEPS_LANG decides on its
// own; LANG and LC_ALL are guesses that fall through to DEFAULT_LANG when no file matches.
async function languages($: EngineInterface): Promise<string[]> {
  const explicit = tag((await $.env.get('NEXT_STEPS_LANG')) ?? '')
  if (explicit) return [explicit]
  const guessed = [await $.env.get('LC_ALL'), await $.env.get('LANG')]
  return [...guessed.map(s => tag(s ?? '')), tag(DEFAULT_LANG)].filter(Boolean)
}

async function load($: EngineInterface): Promise<Dict> {
  let langs: string[]
  try {
    langs = await languages($)
  } catch {
    return EN // no environment to ask
  }
  for (const lang of langs) {
    for (const name of new Set([lang, lang.split('-')[0]])) {
      const dict = await readDict($, name)
      if (dict) return dict
    }
  }
  return EN
}

async function readDict($: EngineInterface, name: string): Promise<Dict | undefined> {
  if (!name) return undefined
  try {
    const text = await $.fs.read(`${$.plugin.root}/hooks/locales/${name}.json`)
    return { ...EN, ...JSON.parse(text) }
  } catch {
    return undefined // no file for this language, or not JSON: English stands
  }
}

const MAX = 6

// The model that writes the message Send submits. 'haiku' is near-instant; 'sonnet' is
// slower but more specific. Change this one line to switch.
const SEND_MODEL = 'haiku'

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) + '…' : s)
const words = (s: string, max: number) => s.split(/\s+/).slice(0, max).join(' ')

// Button labels must stay short or the band overflows: at most 30 characters, cut at
// a word boundary with an ellipsis.
const LABEL_CHARS = 30
function shortLabel(s: string): string {
  const w = s.replace(/\s+/g, ' ').trim()
  if (w.length <= LABEL_CHARS) return w
  const cut = w.slice(0, LABEL_CHARS - 1)
  const space = cut.lastIndexOf(' ')
  return (space > 12 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, '') + '…'
}

function parseList(text: string): Suggestion[] {
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) return []
  try {
    const list = JSON.parse(m[0])
    if (!Array.isArray(list)) return []
    return list
      .filter(x => x && typeof x.label === 'string' && x.label.trim() !== '')
      .map(x => {
        const label = shortLabel(x.label.trim())
        const prompt = typeof x.prompt === 'string' && x.prompt.trim() !== '' ? x.prompt.trim() : label
        return { label, prompt }
      })
      .slice(0, MAX)
  } catch {
    return []
  }
}

// ---------- cache: reuse a model reply when the exact same request repeats ----------

type CacheEntry = { text: string; at: number }

// A small LRU with expiry. The key is the whole request (model, instructions, the full
// prompt with its context, limits), so any change in context is a different key and a
// stale reply can never come back.
function makeCache(limit: number, ttlMs: number, now: () => number = () => Date.now()) {
  const entries = new Map<string, CacheEntry>()
  return {
    get(key: string): string | undefined {
      const hit = entries.get(key)
      if (!hit) return undefined
      if (now() - hit.at > ttlMs) {
        entries.delete(key)
        return undefined
      }
      entries.delete(key) // refresh its place as most recently used
      entries.set(key, hit)
      return hit.text
    },
    set(key: string, text: string) {
      entries.delete(key)
      entries.set(key, { text, at: now() })
      while (entries.size > limit) entries.delete(entries.keys().next().value as string)
    },
    get size() {
      return entries.size
    },
  }
}

type CompleteRequest = {
  model: string
  system: string
  prompt: string
  maxTokens: number
  effort: 'low'
  timeoutMs: number
}

// 40 replies, kept 30 minutes. Lives in memory: a reload starts it empty.
const replyCache = makeCache(40, 30 * 60_000)
const cacheStats = { hits: 0, modelCalls: 0 }

const cacheKey = (r: CompleteRequest) =>
  JSON.stringify([r.model, r.system, r.prompt, r.maxTokens, r.effort])

// Answers from the cache when the identical request was answered before; otherwise asks
// the model and keeps a good answer. Only answered replies are cached, never errors.
async function completeCached($: EngineInterface, req: CompleteRequest): Promise<string | undefined> {
  const key = cacheKey(req)
  const cached = replyCache.get(key)
  if (cached !== undefined) {
    cacheStats.hits++
    return cached
  }
  cacheStats.modelCalls++
  const r = await $.model.complete(req)
  if (!r.isAnswered || !r.text.trim()) return undefined
  replyCache.set(key, r.text)
  return r.text
}

async function suggest($: EngineInterface, answer: string) {
  const [asked] = await Promise.all([
    read($, lastPrompt),
    update($, lastAnswer, () => answer),
    update($, loading, () => true),
  ])
  // Labels only (the full prompt is written at Send), at low effort: a short, fast reply.
  const t = await locale($)
  const reply = await completeCached($, {
    model: 'haiku',
    system: t('suggest.system', { max: MAX }),
    prompt: t('suggest.prompt', { asked: clip(asked, 3000), answer: clip(answer, 6000) }),
    maxTokens: 350,
    effort: 'low',
    timeoutMs: 15000,
  })
  await Promise.all([
    update($, suggestions, () => (reply ? parseList(reply) : [])),
    update($, selected, () => []),
    update($, loading, () => false),
  ])
}

async function toggle($: EngineInterface, i: number) {
  await update($, selected, l => (l.includes(i) ? l.filter(x => x !== i) : [...l, i].sort((a, b) => a - b)))
}

// Sends the ticked steps as one well-written prompt, composed by SEND_MODEL with the
// conversation as context; falls back to the plain labels if that fails.
async function sendSelected($: EngineInterface) {
  const [list, ticked, busy, asked, answer] = await Promise.all([
    read($, suggestions),
    read($, selected),
    read($, composing),
    read($, lastPrompt),
    read($, lastAnswer),
  ])
  const picked = ticked.map(i => list[i]).filter(Boolean)
  if (picked.length === 0 || busy) return
  const t = await locale($)
  // Fallback if the writer fails: the labels as a plain list.
  let text =
    picked.length === 1
      ? picked[0].label
      : t('send.fallback') + '\n' + picked.map((s, i) => `${i + 1}. ${s.label}`).join('\n')
  await update($, composing, () => true)
  try {
    const steps = picked.map((s, i) => `${i + 1}. ${s.label}`).join('\n')
    const reply = await completeCached($, {
      model: SEND_MODEL,
      system: t('compose.system'),
      prompt: t('compose.prompt', { asked: clip(asked, 4000), answer: clip(answer, 10000), steps }),
      maxTokens: 900,
      effort: 'low',
      timeoutMs: 25000,
    })
    if (reply) text = reply.trim()
  } catch {
    // keep the fallback
  }
  await Promise.all([
    update($, composing, () => false),
    update($, suggestions, () => []),
    update($, selected, () => []),
  ])
  await $.prompt.submit({ text, asUser: true })
}


// ---------- /mod-bench: timing measurements, run on demand ----------

// Scratch values the storage benchmark writes, so it never touches real state.
const benchA = atom({ plugin: 'next-steps', key: 'benchA' } as const, 0)
const benchB = atom({ plugin: 'next-steps', key: 'benchB' } as const, 0)
const benchC = atom({ plugin: 'next-steps', key: 'benchC' } as const, 0)

// The module's own clock: no round-trip to the host, so short timings stay honest.
const tick = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// How long each real message waited inside this mod before going out, newest last.
const submitWaits: number[] = []

type Stat = { runs: number; min: number; median: number; mean: number; max: number }
function stat(xs: number[]): Stat {
  const a = [...xs].sort((x, y) => x - y)
  const r = (n: number) => Math.round(n * 100) / 100
  return {
    runs: a.length,
    min: r(a[0] ?? 0),
    median: r(a[Math.floor((a.length - 1) / 2)] ?? 0),
    mean: r(a.reduce((x, y) => x + y, 0) / (a.length || 1)),
    max: r(a[a.length - 1] ?? 0),
  }
}

async function timeIt(n: number, fn: () => Promise<unknown>): Promise<Stat> {
  const xs: number[] = []
  for (let i = 0; i < n; i++) {
    const t0 = tick()
    await fn()
    xs.push(tick() - t0)
  }
  return stat(xs)
}

async function runBench($: EngineInterface): Promise<string> {
  const t = await locale($)
  const N = 20
  const bump = (n: number) => n + 1
  const writesSequential = await timeIt(N, async () => {
    await update($, benchA, bump)
    await update($, benchB, bump)
    await update($, benchC, bump)
  })
  const writesBatched = await timeIt(N, () =>
    Promise.all([update($, benchA, bump), update($, benchB, bump), update($, benchC, bump)]),
  )
  const readsSequential = await timeIt(N, async () => {
    await read($, suggestions)
    await read($, selected)
    await read($, composing)
    await read($, loading)
  })
  const readsBatched = await timeIt(N, () =>
    Promise.all([read($, suggestions), read($, selected), read($, composing), read($, loading)]),
  )

  // Model calls on the current conversation: labels, then Send written by each model.
  const [asked, answer, list] = await Promise.all([read($, lastPrompt), read($, lastAnswer), read($, suggestions)])
  const labels = list.filter(x => x && typeof x === 'object' && x.label).slice(0, 2).map(x => x.label)
  const steps = (labels.length ? labels : [t('bench.sampleStep')])
    .map((l, i) => `${i + 1}. ${l}`)
    .join('\n')
  const composeInput = t('compose.prompt', { asked: clip(asked, 4000), answer: clip(answer, 10000), steps })
  const timed = async (model: string, system: string, prompt: string, maxTokens: number) => {
    const t0 = tick()
    const r = await $.model.complete({ model, system, prompt, maxTokens, effort: 'low', timeoutMs: 60000 })
    return {
      model,
      ms: Math.round(tick() - t0),
      outputTokens: r.usage.output_tokens,
      text: r.isAnswered ? r.text : `(no reply: ${r.reason})`,
    }
  }
  const labelsCall = await timed(
    'haiku',
    t('suggest.system', { max: MAX }),
    t('suggest.prompt', { asked: clip(asked, 3000), answer: clip(answer, 6000) }),
    350,
  )
  const sendHaiku = await timed('haiku', t('compose.system'), composeInput, 900)
  const sendSonnet = await timed('sonnet', t('compose.system'), composeInput, 900)

  const result = {
    measuredAt: new Date().toISOString(),
    storage: { writesSequential, writesBatched, readsSequential, readsBatched },
    realMessagesWaitedInMod: stat(submitWaits),
    cache: { entries: replyCache.size, hits: cacheStats.hits, modelCalls: cacheStats.modelCalls },
    models: { labels: labelsCall, sendHaiku, sendSonnet },
    stepsUsed: steps,
  }
  await $.fs.write(`${$.plugin.root}/bench.json`, JSON.stringify(result, null, 2))
  const ms = (x: Stat) => `${x.median} ms median`
  return [
    t('bench.done'),
    t('bench.writes', { seq: ms(writesSequential), batched: ms(writesBatched) }),
    t('bench.reads', { seq: ms(readsSequential), batched: ms(readsBatched) }),
    t('bench.cache', { hits: cacheStats.hits, calls: cacheStats.modelCalls, entries: replyCache.size }),
    t('bench.models', { labels: labelsCall.ms, haiku: sendHaiku.ms, sonnet: sendSonnet.ms }),
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'mod-bench', description: (await locale($))('bench.description') })
    return result
  })

  on('command.run', { command: 'mod-bench' }, async $ => ({ text: await runBench($) }))

  on('prompt.submit', async ($, e, next) => {
    const t0 = tick()
    // A new request makes the old suggestions stale.
    if (!e.turnId) {
      // In the background: the message goes out without waiting on these.
      void Promise.all([
        update($, lastPrompt, () => e.text),
        update($, suggestions, () => []),
        update($, selected, () => []),
      ])
    }
    submitWaits.push(tick() - t0)
    if (submitWaits.length > 50) submitWaits.shift()
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.reason === 'answer' && e.answer.trim()) {
      void suggest($, e.answer).catch(() => update($, loading, () => false))
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const inner = await next(e)
    if (e.props.hasSurvey) return inner
    // Skip anything saved in an older format (plain strings) before a reload.
    const [saved, picked, isComposing, isLoading] = await Promise.all([
      read($, suggestions),
      read($, selected),
      read($, composing),
      read($, loading),
    ])
    const list = saved.filter(x => x && typeof x === 'object' && x.label)
    const { Box, Text, Button } = $.ui.resolve(e)
    const t = await locale($)

    if (e.props.isWorking || list.length === 0) {
      // Placeholder, so the spot never looks broken or empty.
      const hint = e.props.isWorking
        ? t('hint.working')
        : isLoading
          ? t('hint.loading')
          : t('hint.empty')
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text dimColor>{hint}</Text>
          <Box flexGrow={1}>{inner}</Box>
        </Box>
      )
    }

    const item = (s: Suggestion, i: number) => (
      <Button
        key={`n${i}`}
        label={`${picked.includes(i) ? '☑' : '☐'}  ${s.label}`}
        dimColor={!picked.includes(i)}
        onPress={() => toggle($, i)}
      />
    )
    // Two columns, filled down then across: 1-3 left, 4-6 right.
    const half = Math.ceil(list.length / 2)
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {/* Shrinks and clips if ever too wide, so the right side is never pushed off. */}
        <Box flexDirection="column" alignItems="flex-start" gap={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Box flexDirection="row" alignItems="flex-start" columnGap={2}>
            <Box flexDirection="column" alignItems="flex-start" gap={1}>
              {list.slice(0, half).map((s, i) => item(s, i))}
            </Box>
            <Box flexDirection="column" alignItems="flex-start" gap={1}>
              {list.slice(half).map((s, i) => item(s, i + half))}
            </Box>
          </Box>
          {/* Footer: what is ticked, a way to undo it, and the action, side by side. */}
          <Box flexDirection="row" alignItems="center" gap={1}>
            {isComposing ? (
              <Text dimColor>{t('send.composing')}</Text>
            ) : picked.length > 0 ? (
              <Box flexDirection="row" alignItems="center" gap={1}>
                <Button
                  key="send"
                  label={picked.length === 1 ? t('send.one') : t('send.n', { n: picked.length })}
                  variant="primary"
                  onPress={() => sendSelected($)}
                />
                <Button key="clear" label={t('send.clear')} dimColor onPress={() => update($, selected, () => [])} />
                <Text dimColor>{t('send.selected', { picked: picked.length, total: list.length })}</Text>
              </Box>
            ) : (
              <Text dimColor>{t('send.hint')}</Text>
            )}
          </Box>
        </Box>
        <Box flexGrow={1} flexShrink={0}>{inner}</Box>
      </Box>
    )
  })
}
