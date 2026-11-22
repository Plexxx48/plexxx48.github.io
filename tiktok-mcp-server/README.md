# Serveur MCP TikTok (OAuth)

Serveur MCP **distant** (Streamable HTTP) qui connecte Claude (ou tout client MCP) à un compte TikTok,
avec une connexion **OAuth 2.1** complète : l'utilisateur clique sur « Se connecter », se connecte
à TikTok, et c'est tout. Aucun jeton à copier-coller.

## Outils disponibles

| Outil | Scope TikTok | Description |
|---|---|---|
| `get_profile` | `user.info.basic` (+ `profile`, `stats`) | Profil, abonnés, likes, nombre de vidéos |
| `list_videos` | `video.list` | Vidéos récentes avec vues / likes / commentaires / partages |
| `get_videos` | `video.list` | Détails et stats de vidéos précises |
| `get_creator_info` | `video.publish` | Options de publication (niveaux de confidentialité autorisés, etc.) |
| `publish_video` | `video.publish` | Publication directe d'une vidéo à partir d'une URL |
| `upload_video_draft` | `video.upload` | Envoi d'une vidéo en brouillon dans la boîte de réception TikTok |
| `get_post_status` | `video.publish` / `video.upload` | Suivi du traitement d'une publication |

## Fonctionnement de l'OAuth

```
Claude ──(1) /register, /authorize + PKCE──▶ Serveur MCP ──(2) redirection──▶ TikTok Login
Claude ◀─(4) code du serveur MCP──────────── Serveur MCP ◀─(3) /oauth/tiktok/callback──┘
Claude ──(5) /token ─▶ jetons du serveur MCP (les jetons TikTok ne quittent jamais le serveur)
```

- Les jetons TikTok sont **chiffrés** (AES-256-GCM) et **renouvelés automatiquement** (ils expirent après 24 h).
- Les jetons émis vers Claude sont stockés sous forme de hachage et tournent à chaque rafraîchissement.

## 1. Configurer l'application TikTok

1. Sur <https://developers.tiktok.com>, ouvrez (ou créez) votre application.
2. Ajoutez les produits **Login Kit**, **Display API** et **Content Posting API**
   (activez « Direct Post » pour `publish_video`).
3. Activez les scopes voulus : `user.info.basic`, `user.info.profile`, `user.info.stats`,
   `video.list`, `video.publish`, `video.upload`.
4. Dans Login Kit, ajoutez la **Redirect URI** : `https://VOTRE-SERVEUR/oauth/tiktok/callback`
5. URL de politique de confidentialité / conditions : vous pouvez utiliser
   `https://plexxx48.github.io/privacy.html` et `https://plexxx48.github.io/terms.html`.
6. Notez le **Client Key** et le **Client Secret**.

> Tant que l'application n'a pas passé l'audit de TikTok, les vidéos publiées sont limitées à
> `SELF_ONLY` (privées) et les comptes doivent être ajoutés comme testeurs (Sandbox).

## 2. Lancer en local

Node.js 22.9 ou plus récent est requis.

```bash
cd tiktok-mcp-server
npm install
cp .env.example .env     # puis remplissez les valeurs
npm start
npm test                 # test de bout en bout avec un faux TikTok
```

TikTok exige une Redirect URI en HTTPS : pour tester en local, exposez le port avec un tunnel
(ex. `cloudflared tunnel --url http://localhost:3000` ou `ngrok http 3000`) et mettez l'URL
obtenue dans `PUBLIC_URL` et dans la Redirect URI de l'app TikTok.

## 3. Déployer

N'importe quel hébergeur Node.js ou Docker convient (Render, Railway, Fly.io, un VPS…) :

```bash
docker build -t tiktok-mcp .
docker run -p 3000:3000 -v tiktok-mcp-data:/data --env-file .env tiktok-mcp
```

Important : `DATA_FILE` doit être sur un **disque persistant**, sinon les connexions sont perdues
à chaque redémarrage. **GitHub Pages ne peut pas héberger ce serveur** (site statique uniquement).

## 4. Ajouter le connecteur dans Claude

- **claude.ai / application Claude** : Paramètres → Connecteurs → *Ajouter un connecteur personnalisé*
  → URL : `https://VOTRE-SERVEUR/mcp`. Cliquez sur « Se connecter » et autorisez TikTok.
- **Claude Code** :
  ```bash
  claude mcp add --transport http tiktok https://VOTRE-SERVEUR/mcp
  ```
  puis lancez `/mcp` dans Claude Code pour vous authentifier.

## Variables d'environnement

| Variable | Obligatoire | Description |
|---|---|---|
| `PUBLIC_URL` | oui (prod) | URL publique HTTPS du serveur |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | oui | Identifiants de l'app TikTok |
| `TOKEN_ENCRYPTION_SECRET` | oui | ≥ 32 caractères aléatoires (`openssl rand -base64 48`) |
| `TIKTOK_SCOPES` | non | Scopes demandés (doivent être activés dans l'app) |
| `DATA_FILE` | non | Emplacement du stockage (défaut `./data/store.json`) |
| `ALLOWED_TIKTOK_OPEN_IDS` | recommandé | Limite le serveur à vos comptes TikTok |
| `ACCESS_TOKEN_TTL_SEC` | non | Durée des jetons émis vers Claude (défaut 3600) |
| `MAX_VIDEO_MB` | non | Taille max des vidéos téléchargées (défaut 1024) |

### Sécurité

- Ne commitez jamais `.env` ni le dossier `data/` (déjà dans `.gitignore`).
- Renseignez `ALLOWED_TIKTOK_OPEN_IDS` : sans cela, n'importe qui connaissant l'URL peut
  connecter **son propre** compte TikTok via votre application. Votre `open_id` s'affiche dans
  les logs du serveur à la première connexion.

## Publication de vidéos

`publish_video` prend une `video_url` publique :
- `upload_method: "file_upload"` (défaut) : le serveur télécharge la vidéo et l'envoie à TikTok
  par morceaux. Fonctionne avec n'importe quelle URL.
- `upload_method: "pull_from_url"` : TikTok récupère lui-même l'URL. Le domaine doit être vérifié
  dans votre app TikTok.

Conformément aux règles de TikTok, l'assistant doit appeler `get_creator_info` et faire confirmer
la légende et le niveau de confidentialité avant de publier.
