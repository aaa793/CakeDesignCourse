// =============================================================================
// lib/payment.js — Service de traitement des paiements
// RÈGLE : Ce fichier contient la logique métier de vérification des paiements.
//         Il utilise lib/db.js pour le SQL et lib/telegram.js pour Telegram.
//         Il ne connaît rien du HTTP direct.
// =============================================================================

import { buildPaymentExtractionPrompt } from './prompts.js';
import {
  getLeadWithCourseAndBusiness,
  createPayment,
  approvePayment,
  flagPaymentForReview,
  updateLeadStatus,
  isReferenceAlreadyUsed,
} from './db.js';
import {
  sendTelegramMessage,
  createSingleUseInviteLink,
  notifyAdmin,
} from './telegram.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const VISION_MODEL = 'google/gemini-2.5-flash';

// -----------------------------------------------------------------------------
// extractPaymentInfoFromImage(imageUrl)
// Appelle le modèle de vision via OpenRouter pour extraire les données
// d'une image de preuve de virement bancaire algérien.
//
// Retourne un objet { montant, reference, date, nom_expediteur }
// Les valeurs peuvent être null si non lisibles dans l'image.
// -----------------------------------------------------------------------------
export async function extractPaymentInfoFromImage(imageUrl) {
  const prompt = buildPaymentExtractionPrompt();

  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
      'X-Title': 'Formation Automation',
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompt,
            },
            {
              type: 'image_url',
              image_url: { url: imageUrl },
            },
          ],
        },
      ],
      max_tokens: 512,
      temperature: 0, // Température 0 pour des extractions factuelles reproductibles
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`[Payment] Erreur OpenRouter vision: ${response.status} — ${errText}`);
  }

  const data = await response.json();
  const rawContent = data.choices[0].message.content.trim();

  // Le modèle peut parfois entourer le JSON avec des backticks markdown
  const cleanedContent = rawContent.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  try {
    const parsed = JSON.parse(cleanedContent);
    return {
      montant: parsed.montant !== undefined ? Number(parsed.montant) : null,
      reference: parsed.reference || null,
      date: parsed.date || null,
      nom_expediteur: parsed.nom_expediteur || null,
    };
  } catch {
    console.error('[Payment] Impossible de parser la réponse vision JSON:', rawContent);
    // Retourne des nulls plutôt que de faire planter — sera marqué needs_review
    return { montant: null, reference: null, date: null, nom_expediteur: null };
  }
}

// -----------------------------------------------------------------------------
// verifyAndProcessPayment(leadId, imageUrl)
// Fonction principale qui orchestre tout le processus de vérification de paiement :
//
//   1. Récupère les données du lead, course et business depuis la DB
//   2. Crée un enregistrement payment en statut 'pending'
//   3. Extrait les données de l'image via le modèle de vision
//   4. Vérifie si le montant correspond au prix attendu
//   5. Vérifie si la référence n'a pas déjà été utilisée (anti-fraude)
//   6a. Si tout OK → approbation automatique, génération lien d'invite, message à l'acheteur
//   6b. Sinon → notification admin pour vérification manuelle
//
// Retourne : { status: 'auto_approved' | 'needs_review', reason?: string }
// -----------------------------------------------------------------------------
export async function verifyAndProcessPayment(leadId, imageUrl) {
  // Étape 1 : Chargement des données
  const lead = await getLeadWithCourseAndBusiness(leadId);

  if (!lead) {
    throw new Error(`[Payment] Lead introuvable: ${leadId}`);
  }

  const { telegram_user_id, telegram_bot_token, telegram_group_chat_id, admin_telegram_chat_id, price_dzd, course_name } = lead;

  // Étape 2 : Création du paiement en base (statut 'pending')
  const payment = await createPayment(leadId, imageUrl);
  const paymentId = payment.id;

  // Étape 3 : Extraction des données de l'image
  let extractedData = { montant: null, reference: null, date: null, nom_expediteur: null };
  try {
    extractedData = await extractPaymentInfoFromImage(imageUrl);
    console.log(`[Payment] Données extraites pour lead ${leadId}:`, extractedData);
  } catch (err) {
    console.error('[Payment] Erreur extraction vision:', err.message);
    // Continuera vers needs_review avec montant null
  }

  const { montant, reference, date: dateVirement, nom_expediteur: nomExpediteur } = extractedData;

  // Étape 4 & 5 : Vérifications
  const reasons = [];

  // Vérification du montant (tolérance de 0 DA — montant exact requis)
  const expectedAmount = Number(price_dzd);
  const detectedAmount = montant !== null ? Number(montant) : null;
  const amountMatches = detectedAmount !== null && detectedAmount === expectedAmount;

  if (!amountMatches) {
    if (detectedAmount === null) {
      reasons.push(`Montant illisible dans l'image`);
    } else {
      reasons.push(`Montant incorrect: ${detectedAmount} DA détecté, ${expectedAmount} DA attendu`);
    }
  }

  // Vérification anti-fraude de la référence
  let referenceAlreadyUsed = false;
  if (reference) {
    referenceAlreadyUsed = await isReferenceAlreadyUsed(reference);
    if (referenceAlreadyUsed) {
      reasons.push(`Référence "${reference}" déjà utilisée pour un autre paiement`);
    }
  } else {
    reasons.push(`Numéro de référence absent ou illisible`);
  }

  const isAutoApproved = amountMatches && !referenceAlreadyUsed && reference !== null;

  // Étape 6a : Approbation automatique
  if (isAutoApproved) {
    let inviteLink = null;

    try {
      // Génération du lien d'invitation à usage unique
      inviteLink = await createSingleUseInviteLink(telegram_bot_token, telegram_group_chat_id);
    } catch (err) {
      // Si la génération du lien échoue, on passe en needs_review plutôt que d'approuver sans lien
      console.error('[Payment] Erreur génération lien d\'invitation:', err.message);
      await flagPaymentForReview(paymentId, { montant, reference, nomExpediteur, dateVirement, reason: 'Échec génération lien invitation' });
      await updateLeadStatus(leadId, 'payment_pending');
      await notifyAdmin(
        telegram_bot_token,
        admin_telegram_chat_id,
        buildAdminAlertMessage(lead, { montant, reference, nomExpediteur, dateVirement }, `✅ Montant et référence OK mais erreur technique sur le lien d'invitation. Veuillez envoyer manuellement.\n\nErreur: ${err.message}`, paymentId)
      );
      return { status: 'needs_review', reason: 'Erreur génération lien' };
    }

    // Sauvegarde de l'approbation en base
    await approvePayment(paymentId, { montant, reference, nomExpediteur, dateVirement, inviteLink });
    await updateLeadStatus(leadId, 'approved');

    // Message de confirmation à l'acheteur (en darija par défaut — s'adapte à detected_lang si disponible)
    const confirmationMessage = buildApprovalMessage(lead, inviteLink);
    await sendTelegramMessage(telegram_bot_token, telegram_user_id, confirmationMessage);

    // Notification admin d'une vente réussie
    await notifyAdmin(
      telegram_bot_token,
      admin_telegram_chat_id,
      `✅ <b>Vente confirmée automatiquement</b>\n\n` +
      `Formation : ${course_name}\n` +
      `Acheteur : ${lead.telegram_username ? '@' + lead.telegram_username : telegram_user_id}\n` +
      `Montant : ${montant} DA\n` +
      `Référence : ${reference}\n` +
      `Expéditeur : ${nomExpediteur || 'N/A'}\n` +
      `Lien envoyé : ✅`
    ).catch(err => console.error('[Payment] Erreur notification admin (vente OK):', err.message));

    return { status: 'auto_approved', inviteLink };
  }

  // Étape 6b : Vérification manuelle nécessaire
  await flagPaymentForReview(paymentId, { montant, reference, nomExpediteur, dateVirement, reason: reasons.join('; ') });
  await updateLeadStatus(leadId, 'payment_pending');

  // Message à l'utilisateur pour le rassurer (sans lui dire pourquoi ça bloque)
  const pendingMessage = buildPendingMessage(lead);
  await sendTelegramMessage(telegram_bot_token, telegram_user_id, pendingMessage);

  // Alerte admin avec détail des problèmes détectés
  const adminAlert = buildAdminAlertMessage(lead, { montant, reference, nomExpediteur, dateVirement }, reasons.join('\n— '), paymentId);
  await notifyAdmin(telegram_bot_token, admin_telegram_chat_id, adminAlert)
    .catch(err => console.error('[Payment] Erreur notification admin (review):', err.message));

  return { status: 'needs_review', reasons };
}

// -----------------------------------------------------------------------------
// Messages Telegram — Fonctions utilitaires internes
// Ces fonctions construisent les textes envoyés aux utilisateurs.
// Rédigés en darija (avec fallback français) pour correspondre à l'audience cible.
// -----------------------------------------------------------------------------

function buildApprovalMessage(lead, inviteLink) {
  const lang = lead.detected_lang || 'dz';

  if (lang === 'fr') {
    return `🎉 <b>Paiement confirmé !</b>\n\n` +
      `Félicitations ! Votre inscription à la formation "${lead.course_name}" est validée.\n\n` +
      `Voici votre lien d'accès au groupe privé (usage unique) :\n${inviteLink}\n\n` +
      `⚠️ Ce lien ne fonctionne qu'une seule fois, ne le partagez pas.`;
  }

  if (lang === 'en') {
    return `🎉 <b>Payment confirmed!</b>\n\n` +
      `Congratulations! Your enrollment in "${lead.course_name}" is now validated.\n\n` +
      `Here's your private group link (single-use):\n${inviteLink}\n\n` +
      `⚠️ This link works only once, please don't share it.`;
  }

  // Darija par défaut
  return `🎉 <b>El paiement dyalek maqboul!</b>\n\n` +
    `Mabrouk! Inscription dyalek fi "${lead.course_name}" mwafaqa 100%.\n\n` +
    `Ha hna link dyalek lil groupe (rah yakhdem marra waHda ghir):\n${inviteLink}\n\n` +
    `⚠️ Ma tpartagi chi had link, ghir lik inta.`;
}

function buildPendingMessage(lead) {
  const lang = lead.detected_lang || 'dz';

  if (lang === 'fr') {
    return `📸 Merci pour votre reçu ! Nous l'avons bien reçu et nous vérifions votre paiement.\n\n` +
      `Vous recevrez votre lien d'accès dans les plus brefs délais. 🙏`;
  }

  if (lang === 'en') {
    return `📸 Thank you for your receipt! We've received it and are verifying your payment.\n\n` +
      `You'll receive your access link shortly. 🙏`;
  }

  // Darija par défaut
  return `📸 Chokran 3la swira dial reçu! Wslat lina, ghadi nverificiw el virement dyalek.\n\n` +
    `Ghadi twslek link dial accès fi aqrab waqt. 🙏`;
}

function buildAdminAlertMessage(lead, extractedData, reasonText, paymentId) {
  const { montant, reference, nomExpediteur, dateVirement } = extractedData;
  return `⚠️ <b>Paiement à vérifier manuellement</b>\n\n` +
    `Formation : ${lead.course_name}\n` +
    `Prix attendu : ${lead.price_dzd} DA\n` +
    `Lead : ${lead.telegram_username ? '@' + lead.telegram_username : lead.telegram_user_id}\n` +
    `Payment ID : <code>${paymentId}</code>\n\n` +
    `📊 <b>Données extraites :</b>\n` +
    `• Montant : ${montant !== null ? montant + ' DA' : 'Non lisible'}\n` +
    `• Référence : ${reference || 'Non trouvée'}\n` +
    `• Expéditeur : ${nomExpediteur || 'Non lisible'}\n` +
    `• Date : ${dateVirement || 'Non lisible'}\n\n` +
    `❌ <b>Problèmes détectés :</b>\n— ${reasonText}\n\n` +
    `👉 Vérifiez manuellement et envoyez le lien si valide.`;
}
