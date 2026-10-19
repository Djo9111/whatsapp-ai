# WhatsApp AI Bot

Bot WhatsApp qui répond automatiquement à une liste de contacts autorisés, avec un modèle local via Ollama.

## Fonctionnement

- Connexion à WhatsApp Web avec whatsapp-web.js (session conservée via LocalAuth)
- Réponses générées par un modèle Ollama local
- Liste blanche de contacts, compatible avec les identifiants `@lid`
- Historique court par conversation (10 derniers échanges)
- Stickers, images, vocaux et documents convertis en description texte pour le modèle
- Protections : cooldown entre réponses, limite quotidienne par contact, longueur maximale

## Prérequis

- Node.js 18 ou plus récent
- Google Chrome installé
- Ollama lancé en local avec le modèle choisi (`ollama pull qwen2.5:1.5b`)

## Installation

```bash
npm install
cp config.example.json config.json
```

Renseigne ensuite tes contacts autorisés dans `config.json` (format international sans le +, exemple `221770000000`).

## Lancement

```bash
node bot.js
```

Au premier lancement, scanne le QR code avec WhatsApp (Appareils connectés).

## Sécurité

`config.json`, `.wwebjs_auth/` et `.wwebjs_cache/` sont exclus du dépôt. Le dossier `.wwebjs_auth/` contient la session WhatsApp : ne le partage jamais.