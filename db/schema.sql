-- =============================================================================
-- SCHÉMA DE LA BASE DE DONNÉES
-- Système multi-tenant de vente de formations en ligne via Telegram
-- =============================================================================

-- Extension pour générer des UUID côté Postgres
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- TABLE : businesses
-- Représente une cliente (ex: une pâtissière) qui possède plusieurs formations
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS businesses (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    TEXT NOT NULL,
  -- Chat ID du canal ou groupe Telegram admin de cette cliente
  admin_telegram_chat_id  TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- TABLE : courses
-- Représente une formation spécifique (ex: "Cake Design Débutant").
-- Chaque formation a son propre bot Telegram et son propre groupe.
-- C'est ici que réside tout le paramétrage multi-tenant.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS courses (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id             UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  description             TEXT,
  -- Prix exact attendu pour le paiement, en dinars algériens
  price_dzd               NUMERIC(10, 2) NOT NULL,
  -- Texte complet à envoyer à l'utilisateur intéressé (RIB, CCP, instructions)
  payment_info            TEXT NOT NULL,
  -- Namespace Pinecone isolé pour les embeddings de cette formation
  pinecone_namespace      TEXT NOT NULL UNIQUE,
  -- Token du bot Telegram dédié à cette formation (ex: "7123456789:AAHx...")
  telegram_bot_token      TEXT NOT NULL UNIQUE,
  telegram_bot_username   TEXT NOT NULL,
  -- Chat ID du groupe Telegram privé auquel on invite les acheteurs
  telegram_group_chat_id  TEXT NOT NULL,
  active                  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- TABLE : leads
-- Représente un utilisateur Telegram qui a interagi avec un bot de formation.
-- Un lead est unique par (course_id, telegram_user_id) — un utilisateur peut
-- être lead de plusieurs formations différentes sans conflit.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  course_id             UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  telegram_user_id      TEXT NOT NULL,
  telegram_username     TEXT,
  -- Statut du parcours : new → interested → payment_pending → approved / rejected
  status                TEXT NOT NULL DEFAULT 'new'
                          CHECK (status IN ('new', 'interested', 'payment_pending', 'approved', 'rejected')),
  -- Langue détectée de l'utilisateur : 'fr', 'en', 'dz' (darija)
  detected_lang         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Un utilisateur ne peut être lead qu'une seule fois par formation
  UNIQUE (course_id, telegram_user_id)
);

-- Index pour accélérer les recherches par bot (webhook)
CREATE INDEX IF NOT EXISTS idx_leads_telegram_user ON leads(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_leads_course ON leads(course_id);

-- -----------------------------------------------------------------------------
-- TABLE : messages
-- Historique complet des échanges pour chaque lead.
-- Utilisé pour construire l'historique de conversation dans le contexte LLM.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- 'in' = message reçu de l'utilisateur, 'out' = réponse envoyée par le bot
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, created_at);

-- -----------------------------------------------------------------------------
-- TABLE : payments
-- Trace chaque preuve de paiement envoyée par un lead.
-- Une même référence de virement ne doit jamais être utilisée deux fois.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- URL publique de l'image de preuve (fichier Telegram résolu)
  proof_image_url     TEXT NOT NULL,
  -- Données extraites par le modèle de vision
  montant_detecte     NUMERIC(10, 2),
  reference_detectee  TEXT,
  nom_expediteur      TEXT,
  date_virement       TEXT,
  -- 'pending' → 'auto_approved' ou 'needs_review'
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'auto_approved', 'needs_review', 'rejected')),
  -- Lien d'invitation Telegram généré après approbation automatique
  telegram_invite_link TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at         TIMESTAMPTZ
);

-- Index UNIQUE PARTIEL : une référence de virement ne peut être approuvée
-- qu'une seule fois. Empêche la fraude par réutilisation du même reçu.
-- Partiel sur 'auto_approved' uniquement car les 'needs_review' peuvent
-- avoir des références null ou en cours de validation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_reference_unique
  ON payments (reference_detectee)
  WHERE status = 'auto_approved' AND reference_detectee IS NOT NULL;
