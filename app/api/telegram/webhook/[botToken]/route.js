// =============================================================================
// app/api/telegram/webhook/[botToken]/route.js
// Route POST — Point d'entrée des updates Telegram via webhook
//
// RÈGLE : Ce fichier ne contient AUCUNE logique métier ni SQL.
//         Il reçoit la requête HTTP, délègue aux services lib/, retourne 200.
//
// URL : POST /api/telegram/webhook/<bot_token>
// Chaque bot a sa propre URL webhook — le token dans l'URL identifie la formation.
// =============================================================================

import { getCourseByBotToken, getOrCreateLead, updateLeadStatus, logMessage, getConversationHistory, updateLeadLang } from '@/lib/db';
import { generateReply } from '@/lib/rag';
import { sendTelegramMessage, getTelegramFileUrl, notifyAdmin } from '@/lib/telegram';
import { verifyAndProcessPayment } from '@/lib/payment';

// Timeout Vercel pour les routes API (60s max sur le plan Pro, 10s sur Hobby)
export const maxDuration = 60;

export async function POST(request, { params }) {
  // IMPORTANT : Le webhook Telegram DOIT toujours retourner 200 OK rapidement.
  // Si on retourne autre chose, Telegram réessaie la requête en boucle pendant 24h.
  // Toute la gestion d'erreur est donc dans un try/catch global qui log et retourne 200.

  try {
    const botToken = params.botToken;

    // Parse du corps de la requête Telegram
    let update;
    try {
      update = await request.json();
    } catch {
      console.error('[Webhook] Corps de requête invalide (pas du JSON)');
      return Response.json({ ok: true });
    }

    // On ne traite que les messages (pas les edited_message, callback_query, etc.)
    const message = update.message;
    if (!message) {
      return Response.json({ ok: true });
    }

    // Ignorer les messages venant de groupes ou canaux
    // Le bot ne doit traiter que les conversations privées (DM)
    if (message.chat.type !== 'private') {
      return Response.json({ ok: true });
    }

    // Identification de la formation via le token du bot
    const course = await getCourseByBotToken(botToken);
    if (!course) {
      console.error(`[Webhook] Aucune formation trouvée pour le token: ${botToken}`);
      return Response.json({ ok: true });
    }

    // Extraction des infos de l'utilisateur depuis l'update Telegram
    const telegramUserId = String(message.from.id);
    const telegramUsername = message.from.username || null;

    // Récupération ou création du lead (idempotent grâce à ON CONFLICT en DB)
    const lead = await getOrCreateLead(
      course.business_id,
      course.course_id,
      telegramUserId,
      telegramUsername
    );

    // -------------------------------------------------------------------------
    // CAS 1 : L'utilisateur envoie une photo (preuve de paiement)
    // -------------------------------------------------------------------------
    if (message.photo && message.photo.length > 0) {
      // Telegram envoie plusieurs versions de la photo à différentes résolutions.
      // On prend la dernière (index -1) qui est toujours la plus haute qualité.
      const highestQualityPhoto = message.photo[message.photo.length - 1];

      try {
        // Résolution du file_id en URL téléchargeable
        const imageUrl = await getTelegramFileUrl(botToken, highestQualityPhoto.file_id);

        // Traitement complet du paiement (extraction vision, vérification, approbation)
        await verifyAndProcessPayment(lead.id, imageUrl);

        // logMessage de la réception de la photo (le texte de remplacement indique que c'était une image)
        await logMessage(lead.id, 'in', '[Photo envoyée par l\'utilisateur]');

      } catch (err) {
        console.error('[Webhook] Erreur traitement photo:', err.message);
        // En cas d'erreur, prévenir l'utilisateur sans crasher le webhook
        await sendTelegramMessage(
          botToken,
          telegramUserId,
          '😕 Une erreur est survenue lors du traitement de votre image. Veuillez réessayer dans quelques instants.'
        ).catch(() => {}); // Erreur silencieuse si le message de fallback échoue aussi
      }

      return Response.json({ ok: true });
    }

    // -------------------------------------------------------------------------
    // CAS 2 : L'utilisateur envoie un message texte
    // -------------------------------------------------------------------------
    if (message.text) {
      const userText = message.text;

      // Enregistrement du message entrant
      await logMessage(lead.id, 'in', userText);

      // Récupération de l'historique pour le contexte de conversation
      const history = await getConversationHistory(lead.id, 10);

      // Génération de la réponse via le pipeline RAG
      let replyText = '';
      let intent = 'other';
      let lang = lead.detected_lang || 'fr';

      try {
        const result = await generateReply(course, userText, history);
        replyText = result.replyText;
        intent = result.intent;
        lang = result.lang;
      } catch (err) {
        console.error('[Webhook] Erreur generateReply:', err.message);
        // Réponse de fallback générique en cas d'erreur LLM
        replyText = 'Merci pour votre message ! Une erreur technique est survenue. Veuillez réessayer dans quelques instants. 🙏';
      }

      // Envoi de la réponse à l'utilisateur
      try {
        await sendTelegramMessage(botToken, telegramUserId, replyText);
      } catch (err) {
        console.error('[Webhook] Erreur envoi message Telegram:', err.message);
      }

      // Enregistrement de la réponse sortante
      if (replyText) {
        await logMessage(lead.id, 'out', replyText);
      }

      // Mise à jour de la langue détectée si elle a changé
      if (lang && lang !== lead.detected_lang) {
        await updateLeadLang(lead.id, lang).catch(() => {});
      }

      // -----------------------------------------------------------------------
      // Gestion des intents : actions déclenchées selon le résultat du LLM
      // -----------------------------------------------------------------------

      if (intent === 'interested' && lead.status === 'new') {
        // Le bot a détecté un intérêt → mise à jour du statut du lead
        await updateLeadStatus(lead.id, 'interested').catch(() => {});

        // Notification admin d'un nouveau lead intéressé
        await notifyAdmin(
          botToken,
          course.admin_telegram_chat_id,
          `🔥 <b>Nouveau lead intéressé !</b>\n\n` +
          `Formation : ${course.course_name}\n` +
          `Utilisateur : ${telegramUsername ? '@' + telegramUsername : telegramUserId}\n` +
          `Langue détectée : ${lang}\n\n` +
          `Les infos de paiement ont été envoyées automatiquement.`
        ).catch(err => console.error('[Webhook] Erreur notif admin (interested):', err.message));
      }

      if (intent === 'payment_sent') {
        // L'utilisateur mentionne avoir envoyé son paiement mais sans photo
        // → On lui rappelle d'envoyer la photo du reçu
        const reminderMessage = lang === 'dz'
          ? '📸 Wajib tbi3tli swira dial reçu/virement dyalek. Abi3 photo mn galerie dyalek direct hna !'
          : lang === 'en'
            ? '📸 Please send a photo of your payment receipt directly here in the chat!'
            : '📸 Merci ! Envoyez maintenant une photo de votre reçu de virement directement dans ce chat.';

        await sendTelegramMessage(botToken, telegramUserId, reminderMessage)
          .catch(() => {});
      }

      return Response.json({ ok: true });
    }

    // Tout autre type de message (sticker, audio, etc.) → ignorer silencieusement
    return Response.json({ ok: true });

  } catch (err) {
    // Erreur non gérée au niveau global → log côté serveur, 200 OK pour Telegram
    console.error('[Webhook] Erreur critique non gérée:', err.message, err.stack);
    return Response.json({ ok: true });
  }
}
