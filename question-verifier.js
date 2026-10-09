/**
 * Question Verifier - Validation et assainissement des questions générées
 * Conforme à la charte ElmasCore (ELMAS.md).
 */

const FORBIDDEN_PATTERNS = [
  /page\s*\d+/i,
  /document\s*\d+/i,
  /figure\s*\d+/i,
  /tableau\s*ci-dessus/i,
  /texte\s*ci-dessus/i,
  /selon\s*l'extrait/i,
  /d'après\s*le\s*document/i
]

export function verifyQuestion(question) {
  if (!question || typeof question !== 'object') {
    return { valid: false, reason: 'Format invalide' }
  }

  const prompt = String(question.prompt || question.question || '').trim()
  if (prompt.length < 8) {
    return { valid: false, reason: 'Énoncé trop court' }
  }

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(prompt)) {
      return { valid: false, reason: 'Référence à un document physique' }
    }
  }

  const options = (question.options || question.choices || []).map((o) => String(o).trim())
  if (!Array.isArray(options) || options.length < 2) {
    return { valid: false, reason: 'Moins de deux choix' }
  }

  const unique = new Set(options)
  if (unique.size < options.length) {
    return { valid: false, reason: 'Choix dupliqués' }
  }

  const answer = question.answer !== undefined ? question.answer : question.correctAnswer
  const answerIdx = Number(answer)
  if (!Number.isInteger(answerIdx) || answerIdx < 0 || answerIdx >= options.length) {
    return { valid: false, reason: `Index de réponse invalide: ${answer}` }
  }

  return { valid: true, cleanOptions: options, cleanAnswer: answerIdx, prompt }
}

export function sanitizeQuestionList(rawQuestions, prefix = 'srv') {
  if (!Array.isArray(rawQuestions)) return []

  const validQuestions = []
  rawQuestions.forEach((q, idx) => {
    const check = verifyQuestion(q)
    if (!check.valid) return

    validQuestions.push({
      id: q.id || `${prefix}-${idx + 1}-${Date.now().toString(36)}`,
      type: 'mcq',
      prompt: check.prompt,
      options: check.cleanOptions,
      answer: check.cleanAnswer,
      explanation: String(q.explanation || q.explication || '').trim()
    })
  })

  return validQuestions
}
