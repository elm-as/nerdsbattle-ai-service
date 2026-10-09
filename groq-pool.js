/**
 * Groq Pool Backend - Rotation multi-clés et régulation de débit
 * Conforme à la charte ElmasCore (ELMAS.md).
 */

const DEFAULT_MODEL = 'openai/gpt-oss-120b'
const FALLBACK_MODEL = 'openai/gpt-oss-20b'
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'

let keyIndex = 0
const keyCooldowns = new Map()

export function getKeys() {
  const envKeys = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || ''
  return envKeys
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
}

function selectAvailableKey(keys) {
  if (!keys || keys.length === 0) return null
  const now = Date.now()

  for (let i = 0; i < keys.length; i++) {
    const key = keys[keyIndex % keys.length]
    keyIndex++
    const cooldown = keyCooldowns.get(key) || 0
    if (now >= cooldown) return key
  }

  // Si toutes sont en cooldown, prendre la plus ancienne
  return keys[0]
}

function setCooldown(key, seconds = 15) {
  if (key) keyCooldowns.set(key, Date.now() + seconds * 1000)
}

/**
 * Exécute une complétion Groq avec bascule automatique et gestion des 429
 */
export async function executeCompletion({
  messages,
  model = DEFAULT_MODEL,
  temperature = 0.2,
  maxTokens = 2048,
  jsonMode = true
}) {
  const keys = getKeys()
  if (keys.length === 0) {
    throw new Error('Aucune clé Groq disponible sur le serveur.')
  }

  const maxAttempts = Math.min(keys.length * 2, 6)
  let lastError = null

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const apiKey = selectAvailableKey(keys)
    if (!apiKey) break

    try {
      const payload = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens
      }
      if (jsonMode) payload.response_format = { type: 'json_object' }

      const response = await fetch(GROQ_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })

      if (response.status === 429) {
        setCooldown(apiKey, 20)
        await new Promise((r) => setTimeout(r, 800))
        continue
      }

      if (!response.ok) {
        if (response.status === 404 && model !== FALLBACK_MODEL) {
          model = FALLBACK_MODEL
        }
        setCooldown(apiKey, 5)
        continue
      }

      const data = await response.json()
      const content = data.choices?.[0]?.message?.content?.trim()
      if (!content) throw new Error('Contenu vide retourné par Groq')

      return jsonMode ? JSON.parse(content) : content
    } catch (err) {
      lastError = err
      setCooldown(apiKey, 5)
    }
  }

  throw lastError || new Error('Échec après rotation des clés Groq')
}

export function getPoolStats() {
  const keys = getKeys()
  const now = Date.now()
  const activeCount = keys.filter((k) => (keyCooldowns.get(k) || 0) <= now).length
  return {
    totalKeys: keys.length,
    activeKeys: activeCount,
    coolingKeys: keys.length - activeCount
  }
}
