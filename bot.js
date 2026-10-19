const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

const config = JSON.parse(
  fs.readFileSync('./config.json', 'utf8')
);

const allowed = new Set(
  (config.allowedContacts || []).map(String)
);

const conversations = new Map();
const lastReplyAt = new Map();
const dailyCounts = new Map();
const processedIds = new Set();
const processing = new Set();

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath:
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false,
    dumpio: true,
    timeout: 60000,
    args: ['--disable-gpu']
  }
});

client.on('qr', qr => {
  console.log('Scanne ce QR code avec WhatsApp :');
  qrcode.generate(qr, { small: true });
});

client.on('loading_screen', (percent, message) => {
  console.log('Chargement WhatsApp Web :', percent + '%', message);
});

client.on('authenticated', () => {
  console.log('Authentifié. Synchronisation en cours...');
});

client.on('change_state', state => {
  console.log("Changement d'état :", state);
});

client.on('ready', () => {
  console.log('Bot connecté. En attente de messages...');
});

client.on('auth_failure', msg => {
  console.error('Échec authentification :', msg);
});

client.on('disconnected', reason => {
  console.log('WhatsApp déconnecté :', reason);
});

async function askOllama(chatId, text) {
  const history = conversations.get(chatId) || [];

  const messages = [
    { role: 'system', content: config.systemPrompt },
    ...history,
    { role: 'user', content: text }
  ];

  console.log('Appel à Ollama...');
  console.log('Modèle utilisé :', config.model);

  const response = await fetch(
    'http://127.0.0.1:11434/api/chat',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: 220
        }
      }),
      signal: AbortSignal.timeout(120000)
    }
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `Ollama HTTP ${response.status}: ${details}`
    );
  }

  const data = await response.json();
  const answer = data.message?.content?.trim();

  if (!answer) {
    throw new Error('Réponse IA vide');
  }

  const finalAnswer = answer.slice(
    0,
    config.maxReplyLength || 2000
  );

  const updated = [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: finalAnswer }
  ].slice(-10);

  conversations.set(chatId, updated);

  console.log('Réponse Ollama reçue.');

  return finalAnswer;
}

// Types non textuels acceptés, traduits en description pour le modèle.
// Le modèle est uniquement textuel : il ne voit pas le contenu du média.
const MEDIA_DESCRIPTIONS = {
  sticker: 'un sticker',
  image: 'une image',
  video: 'une vidéo',
  audio: 'un fichier audio',
  ptt: 'un message vocal',
  document: 'un document',
  location: 'une localisation',
  vcard: 'une fiche contact',
  multi_vcard: 'plusieurs fiches contact'
};

function buildIncomingText(msg) {
  if (msg.type === 'chat') {
    return msg.body?.trim() || '';
  }

  const description = MEDIA_DESCRIPTIONS[msg.type];

  if (!description) {
    return '';
  }

  // Pour image, vidéo et document, msg.body contient la légende éventuelle.
  const caption =
    ['image', 'video', 'document'].includes(msg.type)
      ? msg.body?.trim()
      : '';

  let text = `[Le contact a envoyé ${description}. Tu ne peux pas voir ou écouter son contenu.`;

  if (caption) {
    text += ` Légende : "${caption}"`;
  }

  text += ' Réponds brièvement et naturellement, sans inventer ce qu\'il contient.]';

  return text;
}

function getTodayKey(contact) {
  return `${contact}:${new Date().toISOString().slice(0, 10)}`;
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

// Construit un identifiant fiable, même si id._serialized est absent
// (cas observé sur certaines conversations @lid).
function getMessageId(msg) {
  const id = msg.id || {};

  if (id._serialized) {
    return id._serialized;
  }

  if (id.remote && id.id) {
    const remote =
      typeof id.remote === 'string'
        ? id.remote
        : id.remote._serialized || JSON.stringify(id.remote);
    return `${id.fromMe ? 'true' : 'false'}_${remote}_${id.id}`;
  }

  if (id.id) {
    return `${msg.from}_${id.id}`;
  }

  if (msg.timestamp) {
    return `${msg.from}_${msg.timestamp}_${msg.body || ''}`;
  }

  return null;
}

client.on('message', async msg => {
  console.log('\nMESSAGE DÉTECTÉ :', {
    from: msg.from,
    fromMe: msg.fromMe,
    type: msg.type,
    body: msg.body
  });

  try {
    // Ne jamais répondre à ses propres messages.
    if (msg.fromMe) {
      console.log('Message ignoré : message envoyé par le bot.');
      return;
    }

    // Ignorer les groupes, statuts et messages non textuels.
    if (msg.from.endsWith('@g.us')) {
      console.log('Message ignoré : groupe WhatsApp.');
      return;
    }

    if (msg.isStatus || msg.from === 'status@broadcast') {
      console.log('Message ignoré : statut WhatsApp.');
      return;
    }

    if (msg.type !== 'chat' && !MEDIA_DESCRIPTIONS[msg.type]) {
      console.log('Message ignoré : type non pris en charge ->', msg.type);
      return;
    }

    const text = buildIncomingText(msg);

    if (!text) {
      console.log('Message ignoré : contenu vide.');
      return;
    }

    if (msg.type !== 'chat') {
      console.log('Média converti en texte pour le modèle :', text);
    }

    if (
      config.maxMessageLength &&
      text.length > config.maxMessageLength
    ) {
      console.log('Message ignoré : longueur maximale dépassée.');
      return;
    }

    // Protection contre les événements répétés.
    const messageId = getMessageId(msg);

    if (!messageId) {
      console.log('Message ignoré : aucun identifiant exploitable.');
      console.log('Contenu brut de msg.id :', JSON.stringify(msg.id));
      return;
    }

    if (processedIds.has(messageId)) {
      console.log('Message ignoré : déjà traité ->', messageId);
      return;
    }

    console.log('Identifiant du message :', messageId);

    processedIds.add(messageId);

    if (processedIds.size > 2000) {
      const oldest = processedIds.values().next().value;
      processedIds.delete(oldest);
    }

    // Récupérer les informations du contact.
    let contact = null;

    try {
      contact = await msg.getContact();
    } catch (error) {
      console.error(
        'Impossible de récupérer le contact :',
        error.message
      );
    }

    const contactId = contact?.id?._serialized || '';

    // Avec un @lid, contact.number peut renvoyer le LID au lieu du
    // vrai numéro. Le numéro fiable est alors dans contactId (@c.us).
    const phoneFromContactId = contactId.endsWith('@c.us')
      ? normalizePhone(contactId.split('@')[0])
      : '';

    const phone =
      phoneFromContactId || normalizePhone(contact?.number);

    console.log('Identifiant WhatsApp :', msg.from);
    console.log('Identifiant du contact :', contactId || 'indisponible');
    console.log('Numéro résolu :', phone || 'indisponible');
    console.log('Liste des contacts autorisés :', [...allowed]);

    // Autoriser uniquement un numéro ou identifiant explicitement
    // présent dans config.json.
    const isAllowed =
      (phone && allowed.has(phone)) ||
      allowed.has(msg.from) ||
      (contactId && allowed.has(contactId));

    if (!isAllowed) {
      console.log(
        'Contact non autorisé ou numéro non résolu. Aucune réponse envoyée.'
      );
      console.log(
        `Si c'est bien un contact autorisé, ajoute "${msg.from}" dans allowedContacts.`
      );
      return;
    }

    console.log('Contact autorisé.');

    const chatId = msg.from;
    const countKey = getTodayKey(phone || msg.from);

    // Un seul traitement à la fois par conversation.
    if (processing.has(chatId)) {
      console.log('Message ignoré : conversation déjà en traitement.');
      return;
    }

    // Respecter le délai entre deux réponses.
    const now = Date.now();
    const cooldown =
      Number(config.cooldownSeconds || 0) * 1000;

    if (
      now - (lastReplyAt.get(chatId) || 0) < cooldown
    ) {
      console.log('Message ignoré : délai entre réponses non écoulé.');
      return;
    }

    // Limite quotidienne.
    const count = dailyCounts.get(countKey) || 0;
    const maxReplies = Number(
      config.maxRepliesPerContactPerDay || 0
    );

    if (maxReplies > 0 && count >= maxReplies) {
      console.log('Limite quotidienne atteinte.');
      return;
    }

    processing.add(chatId);

    try {
      console.log('Message autorisé :', text);

      // Générer la réponse avec Ollama.
      const answer = await askOllama(chatId, text);

      console.log('Tentative d’envoi de la réponse WhatsApp...');

      // Envoyer la réponse dans la conversation d'origine.
      await client.sendMessage(chatId, answer);

      lastReplyAt.set(chatId, Date.now());
      dailyCounts.set(countKey, count + 1);

      console.log('Réponse envoyée avec succès à', chatId);
    } catch (error) {
      console.error(
        'ERREUR DE TRAITEMENT :',
        error.stack || error.message
      );
    } finally {
      processing.delete(chatId);
    }
  } catch (error) {
    console.error(
      'ERREUR DU GESTIONNAIRE DE MESSAGE :',
      error.stack || error.message
    );
  }
});

client.initialize();