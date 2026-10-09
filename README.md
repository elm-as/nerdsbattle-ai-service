# NerdsBattle AI Microservice (Render Web Service)

Ce microservice Node.js gère la génération, l'enrichissement et la vérification des questions en temps réel via un pool de 5 clés Groq avec rotation automatique.

---

## 🚀 Déploiement en 2 minutes sur Render (Plan Gratuit)

### Étape 1 : Créer le Web Service sur Render

1. Rends-toi sur [Render Dashboard](https://dashboard.render.com/) et clique sur **New +** $\rightarrow$ **Web Service**.
2. Connecte ton dépôt GitHub `NerdsBattle`.
3. Configure les paramètres suivants :
   - **Name** : `nerdsbattle-ai-service` (ou le nom de ton choix)
   - **Root Directory** : `server`
   - **Environment** : `Node`
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : `Free`

### Étape 2 : Variables d'Environnement (Render Dashboard)

Dans l'onglet **Environment** sur Render, ajoute :

| Variable | Valeur |
|---|---|
| `GROQ_API_KEYS` | `gsk_puoKmrL...,gsk_XHnHvB...,gsk_YCU7lZ...,gsk_KVVGgn...,gsk_QC9nng...` |
| `GROQ_MODEL` | `openai/gpt-oss-120b` |
| `NODE_ENV` | `production` |

Clique sur **Deploy**.

---

## ⏱️ Garder le service éveillé 24h/24 avec UptimeRobot

Comme c'est un plan gratuit, Render met le service en veille après 15 min d'inactivité.

1. Rends-toi sur [UptimeRobot](https://uptimerobot.com/) (gratuit).
2. Clique sur **Add New Monitor**.
   - **Monitor Type** : `HTTP(s)`
   - **Friendly Name** : `NerdsBattle AI Service`
   - **URL (or IP)** : `https://ton-service.onrender.com/health`
   - **Monitoring Interval** : `Every 5 minutes`
3. Valide : ton service reste **éveillé en continu 24h/24 sans aucun cold start** !

---

## 📡 Endpoints Disponibles

### `GET /health`
Vérification de bon fonctionnement pour UptimeRobot.
```json
{
  "status": "ok",
  "service": "nerdsbattle-ai-service",
  "uptimeSeconds": 1420,
  "timestamp": "2026-10-09T08:30:00.000Z"
}
```

### `GET /api/status`
Statistiques du pool de clés Groq.
```json
{
  "status": "ok",
  "uptime": 1420,
  "pool": {
    "totalKeys": 5,
    "activeKeys": 5,
    "coolingKeys": 0
  }
}
```

### `POST /api/generate-questions`
Génère et certifie des questions à la volée avant un match.
**Body :**
```json
{
  "subjectName": "Mathématiques",
  "levelName": "Terminale C",
  "count": 6,
  "topic": "Limites et continuité",
  "contextText": "Théorème des valeurs intermédiaires..."
}
```

### `POST /api/enrich-course`
Enrichit une leçon avec synthèse pédagogique et QCMs certifiés.
