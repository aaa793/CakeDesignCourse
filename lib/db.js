// =============================================================================
// lib/db.js — Couche Repository (accès base de données uniquement)
// RÈGLE : Ce fichier est le SEUL endroit où des requêtes SQL sont exécutées.
//         Aucun autre fichier ne doit contenir de SQL.
// =============================================================================

import { Pool } from 'pg';

// Pool de connexions PostgreSQL — réutilisé entre les invocations serverless
// grâce au module caching de Node.js (évite de créer une connexion à chaque requête)
let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Sur Vercel/Neon, SSL est requis en production
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      // Limite le nombre de connexions pour rester dans les quotas Neon/Supabase
      max: 10,
    });
  }
  return pool;
}

// -----------------------------------------------------------------------------
// query(text, params) — Exécute une requête SQL paramétrée
// Fonction de bas niveau utilisée par toutes les autres fonctions de ce fichier
// -----------------------------------------------------------------------------
export async function query(text, params) {
  const client = getPool();
  try {
    const result = await client.query(text, params);
    return result;
  } catch (err) {
    console.error('[DB] Erreur requête SQL:', err.message, '| Requête:', text);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// getCourseByBotToken(botToken)
// Retourne les infos complètes de la formation + business associés à un token bot.
// Appelé à chaque webhook pour identifier "qui parle à qui".
// -----------------------------------------------------------------------------
export async function getCourseByBotToken(botToken) {
  const sql = `
    SELECT
      c.id                      AS course_id,
      c.name                    AS course_name,
      c.description             AS course_description,
      c.price_dzd,
      c.payment_info,
      c.pinecone_namespace,
      c.telegram_bot_token,
      c.telegram_bot_username,
      c.telegram_group_chat_id,
      c.active,
      b.id                      AS business_id,
      b.name                    AS business_name,
      b.admin_telegram_chat_id
    FROM courses c
    JOIN businesses b ON b.id = c.business_id
    WHERE c.telegram_bot_token = $1
      AND c.active = TRUE
    LIMIT 1
  `;
  const result = await query(sql, [botToken]);
  return result.rows[0] || null;
}

// -----------------------------------------------------------------------------
// getOrCreateLead(businessId, courseId, telegramUserId, telegramUsername)
// Récupère ou crée un lead pour cet utilisateur dans cette formation.
// La contrainte UNIQUE (course_id, telegram_user_id) gère les doublons côté DB.
// On utilise ON CONFLICT pour être idempotent (safe à appeler à chaque message).
// -----------------------------------------------------------------------------
export async function getOrCreateLead(businessId, courseId, telegramUserId, telegramUsername) {
  const sql = `
    INSERT INTO leads (business_id, course_id, telegram_user_id, telegram_username, last_message_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (course_id, telegram_user_id)
    DO UPDATE SET
      last_message_at = NOW(),
      -- Met à jour le username s'il a changé (Telegram le permet)
      telegram_username = EXCLUDED.telegram_username
    RETURNING *
  `;
  const result = await query(sql, [businessId, courseId, String(telegramUserId), telegramUsername || null]);
  return result.rows[0];
}

// -----------------------------------------------------------------------------
// updateLeadStatus(leadId, status)
// Met à jour le statut du parcours d'un lead (ex: 'new' → 'interested')
// -----------------------------------------------------------------------------
export async function updateLeadStatus(leadId, status) {
  const sql = `
    UPDATE leads
    SET status = $2
    WHERE id = $1
    RETURNING *
  `;
  const result = await query(sql, [leadId, status]);
  return result.rows[0];
}

// -----------------------------------------------------------------------------
// updateLeadLang(leadId, lang)
// Persiste la langue détectée pour adapter les futurs messages automatiques
// -----------------------------------------------------------------------------
export async function updateLeadLang(leadId, lang) {
  const sql = `
    UPDATE leads
    SET detected_lang = $2
    WHERE id = $1
  `;
  await query(sql, [leadId, lang]);
}

// -----------------------------------------------------------------------------
// logMessage(leadId, direction, content)
// Enregistre un message entrant ('in') ou sortant ('out') dans l'historique.
// Utilisé pour construire l'historique de conversation dans le prompt LLM.
// -----------------------------------------------------------------------------
export async function logMessage(leadId, direction, content) {
  const sql = `
    INSERT INTO messages (lead_id, direction, content)
    VALUES ($1, $2, $3)
    RETURNING id
  `;
  const result = await query(sql, [leadId, direction, content]);
  return result.rows[0];
}

// -----------------------------------------------------------------------------
// getConversationHistory(leadId, limit)
// Récupère les N derniers messages pour construire le contexte de conversation
// -----------------------------------------------------------------------------
export async function getConversationHistory(leadId, limit = 10) {
  const sql = `
    SELECT direction, content, created_at
    FROM messages
    WHERE lead_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `;
  const result = await query(sql, [leadId, limit]);
  // Inverse l'ordre pour avoir chronologique (DESC → on prend les N derniers, puis on remet dans l'ordre)
  return result.rows.reverse();
}

// -----------------------------------------------------------------------------
// getLeadWithCourseAndBusiness(leadId)
// Récupère toutes les données nécessaires pour traiter un paiement :
// lead + course + business en une seule jointure
// -----------------------------------------------------------------------------
export async function getLeadWithCourseAndBusiness(leadId) {
  const sql = `
    SELECT
      l.id                      AS lead_id,
      l.telegram_user_id,
      l.telegram_username,
      l.status                  AS lead_status,
      l.detected_lang,
      c.id                      AS course_id,
      c.name                    AS course_name,
      c.price_dzd,
      c.payment_info,
      c.telegram_bot_token,
      c.telegram_group_chat_id,
      b.id                      AS business_id,
      b.admin_telegram_chat_id
    FROM leads l
    JOIN courses c ON c.id = l.course_id
    JOIN businesses b ON b.id = l.business_id
    WHERE l.id = $1
  `;
  const result = await query(sql, [leadId]);
  return result.rows[0] || null;
}

// -----------------------------------------------------------------------------
// createPayment(leadId, proofImageUrl)
// Crée un enregistrement de paiement en statut 'pending'
// -----------------------------------------------------------------------------
export async function createPayment(leadId, proofImageUrl) {
  const sql = `
    INSERT INTO payments (lead_id, proof_image_url)
    VALUES ($1, $2)
    RETURNING *
  `;
  const result = await query(sql, [leadId, proofImageUrl]);
  return result.rows[0];
}

// -----------------------------------------------------------------------------
// approvePayment(paymentId, data)
// Met à jour le paiement avec les données extraites et le statut approuvé
// -----------------------------------------------------------------------------
export async function approvePayment(paymentId, { montant, reference, nomExpediteur, dateVirement, inviteLink }) {
  const sql = `
    UPDATE payments
    SET
      montant_detecte     = $2,
      reference_detectee  = $3,
      nom_expediteur      = $4,
      date_virement       = $5,
      status              = 'auto_approved',
      telegram_invite_link = $6,
      verified_at         = NOW()
    WHERE id = $1
    RETURNING *
  `;
  const result = await query(sql, [paymentId, montant, reference, nomExpediteur, dateVirement, inviteLink]);
  return result.rows[0];
}

// -----------------------------------------------------------------------------
// flagPaymentForReview(paymentId, data)
// Marque le paiement comme nécessitant une vérification manuelle
// -----------------------------------------------------------------------------
export async function flagPaymentForReview(paymentId, { montant, reference, nomExpediteur, dateVirement, reason }) {
  const sql = `
    UPDATE payments
    SET
      montant_detecte    = $2,
      reference_detectee = $3,
      nom_expediteur     = $4,
      date_virement      = $5,
      status             = 'needs_review'
    WHERE id = $1
    RETURNING *
  `;
  const result = await query(sql, [paymentId, montant, reference, nomExpediteur, dateVirement]);
  return result.rows[0];
}

// -----------------------------------------------------------------------------
// isReferenceAlreadyUsed(reference)
// Vérifie si une référence de virement a déjà été approuvée (anti-fraude)
// -----------------------------------------------------------------------------
export async function isReferenceAlreadyUsed(reference) {
  const sql = `
    SELECT id FROM payments
    WHERE reference_detectee = $1
      AND status = 'auto_approved'
    LIMIT 1
  `;
  const result = await query(sql, [reference]);
  return result.rows.length > 0;
}
