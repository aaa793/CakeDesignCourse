# Formation Automation — Système de vente de formations via Telegram

Système multi-tenant d'automatisation des ventes de formations en ligne via Telegram.
Chaque formation a son propre bot Telegram, son propre espace RAG dans Pinecone,
et son propre groupe d'accès privé — sans dupliquer de code.

## Architecture en un coup d'œil

```
Message Telegram → Webhook Next.js → RAG (Gemini + Pinecone) → Réponse bot
                                   → Détection paiement     → Vérification vision → Lien d'accès
```

---

## ÉTAPE 1 — Créer les comptes nécessaires

### 1.1 Base de données PostgreSQL

Choisissez l'une de ces options gratuites :

**Option A — Neon (recommandé)**
1. Allez sur [neon.tech](https://neon.tech) et créez un compte gratuit
2. Créez un nouveau projet (choisissez la région la plus proche)
3. Copiez la "Connection string" qui ressemble à :
   `postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require`

**Option B — Supabase**
1. Allez sur [supabase.com](https://supabase.com) et créez un compte gratuit
2. Créez un nouveau projet
3. Dans Settings > Database, copiez la "Connection string" (URI format)

### 1.2 Pinecone (Vector Store pour le RAG)

1. Allez sur [pinecone.io](https://www.pinecone.io) et créez un compte gratuit
2. Créez un **nouvel index** avec ces paramètres :
   - **Dimensions** : `3072` (taille des vecteurs Gemini `gemini-embedding-001`)
   - **Metric** : `cosine`
   - **Type** : Serverless (plus économique)
   - **Cloud/Region** : AWS us-east-1 (ou le plus proche)
3. Une fois créé, notez :
   - Votre **API Key** (dans le menu de gauche > API Keys)
   - L'**URL de l'index** (visible dans le dashboard de l'index, format : `https://your-index-xxxx.svc.us-east-1.pinecone.io`)

### 1.3 OpenRouter (LLM — texte et vision)

1. Allez sur [openrouter.ai](https://openrouter.ai) et créez un compte
2. Ajoutez des crédits (même 5$ suffisent pour commencer)
3. Dans Settings > API Keys, créez une nouvelle clé API
4. Notez votre clé (format : `sk-or-v1-xxx...`)

> Le modèle utilisé est `google/gemini-2.5-flash` — très rapide et peu coûteux (~0.0001$/message)

### 1.4 Google AI Studio (Embeddings Gemini)

1. Allez sur [aistudio.google.com](https://aistudio.google.com/app/apikey)
2. Connectez-vous avec votre compte Google
3. Cliquez "Create API key" et copiez la clé (format : `AIzaSy...`)

> Les embeddings Gemini sont **gratuits** jusqu'à 1 500 requêtes/jour

### 1.5 BotFather Telegram (Créer votre bot)

Pour chaque formation, vous devez créer un bot Telegram séparé :

1. Ouvrez Telegram et cherchez `@BotFather`
2. Envoyez `/newbot`
3. Donnez un nom à votre bot (ex: "Cours Cake Design")
4. Donnez un username (doit finir par "bot", ex: `cake_design_formations_bot`)
5. BotFather vous envoie un **token** (format : `7123456789:AAHx...`)
   → **Notez ce token, c'est votre `telegram_bot_token`**

**Créer le groupe Telegram privé de la formation :**
1. Créez un nouveau groupe Telegram privé
2. Ajoutez votre bot comme **administrateur** avec le droit "Invite users via links"
3. Pour obtenir le `chat_id` du groupe :
   - Ajoutez temporairement `@userinfobot` dans le groupe
   - Il vous donnera l'ID (format négatif, ex: `-1001234567890`)
   → **Notez cet ID, c'est votre `telegram_group_chat_id`**

**Créer un canal admin pour les notifications :**
1. Créez un canal Telegram ou un groupe pour vous seule
2. Obtenez son chat_id de la même façon
   → **Notez cet ID, c'est votre `admin_telegram_chat_id`**

---

## ÉTAPE 2 — Configurer le projet

### 2.1 Cloner/télécharger le projet

```bash
# Naviguer dans le dossier du projet
cd formation-automation

# Installer les dépendances
npm install
```

### 2.2 Créer le fichier de configuration

```bash
# Copier le fichier exemple
cp .env.local.example .env.local
```

Ouvrez `.env.local` et remplissez toutes les valeurs avec celles collectées à l'étape 1 :

```env
DATABASE_URL=postgresql://user:password@...
OPENROUTER_API_KEY=sk-or-v1-...
GEMINI_API_KEY=AIzaSy...
PINECONE_API_KEY=pcsk_...
PINECONE_INDEX_URL=https://your-index-xxxx.svc.us-east-1.pinecone.io
APP_URL=https://votre-app.vercel.app
```

---

## ÉTAPE 3 — Initialiser la base de données

```bash
# Option A : Avec psql (si installé)
psql $DATABASE_URL -f db/schema.sql

# Option B : Copier-coller le contenu de db/schema.sql
# dans l'éditeur SQL de votre tableau de bord Neon ou Supabase
```

---

## ÉTAPE 4 — Insérer votre première formation

Connectez-vous à votre base de données et exécutez ces requêtes SQL :

```sql
-- 1. Créer la business (votre cliente)
INSERT INTO businesses (name, admin_telegram_chat_id)
VALUES ('Ma Pâtisserie', '-1001234567890')  -- remplacez par votre chat_id admin
RETURNING id;
-- → Notez l'UUID retourné, ex: 'aaa-111-...'

-- 2. Créer la formation
INSERT INTO courses (
  business_id,
  name,
  description,
  price_dzd,
  payment_info,
  pinecone_namespace,
  telegram_bot_token,
  telegram_bot_username,
  telegram_group_chat_id
) VALUES (
  'aaa-111-...',  -- business_id de l'étape précédente
  'Cake Design Débutant',
  'Formation complète pour apprendre le cake design de zéro',
  4500.00,
  'Pour vous inscrire, effectuez un virement de 4500 DA vers :
CCP : 1234567 clé 89
Ou via Baridimob : 00799-1234567-89
Nom : Fatima Benali
Référence à mettre : CAKE2024
Après le virement, envoyez une photo de votre reçu ici.',
  'cake-design-debutant',  -- namespace Pinecone (unique, pas d''espaces)
  '7123456789:AAHxxxxxxxxxxxxxxxxxxx',  -- token de votre bot
  'cake_design_bot',
  '-1001987654321'  -- chat_id du groupe formation
)
RETURNING id;
-- → Notez l'UUID retourné, ex: 'bbb-222-...' — c'est votre COURSE_ID
```

---

## ÉTAPE 5 — Préparer et ingérer le contenu de la formation

### 5.1 Créer le fichier de contenu

Créez le fichier `content/<COURSE_ID>.txt` (remplacez `<COURSE_ID>` par l'UUID de votre formation) :

```bash
# Exemple avec l'UUID bbb-222-...
cp content/PLACEHOLDER-course.txt content/bbb-222-....txt
```

Éditez ce fichier et remplacez son contenu par **tout le contenu de votre formation** :
- Description du cours
- Liste des modules
- Détail de chaque leçon
- FAQ
- Informations pratiques (durée, format, prérequis...)

> Plus le contenu est riche et détaillé, meilleures seront les réponses du bot !

### 5.2 Lancer l'ingestion

```bash
node scripts/ingest-course.js --course-id=bbb-222-...
```

Le script affiche sa progression :
```
🚀 Ingestion du contenu pour la formation: bbb-222-...
📋 Récupération des informations de la formation...
✅ Formation trouvée: "Cake Design Débutant"
📄 Lecture du fichier: .../content/bbb-222-....txt
   1234 mots trouvés dans le fichier.
✂️  Découpage du texte en chunks...
   8 chunks créés.
🔢 Génération des embeddings (Gemini)...
   Chunk 1/8 (398 mots)... ✅
   ...
📤 Upsert dans Pinecone...
🎉 Ingestion terminée avec succès !
```

---

## ÉTAPE 6 — Déployer sur Vercel

### 6.1 Pousser le code sur GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/votre-username/formation-automation.git
git push -u origin main
```

### 6.2 Déployer sur Vercel

1. Allez sur [vercel.com](https://vercel.com) et connectez votre compte GitHub
2. Cliquez "New Project" et importez votre repository
3. Dans "Environment Variables", ajoutez toutes les variables de votre `.env.local`
4. Cliquez "Deploy"
5. Notez votre URL de déploiement (ex: `https://formation-automation.vercel.app`)

### 6.3 Mettre à jour APP_URL

Dans Vercel > Settings > Environment Variables, mettez à jour `APP_URL` avec votre vraie URL.

---

## ÉTAPE 7 — Configurer le Webhook Telegram

Pour chaque bot, configurez le webhook vers votre URL Vercel.
Ouvrez ce lien dans votre navigateur (adaptez les valeurs) :

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://formation-automation.vercel.app/api/telegram/webhook/<BOT_TOKEN>
```

Vous devriez voir : `{"ok":true,"result":true,"description":"Webhook was set"}`

**Vérifier que le webhook est bien configuré :**
```
https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

---

## ÉTAPE 8 — Tester en local (optionnel)

Pour tester sans déployer sur Vercel, utilisez ngrok pour exposer votre serveur local :

### 8.1 Démarrer le serveur de développement

```bash
npm run dev
# → Serveur disponible sur http://localhost:3000
```

### 8.2 Exposer avec ngrok

```bash
# Installer ngrok : https://ngrok.com/download
ngrok http 3000
# → Vous obtenez une URL publique comme https://xxxx.ngrok-free.app
```

### 8.3 Configurer le webhook Telegram vers ngrok

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://xxxx.ngrok-free.app/api/telegram/webhook/<BOT_TOKEN>
```

### 8.4 Tester

Ouvrez une conversation privée avec votre bot sur Telegram et envoyez un message !

---

## Ajouter une nouvelle formation

C'est la beauté du système multi-tenant : **pas de nouveau code à écrire**.

1. Créez un nouveau bot avec BotFather → nouveau token
2. Créez un nouveau groupe Telegram et ajoutez le bot admin
3. Insérez une nouvelle ligne dans la table `courses` (SQL comme à l'étape 4)
4. Créez le fichier `content/<nouveau_course_id>.txt` avec le contenu
5. Lancez `node scripts/ingest-course.js --course-id=<nouveau_course_id>`
6. Configurez le webhook Telegram pour le nouveau token bot
7. **C'est tout !**

---

## Structure des fichiers

```
formation-automation/
├── db/
│   └── schema.sql              ← Structure de la base de données
├── lib/
│   ├── db.js                   ← Repository : tout le SQL ici
│   ├── rag.js                  ← Service : embeddings + Pinecone + LLM
│   ├── prompts.js              ← Templates de prompts
│   ├── telegram.js             ← Toutes les interactions avec l'API Telegram
│   └── payment.js              ← Logique de vérification des paiements
├── app/
│   └── api/
│       ├── telegram/webhook/[botToken]/route.js  ← Webhook Telegram
│       └── payment/verify/route.js               ← API de vérification manuelle
├── scripts/
│   └── ingest-course.js        ← Script CLI d'ingestion du contenu
├── content/
│   └── <course-id>.txt         ← Contenu de chaque formation
├── .env.local                  ← Vos secrets (ne pas committer !)
├── .env.local.example          ← Modèle de configuration
└── package.json
```

---

## Dépannage courant

**Le bot ne répond pas**
→ Vérifiez le webhook avec `/getWebhookInfo` (voir si `last_error_message` est rempli)
→ Vérifiez les logs dans Vercel > Functions > votre fonction

**Erreur "Formation introuvable" dans les logs**
→ Le `telegram_bot_token` dans la table `courses` ne correspond pas au token du webhook
→ Vérifiez que la colonne `active = TRUE`

**Le paiement est toujours en `needs_review`**
→ Vérifiez que le montant dans l'image correspond EXACTEMENT à `price_dzd` (pas de centimes)
→ L'image doit être nette — les vieux reçus froissés peuvent être illisibles pour le modèle de vision

**Erreur d'embedding Pinecone dimension mismatch**
→ Votre index Pinecone doit être en dimension **3072** (et non 1536 ou 768)
→ Supprimez et recréez l'index avec la bonne dimension, puis relancez l'ingestion
