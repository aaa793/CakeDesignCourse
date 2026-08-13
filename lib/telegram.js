// =============================================================================
// lib/telegram.js — Couche d'accès à l'API Telegram
// RÈGLE : Ce fichier est le SEUL endroit qui appelle api.telegram.org.
//         Aucun autre fichier ne doit faire d'appels directs à Telegram.
// =============================================================================

const TELEGRAM_BASE_URL = 'https://api.telegram.org/bot';
const TELEGRAM_FILE_URL = 'https://api.telegram.org/file/bot';

// -----------------------------------------------------------------------------
// callTelegramAPI(botToken, method, body)
// Fonction interne générique pour appeler n'importe quelle méthode de l'API Bot Telegram.
// Centralise la gestion des erreurs HTTP et JSON.
// -----------------------------------------------------------------------------
async function callTelegramAPI(botToken, method, body = {}) {
  const url = `${TELEGRAM_BASE_URL}${botToken}/${method}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`[Telegram] Erreur API ${method}: ${data.description} (code: ${data.error_code})`);
  }

  return data.result;
}

// -----------------------------------------------------------------------------
// sendTelegramMessage(botToken, chatId, text)
// Envoie un message texte à un utilisateur ou un groupe.
// parse_mode 'HTML' permet d'utiliser <b>, <i>, <code> pour formater.
// -----------------------------------------------------------------------------
export async function sendTelegramMessage(botToken, chatId, text) {
  return callTelegramAPI(botToken, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  });
}

// -----------------------------------------------------------------------------
// getTelegramFileUrl(botToken, fileId)
// Résout un file_id Telegram (opaque) en URL publique téléchargeable.
// Nécessaire pour télécharger les photos envoyées par l'utilisateur.
//
// ATTENTION : L'URL retournée n'est valide que ~1 heure — télécharger rapidement.
// -----------------------------------------------------------------------------
export async function getTelegramFileUrl(botToken, fileId) {
  const fileInfo = await callTelegramAPI(botToken, 'getFile', { file_id: fileId });
  // fileInfo.file_path est le chemin relatif sur les serveurs Telegram
  const fileUrl = `${TELEGRAM_FILE_URL}${botToken}/${fileInfo.file_path}`;
  return fileUrl;
}

// -----------------------------------------------------------------------------
// createSingleUseInviteLink(botToken, groupChatId)
// Génère un lien d'invitation Telegram à usage unique (member_limit: 1).
// Après qu'une personne l'a utilisé, le lien expire automatiquement.
// C'est le mécanisme d'accès sécurisé au groupe formation après paiement.
//
// PRÉREQUIS : Le bot doit être administrateur du groupe avec le droit
//             "Invite users via links".
// -----------------------------------------------------------------------------
export async function createSingleUseInviteLink(botToken, groupChatId) {
  const result = await callTelegramAPI(botToken, 'createChatInviteLink', {
    chat_id: groupChatId,
    member_limit: 1,         // Usage unique — expire après 1 utilisation
    creates_join_request: false, // Accès direct sans demande d'approbation
  });

  return result.invite_link;
}

// -----------------------------------------------------------------------------
// notifyAdmin(botToken, adminChatId, text)
// Envoie une notification au canal ou groupe admin.
// Utilisé pour alerter la cliente quand un paiement nécessite une vérif manuelle.
// -----------------------------------------------------------------------------
export async function notifyAdmin(botToken, adminChatId, text) {
  return callTelegramAPI(botToken, 'sendMessage', {
    chat_id: adminChatId,
    text,
    parse_mode: 'HTML',
  });
}

// -----------------------------------------------------------------------------
// sendTelegramPhoto(botToken, chatId, photoUrl, caption)
// Envoie une photo avec une légende — utile pour confirmer la réception
// d'un reçu ou envoyer des visuels de la formation.
// -----------------------------------------------------------------------------
export async function sendTelegramPhoto(botToken, chatId, photoUrl, caption = '') {
  return callTelegramAPI(botToken, 'sendPhoto', {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: 'HTML',
  });
}

// -----------------------------------------------------------------------------
// setWebhook(botToken, webhookUrl)
// Configure le webhook Telegram pour ce bot.
// Utile pour le script de setup initial (appelable manuellement).
// -----------------------------------------------------------------------------
export async function setWebhook(botToken, webhookUrl) {
  return callTelegramAPI(botToken, 'setWebhook', {
    url: webhookUrl,
    // Limite les types d'updates reçus pour réduire le trafic
    allowed_updates: ['message'],
    // Supprime les messages en attente lors du changement de webhook
    drop_pending_updates: true,
  });
}
