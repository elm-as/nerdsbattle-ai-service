/**
 * NerdsBattle AI Backend Service - Render Web Service
 * Conforme à la charte ElmasCore (ELMAS.md).
 */

import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { executeCompletion, getPoolStats } from './groq-pool.js'
import { sanitizeQuestionList } from './question-verifier.js'
import { BackgroundEnricher } from './background-enricher.js'

// Charger .env depuis server/ ou depuis la racine du projet
dotenv.config()
const rootEnv = path.resolve(process.cwd(), '.env')
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv })
}
const parentEnv = path.resolve(process.cwd(), '..', '.env')
if (fs.existsSync(parentEnv)) {
  dotenv.config({ path: parentEnv })
}

const app = express()
const PORT = process.env.PORT || 3001
const enricher = new BackgroundEnricher()

app.use(cors())
app.use(express.json())

// ─── Healthcheck pour UptimeRobot & monitoring ───────────────────

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'nerdsbattle-ai-service',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  })
})

app.get('/api/status', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    pool: getPoolStats(),
    enricher: enricher.getStats()
  })
})

app.post('/api/enrich-now', async (req, res) => {
  try {
    enricher.runCycle()
    return res.status(200).json({ success: true, message: 'Cycle d’enrichissement déclenché.' })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── Génération de questions à la volée pour matchs ──────────────

function getDisciplineRules(subjectName) {
  const norm = String(subjectName || '').toLowerCase()
  if (norm.includes('math')) {
    return `RÈGLE STRICTE SUR LA MATIÈRE :
- Tu es un examinateur de MATHÉMATIQUES PURES.
- Les questions doivent porter EXCLUSIVEMENT sur les concepts mathématiques : analyse, fonctions, limites, dérivées, primitives, intégrales, logarithmes, exponentielles, suites, probabilités, nombres complexes, géométrie.
- INTERDICTION ABSOLUE : ZÉRO question de physique (aucun condensateur, aucun circuit électrique RC/RLC, aucune notion d'électricité, de force, d'énergie ou de chimie). Même pour les équations différentielles, formule des équations purement mathématiques sans contexte physique (ex: y' + 2y = 0 avec y(0) = 1).`
  }
  if (norm.includes('physique') || norm.includes('chimie')) {
    return `RÈGLE STRICTE SUR LA MATIÈRE :
- Tu es un examinateur de PHYSIQUE-CHIMIE (mécanique, électricité, optique, ondes, chimie).`
  }
  if (norm.includes('svt')) {
    return `RÈGLE STRICTE SUR LA MATIÈRE :
- Tu es un examinateur de SVT (biologie, géologie, génétique).`
  }
  if (norm.includes('philo')) {
    return `RÈGLE STRICTE SUR LA MATIÈRE :
- Tu es un examinateur de PHILOSOPHIE.`
  }
  return `RÈGLE STRICTE : Reste rigoureusement dans le champ disciplinaire de la matière "${subjectName}".`
}

app.post('/api/generate-questions', async (req, res) => {
  const { subjectName, levelName, count = 6, contextText = '', topic = '' } = req.body

  if (!subjectName || !levelName) {
    return res.status(400).json({ error: 'subjectName et levelName sont requis.' })
  }

  const disciplineRule = getDisciplineRules(subjectName)

  const systemPrompt = `Tu es l'examinateur d'élite de NerdsBattle pour le programme officiel de Côte d'Ivoire.
Ta mission est de créer des questions QCM professionnelles, captivantes et impeccablement formatées.
Tu dois répondre STRICTEMENT en JSON avec la structure :
{
  "questions": [
    {
      "prompt": "Énoncé clair, auto-suffisant avec formules entre dollars simples si nécessaire",
      "options": ["Choix A", "Choix B", "Choix C", "Choix D"],
      "answer": 0,
      "explanation": "Explication pédagogique concise"
    }
  ]
}`

  const userPrompt = `Matière : ${subjectName}
Niveau : ${levelName}
Thème : ${topic || 'Général'}
Nombre de questions : ${count}

${disciplineRule}

Contexte du programme :
${contextText || 'Programme officiel national'}

CONSIGNES STRICTES :
1. ${disciplineRule}
2. Chaque question doit être 100% autonome et compréhensible seule.
3. Exactement 4 choix de réponses distincts et réalistes.
4. "answer" DOIT être l'index 0-based exact (0, 1, 2 ou 3) de la bonne réponse.
5. FORMULES MATHÉMATIQUES : Entoure TOUTES les formules, variables et fractions de dollars simples $ ... $ (ex: "$t = \\frac{\\ln 4}{2}$", "$3e^{2t} = 12$", "$f(x) = x^2$"). Ne laisse JAMAIS de commande LaTeX nue sans "$".`

  try {
    const rawResult = await executeCompletion({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      maxTokens: 2048,
      jsonMode: true
    })

    const rawList = rawResult?.questions || []
    const verified = sanitizeQuestionList(rawList, `match-${subjectName}`)

    return res.status(200).json({
      success: true,
      count: verified.length,
      questions: verified
    })
  } catch (err) {
    console.error('[server] Erreur génération questions:', err.message)
    return res.status(500).json({ error: 'Échec de la génération IA', details: err.message })
  }
})

// ─── Enrichissement de cours ─────────────────────────────────────

app.post('/api/enrich-course', async (req, res) => {
  const { title, situation, exercise, theory, levelName, subjectName } = req.body

  if (!title) {
    return res.status(400).json({ error: 'Le titre du cours est requis.' })
  }

  const systemPrompt = `Tu es un inspecteur pédagogique expert du programme de Côte d'Ivoire.
Ta mission est d'enrichir une leçon et de générer 5 questions QCM de très haute qualité.
Réponds STRICTEMENT en JSON :
{
  "summary": "Résumé clair et stimulant de 2-3 phrases",
  "questions": [
    {
      "prompt": "Énoncé autonome et rigoureux",
      "options": ["Choix 1", "Choix 2", "Choix 3", "Choix 4"],
      "answer": 0,
      "explanation": "Démonstration pédagogique claire"
    }
  ]
}`

  const userPrompt = `Matière : ${subjectName || 'Général'} | Niveau : ${levelName || 'Général'}
Titre : ${title}
Situation problème : ${situation || 'N/A'}
Exercices officiels : ${exercise || 'N/A'}
Contenu théorique complémentaire : ${String(theory || '').slice(0, 1400)}

Consignes :
1. Les 4 options doivent être plausibles et distinctes.
2. "answer" doit être l'index 0-based exact de la bonne réponse.
3. Aucune question ne doit faire référence à un livre physique.`

  try {
    const result = await executeCompletion({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      maxTokens: 2048,
      jsonMode: true
    })

    const questions = sanitizeQuestionList(result?.questions || [], 'enriched')

    return res.status(200).json({
      success: true,
      summary: result?.summary || situation || '',
      questions
    })
  } catch (err) {
    console.error('[server] Erreur enrichissement cours:', err.message)
    return res.status(500).json({ error: 'Échec de l’enrichissement', details: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`[nerdsbattle-ai-service] En écoute sur le port ${PORT}`)
  console.log(`[nerdsbattle-ai-service] Healthcheck disponible sur http://localhost:${PORT}/health`)
  enricher.start()
})
