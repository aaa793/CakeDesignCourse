#!/usr/bin/env node
// =============================================================================
// scripts/ingest-course.js — Script d'ingestion du contenu d'une formation
//
// Usage :
//   node scripts/ingest-course.js --course-id=<uuid>
//
// Ce script :
//   1. Lit le fichier content/<course-id>.txt
//   2. Découpe le texte en chunks de ~300-500 mots par paragraphes
//   3. Embed chaque chunk via l'API Gemini
//   4. Upsert les vecteurs dans Pinecone au namespace de la formation
//
// À exécuter une fois lors de la création d'une nouvelle formation,
// et à relancer si le contenu du cours change.
// =============================================================================

// Chargement des variables d'environnement depuis .env.local
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query } from '../lib/db.js';
import { embedTextForDocument, upsertToPinecone } from '../lib/rag.js';

// Résolution du chemin racine du projet (compatible ESM)
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// Charge .env.local (Next.js utilise ce fichier pour les variables d'environnement)
config({ path: resolve(PROJECT_ROOT, '.env.local') });

// Délai entre chaque appel API pour respecter les rate limits Gemini
const EMBED_DELAY_MS = 200;

// -----------------------------------------------------------------------------
// parseArgs() — Parse les arguments de la ligne de commande
// Supporte --course-id=<uuid>
// -----------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const courseIdArg = args.find(arg => arg.startsWith('--course-id='));

  if (!courseIdArg) {
    console.error('❌ Argument manquant. Usage: node scripts/ingest-course.js --course-id=<uuid>');
    process.exit(1);
  }

  return { courseId: courseIdArg.split('=')[1] };
}

// -----------------------------------------------------------------------------
// splitIntoChunks(text, targetWordCount)
// Découpe le texte en chunks de ~targetWordCount mots.
//
// Stratégie : on coupe aux paragraphes (double saut de ligne) et on fusionne
// les paragraphes courts jusqu'à atteindre la taille cible.
// Cela préserve la cohérence sémantique (un chunk = un ou plusieurs paragraphes).
// -----------------------------------------------------------------------------
function splitIntoChunks(text, targetWordCount = 400) {
  // Nettoyage : suppression des espaces multiples et normalisation des fins de ligne
  const cleanText = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // Découpage par paragraphes (double saut de ligne)
  const paragraphs = cleanText.split('\n\n').filter(p => p.trim().length > 0);

  const chunks = [];
  let currentChunk = '';
  let currentWordCount = 0;

  for (const paragraph of paragraphs) {
    const paragraphWords = paragraph.trim().split(/\s+/).length;

    // Si ajouter ce paragraphe dépasse la cible ET qu'on a déjà du contenu,
    // on sauvegarde le chunk actuel et on repart
    if (currentWordCount + paragraphWords > targetWordCount && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = paragraph;
      currentWordCount = paragraphWords;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      currentWordCount += paragraphWords;
    }
  }

  // Dernier chunk restant
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

// -----------------------------------------------------------------------------
// sleep(ms) — Pause pour respecter les rate limits des APIs
// -----------------------------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// main() — Fonction principale du script
// -----------------------------------------------------------------------------
async function main() {
  const { courseId } = parseArgs();

  console.log(`\n🚀 Ingestion du contenu pour la formation: ${courseId}\n`);

  // Étape 1 : Récupération de la formation depuis la base de données
  console.log('📋 Récupération des informations de la formation...');
  const courseResult = await query(
    'SELECT id, name, pinecone_namespace FROM courses WHERE id = $1 AND active = TRUE',
    [courseId]
  );

  if (courseResult.rows.length === 0) {
    console.error(`❌ Formation introuvable ou inactive pour l'ID: ${courseId}`);
    process.exit(1);
  }

  const course = courseResult.rows[0];
  console.log(`✅ Formation trouvée: "${course.name}"`);
  console.log(`   Namespace Pinecone: ${course.pinecone_namespace}\n`);

  // Étape 2 : Lecture du fichier de contenu
  const contentPath = resolve(PROJECT_ROOT, 'content', `${courseId}.txt`);
  console.log(`📄 Lecture du fichier: ${contentPath}`);

  let rawText;
  try {
    rawText = readFileSync(contentPath, 'utf-8');
  } catch (err) {
    console.error(`❌ Impossible de lire le fichier: ${contentPath}`);
    console.error(`   Créez le fichier content/${courseId}.txt avec le contenu de la formation.`);
    process.exit(1);
  }

  console.log(`   ${rawText.split(/\s+/).length} mots trouvés dans le fichier.\n`);

  // Étape 3 : Découpage en chunks
  console.log('✂️  Découpage du texte en chunks...');
  const chunks = splitIntoChunks(rawText, 400);
  console.log(`   ${chunks.length} chunks créés.\n`);

  // Étape 4 : Embedding et préparation des vecteurs Pinecone
  console.log('🔢 Génération des embeddings (Gemini)...');
  const vectors = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const wordCount = chunk.split(/\s+/).length;

    process.stdout.write(`   Chunk ${i + 1}/${chunks.length} (${wordCount} mots)... `);

    try {
      const embedding = await embedTextForDocument(chunk);

      vectors.push({
        // ID unique basé sur le course-id et l'index du chunk
        id: `${courseId}_chunk_${i}`,
        values: embedding,
        metadata: {
          text: chunk,
          chunkIndex: i,
          courseId: courseId,
          courseName: course.name,
        },
      });

      process.stdout.write('✅\n');
    } catch (err) {
      process.stdout.write(`❌ Erreur: ${err.message}\n`);
      console.error(`   Le chunk ${i} sera ignoré. Continuons...`);
    }

    // Pause pour respecter les rate limits Gemini (max ~60 req/min sur le tier gratuit)
    if (i < chunks.length - 1) {
      await sleep(EMBED_DELAY_MS);
    }
  }

  console.log(`\n   ${vectors.length}/${chunks.length} chunks embeddés avec succès.\n`);

  if (vectors.length === 0) {
    console.error('❌ Aucun vecteur généré. Vérifiez votre clé API Gemini.');
    process.exit(1);
  }

  // Étape 5 : Upsert dans Pinecone par batch de 100 (limite Pinecone par requête)
  console.log(`📤 Upsert dans Pinecone (namespace: ${course.pinecone_namespace})...`);
  const BATCH_SIZE = 100;

  for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
    const batch = vectors.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(vectors.length / BATCH_SIZE);

    process.stdout.write(`   Batch ${batchNum}/${totalBatches} (${batch.length} vecteurs)... `);

    try {
      await upsertToPinecone(batch, course.pinecone_namespace);
      process.stdout.write('✅\n');
    } catch (err) {
      process.stdout.write(`❌\n`);
      console.error(`   Erreur batch ${batchNum}: ${err.message}`);
      process.exit(1);
    }
  }

  console.log(`\n🎉 Ingestion terminée avec succès !`);
  console.log(`   ${vectors.length} chunks indexés dans Pinecone.`);
  console.log(`   La formation "${course.name}" est maintenant prête à répondre aux questions.\n`);

  process.exit(0);
}

// Lancement du script
main().catch(err => {
  console.error('\n❌ Erreur fatale:', err.message);
  console.error(err.stack);
  process.exit(1);
});
