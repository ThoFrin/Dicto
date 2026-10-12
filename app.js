
"use strict";

// --------------------------------------------------
// Dicto — reconnaissance vocale avec reprise robuste
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

// idle, listening, paused, finishing, unsupported
let state = "idle";

// Intention de l'utilisateur.
let desiredState = "idle";

// Cycle de vie de la session.
let recognitionStopping = false;
let sessionNumber = 0;

// Résultats reconnus pendant la session.
let sessionResults = [];
let finalTranscript = "";

// Temporisateurs.
let restartTimer = null;
let stopWatchdog = null;
let toastTimer = null;

// Limitation des tentatives de redémarrage.
let restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 3;

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

  const active =
    listening ||
    paused ||
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

    micButton.disabled = state === "finishing";
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
    updateStatus(
      "Finalisation…",
      "Conservation du texte reconnu."
    );
  } else if (listening) {
    updateStatus(
      recognitionStopping
        ? "Reprise en cours…"
        : "Je vous écoute…",
      "Appuyez sur le microphone pour mettre en pause."
    );
  } else if (paused) {
    updateStatus(
      "Dictée en pause",
      "Appuyez sur le microphone pour reprendre."
    );
  } else {
    updateStatus(
      "Prêt à vous écouter",
      "Appuyez sur le microphone pour commencer."
    );
  }
}

// --------------------------------------------------
// Mise en forme du texte
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

  if (/^[,.;:!?%)\]}»”]/u.test(addition)) {
    return formatText(current + addition);
  }

  const separator = /[(\[«“]$/u.test(current) ? "" : " ";

  return formatText(current + separator + addition);
}

// --------------------------------------------------
// Résultats de reconnaissance
// --------------------------------------------------

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

  const parts = [
    finalTranscript,
    finalPart,
    interimPart
  ].filter(Boolean);

  transcript.value = formatText(parts.join(" "));
  updateCounters();

  if (document.activeElement !== transcript) {
    transcript.scrollTop = transcript.scrollHeight;
  }
}

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
// Temporisateurs et fin de session
// --------------------------------------------------

function clearRestartTimer() {
  if (restartTimer !== null) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function clearStopWatchdog() {
  if (stopWatchdog !== null) {
    clearTimeout(stopWatchdog);
    stopWatchdog = null;
  }
}

function settleAfterSessionEnd() {
  clearRestartTimer();
  clearStopWatchdog();

  if (desiredState === "listening") {
    state = "listening";
    updateInterface();
    scheduleRestart(500);
    return;
  }

  if (desiredState === "paused") {
    state = "paused";
  } else {
    state = "idle";
    desiredState = "idle";
  }

  updateInterface();

  if (state === "idle") {
    showToast("Dictée terminée.");
  }
}

// --------------------------------------------------
// Récupération si Safari ne déclenche pas onend
// --------------------------------------------------

function armStopWatchdog(instance) {
  clearStopWatchdog();

  // Protection contre une session bloquée lors de stop().
  stopWatchdog = setTimeout(() => {
    stopWatchdog = null;

    if (recognition !== instance) return;

    console.warn(
      "La session tarde à se terminer. Tentative de libération."
    );

    try {
      instance.abort();
    } catch (error) {
      console.warn("Interruption de la session :", error);
    }

    // Laisse un court délai au moteur pour libérer la session.
    stopWatchdog = setTimeout(() => {
      stopWatchdog = null;

      if (recognition !== instance) return;

      commitSessionResults();

      recognition = null;
      recognitionStopping = false;

      settleAfterSessionEnd();
    }, 800);
  }, 1800);
}

// --------------------------------------------------
// Création du moteur
// --------------------------------------------------


function createRecognition() {
  const instance = new SpeechRecognition();
  const thisSession = ++sessionNumber;

  instance.lang = "fr-FR";
  instance.continuous = true;
  instance.interimResults = true;
  instance.maxAlternatives = 1;

  console.log("[Dicto] Création de la session", thisSession);

  instance.onstart = () => {
    if (recognition !== instance) return;

    console.log("[Dicto] Moteur démarré");
    state = "listening";
    updateInterface();
    updateStatus(
      "Microphone actif",
      "Parlez maintenant. En attente du texte reconnu…"
    );
  };

  instance.onaudiostart = () => {
    console.log("[Dicto] Capture audio démarrée");
  };

  instance.onspeechstart = () => {
    console.log("[Dicto] Parole détectée");
    updateStatus("Parole détectée", "Reconnaissance en cours…");
  };

  instance.onspeechend = () => {
    console.log("[Dicto] Fin de parole détectée");
  };

  instance.onresult = (event) => {
    if (recognition !== instance) return;
    if (thisSession !== sessionNumber) return;

    console.log(
      "[Dicto] Résultat reçu",
      "index =", event.resultIndex,
      "nombre de résultats =", event.results.length
    );

    for (
      let i = event.resultIndex;
      i < event.results.length;
      i++
    ) {
      const result = event.results[i];
      const spokenText = result[0]?.transcript?.trim();

      console.log("[Dicto] Texte reçu :", spokenText);

      if (!spokenText) continue;

      sessionResults[i] = {
        text: spokenText,
        isFinal: result.isFinal
      };
    }

    renderTranscript();

    if (getSessionFinalText() || getSessionInterimText()) {
      updateStatus("Texte reconnu", "Vous pouvez continuer à dicter.");
    }
  };

  instance.onerror = (event) => {
    if (recognition !== instance) return;

    console.error(
      "[Dicto] Erreur de reconnaissance :",
      event.error,
      event.message || ""
    );

    const messages = {
      "not-allowed":
        "Accès au microphone refusé. Vérifiez les autorisations de Safari.",
      "service-not-allowed":
        "Le service de reconnaissance vocale est bloqué.",
      "audio-capture":
        "Le microphone n'est pas accessible.",
      "network":
        "Erreur réseau du service de reconnaissance vocale.",
      "no-speech":
        "Aucune parole détectée. Parlez plus près du microphone.",
      "language-not-supported":
        "La reconnaissance vocale en français n'est pas disponible.",
      "aborted":
        "La session vocale a été interrompue."
    };

    const message = messages[event.error] ||
      `Erreur vocale : ${event.error}`;

    if (
      ["not-allowed", "service-not-allowed",
       "audio-capture", "language-not-supported"].includes(event.error)
    ) {
      desiredState = "idle";
      clearRestartTimer();
      showToast(message);
    } else if (event.error !== "aborted") {
      showToast(message);
    }
  };

  instance.onend = () => {
    if (recognition !== instance) return;
    if (thisSession !== sessionNumber) return;

    console.log("[Dicto] Session terminée");

    clearStopWatchdog();
    commitSessionResults();

    recognition = null;
    recognitionStopping = false;

    settleAfterSessionEnd();
  };

  return instance;
}

// --------------------------------------------------
// Démarrage et redémarrage
// --------------------------------------------------

function scheduleRestart(delay = 500) {
  clearRestartTimer();

  if (desiredState !== "listening") return;
  if (recognition) return;

  restartTimer = setTimeout(() => {
    restartTimer = null;

    if (desiredState !== "listening") return;
    if (recognition) return;

    startRecognitionSession();
  }, delay);
}

function startRecognitionSession() {
  if (desiredState !== "listening") return;
  if (recognition) return;

  if (!SpeechRecognition) {
    state = "unsupported";
    desiredState = "idle";
    updateInterface();

    showToast(
      "La reconnaissance vocale n'est pas prise en charge."
    );
    return;
  }

  if (!window.isSecureContext) {
    state = "idle";
    desiredState = "idle";
    updateInterface();

    showToast("Le microphone nécessite une connexion HTTPS.");
    return;
  }

  let instance;

  try {
    sessionResults = [];

    instance = createRecognition();
    recognition = instance;
    recognitionStopping = false;

    state = "listening";
    updateInterface();

    instance.start();

    restartAttempts = 0;
  } catch (error) {
    console.error("Démarrage impossible :", error);

    if (recognition === instance) {
      recognition = null;
    }

    recognitionStopping = false;

    if (desiredState === "listening") {
      restartAttempts++;

      if (restartAttempts <= MAX_RESTART_ATTEMPTS) {
        showToast("Reconnexion du microphone…");
        scheduleRestart(1000);
      } else {
        desiredState = "paused";
        state = "paused";
        restartAttempts = 0;

        updateInterface();

        showToast(
          "La reprise automatique a échoué. Appuyez pour réessayer."
        );
      }
    } else {
      state = desiredState === "paused" ? "paused" : "idle";
      updateInterface();
    }
  }
}

// --------------------------------------------------
// Bouton microphone : démarrer, pause ou reprise
// --------------------------------------------------

function startOrResume() {
  if (!SpeechRecognition) {
    state = "unsupported";
    desiredState = "idle";
    updateInterface();

    showToast("La reconnaissance vocale n'est pas disponible.");
    return;
  }

  if (!window.isSecureContext) {
    showToast("Le microphone nécessite une connexion HTTPS.");
    return;
  }

  // Une deuxième pression pendant l'écoute demande une pause.
  if (
    desiredState === "listening" &&
    state === "listening" &&
    !recognitionStopping
  ) {
    pauseListening();
    return;
  }

  clearRestartTimer();
  restartAttempts = 0;
  desiredState = "listening";

  if (recognition) {
    if (recognitionStopping) {
      // La session précédente s'arrête encore.
      // Son onend ou le watchdog déclenchera la reprise.
      state = "listening";
      updateInterface();
      return;
    }

    // Une session est déjà active : ne pas en créer une autre.
    state = "listening";
    updateInterface();
    return;
  }

  state = "listening";
  updateInterface();
  startRecognitionSession();
}

// --------------------------------------------------
// Pause
// --------------------------------------------------

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

  recognitionStopping = true;
  armStopWatchdog(currentRecognition);

  try {
    currentRecognition.stop();
  } catch (error) {
    console.warn("Arrêt de la session :", error);

    // Le watchdog s'occupera de libérer la session si nécessaire.
  }
}

// --------------------------------------------------
// Terminer définitivement
// --------------------------------------------------

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

  recognitionStopping = true;
  armStopWatchdog(currentRecognition);

  try {
    currentRecognition.stop();
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
  // Le texte modifié devient la nouvelle base.
  finalTranscript = transcript.value;
  sessionResults = [];

  updateCounters();
});

// --------------------------------------------------
// Effacement
// --------------------------------------------------

clearButton.addEventListener("click", () => {
  if (!window.confirm("Effacer tout le texte ?")) return;

  desiredState = "idle";
  state = "finishing";

  clearRestartTimer();
  clearStopWatchdog();

  const oldRecognition = recognition;

  // Invalide les anciens événements avant d'interrompre la session.
  recognition = null;
  recognitionStopping = false;
  sessionNumber++;

  if (oldRecognition) {
    try {
      oldRecognition.abort();
    } catch (error) {
      console.warn("Interruption de la session :", error);
    }
  }

  sessionResults = [];
  finalTranscript = "";
  transcript.value = "";

  restartAttempts = 0;

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

      showToast(
        "Texte copié. Vous pouvez le coller dans votre e-mail."
      );
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
        console.error(
          "Service worker non enregistré :",
          error
        );
      });
  });
}

// --------------------------------------------------
// Initialisation
// --------------------------------------------------

if (!SpeechRecognition) {
  state = "unsupported";
  desiredState = "idle";
} else {
  state = "idle";
  desiredState = "idle";
}

updateCounters();
updateInterface();
