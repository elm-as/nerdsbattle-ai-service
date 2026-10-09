/**
 * Worker d'enrichissement continu en arrière-plan.
 * Conforme à la charte ElmasCore (ELMAS.md).
 *
 * Fonctionnement :
 *   - Tourne toutes les 5 minutes (ou AUTO_ENRICH_INTERVAL_MS).
 *   - Alterne équitablement entre TOUS les niveaux et TOUTES les matières.
 *   - Sélectionne en priorité les leçons ayant le moins de questions.
 *   - Fournit à l'IA la liste des questions déjà connues pour interdire les doublons.
 *   - Valide strictement chaque question via question-verifier.js avant de pousser dans Supabase.
 */

import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { executeCompletion } from './groq-pool.js'
import { sanitizeQuestionList } from './question-verifier.js'

dotenv.config()
const rootEnv = path.resolve(process.cwd(), '.env')
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv })
}
const parentEnv = path.resolve(process.cwd(), '..', '.env')
if (fs.existsSync(parentEnv)) {
  dotenv.config({ path: parentEnv })
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const BATCH_QUESTIONS_COUNT = 5

const ROTATION_LEVELS = [
  'terminale',
  'premiere',
  'seconde',
  'troisieme',
  'quatrieme',
  'cinquieme',
  'sixieme'
]

const ROTATION_SUBJECTS = [
  'maths',
  'physique',
  'svt',
  'histoire',
  'francais',
  'anglais',
  'philosophie',
  'espagnol',
  'allemand',
  'edhc'
]

function getDisciplineRule(subjectId) {
  const norm = String(subjectId || '').toLowerCase()
  if (norm.includes('math')) {
    return `DISCIPLINE : MATHÉMATIQUES PURES.
- Les questions portent STRICTEMENT sur les concepts mathématiques : analyse, suites, fonctions, limites, dérivées, intégrales, géométrie, probabilités, arithmétique.
- INTERDICTION ABSOLUE : Zéro notion de physique (aucun condensateur, aucun circuit RC/RLC, aucune vitesse, aucune intensité). Formule des équations et énoncés 100% abstraits ou purement mathématiques.
- FORMULES : Entoure toute expression mathématique de dollars simples $ ... $.`
  }
  if (norm.includes('physique') || norm.includes('chimie')) {
    return `DISCIPLINE : PHYSIQUE-CHIMIE. Mécanique, électricité, ondes, chimie des solutions, oxydoréduction, énergie.`
  }
  if (norm.includes('svt')) {
    return `DISCIPLINE : SVT. Biologie cellulaire, génétique, immunologie, géologie, tectonique.`
  }
  if (norm.includes('histoire')) {
    return `DISCIPLINE : HISTOIRE-GÉOGRAPHIE. Programme officiel national (indépendance de la Côte d'Ivoire, organisations régionales UA/CEDEAO, décolonisation, géopolitique mondiale).`
  }
  if (norm.includes('philo')) {
    return `DISCIPLINE : PHILOSOPHIE. Notions au programme (la conscience, l'inconscient, la vérité, la liberté, l'État, autrui).`
  }
  return `DISCIPLINE : ${subjectId}. Reste rigoureusement dans le champ disciplinaire officiel.`
}

export class BackgroundEnricher {
  constructor(config = {}) {
    this.intervalMs = Number(process.env.AUTO_ENRICH_INTERVAL_MS) || DEFAULT_INTERVAL_MS
    this.supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
    this.supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
    this.timerId = null
    this.isRunning = false
    this.levelIndex = 0
    this.subjectIndex = 0
    this.stats = {
      totalRuns: 0,
      totalEnriched: 0,
      totalQuestionsAdded: 0,
      lastRunAt: null,
      lastTarget: null,
      lastError: null
    }
  }

  start() {
    if (this.timerId) return
    const enabled = process.env.AUTO_ENRICH_ENABLED !== 'false'
    if (!enabled) {
      console.log('[auto-enricher] Désactivé via AUTO_ENRICH_ENABLED=false')
      return
    }

    if (!this.supabaseUrl || !this.supabaseKey) {
      console.warn('[auto-enricher] URL ou clé Supabase manquante, worker en pause.')
      return
    }

    console.log(`[auto-enricher] Démarré : rotation toutes les ${this.intervalMs / 60000} minutes.`)
    // Premier cycle après 30 secondes pour laisser le serveur s'initialiser
    this.timerId = setTimeout(() => this.runCycle(), 30 * 1000)
  }

  stop() {
    if (this.timerId) {
      clearTimeout(this.timerId)
      this.timerId = null
    }
    console.log('[auto-enricher] Arrêté.')
  }

  getStats() {
    return {
      enabled: Boolean(this.timerId),
      intervalMinutes: this.intervalMs / 60000,
      ...this.stats
    }
  }

  async runCycle() {
    if (this.isRunning) return
    this.isRunning = true
    this.stats.totalRuns++
    this.stats.lastRunAt = new Date().toISOString()

    try {
      await this.processNextBatch()
    } catch (err) {
      console.error('[auto-enricher] Erreur lors du cycle :', err.message)
      this.stats.lastError = err.message
    } finally {
      this.isRunning = false
      this.advanceRotation()
      this.timerId = setTimeout(() => this.runCycle(), this.intervalMs)
    }
  }

  advanceRotation() {
    this.subjectIndex = (this.subjectIndex + 1) % ROTATION_SUBJECTS.length
    if (this.subjectIndex === 0) {
      this.levelIndex = (this.levelIndex + 1) % ROTATION_LEVELS.length
    }
  }

  async processNextBatch() {
    const levelId = ROTATION_LEVELS[this.levelIndex]
    const subjectId = ROTATION_SUBJECTS[this.subjectIndex]
    this.stats.lastTarget = `${subjectId} / ${levelId}`

    // 1. Chercher les cours correspondants dans Supabase
    const endpoint = `${this.supabaseUrl.replace(/\/$/, '')}/rest/v1/courses?level_id=eq.${levelId}&subject_id=eq.${subjectId}&select=id,title,questions,lesson,summary`
    const res = await fetch(endpoint, {
      headers: {
        apikey: this.supabaseKey,
        Authorization: `Bearer ${this.supabaseKey}`
      }
    })

    if (!res.ok) {
      throw new Error(`Échec lecture Supabase (${res.status})`)
    }

    const courses = await res.json()
    if (!courses || courses.length === 0) {
      console.log(`[auto-enricher] Aucun cours trouvé pour ${subjectId} / ${levelId}, passage au suivant.`)
      return
    }

    // 2. Sélectionner en priorité le cours avec le moins de questions
    const sorted = [...courses].sort((a, b) => {
      const qA = Array.isArray(a.questions) ? a.questions.length : 0
      const qB = Array.isArray(b.questions) ? b.questions.length : 0
      return qA - qB
    })
    const targetCourse = sorted[0]
    const existingQuestions = Array.isArray(targetCourse.questions) ? targetCourse.questions : []

    console.log(
      `[auto-enricher] Cible sélectionnée : "${targetCourse.title}" (${subjectId} / ${levelId}) ` +
      `avec ${existingQuestions.length} questions existantes.`
    )

    // 3. Générer de nouvelles questions inédites
    const newQuestions = await this.generateUniqueQuestions({
      course: targetCourse,
      subjectId,
      levelId,
      existingQuestions
    })

    if (newQuestions.length === 0) {
      console.log(`[auto-enricher] Aucune question valide retenue pour "${targetCourse.title}".`)
      return
    }

    // 4. Fusionner et mettre à jour dans Supabase
    const updatedList = [...existingQuestions, ...newQuestions]
    const patchUrl = `${this.supabaseUrl.replace(/\/$/, '')}/rest/v1/courses?id=eq.${encodeURIComponent(targetCourse.id)}`
    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: this.supabaseKey,
        Authorization: `Bearer ${this.supabaseKey}`,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ questions: updatedList })
    })

    if (!patchRes.ok) {
      const errTxt = await patchRes.text()
      throw new Error(`Échec PATCH Supabase (${patchRes.status}) : ${errTxt}`)
    }

    this.stats.totalEnriched++
    this.stats.totalQuestionsAdded += newQuestions.length
    console.log(
      `[auto-enricher] ✅ "${targetCourse.title}" enrichi : +${newQuestions.length} questions ` +
      `(Total désormais : ${updatedList.length} questions).`
    )
  }

  async generateUniqueQuestions({ course, subjectId, levelId, existingQuestions }) {
    const disciplineRule = getDisciplineRule(subjectId)
    const existingPrompts = existingQuestions
      .map((q) => q.prompt || q.question)
      .filter(Boolean)
      .slice(-15) // Dernières 15 pour guider sans surcharger le contexte

    const systemPrompt = `Tu es l'inspecteur pédagogique d'élite de NerdsBattle pour le système éducatif de Côte d'Ivoire.
Ta mission est de créer ${BATCH_QUESTIONS_COUNT} questions QCM 100% inédites, de haute rigueur et sans ambiguïté.
Tu réponds STRICTEMENT en JSON :
{
  "questions": [
    {
      "prompt": "Énoncé complet et autonome",
      "options": ["Choix A", "Choix B", "Choix C", "Choix D"],
      "answer": 0,
      "explanation": "Démonstration pédagogique claire"
    }
  ]
}`

    const userPrompt = `Matière : ${subjectId} | Niveau : ${levelId}
Leçon officielle : ${course.title}
Résumé / Situation : ${course.summary || 'Programme officiel'}
Extrait de cours : ${String(course.lesson || '').slice(0, 1200)}

${disciplineRule}

CONSIGNES STRICTES :
1. RÈGLE D'UNICITÉ : Ne répète JAMAIS les questions suivantes déjà présentes :
${existingPrompts.map((p, i) => `   - [Existant ${i + 1}] : ${p}`).join('\n') || '   (Aucune question précédente)'}
2. Explore d'autres aspects, théorèmes, cas particuliers ou données numériques.
3. Chaque question doit avoir exactement 4 choix réalistes.
4. "answer" doit être l'index exact (0, 1, 2 ou 3) de la bonne réponse.
5. Formules et variables sous dollars simples $ ... $.`

    const rawResult = await executeCompletion({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      maxTokens: 2048,
      jsonMode: true
    })

    const rawList = rawResult?.questions || []
    const certified = sanitizeQuestionList(rawList, `auto-${subjectId}`)

    // Déduplication stricte par prompt normalisé
    const knownSet = new Set(
      existingQuestions.map((q) =>
        String(q.prompt || q.question || '').toLowerCase().replace(/\s+/g, ' ').trim()
      )
    )

    const uniqueList = []
    for (const q of certified) {
      const norm = String(q.prompt).toLowerCase().replace(/\s+/g, ' ').trim()
      if (!knownSet.has(norm)) {
        uniqueList.push(q)
        knownSet.add(norm)
      }
    }

    return uniqueList
  }
}
