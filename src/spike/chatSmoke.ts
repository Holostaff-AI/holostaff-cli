/**
 * A3 — chat-agent smoke (no UI).
 *
 * Drives runChat() with two turns to verify:
 *   - tools: [] keeps the agent from looking around the filesystem
 *   - the system prompt produces in-scope, terse answers
 *   - resume: sessionId carries context across turns
 *
 * Required env: AZURE_ANTHROPIC_ENDPOINT + AZURE_ANTHROPIC_API_KEY.
 *
 * Run:  cd cli && npm run spike:chat
 */

import { runChat, type ChatEvent } from '../agent/runChat.js'

async function turn(prompt: string, resume?: string): Promise<string | undefined> {
  console.log(`\n> ${prompt}\n`)
  let acc = ''
  let session: string | undefined = resume

  await runChat({
    prompt,
    resume,
    onEvent: (ev: ChatEvent) => {
      switch (ev.type) {
        case 'session':
          session = ev.sessionId
          break
        case 'delta':
          process.stdout.write(ev.text)
          acc += ev.text
          break
        case 'completed':
          process.stdout.write('\n')
          if (ev.sessionId) session = ev.sessionId
          console.log(`  ↳ ${ev.tokens.input} in / ${ev.tokens.output} out`)
          break
        case 'failed':
          console.log(`  ✗ ${ev.error}`)
          break
      }
    },
  })

  void acc
  return session
}

console.log('Holostaff CLI — chat smoke (A3)')

const sessionId = await turn('In one sentence: what does /scan do?')
if (!sessionId) {
  console.log('\n✗ no session id captured — chat agent failed')
  process.exit(1)
}

await turn('And what stays on the developer\'s machine when it runs?', sessionId)

console.log('\n✓ done')
process.exit(0)
