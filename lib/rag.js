// =============================================================================
// lib/rag.js — Service RAG (Retrieval-Augmented Generation)
// RÈGLE : Ce fichier contient la logique métier du RAG.
//         Il ne connaît rien du HTTP, de Telegram, ni du SQL.
// =============================================================================

import { buildSystemPrompt, buildUserMessageWithContext } from './prompts.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const GEMINI_EMBED_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';
const DEFAULT_MODEL = 'google/gemini-2.5-flash';

// -----------------------------------------------------------------------------
// embedText(text)
// Convertit un texte en vecteur d'embedding via l'API Gemini.
// Utilisé pour la recherche sémantique dans Pinecone.
// -----------------------------------------------------------------------------
export async function embedText(text) {
  const response = await fetch(`${GEMINI_EMBED_URL}?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/gemini-embedding-001',
      content: {
        parts: [{ text }],
      },
      // taskType RETRIEVAL_QUERY pour les requêtes, RETRIEVAL_DOCUMENT pour l'ingestion
      taskType: 'RETRIEVAL_QUERY',
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`[RAG] Erreur Gemini embedding: ${response.status} — ${errText}`);
  }

  const data = await response.json();
  return data.embedding.values; // Tableau de nombres flottants (vecteur)
}

// -----------------------------------------------------------------------------
// embedTextForDocument(text)
// Même chose mais avec taskType RETRIEVAL_DOCUMENT pour l'ingestion de chunks.
// Séparé de embedText pour respecter la recommandation Gemini sur les taskTypes.
// -----------------------------------------------------------------------------
export async function embedTextForDocument(text) {
  const response = await fetch(`${GEMINI_EMBED_URL}?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/gemini-embedding-001',
      content: {
        parts: [{ text }],
      },
      taskType: 'RETRIEVAL_DOCUMENT',
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`[RAG] Erreur Gemini embedding (document): ${response.status} — ${errText}`);
  }

  const data = await response.json();
  return data.embedding.values;
}

// -----------------------------------------------------------------------------
// queryPinecone(vector, namespace, topK)
// Recherche les chunks les plus proches dans Pinecone pour un namespace donné.
// Retourne un tableau de textes (les contenus des chunks matchés).
//
// Chaque namespace correspond à une formation — isolation totale des données.
// -----------------------------------------------------------------------------
export async function queryPinecone(vector, namespace, topK = 5) {
  const pineconeIndexUrl = process.env.PINECONE_INDEX_URL;

  const response = await fetch(`${pineconeIndexUrl}/query`, {
    method: 'POST',
    headers: {
      'Api-Key': process.env.PINECONE_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      vector,
      topK,
      namespace,
      includeMetadata: true,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`[RAG] Erreur Pinecone query: ${response.status} — ${errText}`);
  }

  const data = await response.json();

  // Extrait uniquement le texte des métadonnées de chaque chunk
  const texts = data.matches
    .filter(match => match.metadata && match.metadata.text)
    .map(match => match.metadata.text);

  return texts;
}

// -----------------------------------------------------------------------------
// upsertToPinecone(vectors, namespace)
// Insère ou met à jour des vecteurs dans Pinecone.
// Utilisé par le script d'ingestion.
// vectors : [{id, values, metadata: {text, chunkIndex, courseId}}]
// -----------------------------------------------------------------------------
export async function upsertToPinecone(vectors, namespace) {
  const pineconeIndexUrl = process.env.PINECONE_INDEX_URL;

  const response = await fetch(`${pineconeIndexUrl}/vectors/upsert`, {
    method: 'POST',
    headers: {
      'Api-Key': process.env.PINECONE_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ vectors, namespace }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`[RAG] Erreur Pinecone upsert: ${response.status} — ${errText}`);
  }

  return response.json();
}

// -----------------------------------------------------------------------------
// callOpenRouter(messages, model, options)
// Appel générique à l'API OpenRouter (compatible OpenAI).
// Centralise la gestion des erreurs et des headers nécessaires.
// -----------------------------------------------------------------------------
async function callOpenRouter(messages, model = DEFAULT_MODEL, options = {}) {
  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      // Headers recommandés par OpenRouter pour identifier l'app
      'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
      'X-Title': 'Formation Automation',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: options.maxTokens || 1024,
      temperature: options.temperature ?? 0.7,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`[RAG] Erreur OpenRouter: ${response.status} — ${errText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// -----------------------------------------------------------------------------
// parseIntentFromReply(rawReply)
// Extrait le JSON d'intent caché de la réponse du LLM.
// Le modèle est instruit de terminer ses réponses par :
//   <<<INTENT>>>{"intent": "...", "lang": "..."}
//
// Retourne { replyText, intent, lang }
// En cas d'erreur de parsing, renvoie des valeurs par défaut sûres.
// -----------------------------------------------------------------------------
function parseIntentFromReply(rawReply) {
  const INTENT_MARKER = '<<<INTENT>>>';
  const markerIndex = rawReply.lastIndexOf(INTENT_MARKER);

  if (markerIndex === -1) {
    // Le modèle n'a pas inclus le marqueur — réponse safe par défaut
    return {
      replyText: rawReply.trim(),
      intent: 'other',
      lang: 'fr',
    };
  }

  const replyText = rawReply.substring(0, markerIndex).trim();
  const intentJson = rawReply.substring(markerIndex + INTENT_MARKER.length).trim();

  try {
    const parsed = JSON.parse(intentJson);
    return {
      replyText,
      intent: parsed.intent || 'other',
      lang: parsed.lang || 'fr',
    };
  } catch {
    console.warn('[RAG] Impossible de parser l\'intent JSON:', intentJson);
    return { replyText, intent: 'other', lang: 'fr' };
  }
}

// -----------------------------------------------------------------------------
// generateReply(course, userMessage, conversationHistory)
// Fonction principale du RAG — orchestre tout le pipeline :
//   1. Embed la question de l'utilisateur
//   2. Cherche les chunks pertinents dans Pinecone (namespace de la formation)
//   3. Construit le prompt avec contexte RAG
//   4. Appelle le LLM via OpenRouter
//   5. Parse la réponse pour extraire le texte et l'intent
//
// Paramètres :
//   course : objet retourné par getCourseByBotToken()
//   userMessage : string, le message brut de l'utilisateur
//   conversationHistory : [{direction: 'in'|'out', content: string}]
//
// Retourne : { replyText: string, intent: string, lang: string }
// -----------------------------------------------------------------------------
export async function generateReply(course, userMessage, conversationHistory = []) {
  // Étape 1 : Embedding de la question
  let ragContext = '';
  try {
    const questionVector = await embedText(userMessage);

    // Étape 2 : Recherche sémantique dans Pinecone
    const chunks = await queryPinecone(questionVector, course.pinecone_namespace, 5);
    ragContext = chunks.join('\n\n---\n\n');
  } catch (err) {
    // Le RAG échoue → on continue quand même avec un contexte vide
    // Le modèle répondra en se basant sur le prompt système uniquement
    console.error('[RAG] Erreur RAG (embed/pinecone), réponse sans contexte:', err.message);
  }

  // Étape 3 : Construction des messages pour le LLM
  const systemPrompt = buildSystemPrompt(course);
  const userMessageWithContext = buildUserMessageWithContext(userMessage, ragContext);

  // Construction de l'historique de conversation au format OpenAI messages[]
  const messages = [
    { role: 'system', content: systemPrompt },
    // Injection de l'historique des N derniers messages
    ...conversationHistory.map(msg => ({
      role: msg.direction === 'in' ? 'user' : 'assistant',
      content: msg.content,
    })),
    // Message actuel avec le contexte RAG injecté
    { role: 'user', content: userMessageWithContext },
  ];

  // Étape 4 : Appel LLM
  const rawReply = await callOpenRouter(messages, DEFAULT_MODEL, { maxTokens: 1024 });

  // Étape 5 : Parsing de la réponse
  return parseIntentFromReply(rawReply);
}
