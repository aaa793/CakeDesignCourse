// =============================================================================
// app/api/payment/verify/route.js
// Route POST — Vérification manuelle d'un paiement
//
// RÈGLE : Ce fichier ne contient AUCUNE logique. Il reçoit { leadId, imageUrl },
//         délègue entièrement à lib/payment.js, et retourne le résultat en JSON.
//
// Usage : appelable depuis un dashboard admin pour déclencher une vérif manuelle.
// =============================================================================

import { verifyAndProcessPayment } from '@/lib/payment';

export async function POST(request) {
  try {
    const body = await request.json();
    const { leadId, imageUrl } = body;

    // Validation minimale des paramètres requis
    if (!leadId || !imageUrl) {
      return Response.json(
        { error: 'Paramètres manquants : leadId et imageUrl sont requis' },
        { status: 400 }
      );
    }

    // Délégation complète au service payment — toute la logique est là-bas
    const result = await verifyAndProcessPayment(leadId, imageUrl);

    return Response.json({ ok: true, ...result });

  } catch (err) {
    console.error('[API /payment/verify] Erreur:', err.message);
    return Response.json(
      { error: err.message },
      { status: 500 }
    );
  }
}
