
"use strict";

// ==================================================
// Dicto — gestion fiable de la dictée vocale
// Compatible avec SpeechRecognition / Safari iOS
// ==================================================

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

// États : idle, listening, paused, finishing, unsupported.
let state = "idle";
let desiredState = "idle";

// Une seule instance peut exister à la fois.
let recognition = null;
let recognitionStopping = false;
let sessionNumber = 0;

// Texte définitif et résultats de la session courante.
let finalTranscript = "";
let sessionResults = [];
let discardCurrentSession = false;

// Temporisateurs.
let restartTimer = null;
let toastTimer = null;

// Limite les redémarrages automatiques en cas d'échec.
let restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 4;

// ==================================================
// Messages et interface
// ==================================================

function showToast(message) {
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("visible");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    toast.classList.remove("visible");
  }, 3500);
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
      "Ce navigateur ne prend pas en charge la reconnaissance vocale."
    );
  } else if (state === "finishing") {
    updateStatus(
      "Finalisation…",
      "Enregistrement des derniers résultats reconnus."
    );
  } else if (listening && recognitionStopping) {
    updateStatus(
      "Reprise en attente…",
      "Fermeture de la session précédente."
    );
  } else if (listening) {
    updateStatus(
      "Je vous écoute…",
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

// ==================================================
// Mise en forme du texte
// ==================================================

function cleanPunctuation(text) {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:!?])([^\s])/g, "$1 $2")
    .replace(/\.{2,}/g, "…")
    .trim();
}

function capitalizeSentences(text) {
  return text.replace(
    /(^|[.!?…]\s+)([\p{Ll}])/gu,
    (_, prefix, letter) =>
      prefix + letter.toLocaleUpperCase("fr-FR")
  );
}

function formatText(text) {
  return capitalizeSentences(cleanPunctuation(text));
}

function appendSegment(current, segment) {
  const addition = cleanPunctuation(segment);

  if (!addition) return current;
  if (!current) return capitalizeSentences(addition);

  // Évite un espace avant la ponctuation.
  if (/^[,.;:!?%)\]}»”]/u.test(addition)) {
    return formatText(current + addition);
  }

  // Évite un espace après une parenthèse ou un guillemet ouvrant.
  const separator = /[(\[«“]$/u.test(current) ? "" : " ";

  return formatText(current + separator + addition);
}

// ==================================================
// Lecture et affichage des résultats
// ==================================================

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
  const parts = [
    finalTranscript,
    getSessionFinalText(),
    getSessionInterimText()
  ].filter(Boolean);

  transcript.value = formatText(parts.join(" "));
  updateCounters();

  if (document.activeElement !== transcript) {
    transcript.scrollTop = transcript.scrollHeight;
  }
}

function commitSessionResults() {
  if (discardCurrentSession) {
    sessionResults = [];
    return;
  }

  const finalPart = getSessionFinalText();

  if (finalPart) {
    finalTranscript = appendSegment(finalTranscript, finalPart);
  }

  sessionResults = [];

  transcript.value = formatText(finalTranscript);
  updateCounters();
}

// ==================================================
// Temporisation des redémarrages automatiques
// ==================================================

function clearRestartTimer() {
  if (restartTimer !== null) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function scheduleRestart(delay = 700) {
  clearRestartTimer();

  if (desiredState !== "listening") return;
  if (recognition !== null) return;

  restartTimer = setTimeout(() => {
    restartTimer = null;

    // Vérifier à nouveau l'intention juste avant le démarrage.
    if (desiredState !== "listening") return;
    if (recognition !== null) return;

    startRecognitionSession();
  }, delay);
}

// ==================================================
// Fin effective d'une session
// ==================================================

function handleSessionEnd(instance, thisSession) {
  // Ignore les événements provenant d'une ancienne session.
  if (recognition !== instance) return;
  if (thisSession !== sessionNumber) return;

  console.log("[Dicto] Session terminée :", thisSession);

  commitSessionResults();

  // Libération uniquement à la réception de onend.
  recognition = null;
  recognitionStopping = false;
  discardCurrentSession = false;

  if (desiredState === "listening") {
    state = "listening";
    updateInterface();

    // Le nouveau démarrage se fait après la fermeture effective.
    scheduleRestart(700);
    return;
  }

  clearRestartTimer();

  if (desiredState === "paused") {
    state = "paused";
    updateInterface();
    return;
  }

  desiredState = "idle";
  state = "idle";
  updateInterface();

  showToast("Dictée terminée.");
}

// ==================================================
// Création d'une nouvelle instance de reconnaissance
// ==================================================

function createRecognition() {
  const instance = new SpeechRecognition();
  const thisSession = ++sessionNumber;

  instance.lang = "fr-FR";
  instance.continuous = true;
  instance.interimResults = true;
  instance.maxAlternatives = 1;

  console.log("[Dicto] Nouvelle session :", thisSession);

  instance.onstart = () => {
    if (recognition !== instance) return;
    if (thisSession !== sessionNumber) return;

    console.log("[Dicto] Moteur démarré :", thisSession);

    restartAttempts = 0;
    state = desiredState === "paused" ? "paused" : "listening";
    updateInterface();
  };

  instance.onaudiostart = () => {
    console.log("[Dicto] Capture audio démarrée :", thisSession);
  };

  instance.onspeechstart = () => {
    console.log("[Dicto] Parole détectée :", thisSession);

    if (recognition === instance && desiredState === "listening") {
      updateStatus("Parole détectée", "Reconnaissance en cours…");
    }
  };

  instance.onspeechend = () => {
    console.log("[Dicto] Fin de parole :", thisSession);
  };

  instance.onresult = (event) => {
    if (recognition !== instance) return;
    if (thisSession !== sessionNumber) return;
    if (discardCurrentSession) return;

    console.log(
      "[Dicto] Résultat reçu :",
      thisSession,
      "index :",
      event.resultIndex
    );

    for (
      let i = event.resultIndex;
      i < event.results.length;
      i++
    ) {
      const result = event.results[i];
      const spokenText = result[0]?.transcript?.trim();

      if (!spokenText) continue;

      sessionResults[i] = {
        text: spokenText,
        isFinal: result.isFinal
      };

      console.log(
        "[Dicto] Texte :",
        spokenText,
        "| définitif :",
        result.isFinal
      );
    }

    renderTranscript();

    if (getSessionFinalText() || getSessionInterimText()) {
      updateStatus(
        "Texte reconnu",
        "Vous pouvez continuer à dicter."
      );
    }
  };

  instance.onerror = (event) => {
    if (recognition !== instance) return;
    if (thisSession !== sessionNumber) return;

    console.error(
      "[Dicto] Erreur vocale :",
      event.error,
      event.message || ""
    );

    const messages = {
      "not-allowed":
        "Accès au microphone refusé. Vérifiez les autorisations.",
      "service-not-allowed":
        "Le service de reconnaissance vocale est bloqué.",
      "audio-capture":
        "Le microphone n'est pas accessible.",
      "network":
        "Le service vocal a rencontré une erreur réseau.",
      "no-speech":
        "Aucune parole détectée. Vous pouvez réessayer.",
      "language-not-supported":
        "La reconnaissance vocale en français n'est pas disponible.",
      "aborted":
        "La session vocale a été interrompue."
    };

    const fatalErrors = [
      "not-allowed",
      "service-not-allowed",
      "audio-capture",
      "language-not-supported"
    ];

    if (fatalErrors.includes(event.error)) {
      desiredState = "idle";
      clearRestartTimer();
      showToast(messages[event.error]);
    } else if (
      event.error !== "aborted" &&
      event.error !== "no-speech"
    ) {
      showToast(
        messages[event.error] ||
        `Erreur de reconnaissance : ${event.error}`
      );
    }

    // Important : ne pas libérer l'instance ici.
    // L'événement onend reste responsable de sa fermeture.
  };

  instance.onend = () => {
    handleSessionEnd(instance, thisSession);
  };

  return instance;
}

// ==================================================
// Démarrage d'une session
// ==================================================

function startRecognitionSession() {
  if (desiredState !== "listening") return;
  if (recognition !== null) return;

  if (!SpeechRecognition) {
    desiredState = "idle";
    state = "unsupported";
    updateInterface();

    showToast("La reconnaissance vocale n'est pas disponible.");
    return;
  }

  if (!window.isSecureContext) {
    desiredState = "idle";
    state = "idle";
    updateInterface();

    showToast("Le microphone nécessite une connexion HTTPS.");
    return;
  }

  let instance;

  try {
    sessionResults = [];
    discardCurrentSession = false;

    instance = createRecognition();

    // La référence est affectée avant start() pour les événements.
    recognition = instance;
    recognitionStopping = false;

    state = "listening";
    updateInterface();

    console.log("[Dicto] Appel de start()");

    instance.start();
  } catch (error) {
    console.error("[Dicto] Échec de start() :", error);

    // Un échec synchrone ne produira pas nécessairement onend.
    if (recognition === instance) {
      recognition = null;
    }

    recognitionStopping = false;

    if (desiredState === "listening") {
      restartAttempts++;

      if (restartAttempts <= MAX_RESTART_ATTEMPTS) {
        state = "listening";
        updateInterface();

        showToast("Démarrage impossible. Nouvelle tentative…");
        scheduleRestart(1200);
      } else {
        desiredState = "paused";
        state = "paused";
        restartAttempts = 0;

        updateInterface();

        showToast(
          "La reconnaissance n'a pas redémarré. Appuyez pour réessayer."
        );
      }
    } else {
      state = desiredState === "paused" ? "paused" : "idle";
      updateInterface();
    }
  }
}

// ==================================================
// Bouton microphone : démarrer, mettre en pause, reprendre
// ==================================================

function startOrResume() {
  if (!SpeechRecognition) {
    desiredState = "idle";
    state = "unsupported";
    updateInterface();

    showToast("La reconnaissance vocale n'est pas disponible.");
    return;
  }

  if (!window.isSecureContext) {
    showToast("Le microphone nécessite une connexion HTTPS.");
    return;
  }

  // Si la dictée est en cours, le clic demande une pause.
  if (desiredState === "listening") {
    pauseListening();
    return;
  }

  if (state === "finishing") {
    showToast("Attendez la fin de la session précédente.");
    return;
  }

  clearRestartTimer();
  restartAttempts = 0;
  desiredState = "listening";

  // Si l'ancienne session termine encore, son onend déclenchera
  // la création de la nouvelle session.
  if (recognition !== null) {
    state = "listening";
    updateInterface();
    return;
  }

  // Démarrage direct depuis le geste de l'utilisateur.
  state = "listening";
  updateInterface();
  startRecognitionSession();
}

// ==================================================
// Pause : conserver le texte et attendre onend
// ==================================================

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
  updateInterface();

  try {
    currentRecognition.stop();
    console.log("[Dicto] Pause demandée : attente de onend");
  } catch (error) {
    console.error("[Dicto] Impossible de demander la pause :", error);

    showToast(
      "La fermeture du microphone a échoué. Réessayez après quelques instants."
    );
  }
}

// ==================================================
// Terminer : finaliser puis revenir à l'état prêt
// ==================================================

function finishListening() {
  if (state === "finishing") return;

  desiredState = "idle";
  clearRestartTimer();

  const currentRecognition = recognition;

  if (!currentRecognition) {
    commitSessionResults();

    state = "idle";
    recognitionStopping = false;
    updateInterface();

    showToast("Dictée terminée.");
    return;
  }

  state = "finishing";
  recognitionStopping = true;
  updateInterface();

  try {
    currentRecognition.stop();
    console.log("[Dicto] Fin demandée : attente de onend");
  } catch (error) {
    console.error("[Dicto] Erreur lors de la finalisation :", error);

    showToast(
      "La finalisation est en cours. Attendez avant de redémarrer."
    );
  }
}

// ==================================================
// Connexion des boutons
// ==================================================

micButton.addEventListener("click", startOrResume);
finishButton.addEventListener("click", finishListening);

// ==================================================
// Modification manuelle du texte
// ==================================================

transcript.addEventListener("input", () => {
  // Le contenu édité devient la nouvelle base.
  finalTranscript = transcript.value;
  sessionResults = [];

  updateCounters();
});

// ==================================================
// Effacement complet
// ==================================================

clearButton.addEventListener("click", () => {
  if (!window.confirm("Effacer tout le texte ?")) return;

  desiredState = "idle";
  clearRestartTimer();

  const oldRecognition = recognition;

  finalTranscript = "";
  sessionResults = [];
  transcript.value = "";
  restartAttempts = 0;

  if (!oldRecognition) {
    state = "idle";
    recognitionStopping = false;
    discardCurrentSession = false;

    updateCounters();
    updateInterface();
    showToast("Texte effacé.");
    return;
  }

  // Empêche les derniers événements de réintroduire le texte effacé.
  discardCurrentSession = true;
  recognitionStopping = true;
  state = "finishing";

  updateCounters();
  updateInterface();

  try {
    oldRecognition.abort();
    console.log("[Dicto] Effacement : attente de onend");
  } catch (error) {
    console.error("[Dicto] Erreur pendant l'effacement :", error);

    showToast(
      "Le moteur vocal termine sa fermeture. Patientez un instant."
    );
  }
});

// ==================================================
// Partage natif iOS / navigateur
// ==================================================

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

    console.error("[Dicto] Erreur de partage :", error);
    showToast("Le partage a échoué. Copiez le texte manuellement.");
  }
});

// ==================================================
// Enregistrement du service worker PWA
// ==================================================

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js")
      .catch((error) => {
        console.error(
          "[Dicto] Enregistrement du service worker impossible :",
          error
        );
      });
  });
}

// ==================================================
// Initialisation
// ==================================================

if (!SpeechRecognition) {
  state = "unsupported";
  desiredState = "idle";
} else {
  state = "idle";
  desiredState = "idle";
}

updateCounters();
updateInterface();

