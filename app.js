
"use strict";

// --------------------------------------------------
// Dicto — reconnaissance vocale et gestion des sessions
// --------------------------------------------------

const micButton = document.getElementById("micButton");
const finishButton = document.getElementById("finishButton");
const shareButton = document.getElementById("shareButton");
const clearButton = document.getElementById("clearButton");

const transcript = document.getElementById("transcript");
const statusText = document.getElementById("status");
const hint = document.getElementById("hint");
const wordCount = document.getElementById("wordCount");
const charCount = document.getElementById("charCount");
const pulse = document.getElementById("pulse");
const toast = document.getElementById("toast");

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let state = "idle"; // idle, listening, paused, finishing, unsupported

// Intention de l'utilisateur, distincte de l'état du moteur.
let desiredState = "idle";

// Résultats indexés de la session courante.
// Les résultats provisoires ne sont jamais ajoutés définitivement.
let sessionResults = [];
let finalTranscript = "";

let restartTimer = null;
let toastTimer = null;
let sessionNumber = 0;
let manualEditVersion = 0;

// --------------------------------------------------
// Messages et affichage
// --------------------------------------------------

function showToast(message) {
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("visible");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("visible");
  }, 3200);
}

function updateStatus(message, description = "") {
  if (statusText) statusText.textContent = message;
  if (hint) hint.textContent = description;
}

function updateCounters() {
  const text = transcript.value.trim();
  const words = text ? text.split(/\s+/u).length : 0;
  const characters = transcript.value.length;

  if (wordCount) {
    wordCount.textContent =
      `${words} ${words > 1 ? "mots" : "mot"}`;
  }

  if (charCount) {
    charCount.textContent =
      `${characters} ${characters > 1 ? "caractères" : "caractère"}`;
  }
}

function updateInterface() {
  const listening = state === "listening";
  const paused = state === "paused";
  const active = listening || paused ||
    state === "finishing" ||
    desiredState === "listening";

  if (micButton) {
    micButton.classList.toggle("is-listening", listening);
    micButton.setAttribute("aria-pressed", String(listening));

    micButton.setAttribute(
      "aria-label",
      listening
        ? "Mettre la dictée en pause"
        : paused
          ? "Reprendre la dictée"
          : "Démarrer la dictée"
    );

    micButton.disabled =
      state === "finishing" && desiredState !== "listening";
  }

  if (pulse) {
    pulse.classList.toggle("active", listening);
  }

  if (finishButton) {
    finishButton.disabled = !active;
  }

  if (state === "unsupported") {
    updateStatus(
      "Dictée indisponible",
      "Essayez Safari sur un iPhone compatible."
    );
  } else if (state === "finishing") {
    updateStatus("Finalisation…", "Conservation du texte reconnu.");
  } else if (listening) {
    updateStatus("Je vous écoute…", "Appuyez pour mettre en pause.");
  } else if (paused) {
    updateStatus("Dictée en pause", "Appuyez sur le microphone pour reprendre.");
  } else {
    updateStatus(
      "Prêt à vous écouter",
      "Appuyez sur le microphone pour commencer."
    );
  }
}

// --------------------------------------------------
// Mise en forme prudente
// --------------------------------------------------

function capitalizeSentences(text) {
  return text.replace(
    /(^|[.!?]\s+)([\p{Ll}])/gu,
    (_, prefix, letter) =>
      prefix + letter.toLocaleUpperCase("fr-FR")
  );
}

function cleanPunctuation(text) {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:!?])([^\s])/g, "$1 $2")
    .replace(/\.{2,}/g, "…")
    .trim();
}

function formatText(text) {
  return capitalizeSentences(cleanPunctuation(text));
}

function appendSegment(current, segment) {
  const addition = cleanPunctuation(segment);

  if (!addition) return current;
  if (!current) return capitalizeSentences(addition);

  // Aucun espace avant la ponctuation fermante.
  if (/^[,.;:!?%)\]}»”]/u.test(addition)) {
    return formatText(current + addition);
  }

  // Pas d'espace après une ouverture de parenthèse/guillemet.
  const separator = /[(\[«“]$/u.test(current) ? "" : " ";

  return formatText(current + separator + addition);
}

// Reconstruit le texte à partir des résultats de la session.
// Les résultats finaux sont conservés par index, sans duplication.
function getSessionFinalText() {
  return sessionResults
    .filter((item) => item && item.isFinal)
    .map((item) => item.text)
    .join(" ")
    .trim();
}

function getSessionInterimText() {
  return sessionResults
    .filter((item) => item && !item.isFinal)
    .map((item) => item.text)
    .join(" ")
    .trim();
}

function renderTranscript() {
  const finalPart = getSessionFinalText();
  const interimPart = getSessionInterimText();

  const parts = [finalTranscript, finalPart, interimPart]
    .filter(Boolean);

  transcript.value = formatText(parts.join(" "));
  updateCounters();

  // Garde le curseur visuel sur le texte récent sans déplacer
  // le curseur d'édition si l'utilisateur est en train d'écrire.
  if (document.activeElement !== transcript) {
    transcript.scrollTop = transcript.scrollHeight;
  }
}

// Consolide uniquement les résultats définitifs.
function commitSessionResults() {
  const finalPart = getSessionFinalText();

  if (finalPart) {
    finalTranscript = appendSegment(finalTranscript, finalPart);
  }

  sessionResults = [];
  transcript.value = formatText(finalTranscript);
  updateCounters();
}

// --------------------------------------------------
// Gestion du moteur de reconnaissance
// --------------------------------------------------

function createRecognition() {
  const instance = new SpeechRecognition();

  instance.lang = "fr-FR";
  instance.continuous = true;
  instance.interimResults = true;
  instance.maxAlternatives = 1;

  const thisSession = ++sessionNumber;
  const editVersionAtStart = manualEditVersion;

  instance.onresult = (event) => {
    if (recognition !== instance) return;
    if (thisSession !== sessionNumber) return;

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const spokenText = result[0]?.transcript?.trim();

      if (!spokenText) continue;

      sessionResults[i] = {
        text: spokenText,
        isFinal: result.isFinal
      };
    }

    /*
     * Si l'utilisateur modifie le texte manuellement pendant
     * la reconnaissance, ne pas remplacer sa version par
     * un ancien état affiché.
     */
    if (editVersionAtStart === manualEditVersion) {
      renderTranscript();
    }
  };

  instance.onerror = (event) => {
    if (recognition !== instance) return;

    console.warn("SpeechRecognition :", event.error);

    const messages = {
      "not-allowed":
        "Autorisez l'accès au microphone dans les réglages du navigateur.",
      "service-not-allowed":
        "Le service de reconnaissance vocale est bloqué.",
      "audio-capture":
        "Aucun microphone accessible n'a été détecté.",
      "network":
        "Interruption réseau. La dictée sera reprise si possible.",
      "no-speech":
        "Aucune parole détectée. Vous pouvez continuer.",
      "language-not-supported":
        "La reconnaissance du français n'est pas disponible.",
      "aborted":
        "Session de reconnaissance interrompue."
    };

    const message = messages[event.error] ||
      `Erreur de reconnaissance : ${event.error}`;

    if (
      event.error === "not-allowed" ||
      event.error === "service-not-allowed" ||
      event.error === "audio-capture" ||
      event.error === "language-not-supported"
    ) {
      desiredState = "idle";
      showToast(message);
    } else if (event.error !== "no-speech" && event.error !== "aborted") {
      showToast(message);
    }
  };

  instance.onend = () => {
    if (recognition !== instance) return;

    // Attendre la fin effective avant d'autoriser un nouveau start().
    commitSessionResults();
    recognition = null;

    if (desiredState === "listening") {
      scheduleRestart();
      return;
    }

    clearRestartTimer();

    if (desiredState === "paused") {
      state = "paused";
    } else {
      state = "idle";
      desiredState = "idle";
    }

    updateInterface();
  };

  return instance;
}

function clearRestartTimer() {
  if (restartTimer !== null) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function scheduleRestart() {
  clearRestartTimer();

  if (desiredState !== "listening" || recognition) return;

  // Petite temporisation pour laisser le moteur se libérer.
  restartTimer = setTimeout(() => {
    restartTimer = null;

    if (desiredState === "listening" && !recognition) {
      startRecognitionSession();
    }
  }, 650);
}

function startRecognitionSession() {
  if (desiredState !== "listening") return;
  if (recognition) return;

  if (!SpeechRecognition) {
    state = "unsupported";
    desiredState = "idle";
    updateInterface();

    showToast(
      "La reconnaissance vocale n'est pas prise en charge par ce navigateur."
    );
    return;
  }

  if (!window.isSecureContext) {
    desiredState = "idle";
    state = "idle";
    updateInterface();

    showToast("Le microphone nécessite HTTPS ou localhost.");
    return;
  }

  let instance;

  try {
    instance = createRecognition();
    recognition = instance;
    state = "listening";
    sessionResults = [];
    updateInterface();

    instance.start();
  } catch (error) {
    console.error("Démarrage impossible :", error);

    if (recognition === instance) {
      recognition = null;
    }

    if (desiredState === "listening") {
      // Évite une boucle de démarrages immédiats.
      state = "paused";
      desiredState = "paused";
      updateInterface();
      showToast("Le microphone n'a pas démarré. Appuyez pour réessayer.");
    } else {
      state = "idle";
      updateInterface();
    }
  }
}

function startOrResume() {
  if (!SpeechRecognition) {
    state = "unsupported";
    updateInterface();
    showToast("La reconnaissance vocale n'est pas disponible ici.");
    return;
  }

  if (!window.isSecureContext) {
    showToast("Le microphone nécessite une connexion HTTPS.");
    return;
  }

  if (desiredState === "listening" && state === "listening") {
    pauseListening();
    return;
  }

  clearRestartTimer();

  desiredState = "listening";

  // Si l'ancienne session est encore en cours d'arrêt,
  // on attend son onend : on ne crée pas de moteur concurrent.
  if (recognition) {
    state = "listening";
    updateInterface();
    return;
  }

  startRecognitionSession();
}

function pauseListening() {
  if (desiredState !== "listening") return;

  desiredState = "paused";
  state = "paused";
  clearRestartTimer();
  updateInterface();

  const currentRecognition = recognition;

  if (!currentRecognition) {
    commitSessionResults();
    updateInterface();
    return;
  }

  try {
    /*
     * stop() laisse au moteur la possibilité d'envoyer
     * les derniers résultats définitifs avant onend.
     * On conserve donc la référence jusqu'à onend.
     */
    currentRecognition.stop();
  } catch (error) {
    console.warn("Arrêt de la session :", error);

    // Si la session était déjà terminée, on attend son onend
    // ou l'action utilisateur suivante.
  }
}

function finishListening() {
  desiredState = "idle";
  state = "finishing";
  clearRestartTimer();
  updateInterface();

  const currentRecognition = recognition;

  if (!currentRecognition) {
    commitSessionResults();
    state = "idle";
    updateInterface();
    showToast("Dictée terminée.");
    return;
  }

  try {
    currentRecognition.stop();
    // Le texte est consolidé dans onend.
    showToast("Finalisation de la dictée…");
  } catch (error) {
    console.warn("Finalisation :", error);
  }
}

// --------------------------------------------------
// Commandes de l'interface
// --------------------------------------------------

micButton.addEventListener("click", startOrResume);
finishButton.addEventListener("click", finishListening);

// --------------------------------------------------
// Édition manuelle
// --------------------------------------------------

transcript.addEventListener("input", () => {
  manualEditVersion++;

  /*
   * Une modification manuelle devient la nouvelle base.
   * Si une session est active, ses prochains résultats
   * restent gérés séparément.
   */
  finalTranscript = transcript.value;
  sessionResults = [];
  updateCounters();
});

// --------------------------------------------------
// Effacement
// --------------------------------------------------

clearButton.addEventListener("click", () => {
  const confirmed = window.confirm("Effacer tout le texte ?");

  if (!confirmed) return;

  desiredState = "idle";
  state = "finishing";
  clearRestartTimer();

  const currentRecognition = recognition;

  if (currentRecognition) {
    try {
      currentRecognition.abort();
    } catch (error) {
      console.warn("Interruption de la session :", error);
    }
  }

  recognition = null;
  sessionNumber++;
  sessionResults = [];
  finalTranscript = "";
  transcript.value = "";
  manualEditVersion++;

  updateCounters();

  state = "idle";
  updateInterface();
  showToast("Texte effacé.");
});

// --------------------------------------------------
// Partage natif iOS / navigateur
// --------------------------------------------------

shareButton.addEventListener("click", async () => {
  const text = transcript.value.trim();

  if (!text) {
    showToast("Dictez ou saisissez un texte avant de le partager.");
    return;
  }

  const shareData = {
    title: "Texte dicté avec Dicto",
    text
  };

  try {
    if (
      navigator.share &&
      (!navigator.canShare || navigator.canShare(shareData))
    ) {
      await navigator.share(shareData);
      return;
    }

    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      showToast("Texte copié. Vous pouvez le coller dans votre e-mail.");
      return;
    }

    transcript.focus();
    transcript.select();
    showToast("Texte sélectionné. Copiez-le pour le partager.");
  } catch (error) {
    if (error.name === "AbortError") return;

    console.error("Erreur de partage :", error);
    showToast("Le partage a échoué. Copiez le texte manuellement.");
  }
});

// --------------------------------------------------
// Service worker de la PWA
// --------------------------------------------------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js")
      .catch((error) => {
        console.error("Service worker non enregistré :", error);
      });
  });
}

// --------------------------------------------------
// Initialisation
// --------------------------------------------------

if (!SpeechRecognition) {
  state = "unsupported";
} else {
  state = "idle";
}

updateCounters();
updateInterface();
