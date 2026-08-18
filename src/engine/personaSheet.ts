// AUTO-SYNCED from holostaff-agent/server/scripts/sim/personaSheet.ts — do not edit here.
// Re-sync: bash server/scripts/sim/sync-cli-engine.sh
/**
 * Persona sheet — the P0 slice of the user-simulation persona model
 * (documents/prd-user-simulation.md §4, decision D14).
 *
 * A persona is data, not prose in a harness: identity + face/voice binding
 * + a character brief + trait dials. Two dials are MECHANICAL — they set
 * loop parameters the harness enforces — the rest condition the prompt:
 *
 *   patience     → how many consecutive no-progress steps before the
 *                  harness tells the persona its patience is wearing thin,
 *                  and the per-wait ceiling.
 *   expressiveness → how often the persona thinks aloud ("say" lines).
 *
 * techLiteracy stays prompt-only in P0 (it shapes vocabulary and what the
 * persona finds obvious), matching the PRD's "prompt + mechanical params"
 * split.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PersonaTraits {
  /** 1 (gives up fast) … 5 (very patient) */
  patience: number
  /** 1 (non-technical) … 5 (developer) */
  techLiteracy: number
  /** 1 (silent type) … 5 (constant think-aloud) */
  expressiveness: number
}

export interface PersonaSheet {
  id: string
  name: string
  role: string
  /** catalog avatar id (server/src/bowtie/avatars/catalog.ts) for the reaction cam */
  avatarId: string
  /** TTS voice for the reaction cam (OpenAI voice name) */
  voiceId: string
  bio: string
  speakingStyle: string
  traits: PersonaTraits
}

export interface MechanicalParams {
  /** consecutive no-progress steps before the patience nudge fires */
  patienceNudgeAfter: number
  /** consecutive no-progress steps after which giving up is legitimized */
  giveUpLegitAfter: number
  /** hard ceiling on a single "wait" action, seconds */
  maxWaitSeconds: number
  /** roughly how many steps between think-aloud lines the prompt asks for */
  sayCadence: string
}

export function loadPersona(dir: string, id: string): PersonaSheet {
  const raw = JSON.parse(readFileSync(join(dir, 'personas', `${id}.json`), 'utf8')) as PersonaSheet
  for (const k of ['id', 'name', 'role', 'avatarId', 'voiceId', 'bio', 'speakingStyle'] as const) {
    if (!raw[k]) throw new Error(`persona ${id}: missing "${k}"`)
  }
  const t = raw.traits
  for (const k of ['patience', 'techLiteracy', 'expressiveness'] as const) {
    if (!t || typeof t[k] !== 'number' || t[k] < 1 || t[k] > 5) {
      throw new Error(`persona ${id}: traits.${k} must be 1-5`)
    }
  }
  return raw
}

export function mechanicalParams(p: PersonaSheet): MechanicalParams {
  return {
    patienceNudgeAfter: 1 + p.traits.patience, // patience 2 → nudge after 3
    giveUpLegitAfter: 3 + p.traits.patience * 2, // patience 2 → 7
    maxWaitSeconds: 10 + p.traits.patience * 14, // patience 2 → 38s
    sayCadence:
      p.traits.expressiveness >= 4
        ? 'almost every step — you keep a running commentary going the whole session'
        : p.traits.expressiveness >= 3
          ? 'every couple of steps'
          : 'only at notable moments',
  }
}

/** The persona system prompt: character brief + trait phrasing. Scenario text is appended by the runner. */
export function personaBriefing(p: PersonaSheet, m: MechanicalParams): string {
  const lit = p.traits.techLiteracy
  const literacyLine =
    lit <= 2
      ? 'You are NOT technical. You do not know web jargon (no "URL slug", no "embed", no "integrations"). You judge everything by what the words on screen mean to a normal person, and unfamiliar terms make you hesitate.'
      : lit >= 4
        ? 'You are technical and move fast through familiar UI patterns, but you still only know what is on screen.'
        : 'You are an everyday computer user: fine with common apps, wary of anything that looks like developer territory.'
  const patienceLine =
    p.traits.patience <= 2
      ? 'You have LITTLE patience. If something is confusing or slow you get irritated quickly, and you would rather quit than fight software.'
      : p.traits.patience >= 4
        ? 'You are patient and persistent; you will try several approaches before giving up.'
        : 'You have average patience: you will retry once or twice, then start doubting the product.'

  return `You are ${p.name}, ${p.role}. ${p.bio}

${literacyLine}
${patienceLine}

You have NEVER seen this product before — you only know what is on screen.
Read what it tells you and act like yourself, not like a QA robot. If copy is
unclear or a step fails, say so bluntly in "confusion" and quote the exact
text that misled you in "quote".

You think aloud while you work (${m.sayCadence}). Your speaking style:
${p.speakingStyle}. The "say" field is what you mutter out loud — first
person, present tense, at most ~14 words, natural speech (it will be spoken
by your voice). Leave "say" as "" on steps where you would stay quiet.

Every step, also report "emotion": exactly one of
neutral | curious | focused | confused | frustrated | anxious | delighted | relieved
— how you actually feel RIGHT NOW, not what would look polite.`
}
